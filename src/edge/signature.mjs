// Capability signature — the ontology projection of aec.loop/v2（评估报告 §4 L0）。
//
// 为什么是"派生"而不是"声明"：已发布字节不可改（catalog.importLoopPackage →
// immutable_version）。任何写进 loop.json 的槽位，改一次词表就得升一次版本，还要
// 过 A/D/B/C 四门、重算 digest、让缓存失效。签名只从作者已经写过的字段算出来，
// 契约一个字节不动，改 loop 图就跟着变。
//
// 契约：
//  S-1 纯函数：无时钟、无文件、无网络、无 LLM。同一份 loop 进，同一份对象出
//      （deep-equal；stableJson 的键序固定）。
//  S-2 七个槽，硬上限。值域封闭；多值槽用"排序后 + 连接"的字符串序列化，
//      这样 diff 是精确字符串比较，不需要集合运算。
//  S-3 P0 不进主分：签名只用于解释、并列时的 tie-break、judge 上下文。
//      召回地板 2.0 一动不动，直到 golden-intents 证明有增益。
//  S-4 未声明也要可见：other / none 是显式取值，不是"没有这个槽"
//      （与 views.mjs 的 V-3 同一套纪律）。

// --- 值域 -------------------------------------------------------------------
// 动词按优先级排序：先看命令证据（argv），再看标题/描述。命令是最硬的证据——
// douyin 包的标题写"提取"，但它的步骤就是 download.mjs，动词应当是 fetch。
const VERB_RULES = [
  ['deploy', /部署|上线|发布到|deploy/i],
  ['fetch', /下载|抓取|爬取|采集|拉取|保存到本地|download|fetch|scrape|crawl/i],
  ['extract', /提取|抽取|解析|识别|ocr|extract/i],
  ['convert', /转成|转换|转码|导出为|换算|convert|transcode|export/i],
  ['compose', /写成|写一份|写一个|撰写|起草|做成|生成|合并|compose|write|draft|generate/i],
  ['analyze', /分析|总结|归纳|统计|评估|审查|检查|analyze|summari[sz]e|review/i],
];

export const VERB_LABEL = {
  deploy: '部署', fetch: '取回', extract: '提取', convert: '转换',
  compose: '撰写/生成', analyze: '分析', other: '未声明',
};

// 交付物类别。config（json/yaml/toml）与 table（csv/xlsx）分开：一个包的交付物
// 是 loop.json 还是数据表，是两件完全不同的事。
const ART_EXT = [
  ['video', ['mp4', 'mov', 'mkv', 'webm', 'avi', 'flv', 'm4v']],
  ['audio', ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg']],
  ['image', ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'heic']],
  ['site', ['html', 'htm', 'css']],
  ['config', ['json', 'yaml', 'yml', 'toml', 'ini']],
  ['code', ['js', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'sh', 'c', 'cpp', 'rb', 'php']],
  ['doc', ['md', 'txt', 'rst', 'adoc', 'docx', 'pdf', 'pptx', 'key', 'pages']],
  ['table', ['csv', 'tsv', 'xlsx', 'xls', 'parquet', 'jsonl']],
  ['archive', ['zip', 'tar', 'gz', 'tgz', '7z', 'rar']],
];
// 并列时的次序：越靠前越"像交付物"。日志与临时文件永远不算交付物——
// 它们是证据（close 用），不是用户拿到手的东西。
const ART_ORDER = ['video', 'audio', 'image', 'site', 'config', 'code', 'doc', 'table', 'archive', 'other'];
const AUX_EXT = new Set(['log', 'tmp', 'lock', 'bak']);
const EXT_CLASS = new Map(ART_EXT.flatMap(([cls, exts]) => exts.map(e => [e, cls])));

export const ART_LABEL = {
  video: '视频', audio: '音频', image: '图片', site: '站点', config: '配置/契约',
  code: '代码', doc: '文档', table: '表格/数据', archive: '压缩包', none: '无产物', other: '其他',
};

export const ENV_LABEL = {
  local: '纯本机', remote: '远程主机', browser: '浏览器', api: '外部 API',
};

const SLOT_META = {
  verb: ['动作', '这个包主要做什么'],
  material: ['输入形态', '用户手上得先有什么'],
  artifact: ['交付物', '最后拿到什么（主匹配槽）'],
  shape: ['步骤形状', 'P=生成 R=跑命令，步骤类型序列'],
  env: ['运行环境', '在工作在哪发生（只列外部通道）'],
  capability: ['外部能力', '缺了就跑不动的票据与工具'],
  risk: ['失败面', '判据类型 + 已声明的错误分支'],
};

export const SIG_SLOTS = Object.keys(SLOT_META);
export const slotLabel = slot => SLOT_META[slot]?.[0] || slot;
export const slotQuestion = slot => SLOT_META[slot]?.[1] || '';

const has = v => v !== undefined && v !== null && String(v).trim() !== '';
const many = arr => (arr.length ? arr.join('+') : 'none');

// 扩展名：'{{out}}.mp4' / '{{out}}/brief.md' / 'a/b/c.tar.gz' 都要取对。
function extOf(p) {
  const tail = String(p ?? '').split(/[?#]/)[0].split('/').pop() || '';
  const m = tail.match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : '';
}

const argvTokens = step => (step?.run?.argv || []).map(x => String(x));

// 命令证据只看 argv：instruction 是给人读的过程描述，里面顺带提到「发布/部署」
// 是常态（元包的 ship 步就是"发布"），拿它判动作会把"造包"误判成"部署"。
// 动作应该由 title + when.description 回答（这个包主要做什么），argv 只在
// 命令本身就说明了动作时优先（douyin 标题写"提取"、命令是 download.mjs）。
function verbFromEvidence(steps) {
  const evidence = steps.flatMap(s => argvTokens(s)).join(' ');
  for (const [verb, re] of VERB_RULES) if (re.test(evidence)) return verb;
  return null;
}

function verbFromText(loop) {
  const text = `${loop?.title || ''} ${loop?.when?.description || ''}`;
  for (const [verb, re] of VERB_RULES) if (re.test(text)) return verb;
  return null;
}

// 输入形态。与 B-12 的"可满足性"判定同源：作者没写 kind、但名字/描述里带
// "链接/短链/网址"的，一样算 url 需求；漏判会让签名比真实需求更宽松。
function materialOf(loop) {
  const names = (loop?.when?.requires_inputs || []).length
    ? loop.when.requires_inputs
    : Object.keys(loop?.inputs || {});
  const out = new Set();
  for (const name of names) {
    const spec = loop?.inputs?.[name] || {};
    const text = `${spec.description || ''} ${name}`;
    if (spec.kind === 'url' || /链接|短链|网址|url/i.test(text)) out.add('url');
    else if (spec.kind === 'file' || /文件|路径|附件|file|path/i.test(text)) out.add('file');
    else out.add('text');
  }
  return many(['url', 'file', 'text'].filter(k => out.has(k)));
}

// 交付物：按"产出次数"计分，最后一步的产物权重 ×2（那才是交付物），日志类
// 扩展名直接排除。并列时按 ART_ORDER 取更像交付物的那类。
function artifactOf(steps) {
  const lastProducing = [...steps].reverse().find(s => (s.produces || []).length);
  const score = new Map();
  for (const s of steps) {
    for (const p of s.produces || []) {
      const ext = extOf(p);
      if (AUX_EXT.has(ext)) continue;
      const cls = EXT_CLASS.get(ext) || 'other';
      score.set(cls, (score.get(cls) || 0) + (s === lastProducing ? 2 : 1));
    }
  }
  if (!score.size) return 'none';
  let best = null;
  for (const cls of ART_ORDER) {
    if (!score.has(cls)) continue;
    if (!best || score.get(cls) > score.get(best)) best = cls;
  }
  return best || 'other';
}

// 环境只列"外部通道"：没有任何外部通道才是 local。这样 env 在包之间才有区分度
// ——否则每个包都是 local+xxx，这一槽等于噪音。
function envOf(loop, steps) {
  const evidence = [
    ...steps.flatMap(argvTokens),
    ...(loop?.tools || []).map(t => t.name || ''),
  ].join(' ');
  const out = [];
  if (/(^|[\s/])(ssh|scp|rsync|sshpass|kubectl)([\s/]|$)/i.test(evidence)) out.push('remote');
  if (/playwright|puppeteer|chromium|chrome|selenium|webdriver/i.test(evidence)) out.push('browser');
  for (const list of Object.values(loop?.resources?.stages || {})) {
    if ((list || []).some(r => r.kind === 'api')) { out.push('api'); break; }
  }
  return many(out.length ? out : ['local']);
}

// 能力 = 缺了这一步就跑不动的东西：内核签发的票据 + 必需的工具。
function capabilityOf(loop) {
  const out = new Set();
  for (const list of Object.values(loop?.resources?.stages || {})) {
    for (const r of list || []) {
      if (r.kind !== 'api') continue;
      out.add(`ticket:${String(r.ref || '').split('/').pop() || 'unknown'}`);
    }
  }
  for (const t of loop?.tools || []) {
    if (t.required === false) continue;
    if (has(t.name)) out.add(`tool:${t.name}`);
  }
  return many([...out].sort());
}

// 失败面 = 判据类型 + on_error 的触发条件。它就是失败卡的索引键（L1 用）。
function riskOf(loop) {
  const out = new Set();
  for (const c of loop?.checks || []) if (has(c.type)) out.add(String(c.type));
  for (const e of loop?.resources?.on_error || []) if (has(e.when)) out.add(`err:${e.when}`);
  return many([...out].sort());
}

// --- 派生 -------------------------------------------------------------------
export function deriveSignature(loop) {
  const steps = loop?.steps || [];
  return {
    v: 'aec.sig/1',
    verb: verbFromEvidence(steps) || verbFromText(loop) || 'other',
    material: materialOf(loop),
    artifact: artifactOf(steps),
    shape: steps.length ? steps.map(s => (s?.kind === 'run' ? 'R' : 'P')).join('') : 'none',
    env: envOf(loop, steps),
    capability: capabilityOf(loop),
    risk: riskOf(loop),
  };
}

// 固定键序，供缓存 key / digest 使用。
export function stableJson(sig) {
  return JSON.stringify(SIG_SLOTS.reduce((acc, k) => ({ ...acc, [k]: sig?.[k] ?? 'none' }), {}));
}

// --- 渲染 -------------------------------------------------------------------
const pretty = (slot, value) => {
  if (slot === 'verb') return `${value}（${VERB_LABEL[value] || value}）`;
  if (slot === 'artifact') return `${value}（${ART_LABEL[value] || value}）`;
  if (slot === 'env') return String(value).split('+').map(v => ENV_LABEL[v] || v).join('+');
  if (slot === 'material') return String(value).split('+').join('+');
  return value;
};

// 一行签名：open 回执与 no_match 用。模型只读文本，所以这里必须是中文可读的。
export function signatureLine(sig) {
  if (!sig) return '（未计算签名）';
  return SIG_SLOTS.map(slot => `${slotLabel(slot)} ${pretty(slot, sig[slot] ?? 'none')}`).join('｜');
}

// 差异槽：只返回真的不一样的槽，附一句人话，供"改造要动哪里"直接引用。
const DIFF_NOTE = {
  verb: (a, b) => `动作不同：${VERB_LABEL[a] || a} vs ${VERB_LABEL[b] || b}`,
  material: (a, b) => `要的输入不同：${a} vs ${b}（用户的材料可能只满足一边）`,
  artifact: (a, b) => `交付物不同：${ART_LABEL[a] || a} vs ${ART_LABEL[b] || b}`,
  shape: (a, b) => `步骤形状不同：${a} vs ${b}（结构相似度低，改造量更大）`,
  env: (a, b) => `运行环境不同：${pretty('env', a)} vs ${pretty('env', b)}`,
  capability: (a, b) => `外部能力不同：${a} vs ${b}（缺票据/工具的那一步跑不动）`,
  risk: (a, b) => `失败面不同：${a} vs ${b}（判据与错误分支不能直接复用）`,
};

export function signatureDiff(a, b) {
  if (!a || !b) return [];
  return SIG_SLOTS
    .filter(slot => (a[slot] ?? 'none') !== (b[slot] ?? 'none'))
    .map(slot => ({
      slot, label: slotLabel(slot),
      a: a[slot] ?? 'none', b: b[slot] ?? 'none',
      note: DIFF_NOTE[slot](a[slot] ?? 'none', b[slot] ?? 'none'),
    }));
}

// 对比表：learn 的"候选签名对比 + 差异槽"。列 = 候选，行 = 槽位。
// 少于 2 个候选时返回空串（没得对比，不要硬造一张表）。
export function signatureTable(entries) {
  const list = (entries || []).filter(e => e?.sig);
  if (list.length < 2) return '';
  const head = ['| 槽位 |', ...list.map(e => ` ${e.ref} |`), ' 差异 |'].join(' ');
  const sep = ['|---|', ...list.map(() => '---|'), '---|'].join('');
  const rows = SIG_SLOTS.map(slot => {
    const values = list.map(e => e.sig[slot] ?? 'none');
    const differ = new Set(values).size > 1;
    return `| ${slotLabel(slot)} | ${values.map(v => pretty(slot, v)).join(' | ')} | ${differ ? '不同' : '一致'} |`;
  });
  return [head, sep, ...rows].join('\n');
}
