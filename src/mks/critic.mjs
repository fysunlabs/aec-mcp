// AEC 5.0.0 P2-1：memory critic（5.0-R-099）。
//
// 纯函数、确定性、零 IO、零网络：relevance/recency/confidence/utility 四因子
// 加权评分；低分不注入（不进 context pack），返回 gaps；默认 top-k 3–5。
// 设计文档（架构说明书 §5.10 / 重构方案 §317）只固定四因子名与 top-k 区间，
// 未规定精确权重/阈值/衰减常数 —— 这里取可注入的保守默认值，并在 P2.md
// 作为实现决策（D-x）声明。宿主可用 opts 覆盖，行为可复现。
//
// 不变量：
//   - 权重和恒为 1（DEFAULT_WEIGHTS）；调用方注入的权重会被归一化。
//   - status=forgotten 永不注入（硬门，critic 不能把被拒候选说回来）。
//   - relevance 由检索层提供（FTS 命中强度），本模块不自己算文本相似度。

/** 默认权重（和 = 1）。relevance 主导，符合 A2「相关性优先于召回率」。 */
export const DEFAULT_WEIGHTS = Object.freeze({
  relevance: 0.50,
  recency: 0.15,
  confidence: 0.20,
  utility: 0.15,
});

/** 注入阈值：低于此分不注入（宁少勿多）。 */
export const DEFAULT_THRESHOLD = 0.42;
/** 默认 top-k（规格 3–5）。 */
export const DEFAULT_TOP_K = 4;
/** recency 半衰期（天）：30 天前的新旧对半。 */
export const RECENCY_HALF_LIFE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const clamp01 = x => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
const normWeights = (w) => {
  const src = { ...DEFAULT_WEIGHTS, ...(w || {}) };
  const sum = Object.values(src).reduce((a, b) => a + Math.max(0, Number(b) || 0), 0);
  if (sum <= 0) return { ...DEFAULT_WEIGHTS };
  return {
    relevance: Math.max(0, src.relevance || 0) / sum,
    recency: Math.max(0, src.recency || 0) / sum,
    confidence: Math.max(0, src.confidence || 0) / sum,
    utility: Math.max(0, src.utility || 0) / sum,
  };
};

const STATUS_UTILITY = Object.freeze({ verified: 1, candidate: 0.65, forgotten: 0 });
const SCOPE_UTILITY = Object.freeze({ global: 1, tenant: 0.9, project: 0.8, session: 0.6 });

/**
 * 单条记忆打分。
 * @param {object} mem 记忆行（至少 relevance/confidence/status/created_at）
 * @param {object} opts { now:number(ms), weights:object }
 * @returns {{ score:number, factors:{relevance,recency,confidence,utility} }}
 */
export function scoreMemory(mem = {}, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const w = normWeights(opts.weights);

  // relevance：检索层给的命中强度（0..1），缺省按置信度折半（保守）。
  const relevance = clamp01(mem.relevance ?? (clamp01(mem.confidence) * 0.5));

  // recency：指数衰减，半衰期 RECENCY_HALF_LIFE_DAYS；未来时间按 1；无时间按 0.5。
  let recency = 0.5;
  const ts = Date.parse(mem.created_at ?? '');
  if (Number.isFinite(ts)) {
    const days = (now - ts) / DAY_MS;
    recency = days <= 0 ? 1 : Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS);
  }

  // confidence：记忆自身置信度（已由 DAL 约束在 [0,1]）。
  const confidence = clamp01(mem.confidence);

  // utility：状态（硬语义：verified>candidate）+ scope 权重；forgotten = 0。
  const statusU = STATUS_UTILITY[mem.status] ?? 0.5;
  const scopeU = SCOPE_UTILITY[mem.scope] ?? 0.7;
  const utility = clamp01(statusU * 0.75 + scopeU * 0.25);

  const factors = {
    relevance: +relevance.toFixed(6),
    recency: +recency.toFixed(6),
    confidence: +confidence.toFixed(6),
    utility: +utility.toFixed(6),
  };
  const score = +(
    w.relevance * relevance + w.recency * recency +
    w.confidence * confidence + w.utility * utility
  ).toFixed(6);
  return { score, factors };
}

/**
 * 批量排序 + 低分过滤 + gaps。
 * @param {Array} cands 候选（每条带 relevance 字段或可打分字段）
 * @param {object} opts { now, weights, threshold, top_k, query }
 * @returns {{ injected:Array, dropped:Array, gaps:string[], meta:object }}
 */
export function recallRank(cands = [], opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_THRESHOLD;
  const rawK = Number.isFinite(opts.top_k) ? opts.top_k : DEFAULT_TOP_K;
  const top_k = Math.max(3, Math.min(5, Math.trunc(rawK))); // 规格 3–5，禁止批量灌入

  const scored = cands
    .filter(m => m && m.status !== 'forgotten') // 硬门：遗忘项不可复活
    .map(m => ({ ...m, ...scoreMemory(m, { now, weights: opts.weights }) }));

  scored.sort((a, b) => b.score - a.score || String(a.memory_id).localeCompare(String(b.memory_id)));
  const injected = scored.filter(x => x.score >= threshold).slice(0, top_k);
  const dropped = scored.filter(x => x.score < threshold || !injected.some(i => i.memory_id === x.memory_id));

  const gaps = [];
  if (cands.length === 0) gaps.push('no_match');
  else if (injected.length === 0) gaps.push('all_below_threshold');
  if (injected.length > 0 && injected.length < Math.min(top_k, scored.length)) gaps.push('lower_relevance_dropped');

  return {
    injected: injected.map(x => ({ ...x, why: whyFor(x) })),
    dropped: dropped.map(x => ({ memory_id: x.memory_id, score: x.score })),
    gaps,
    meta: { candidates: cands.length, scored: scored.length, injected: injected.length, threshold, top_k },
  };
}

function whyFor(x) {
  const bits = [];
  if (x.factors.relevance >= 0.7) bits.push('高度相关');
  if (x.status === 'verified') bits.push('已核验');
  if (x.factors.recency >= 0.7) bits.push('近期');
  if (x.factors.confidence >= 0.8) bits.push('高置信');
  return bits.length ? bits.join(' · ') : `score=${x.score}`;
}
