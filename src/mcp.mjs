// aec-mcp — open-source stdio MCP client for AEC kernels.
// Pure remote client: no kernel code, no local DB of packages. Business ops go
// through the hardened HTTP transport; only identity + edge file layout lives here.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join, basename, resolve, sep, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { z } from 'zod';
import { hostPolicyFromEnv, detectPolicyViolation } from './edge/l0.mjs';
import { resolveWorkspace, sweepSessions, materializeOpen, collectCloseEvidence, edgeCleanup } from './edge/session.mjs';
import { renderClose, renderTurn, renderNoMatch } from './edge/render.mjs';
import { publicError, requireThat, warn } from './edge/util.mjs';
import { withFallbackNotice, LIVE_SCHEMA, SESSION_ID_RE } from './edge/materialize.mjs';
import { createRemoteKernel, inlineExtractionFile, validateEndpoint, probeEndpoint, resolveEndpoint, DEFAULT_KERNEL_URL, verifyApiKey } from './transport.mjs';
import { resolveRolesDbPath } from './db/roles.mjs';
import { RolesDB } from './db/roles.mjs';
import { defaultIdentityDir, credentialsPath, loadCredentials, saveCredentials, detectLegacyIdentity } from './identity.mjs';
// AEC 5.1 O1-03：透明连续性 sidecar（flag-gated，默认 off 字节等价）
import { ContinuityCache, runContinuitySidecar } from './continuity.mjs';
import { renderGuidance } from './guidance-render.mjs';
import { renderKnowledge } from './knowledge-render.mjs';
import { renderComposition } from './composition-render.mjs';
import { createSubjectResolver } from './subject.mjs';
// 5.2.0 O2-01：内置本地记忆域（单入口完整能力）；store 懒加载见 createMcpV2 尾部
import { createLocalHandlers, validateLocalOp } from './mks/local-handlers.mjs';
import { mcpContinuityEnabled, mcpGuidanceEnabled, mcpKnowledgeEnabled, localMemoryMode } from './mks/flags.mjs';

// 模块级惰性状态：仅在 continuity 生效时创建；进程级缓存，不落盘。
let _continuityCache = null;
let _subjectResolver = null;
const continuityActive = (env = process.env) => mcpContinuityEnabled(env) && localMemoryMode(env) === 'node';
const continuityCache = () => (_continuityCache ??= new ContinuityCache());
const subjectResolver = (endpoint) => (_subjectResolver ??= createSubjectResolver({
  verify: async (apiKey) => verifyApiKey({ endpoint, api_key: apiKey }),
}));

const readJson = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// session → workspace 指针（机器级，§10.1 身份旁）：close/turn 只有 {op,session}，
// 不带 workspace（§8.1）。进程换 cwd / 重启后用这份索引兜底找回现场目录。
// v2 条目 = { v:2, workspace, session_dir, trial_of }；v1 是纯字符串（工作区根
// 或完整会话目录），locateSession 兼容读取。Windows 反斜杠路径不再用字符串切分。
const SESSION_INDEX = () => join(defaultIdentityDir(), 'sessions-index.json');
const indexGet = session => readJson(SESSION_INDEX())?.[session] ?? null;
const normSlashes = p => String(p ?? '').replaceAll('\\', '/');
const sessionMarker = session => `/.aec/sessions/${session}`;
export const maskHomePath = (p) => {
  const s = String(p ?? '');
  if (!s) return s;
  const n = normSlashes(s), h = normSlashes(homedir());
  const eq = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (eq(n, h)) return '~';
  if (n.length > h.length && n[h.length] === '/' && eq(n.slice(0, h.length), h)) return `~${n.slice(h.length)}`;
  return s;
};
export function indexPut(session, entry) {
  try {
    const p = SESSION_INDEX();
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const doc = readJson(p) || {};
    doc[session] = entry;                       // 读改写：不丢其它会话键
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    renameSync(tmp, p);                          // 原子替换：半截 JSON 不再可见
  } catch (e) {
    warn(`会话指针写入失败（sessions-index.json）：${e.message} —— 任务继续，进程重启后现场找回将退化为 cwd 推断。`);
  }
}
// 零副作用现场定位：按优先级只读探测 loop.json，绝不调用会 mkdir 的 resolveWorkspace。
// 命中后从 sessionDir 反推 aecDir / ledgerPath，不再依赖字符串切分推导工作区根。
export function locateSession(args, { env = process.env, cwd = process.cwd() } = {}) {
  const session = args?.session;
  const idx = indexGet(session);
  const tried = [], candidates = [], archives = [], seen = new Set();
  const trySessionDir = (label, dir) => {
    if (typeof dir !== 'string' || !dir) return;
    const sd = resolve(dir), key = `s:${normSlashes(sd).toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const loopPath = join(sd, 'loop.json');
    tried.push(`${label} → ${maskHomePath(loopPath)}`);
    if (basename(sd) !== session || !existsSync(loopPath)) return;
    candidates.push({ label, sessionDir: sd });
    const marker = sessionMarker(session);
    if (normSlashes(sd).toLowerCase().endsWith(marker.toLowerCase()))
      archives.push(resolve(normSlashes(sd).slice(0, -marker.length), '.aec', 'archive', session));
  };
  const tryWorkspace = (label, root) => {
    if (typeof root !== 'string' || !root) return;
    const r = resolve(root), key = `w:${normSlashes(r).toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const sd = join(r, '.aec', 'sessions', session), loopPath = join(sd, 'loop.json');
    tried.push(`${label} → ${maskHomePath(loopPath)}`);
    if (existsSync(loopPath)) candidates.push({ label, sessionDir: sd });
    archives.push(join(r, '.aec', 'archive', session));
  };
  // ① 新索引的精确会话目录；② 新索引的工作区根
  if (idx && typeof idx === 'object') {
    trySessionDir('索引.session_dir', idx.session_dir);
    tryWorkspace('索引.workspace', idx.workspace);
  } else if (typeof idx === 'string' && idx) {
    // ③ 旧字符串值：反斜杠规范化后按 /.aec/ 切根，或从尾部剥掉 .aec/sessions/<id>
    const raw = normSlashes(idx), marker = sessionMarker(session);
    if (raw.toLowerCase().endsWith(marker.toLowerCase())) {
      trySessionDir('索引旧值(会话目录)', raw);
      tryWorkspace('索引旧值(剥掉会话段)', raw.slice(0, -marker.length));
    } else {
      const cut = raw.split('/.aec/')[0];
      if (cut !== raw) tryWorkspace('索引旧值(按 /.aec/ 切根)', cut);
      trySessionDir('索引旧值(原值)', raw);
      tryWorkspace('索引旧值(按工作区根)', raw);
    }
  }
  // ④ args.workspace：索引标记为试用时忽略（与 open「试用一律沙箱」对称）
  const trial = !!(idx && typeof idx === 'object' && idx.trial_of)
    || (typeof idx === 'string' && normSlashes(idx).toLowerCase().includes('/.aec-trials/'));
  if (args?.workspace && !trial) tryWorkspace('args.workspace', args.workspace);
  // ⑤ 试用根扫描；⑥ cwd / git root
  const trialRoot = env.AEC_TRIAL_ROOT || join(homedir(), '.aec-trials');
  let dirs = [];
  try { dirs = readdirSync(trialRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { /* 根不存在：跳过 */ }
  for (const name of dirs) tryWorkspace(`试用根扫描(${name})`, join(trialRoot, name));
  tryWorkspace('cwd', cwd);
  let dir = cwd;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, '.git'))) { tryWorkspace('git root', dir); break; }
    dir = dirname(dir);
  }
  if (candidates.length) {
    const { label, sessionDir } = candidates[0];
    const sessionsDir = dirname(sessionDir), aecDir = dirname(sessionsDir);
    return { ok: true, label, sessionDir, sessionsDir, aecDir, ledgerPath: join(aecDir, 'ledger.jsonl'), tried };
  }
  return { ok: false, archived: archives.find(p => existsSync(p)) ?? null, tried,
    index_value: idx == null ? '(无索引条目)' : (typeof idx === 'string' ? maskHomePath(idx)
      : JSON.stringify(idx, (_k, v) => typeof v === 'string' ? maskHomePath(v) : v)) };
}
export function sessionSceneNotFound(args, loc) {
  const lines = [
    `[AEC] 会话 ${args.session} 的现场不存在：按下列顺序只读探测，均未找到 loop.json（探测没有创建任何目录）。`,
    ...loc.tried.map(t => `  · ${t}`),
    `  索引原值：${loc.index_value}`,
  ];
  if (loc.archived) lines.push(`  该会话已 close 并归档：${maskHomePath(loc.archived)}（本次 close 已归档，未删除）。`);
  else lines.push('  未发现归档目录：现场未找到，如实告诉用户；可重新 open。');
  return { isError: true, content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: { code: 'session_scene_not_found', session: args.session, tried: loc.tried, index_value: loc.index_value, archived: loc.archived ? maskHomePath(loc.archived) : null } };
}
// close 成功后把索引条目标记 closed：重复 close 会命中 archive 检查并明确报「已归档」。
export function markSessionClosed(session, sessionDir) {
  const marker = sessionMarker(session), norm = normSlashes(sessionDir);
  const workspace = norm.toLowerCase().endsWith(marker.toLowerCase()) ? resolve(norm.slice(0, -marker.length)) : dirname(dirname(dirname(sessionDir)));
  const prev = indexGet(session);
  indexPut(session, { v: 2, workspace, session_dir: sessionDir, trial_of: (prev && typeof prev === 'object' && prev.trial_of) || null, closed: true, closed_at: new Date().toISOString() });
}


// The edge half of the aec/v2 tool. `kernel` is anything with .call(name, args).
// 密钥模式（2026-11-19）：身份由传输层的 Bearer api_key 承载（内核从身份强制注入
// host_id/tenant），边端不再传 host_id，也不再持有 identity 回调。
// AEC 5.2（ADR §5.3）：第二参 ontologyCtx 由 createMcpV2 注入 —— { env, getStore }，
// getStore 返回 HostMksStore（lite/关闭时 null）。它是 op=ontology 宿主写入的唯一通道。
export function aecEdgeHandlers(kernel, ontologyCtx = null) {
  return {
    async open(args) {
      // 试用沙箱（2026-11-09 根因③）：试用是"验证循环能不能跑通"，不是"替用户
      // 把东西做出来"。带 trial_of 的 open 若没显式给 workspace，一律落到独立
      // 沙箱，绝不写进用户项目目录——从物理上把"测试"和"实施"分开。
      // AEC_TRIAL_ROOT 供测试/运维改位置。
      const trialRoot = args.trial_of
        ? join(process.env.AEC_TRIAL_ROOT || join(homedir(), '.aec-trials'), args.trial_of)
        : null;
      // 试用一律沙箱：显式 workspace 也不能把"验证"变成"写用户项目"。
      const wsArg = trialRoot ?? args.workspace;
      const ws = resolveWorkspace(wsArg);
      const sweep = sweepSessions({ sessionsDir: ws.sessionsDir, ledgerPath: join(ws.aecDir, 'ledger.jsonl') });
      // "id@version" 形式的 ref 归一化成内核要的对象；对象原样透传。
      const refArg = typeof args.experience_ref === 'string'
        ? (() => { const [id, version] = args.experience_ref.split('@'); return id && version ? { id, version } : args.experience_ref; })()
        : args.experience_ref;
      // P0-2（F2）：query 原样透传给内核（g067）；不传时不出现该键，远端 JSON 语义不变。
      // ---- AEC 5.1 O1-03 透明连续性 sidecar（仅 continuity+node 生效；默认字节等价）----
      // 关键路径：kernel open 与增量 recall 并发；sidecar 只读 continuity cache。
      const cActive = continuityActive();
      let cSubject = null, cIncremental = null;
      if (cActive) {
        try {
          const cred = kernel.credential?.();
          if (cred?.source === 'env') cSubject = await subjectResolver(kernel.endpoint).fromEnvKey(cred.api_key);
          else {
            const seg = loadCredentials(credentialsPath())?.[cred?.profile || 'run'];
            cSubject = subjectResolver(kernel.endpoint).fromCredential(seg?.subject);
          }
          if (cSubject) {
            cIncremental = (async () => {
              try {
                const { HostMksStore, resolveHostMksPath } = await import('./mks/store.mjs');
                const { existsSync: ex } = await import('node:fs');
                const dbPath = resolveHostMksPath();
                if (!ex(dbPath)) return [];
                const store = new HostMksStore({ path: dbPath, env: process.env });
                const r = store.recallScoped({ query: args.intent, user_id: cSubject,
                  tenant_id: null, thread_id: args.conversation_id || null, opts: { top_k: 5 } });
                store.close();
                return r.items || [];
              } catch { return []; }
            })();
          }
        } catch { cSubject = null; }
      }
      // kernelP 与 sidecar 并发；sidecar 内部以 kernelP 的完成时刻判定增量早到/晚到。
      const kernelP = kernel.call('aec', { op: 'open', intent: args.intent, experience_ref: refArg, trial_of: args.trial_of, ...(args.query ? { query: args.query } : {}), ...(args.conversation_id ? { conversation_id: args.conversation_id } : {}) });
      let continuityResult = null;
      let payload;
      if (cActive) {
        const sidecarP = runContinuitySidecar({
          enabled: true, subject: cSubject, cache: continuityCache(),
          scope: { tenant: 'default', user_id: cSubject, thread_id: args.conversation_id || null },
          query: args.intent, incrementalRecall: cIncremental, kernelOpen: kernelP, timeoutMs: 150,
          now: () => performance.now(),
        }).catch(() => null);
        [payload, continuityResult] = await Promise.all([kernelP, sidecarP]);
      } else {
        payload = await kernelP;
      }
      // G2 补漏：创作类意图由内核改道，不建会话、不匹配包。
      if (payload.code === 'authoring_redirect') {
        return { content: [{ type: 'text', text: payload.message }], structuredContent: payload };
      }
      if (payload.code !== 'match') {
        const { markdown, structuredContent } = renderNoMatch({
          code: payload.code,
          message: payload.code === 'no_match' ? '没有找到对应经验包。' : payload.code === 'ambiguous_match' ? '有多个包都可能匹配，需要用户选。' : `缺少材料：${(payload.match?.missing || payload.missing || []).join(', ')}`,
          closest: payload.match?.closest || payload.closest || [],
          candidates: payload.match?.candidates || payload.candidates || [],
          advice: payload.code === 'no_match' ? '这件事你可以直接用本地工具做，AEC 没有这方面的经验。' : payload.code === 'ambiguous_match' ? '把候选编号念给用户选，不要自己挑；用户没有进行中的会话，无需 close。' : '向用户要材料，不要猜。',
        });
        return { content: [{ type: 'text', text: markdown }], structuredContent };
      }
      const mat = materializeOpen({ payload, workspace: wsArg });
      // 直接写已解析的工作区根与会话目录（不再切字符串：Windows 反斜杠会切断命中失败）。
      indexPut(payload.session, { v: 2, workspace: ws.root, session_dir: mat.sessionDir, trial_of: args.trial_of ?? null });
      if (sweep.orphan) {
        mat.markdown = `[AEC] 上次有个未完成的会话（${sweep.orphan.age}，${sweep.orphan.steps} 步）——\n      如果用户这次讲的是同一件事，先说一句"上次没跑完，要不要接着做"；否则忽略这句。\n\n${mat.markdown}`;
        mat.structuredContent.orphan = { session: sweep.orphan.session, age: sweep.orphan.age };
      }
      // 阶段横幅放在最前面：模型每次回执都被重述"这轮是验证，不是交付"。
      if (trialRoot) {
        mat.markdown = `【试用 · 阶段 4/5 · 不是交付】产物写入沙箱 ${ws.root}（不在用户项目里，验证完即弃）。${args.workspace ? `\n      · 你给的 workspace=${args.workspace} 已被忽略：试用不允许写真实项目目录。` : ''}\n      · 这轮只证明循环能跑通；不要把它当成为用户实施，也不要改用户真实目录。\n      · 跑完 close 拿 grade；authoritative 才能回 author 侧 publish。\n\n${mat.markdown}`;
        mat.structuredContent.trial = { of: args.trial_of, sandbox: ws.root, delivery: false, ...(args.workspace ? { ignored_workspace: args.workspace } : {}) };
      }
      // 5.1 O1-03：透明连续性注入（独立区块 + structuredContent，数据不是指令）。
      // continuity off / no_identity 时 continuityResult 为 null 或 markdown 为空 → 输出逐字节不变。
      if (continuityResult?.markdown) {
        mat.markdown = `${mat.markdown}\n\n${continuityResult.markdown}`;
      }
      if (continuityResult) {
        mat.structuredContent.continuity = continuityResult.structured;
      }
      // AEC 5.1 O2-03：管理员带教独立区块（AEC_MCP_GUIDANCE=1 才渲染；默认字节等价）。
      // guidance 由 kernel 可选返回；注入模式由 renderGuidance 过滤，不改判据。
      // AEC 5.1 O3-16：组合建议独立区块（kernel 可选返回才有；默认字节等价）。
      if (payload.composition_proposal) {
        const cp = renderComposition(payload.composition_proposal);
        if (cp) {
          mat.markdown = `${mat.markdown}

${cp.markdown}`;
          mat.structuredContent.composition = cp.structured;
        }
      }
      if (mcpGuidanceEnabled() && payload.guidance) {
        const gr = renderGuidance(payload.guidance);
        if (gr) {
          mat.markdown = `${mat.markdown}\n\n${gr.markdown}`;
          mat.structuredContent.guidance = gr.structured;
        }
      }
      // AEC 5.1 O3-04：知识投递独立区块（kernel 可选返回 knowledge；host flag off/无命中字节等价）。
      if (mcpKnowledgeEnabled() && payload.knowledge) {
        const kr = renderKnowledge(payload.knowledge);
        if (kr) {
          mat.markdown = `${mat.markdown}\n\n${kr.markdown}`;
          mat.structuredContent.knowledge = kr.structured;
        }
      }
      // AEC 5.2（ADR §6.4）：BO 摘要的宿主侧合并——binding 状态（bound/unknown/stale）
      // 只有 Host MKS 知道。payload 无 business_ontology（旧包）时整段跳过，字节等价。
      if (payload.business_ontology) {
        const merged = await mergeHostOntologyState(payload.business_ontology, { env: process.env, getStore: ontologyCtx?.getStore ?? null });
        if (merged) {
          mat.structuredContent.business_ontology = merged;
          mat.markdown = `${mat.markdown}\n\n${renderBoBlock(merged)}`;
        }
      }
      return { content: [{ type: 'text', text: mat.markdown }], structuredContent: mat.structuredContent };
    },
    async close(args) {
      if (!args.session) return { isError: true, content: [{ type: 'text', text: '[AEC] 没有进行中的会话：直接重新 open 即可（open 没建会话的场景——no_match/ambiguous——无需 close）。' }] };
      const loc = locateSession(args);
      if (!loc.ok) return sessionSceneNotFound(args, loc);
      const { sessionDir, aecDir } = loc;
      const loop = readJson(join(sessionDir, 'loop.json'));
      if (!loop) return sessionSceneNotFound(args, loc); // 探测与读取之间的并发移走
      const evidence = collectCloseEvidence({ sessionDir, loop });
      // AEC 5.2（ADR §6.5）：op=ontology 期间的会话本体缓冲 → close 交给内核算
      // mismatch/delta candidate（buildCloseOntology 只读它；宿主库写入只有 observe/bind 路径）。
      const ontologyBuf = readOntologyBuffer(sessionDir);
      if (ontologyBuf) evidence.ontology = { mismatches: ontologyBuf.mismatches ?? [], facts: ontologyBuf.facts ?? [] };
      // W25（§16.4 L0 运行期）：report 里出现命中宿主策略 denied_argv0 的步骤 →
      // host_policy_violated=true → 内核 grade 走 A2 abandoned（安全优先于兼容）。
      const l0Violation = detectPolicyViolation(evidence.report, hostPolicyFromEnv());
      if (l0Violation) evidence.host_policy_violated = true;
      const result = await kernel.call('aec', { op: 'close', session: args.session, status: args.status, evidence, ...(args.acceptance !== undefined ? { acceptance: args.acceptance } : {}) });
      const cleanup = result.cleanup?.removed === null
        ? { removed: null }
        : edgeCleanup({ sessionDir, ledgerPath: join(aecDir, 'ledger.jsonl'), result: { ...result, ...readJson(join(sessionDir, 'state.json')) } });
      if (cleanup?.archived) markSessionClosed(args.session, sessionDir);
      const { markdown, structuredContent } = renderClose({
        session: args.session, grade: result.grade, checks: result.checks || [], artifacts: result.artifacts || [], cleanup, reason: result.reason,
        // W16/W18/W23：交付三字段 + 判定原因/上限 + revision（内核 close 输出透传）
        delivery: {
          session_conclusion: result.session_conclusion ?? null,
          delivery_status: result.delivery_status ?? null,
          plan_coverage: result.plan_coverage ?? null,
          grade_reasons: result.grade_reasons ?? null,
          grade_caps: result.grade_caps ?? null,
          grade_revision: result.grade_revision ?? null,
          acceptance_summary: result.acceptance_summary ?? null,
          trust: result.trust ?? null,
        },
      });
      // AEC 5.2 P3-4/P4-1（ADR §6.5）：close 回执的 BO mismatch/delta candidate——
      // 内核只算 candidate，本边端把它写进 Host MKS（host_delta，status=candidate 等人工 promote），
      // 并按 binding 状态合并宿主侧状态。旧包/旧会话无 business_ontology 时整段跳过，字节等价。
      let closeBo = null;
      if (result.business_ontology) {
        closeBo = await mergeHostOntologyState(result.business_ontology, { env: process.env, getStore: ontologyCtx?.getStore ?? null });
        if (Array.isArray(closeBo?.delta_candidate?.patch) && closeBo.delta_candidate.patch.length) {
          const store = ontologyCtx ? await (ontologyCtx.getStore?.() ?? null) : null;
          if (store) {
            try {
              const d = closeBo.delta_candidate;
              store.putHostDelta({ bo_id: closeBo.bo_id, base_digest: d.base_digest, patch: d.patch, source: d.source ?? 'run', status: d.status ?? 'candidate' });
              closeBo.host_delta_written = true;
            } catch (e) { warn(`[AEC] close host_delta 写入失败（candidate 仍随回执返回）：${e.message}`); }
          }
        }
      }
      return { content: [{ type: 'text', text: closeBo ? `${markdown}\n\n${renderBoBlock(closeBo)}` : markdown }], structuredContent: { ...structuredContent, ...(closeBo ? { business_ontology: closeBo } : {}), package_id: readJson(join(sessionDir, 'state.json'))?.package_id ?? null } };
    },
    async turn(args) {
      if (!args.session) return { isError: true, content: [{ type: 'text', text: '[AEC] 缺少会话 id：回执里的"会话 ses_…"就是它，不要自己编。没有会话就先 open。' }] };
      const loc = locateSession(args);
      if (!loc.ok) return sessionSceneNotFound(args, loc);
      const { sessionDir } = loc;
      const loop = readJson(join(sessionDir, 'loop.json'));
      if (!loop) return sessionSceneNotFound(args, loc);
      const evidence = collectCloseEvidence({ sessionDir, loop });
      // W17：goal_op / assumption_op —— 边端读 goal.json 传入，内核纯函数修订后
      // 原子写回（临时文件 + rename；§21.4"要么旧值要么新值"）。
      // R1-3/R1-5（§4.6/§20）：计划修订 —— turn(target="plan", payload={op,...})。
      // 边端读 plan.json/goal.json 传入内核，纯函数修订后原子写回 plan.json；
      // PlanRevision 追加式保留，内核另记 interaction_type=replan 交互记录。
      if (args.target === 'plan' && args.payload?.op) {
        const plan = readJson(join(sessionDir, 'plan.json'));
        const goalFrame = readJson(join(sessionDir, 'goal.json'));
        if (!plan || !goalFrame) return { isError: true, content: [{ type: 'text', text: '[AEC] 会话目录缺 plan.json/goal.json：重新 open 生成计划视图后再做拓扑修订。' }] };
        let result;
        try {
          result = await kernel.call('aec', { op: 'turn', session: args.session, target: 'plan', payload: args.payload, evidence: { plan, goal_frame: goalFrame } });
        } catch (e) {
          const issues = (e.issues || []).map(i => `  · ${i.code}: ${i.message}`).join('\n');
          return { isError: true, content: [{ type: 'text', text: `[AEC] 计划修订被拒（${e.code ?? 'unknown'}）：${e.message}${issues ? `\n${issues}` : ''}` }], structuredContent: { code: e.code ?? 'plan_op_failed', issues: e.issues ?? null } };
        }
        const tmp = join(sessionDir, `plan.json.tmp-${Date.now()}`);
        writeFileSync(tmp, JSON.stringify(result.plan, null, 2), { mode: 0o600 });
        renameSync(tmp, join(sessionDir, 'plan.json'));
        const { markdown, structuredContent } = renderTurn({
          session: args.session, step: { id: null, step_no: 0, step_total: (loop.steps || []).length },
          report: {}, judgement: result.judgement,
          hint: '计划修订已落盘（plan revision 见 structuredContent.plan_revision；revisions[] 追加式保留）。' + (result.unconfirmed_scope_change ? '注意：本次修订造成覆盖缺口且未经用户确认（unconfirmed_scope_change）——close 会如实报 partial，不降级。' : '覆盖保持，不影响等级。'),
          command: null, pending: null, ask: args.ask || null,
        });
        return { content: [{ type: 'text', text: markdown }], structuredContent: { ...structuredContent, plan_revision: result.plan_revision, lost_coverage: result.lost_coverage, unconfirmed_scope_change: result.unconfirmed_scope_change, plan_issues: result.plan_issues, plan: result.plan } };
      }
      if (args.goal_op || args.assumption_op) {
        const goalFrame = readJson(join(sessionDir, 'goal.json'));
        if (!goalFrame) return { isError: true, content: [{ type: 'text', text: '[AEC] 会话目录没有 goal.json：重新 open 生成目标视图后再做结构化修订。' }] };
        let result;
        try {
          // goal_op/assumption_op 走内核 turn 的顶层 goal_frame 入参（§13.2）；
          // 不能塞进 evidence —— 那是 target='plan' 拓扑修订分支才读的位置。
          result = await kernel.call('aec', { op: 'turn', session: args.session, goal_op: args.goal_op ?? undefined, assumption_op: args.assumption_op ?? undefined, target: args.target, payload: args.payload, goal_frame: goalFrame });
        } catch (e) {
          return { isError: true, content: [{ type: 'text', text: `[AEC] 目标修订被拒（${e.code ?? 'unknown'}）：${e.message}` }] };
        }
        const tmp = join(sessionDir, `goal.json.tmp-${Date.now()}`);
        writeFileSync(tmp, JSON.stringify(result.goal_frame, null, 2), { mode: 0o600 });
        renameSync(tmp, join(sessionDir, 'goal.json'));
        const { markdown, structuredContent } = renderTurn({
          session: args.session, step: { id: null, step_no: 0, step_total: (loop.steps || []).length },
          report: {}, judgement: result.judgement, hint: '目标修订已落盘（goal revision 见 structuredContent.goal_revision）；intent_raw 永不覆盖。',
          command: null, pending: null, ask: args.ask || null,
        });
        return { content: [{ type: 'text', text: markdown }], structuredContent: { ...structuredContent, goal_revision: result.goal_revision, goal_frame: result.goal_frame, intent_raw_preserved: result.intent_raw_preserved } };
      }
      const result = await kernel.call('aec', { op: 'turn', session: args.session, note: args.note, ask: args.ask, answer: args.answer, evidence });
      const steps = loop.steps || [];
      const step = result.step || {};
      const failed = (evidence.report?.steps || []).reverse().find(s => !s.ok);
      const { markdown, structuredContent } = renderTurn({
        session: args.session,
        step: { id: step.id, step_no: step.step_no || 0, step_total: steps.length },
        report: { exit: failed?.exit, ms: failed?.ms, stderr_tail: failed?.stderr_tail, stdout_tail: failed?.stdout_tail },
        judgement: result.judgement, hint: result.hint,
        command: step.id ? { argv: [process.execPath, join(sessionDir, 'run', `${step.id}.mjs`)] } : null,
        pending: step.id && existsSync(join(sessionDir, 'run', `${step.id}.wait.mjs`))
          ? { argv: [process.execPath, join(sessionDir, 'run', `${step.id}.wait.mjs`)] } : null,
        ask: args.ask || null,
      });
      return { content: [{ type: 'text', text: markdown }], structuredContent };
    },
    async resource(args) {
      if (!args.session) return { isError: true, content: [{ type: 'text', text: '[AEC] 缺少会话 id：回执里的"会话 ses_…"就是它，不要自己编。' }] };
      const loc = locateSession(args);
      if (!loc.ok) return sessionSceneNotFound(args, loc);
      const { sessionDir } = loc;
      const result = await kernel.call('aec', { op: 'resource', session: args.session, stage: args.stage, trigger: args.trigger, want: args.want });
      // Materialize delivered files the same way open does (§7.5 path rules).
      const tickets = new Map();
      for (const api of result.api || []) {
        const file = `tickets/${String(api.ref).replaceAll('/', '-')}.ticket`;
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(join(sessionDir, 'resources', 'tickets'), { recursive: true });
        writeFileSync(join(sessionDir, 'resources', file), api.ticket, { mode: 0o600 });
        tickets.set(api.ref, file);
      }
      for (const f of result.files || []) {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const dir = f.stage ? join(sessionDir, 'resources', f.stage) : join(sessionDir, 'resources', 'on-demand');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, f.to), Buffer.from(f.content_base64, 'base64'), { mode: 0o600 });
      }
      const list = (result.files || []).map(f => ({ path: f.stage ? `${f.stage}/${f.to}` : `on-demand/${f.to}`, digest: f.digest, size: f.size }));
      const apiList = (result.api || []).map(a => ({ ref: a.ref, ticket_file: tickets.get(a.ref), expires_at: a.expires_at }));
      // a007（R5-5）：文本出口与 structuredContent 同源——session、文件清单、票据引用
      // 都要出现在模型能读到的正文里，不能只在结构化出口里"悄悄"多几个字段。
      const markdown = [ `[AEC] 会话 ${args.session} 材料已投递：`,
        ...list.map(f => `- ${f.path}`),
        ...(list.length ? [] : ['- （本档没有额外文件；票据如有更新已覆盖）']),
        ...apiList.map(a => `- 票据 ${a.ref} → ${a.ticket_file}${a.expires_at ? `（有效至 ${a.expires_at}）` : ''}`),
      ].join('\n');
      return { content: [{ type: 'text', text: markdown }], structuredContent: { v: 'aec/v2', session: args.session, files: list, api: apiList } };
    },
    // AEC 5.2（ADR §5.3）：op=ontology —— 内核只分类（BO 解析/事实分类/绑定校验），
    // 本边端执行 host_writes（host_fact/host_binding/host_delta/host_observation，
    // Host MKS 是唯一持有者）。observe/bind 同时缓冲到会话 ontology.json，
    // close 时作为 evidence.ontology 交给内核算 mismatch/delta。
    async ontology(args) {
      const action = args.action ?? 'get';
      if (!args.session) return { isError: true, content: [{ type: 'text', text: '[AEC] 缺少会话 id：先 open，回执里的"会话 ses_…"就是它。' }] };
      const loc = locateSession(args);
      if (!loc.ok) return sessionSceneNotFound(args, loc);
      const { sessionDir } = loc;
      const result = await kernel.call('aec', {
        op: 'ontology', action, session: args.session,
        ...(action === 'get' ? { sections: args.sections ?? null } : {}),
        ...(action === 'observe' ? { facts: args.facts ?? [] } : {}),
        ...(action === 'bind' ? { slot: args.slot, value_ref: args.value_ref, source: args.source ?? null } : {}),
      });
      const bo = result.bo ?? {};
      const store = ontologyCtx ? await (ontologyCtx.getStore?.() ?? null) : null;
      const hostApplied = { facts: 0, observations: 0, deltas: 0, bindings: 0 };
      let hostState = null;
      if (store) {
        try {
          for (const f of result.host_writes?.facts ?? []) {
            store.putHostFact({ package_id: statePackageId(sessionDir), bo_id: bo.bo_id, bo_version: bo.version, bo_digest: bo.digest, path: f.path, value: f.value ?? null, value_ref: f.value_ref ?? null, source: f.source, observed_at: f.observed_at ?? null, confidence: f.confidence ?? 0.5, valid_until: f.valid_until ?? null, status: 'observed' });
            hostApplied.facts++;
          }
          for (const o of result.host_writes?.observations ?? []) {
            store.putHostObservation({ package_id: statePackageId(sessionDir), bo_id: bo.bo_id, bo_version: bo.version, bo_digest: bo.digest, path: o.path, value: o.value ?? o.value_ref ?? null, source: o.source, observed_at: o.observed_at ?? null, confidence: o.confidence ?? 0.5, status: 'unmodeled' });
            hostApplied.observations++;
          }
          for (const d of result.host_writes?.deltas ?? []) {
            store.putHostDelta({ bo_id: bo.bo_id, base_digest: d.base_digest, patch: d.patch, source: d.source ?? 'run', status: d.status ?? 'candidate' });
            hostApplied.deltas++;
          }
          for (const b of result.host_writes?.bindings ?? []) {
            store.putHostBinding({ package_id: statePackageId(sessionDir), bo_id: bo.bo_id, bo_version: bo.version, bo_digest: bo.digest, slot: b.slot, value_ref: b.value_ref, source: b.source ?? 'user', status: 'bound' });
            hostApplied.bindings++;
          }
          // op=ontology,get：按 host_merge_hint 在边端合并宿主状态（bound/unknown/stale）。
          hostState = hostOntologyState(store, bo, action);
        } catch (e) {
          warn(`[AEC] op=ontology 宿主写入失败（内核分类结果已回，不阻断）：${e.message}`);
        }
      }
      // 会话本体缓冲：close → evidence.ontology（内核 buildCloseOntology 只读）。
      if (result.code === undefined && (action === 'observe' || action === 'bind')) bufferOntology({ sessionDir, action, result });
      const markdown = renderOntologyReceipt({ action, result, hostApplied, hostState });
      return { content: [{ type: 'text', text: markdown }], structuredContent: { v: 'aec/v2', ...result, ...(hostState ? { host_state: hostState } : {}), host_applied: hostApplied } };
    },
  };
}

// ---- AEC 5.2（ADR §4.4/§5.3）：op=ontology 边端辅助 -------------------------------
// Host MKS 写入只发生在这几个函数里；内核永不写宿主库。lite 形态 store=null → 全部跳过，
// 内核回执原样透传（AEC_ONTOLOGY=0 时内核直接回 ontology_disabled）。

// open 回执的宿主侧合并（ADR §6.4）：binding 状态只有 Host MKS 知道。store 缺席时原样透传。
export async function mergeHostOntologyState(summary, { getStore = null } = {}) {
  if (!summary || typeof summary !== 'object' || !summary.bo_id) return summary;
  let store = null;
  try { store = getStore ? await getStore() : null; } catch { store = null; }
  if (!store) return summary;
  try {
    const bindings = store.listHostBindings({ bo_id: summary.bo_id, bo_digest: summary.digest ?? null });
    const facts = store.listHostFacts({ bo_id: summary.bo_id, bo_digest: summary.digest ?? null });
    return {
      ...summary,
      bindings_bound: bindings.filter(b => b.status === 'bound').map(b => ({ slot: b.slot, value_ref: b.value_ref, source: b.source })),
      host_facts: facts.filter(f => f.status !== 'stale').length,
      host_facts_stale: facts.filter(f => f.status === 'stale').length,
    };
  } catch { return summary; }
}

export function renderBoBlock(bo) {
  if (!bo || typeof bo !== 'object') return '';
  const lines = [`【业务本体】BO ${bo.bo_id ?? '?'}@${bo.resolved_version ?? '?'}${bo.digest ? `（digest ${String(bo.digest).slice(0, 12)}…）` : ''}`];
  lines.push(`- 解析：${bo.resolution ?? '?'}${bo.requested_range && bo.resolution !== 'locked' ? `（请求 ${bo.requested_range}）` : ''}${bo.fallback_reason ? `，回退：${bo.fallback_reason}` : ''}`);
  lines.push(`- 目标 ${bo.goals ?? 0} 个；绑定声明 ${bo.bindings_declared ?? 0}（敏感 ${bo.bindings_sensitive ?? 0}）${Array.isArray(bo.bindings_bound) && bo.bindings_bound.length ? `；宿主已绑 ${bo.bindings_bound.length}` : ''}`);
  for (const b of bo.bindings_bound ?? []) lines.push(`  · ${b.slot} ← ${b.value_ref}（${b.source}）`);
  lines.push('- 本会话事实上报用 op=ontology,observe（未知路径进 unmodeled）；槽位绑定用 op=ontology,bind（只存引用）。');
  lines.push('- 业务语义变更只提 delta candidate，人工确认后 promote；不要直接改已发布 BO。');
  return lines.join('\n');
}

function statePackageId(sessionDir) {
  try { return JSON.parse(readFileSync(join(sessionDir, 'state.json'), 'utf8'))?.package_id ?? null; } catch { return null; }
}

function ontologyBufferPath(sessionDir) { return join(sessionDir, 'ontology.json'); }

function readOntologyBuffer(sessionDir) {
  try { return JSON.parse(readFileSync(ontologyBufferPath(sessionDir), 'utf8')) ?? null; } catch { return null; }
}

// observe/bind 的会话内累积：facts=accepted+delta（close 时内核对语义路径再核一遍），
// mismatches=①同 path 值变化（declared→observed）②语义路径观测（声明值未变也算 mismatch）。
function bufferOntology({ sessionDir, action, result }) {
  const buf = readOntologyBuffer(sessionDir) ?? { v: 'aec/v2', bo_id: null, digest: null, facts: [], mismatches: [], bindings: [] };
  const bo = result.bo ?? {};
  buf.bo_id = bo.bo_id ?? buf.bo_id;
  buf.digest = bo.digest ?? buf.digest;
  if (action === 'observe') {
    const seen = new Map(buf.facts.filter(f => f.value_ref == null).map(f => [f.path, f]));
    for (const f of [...(result.accepted ?? []), ...(result.deltas ?? [])]) {
      const prev = seen.get(f.path);
      if (prev) {
        const prevV = prev.value ?? prev.value_ref ?? null;
        const curV = f.value ?? f.value_ref ?? null;
        if (JSON.stringify(prevV) !== JSON.stringify(curV))
          buf.mismatches.push({ path: f.path, declared: prevV, observed: curV, source: f.source ?? 'run' });
      } else seen.set(f.path, f);
      buf.facts.push(f);
    }
    // 语义路径观测：值进 close 后由内核 isSemanticPath 判定并出 delta candidate。
    for (const f of result.deltas ?? [])
      buf.mismatches.push({ path: f.path, declared: null, observed: f.value ?? f.value_ref ?? null, note: 'semantic_path' });
  } else {
    const b = result.bound ?? null;
    if (b) buf.bindings.push({ slot: b.slot, value_ref: b.value_ref, source: b.source ?? 'user', at: new Date().toISOString() });
  }
  writeFileSync(ontologyBufferPath(sessionDir), JSON.stringify(buf, null, 2), { mode: 0o600 });
}

// host_merge_hint 的边端实现：只读当前 bo_digest；旧 digest 事实不计入（内核标 stale 的约定由
// 查询条件承担）；binding 状态 = 声明槽位里的 bound/unknown。
function hostOntologyState(store, bo, action) {
  if (!bo?.bo_id) return null;
  const bindings = store.listHostBindings({ bo_id: bo.bo_id, bo_digest: bo.digest ?? null });
  const facts = store.listHostFacts({ bo_id: bo.bo_id, bo_digest: bo.digest ?? null });
  const boundBySlot = new Map(bindings.filter(b => b.status === 'bound').map(b => [b.slot, b]));
  const declared = action === 'get' && Array.isArray(bo.sections?.bindings) ? bo.sections.bindings.map(b => b.slot) : null;
  const merged = {
    bindings: bindings.filter(b => b.status === 'bound').map(b => ({ slot: b.slot, value_ref: b.value_ref, source: b.source })),
    host_facts: facts.filter(f => f.status !== 'stale').length,
    host_facts_stale: facts.filter(f => f.status === 'stale').length,
  };
  if (declared) merged.declared_unknown = declared.filter(s => !boundBySlot.has(s));
  return merged;
}

function renderOntologyReceipt({ action, result, hostApplied, hostState }) {
  if (result.code) {
    // ontology_disabled / ontology_not_declared：内核已给人类可读 message，原样带回。
    return `[AEC] op=ontology 未执行：${result.message}`;
  }
  const lines = [];
  const bo = result.bo ?? {};
  if (action === 'get') {
    const sections = bo.sections ?? {};
    lines.push(`[AEC] 业务本体 ${bo.bo_id ?? '?'}@${bo.version ?? '?'}${bo.digest ? `（digest ${String(bo.digest).slice(0, 12)}…）` : ''} 声明节视图：`);
    for (const [name, entries] of Object.entries(sections))
      lines.push(`  · ${name} ${Array.isArray(entries) ? entries.length : '?'} 项`);
    if (Array.isArray(bo.declared_paths) && bo.declared_paths.length)
      lines.push(`  · declared_paths ${bo.declared_paths.length} 条（宿主合并见 host_state）`);
    if (hostState) {
      lines.push(`  · 宿主绑定 ${hostState.bindings.length}${hostState.declared_unknown?.length ? `，未绑 ${hostState.declared_unknown.length}` : ''}；宿主事实 ${hostState.host_facts}${hostState.host_facts_stale ? `（stale ${hostState.host_facts_stale}）` : ''}`);
      for (const b of hostState.bindings) lines.push(`    · ${b.slot} ← ${b.value_ref}（${b.source}）`);
    }
    lines.push(result.host_merge_hint ?? '宿主合并：按 declared_paths 读 host_fact/host_binding；旧 digest 的事实标 stale 不参与决策。');
    lines.push('业务语义变更走 delta（人工确认后 promote），不要直接改已发布 BO。');
  } else if (action === 'observe') {
    lines.push(`[AEC] 事实分类完成：accepted ${result.accepted?.length ?? 0}｜unmodeled ${result.unmodeled?.length ?? 0}｜rejected ${result.rejected?.length ?? 0}｜delta ${result.deltas?.length ?? 0}`);
    lines.push(`  · 宿主写入：facts ${hostApplied.facts}、observations ${hostApplied.observations}、deltas ${hostApplied.deltas}（candidate，人工晋升）`);
    for (const r of result.rejected ?? []) lines.push(`  · 拒绝 ${r.path}：${r.code}${r.message ? ` — ${r.message}` : ''}`);
    for (const u of result.unmodeled ?? []) lines.push(`  · unmodeled ${u.path}（进 host_observation，不参与决策；要建模先扩 BO）`);
    lines.push(result.note ?? '内核只分类；宿主库写入由边端执行。');
  } else {
    lines.push(`[AEC] 绑定成功：${result.bound?.slot} ← ${result.bound?.value_ref}（只存引用；明文永不入库）`);
    lines.push(`  · 宿主写入：bindings ${hostApplied.bindings}`);
    lines.push(result.note ?? '由边端写 host_binding。');
  }
  return lines.join('\n');
}

// 模型可执行的错误指引（§0.2：模型永远不需要理解内核内部）。
// 鉴权类错误尤其重要：实测一次排障长会话（42 次调用）就是模型看到
// "host token and machine proof required" 后开始读内核源码造成的。
export function humanError(code) {
  return {
    no_match: '没有找到对应经验包：如实告诉用户，不要编造。',
    ambiguous_match: '多个包都可能：列给用户选。',
    missing_inputs: '缺材料：向用户要，不要猜。',
    session_not_found: '会话不存在：重新 open。',
    session_expired: '会话过期：重新 open。',
    input_missing: '材料缺失：向用户要。',
    // 密钥模式（2026-11-19）：密钥是用户持有的凭证，鉴权失败没有客户端侧自救，
    // 全部如实转告用户，等用户换/补密钥后重试同一调用。
    api_key_required: 'AEC 尚未配置密钥：向用户要一枚 AEC 密钥（aec_key_ 开头，由管理员从 AEC 服务器生成），拿到后用 aec_setup 工具提交；或者让用户把密钥填进 mcp.json 的 env AEC_API_KEY 后重连宿主。',
    key_invalid: 'AEC 密钥无效（云端校验未通过）：确认密钥完整且以 aec_key_ 开头、未被撤销；请用户重新提供后用 aec_setup 再提交一次。',
    key_revoked: 'AEC 密钥已被撤销：把本条原样告诉用户，需要管理员确认或换发一枚新的 aec_key_ 密钥（拿到后用 aec_setup 重新提交）。',
    key_expired: 'AEC 密钥已过期：把本条原样告诉用户，需要管理员重新生成一枚 aec_key_ 密钥（拿到后用 aec_setup 重新提交）。',
    // 旧机器绑定令牌（aec_host_ 前缀）仍存于少数宿主 env：v2.0 客户端不再支持
    // 机器绑定，统一引导到密钥模式。
    unauthorized: 'AEC 通道鉴权失败：若 env 里是旧机器令牌（aec_host_ 前缀），v2.0 已不再支持——请改用管理员下发的 aec_key_ 密钥（aec_setup 提交或 env AEC_API_KEY）。',
    host_fingerprint_missing: '这个凭证是旧机器绑定令牌，v2.0 客户端已不再支持：请向管理员索取新的 aec_key_ 密钥后用 aec_setup 提交。',
    host_expired: 'AEC 凭证已过期（旧机器绑定令牌）：请向管理员索取新的 aec_key_ 密钥。',
    host_inactive: 'AEC 主机已被停用（旧机器绑定令牌）：请向管理员索取新的 aec_key_ 密钥。',
    session_required: '缺少会话 id：回到上一步回执取"会话 ases_…"，不要自己编一个。',
    author_secret_invalid: 'AEC 创作密钥与内核不一致：把本条原样告诉用户，需要运维核对 AEC_AUTHOR_SECRET / author.key 与内核配置。',
    author_enrollment_disabled: 'AEC 内核未配置创作密钥：把本条原样告诉用户，需要运维配置。',
    // 内核未分类异常（TypeError / undefined 之类）：这是 AEC 的缺陷，不是调用方的参数错。
    // 明确要求"停"——B-17 实测模型会连续换参数重试三次，每次都撞同一堵墙。
    internal_error: 'AEC 内核内部错误（是 AEC 的缺陷，不是你的参数或字段写错）：不要重试，也不要换 experience_ref / intent / 包目录再猜一次。把「刚才的操作 + 会话 id + 这条原文」原样告诉用户，并说明需要运维查看内核日志。',
    // 网络类失败（连接/DNS/TLS/超时）有独立分类：与内核缺陷、调用参数无关，
    // 修正网络/配置后即可重试——此前被并入 internal_error，把用户引向"查内核日志"。
    network_error: 'AEC 内核网络不可达（连接/DNS/TLS/超时——不是 AEC 的缺陷，也不是你的参数写错）：检查 AEC_KERNEL_URL 是否为管理员给的真实地址、本机网络与代理是否可达，修正后重试同一调用即可。',
    invalid_request: 'AEC 拒绝了这次请求：按上面的原文改参数后重试一次；重复同样错误说明是内核缺陷，停下并告诉用户。',
  }[code];
}

// 图示 = HTML 一页（用户约束：展示图示一律用 HTML，不贴 mermaid）。
//
// 分工：内核负责"画"（确定性渲染，随 plan/draft 回执返回整页），边端负责"落盘"
// （写成本地文件，回执只给路径）。这样渲染不依赖模型自觉——模型拿到的是路径，
// 除了打开它没有第二条路；也就不会退化成"贴一段没人渲染的 mermaid 源码"。
// 目录可用 AEC_AUTHOR_HTML_DIR 覆盖（测试与多实例）。
export function materializeAuthorHtml(result, op = 'plan') {
  if (!result || typeof result.views_html !== 'string' || !result.views_html.trim()) return null;
  const dir = process.env.AEC_AUTHOR_HTML_DIR || join(homedir(), '.aec-author', 'html');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${result.session || 'unknown'}-${op}.html`);
  // AEC 4.0.2：只有当实时视图构建失败、主页面真的回退到表格版时才加横幅；
  // AEC_AUTHOR_LIVE=0 的旧 -plan.html 内容逐字不变（不静默伪装成实时页）。
  const html = result.author_page_kind === 'fallback' && result.author_page_degraded === true
    ? withFallbackNotice(result.views_html) : result.views_html;
  writeFileSync(file, html, 'utf8');
  if (typeof result.message === 'string') result.message = result.message.replaceAll('{{views_html_path}}', file);
  result.views_html_path = file;
  delete result.views_html; // 整页 HTML 不进 MCP 结构化回执：路径即句柄，省 token
  return file;
}

// B-23：官方契约骨架落盘。内核随 open 回执内联 loop_template，边端写成
// 本地文件并替换占位——模型从第 1 步就有可复制的合法 loop，不必等门教育。
export function materializeLoopTemplate(result) {
  if (!result || typeof result.loop_template !== 'string' || !result.loop_template.trim()) return null;
  const dir = process.env.AEC_AUTHOR_HTML_DIR
    ? join(process.env.AEC_AUTHOR_HTML_DIR, '..')
    : join(homedir(), '.aec-author');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'loop-template.json');
  writeFileSync(file, result.loop_template, 'utf8');
  if (typeof result.message === 'string') result.message = result.message.replaceAll('{{loop_template_path}}', file);
  result.loop_template_path = file;
  delete result.loop_template; // 骨架内容不进回执：文件即句柄
  return file;
}

// AEC 3.1.1：作者期实时可视化落盘（authoring-live 设计 §4.3/§7.1）。
// 同一路径 $AEC_AUTHOR_LIVE_DIR/<session>/ 每次覆盖写：
//   goal/loop/resources.html + live.js → state.js/state.json → index.html 最后。
// 全部原子替换（tmp+rename），文件 0600、目录 0700；历史（history）由边端
// 从上一份 state.json 合并进新 state（内核不读边端文件，远端本地一致）。
// 落盘后：message 里的 {{live_view_path}} 换成真实路径；structuredContent 删除
// live_view 大字段，只留 live_view_path/revision/state/final/degraded。
export function materializeAuthorLive(result) {
  const lv = result?.live_view;
  if (!lv || lv.schema !== LIVE_SCHEMA || typeof lv.html !== 'string' || typeof lv.session !== 'string') return null;
  if (!SESSION_ID_RE.test(lv.session)) return null; // 路径校验：UUID 形状 + 包含性
  const dir = process.env.AEC_AUTHOR_LIVE_DIR || join(homedir(), '.aec-author', 'live');
  const root = resolve(dir);
  const sdir = resolve(root, lv.session);
  if (!sdir.startsWith(root + sep)) return null;
  mkdirSync(sdir, { recursive: true, mode: 0o700 });
  try { chmodSync(sdir, 0o700); } catch { /* best-effort */ }

  // 历史：上一份 state.json 的 history + 本次 revision（rev 不变不追加）。
  let history = [];
  try { history = JSON.parse(readFileSync(join(sdir, 'state.json'), 'utf8')).history || []; } catch { /* first run */ }
  const state = JSON.parse(lv.state_json);
  const last = history[history.length - 1];
  if (!last || last.revision !== state.revision) {
    history.push({ revision: state.revision, state: state.state, digest: state.digest, at: state.updated_at, note: state.phase_note });
  }
  if (history.length > 20) history = history.slice(-20);
  const stateObj = { ...state, history };

  const writeAtomic = (file, content) => {
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, file);
    try { chmodSync(file, 0o600); } catch { /* best-effort */ }
  };
  // 写盘顺序（设计 §4.3）：图与 live.js → state → index.html 最后（index 出现
  // 即代表这一版完整；旧 index 在替换前一直可读）。
  for (const a of lv.assets || []) writeAtomic(join(sdir, a.name), a.html);
  writeAtomic(join(sdir, 'state.js'), `window.__AEC_LIVE_STATE__ = ${JSON.stringify(stateObj)};`);
  writeAtomic(join(sdir, 'state.json'), `${JSON.stringify(stateObj)}\n`);
  writeAtomic(join(sdir, 'index.html'), lv.html);

  const path = join(sdir, 'index.html');
  if (typeof result.message === 'string') result.message = result.message.replaceAll('{{live_view_path}}', path);
  result.live_view_path = path;
  result.live_revision = stateObj.revision;
  result.live_state = stateObj.state;
  result.live_final = stateObj.final;
  result.live_degraded = stateObj.degraded;
  delete result.live_view; // 整页 HTML 不进 MCP 回执：路径即句柄
  return path;
}

// AEC 4.0.2「单一作者页」裁决：优先 live/<session>/index.html，只有实时视图
// 缺失/降级/落盘失败才回退到 -plan.html 表格版。在 materializeAuthorHtml 与
// materializeAuthorLive 之后调用（两者已把整页 HTML 落盘并留下路径）。
// 统一替换 {{author_page_path}}；structuredContent 只留路径契约字段，不带整页 HTML。
export function materializeAuthorPage(result) {
  if (!result) return null;
  const livePath = typeof result.live_view_path === 'string' && result.live_view_path ? result.live_view_path : null;
  const liveUsable = !!livePath && result.live_degraded !== true;
  const fallbackPath = typeof result.views_html_path === 'string' && result.views_html_path ? result.views_html_path : null;
  const path = liveUsable ? livePath : (fallbackPath || livePath);
  if (!path) return null;
  result.author_page_path = path;
  result.author_page_kind = liveUsable ? 'live' : 'fallback';
  result.author_page_degraded = !!livePath && result.live_degraded === true;
  if (typeof result.message === 'string') {
    result.message = result.message
      .replaceAll('{{author_page_path}}', path)
      // 兜底：任何残留的旧占位也统一收敛到同一个主页面，不再给第二个页面路径。
      .replaceAll('{{views_html_path}}', path);
    // 新旧内核混跑时，旧内核仍把 -plan.html 写进消息；live 可用就把主提示
    // 也纠正到 live，避免"结构化主路径=live、文本主提示=表格页"自相矛盾。
    if (liveUsable && fallbackPath && fallbackPath !== path) {
      result.message = result.message.replaceAll(fallbackPath, path);
    }
  }
  // 大字段兜底清理：即便某个 materializer 提前返回，也不把整页 HTML 送进回执。
  delete result.live_view;
  delete result.views_html;
  return path;
}

// 回执文本 = 可执行指引（human）+ 原始报错（原文）。两者都留：指引告诉模型"停还是
// 重试"，原文让运维能定位——之前二选一，要么模型看不到细节，要么只看到 JS 报错。
export function errorReceipt(e) {
  const pub = publicError(e);
  const code = e?.code ? pub.code : (e instanceof SyntaxError ? 'invalid_request' : 'internal_error');
  const human = humanError(code);
  const raw = String(pub.message || '').trim();
  const text = human
    ? `[AEC] ${human}${raw ? `\n      原文：${raw}` : ''}`
    : `[AEC] ${raw}（无法自动处理：把本条原样告诉用户，不要读文件或源码排查。）`;
  return { code, text, pub: { ...pub, code } };
}

export function createMcpV2(kernel, { profile = 'run', endpoint = null, credentialsFile = null, env = process.env, rolesDb = null, rerankFn = undefined, rerankMeta = undefined } = {}) {
  const server = new McpServer({ name: 'aec-mcp', version: '2.2.0' },
    { instructions: profile === 'author'
      ? '经验包创作。仅当用户明确要求"用 AEC 做一个经验包/技能"时调用。五阶段，内核按门推进：open（八维需求卡 + 资源需求）→ learn（本库检索，可选）→ plan（HTML 一页：三张图 + 资源表 + 判据表，必须打开给用户看并确认）→ draft（A/D 门，登记草稿）→ 试用（沙箱里跑，不是交付）→ publish（四门 + 用户明确许可）。图示一律用内核给的 HTML 文件展示，不要贴 mermaid 源码。回执第一行的阶段横幅就是当前该做什么、不许做什么。宿主本地记忆用 aec_local（op=recall 取上下文 / remember 记候选）。'
      : '经验包下发。仅当用户明确要求"使用/调用 AEC"时调用；其余情况不要调用。op=open 时把用户原话传给 intent。任务前可用 aec_local op=recall 取宿主本地记忆，任务后 op=remember 记候选记忆。' });
  // AEC 5.2：op=ontology 宿主写入通道——getStore 在下方 aec_local 块注入同一懒加载
  // store（lite/关闭时 null → 边端全部跳过，回执逐字节等价）。
  const ontologyCtx = { env, getStore: null };
  const handlers = aecEdgeHandlers(kernel, ontologyCtx);
  server.registerTool('aec', {
    description: profile === 'author'
      ? '试用草稿专用（author 工作流的第 4/5 步）。仅在 aec_author draft 返回 trial_ref 后调用：op=open 带 experience_ref 与 trial_of 跑真实试用，op=close 取得 authoritative 证据。试用产物写在独立沙箱（~/.aec-trials/…），不写用户项目；这是验证，不是给用户实施。不要用它处理普通任务——普通任务用 run profile 的 aec。'
      : '经验包下发。仅当用户明确要求"使用/调用 AEC"时调用；其余情况不要调用。op=open 时把用户原话传给 intent。',
    inputSchema: {
      op: z.enum(['open', 'resource', 'turn', 'close', 'ontology']).describe('open=开始任务 resource=取材料 turn=失败或提问 close=结束 ontology=业务本体/宿主事实'),
      intent: z.string().optional().describe('op=open 必填：用户原话，不改写、不总结'),
      session: z.string().optional().describe('open 之外必填'),
      workspace: z.string().optional().describe('可选：产物根目录；不传由 aec-mcp 决定。带 trial_of 的试用一律用沙箱，此参数被忽略'),
      stage: z.string().optional(), trigger: z.string().optional(), want: z.string().optional(),
      note: z.string().optional(), ask: z.string().optional(), answer: z.string().optional(),
      status: z.enum(['done', 'abandoned']).optional(),
      // AEC 5.2（ADR §5.3）：op=ontology 三 action。内核只计算；宿主库写入由本边端执行。
      action: z.enum(['get', 'observe', 'bind']).optional().describe('op=ontology 必填：get=读 BO 声明节视图（本边端合并宿主事实） observe=上报宿主事实（未知 path 进 unmodeled） bind=绑定槽位（只存引用）'),
      sections: z.array(z.string()).optional().describe('op=ontology,get 可选：限定 BO 节'),
      facts: z.array(z.object({
        path: z.string(), value: z.unknown().optional(), value_ref: z.string().optional(),
        source: z.string().optional(), observed_at: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(), valid_until: z.string().optional(),
      })).optional().describe('op=ontology,observe 必填：事实数组；敏感槽位只收 value_ref'),
      slot: z.string().optional().describe('op=ontology,bind 必填：BO bindings 槽位'),
      value_ref: z.string().optional().describe('op=ontology,bind 必填：值引用（敏感槽位需 ref:/host:/env:/vault:/keyring: 前缀）'),
      source: z.string().optional().describe('op=ontology,bind 可选：user|material|probe|memory|knowledge|run|inference'),
      // a125（§20）：显式声明以便拒绝而非静默剥离——验收不经 close 入参。
      acceptance: z.unknown().optional().describe('禁止：验收结果不经 close 入参，传入即被内核拒绝'),
      // W17（§13.2）：GoalFrame / 假设的结构化修订（turn）。target 指向 session
      // outcome_id / assumption_id / question_id；payload 是修订载荷。
      goal_op: z.enum(['restate_intent', 'add_outcome', 'revise_outcome', 'drop_outcome', 'resolve_question']).optional()
        .describe('op=turn 可选：对目标视图的结构化修订（revision+1；intent_raw 永不覆盖）'),
      assumption_op: z.enum(['add', 'confirm', 'invalidate']).optional().describe('op=turn 可选：假设操作（invalidate 触发 T1）'),
      target: z.string().optional().describe('修订作用对象：outcome_id / subgoal_id / step_id / resource_id / assumption_id / question_id'),
      payload: z.record(z.unknown()).optional().describe('修订载荷：{statement?, dimensions?, commitment?, intent_interpreted?, status?}'),
      // 与内核契约一致的对象形状（draft 回执里的 trial_ref 就是它）；
      // 字符串 "id@version" 也接受，由边端归一化——模型两种写法都不该卡在 schema 上。
      experience_ref: z.union([
        z.string(),
        z.object({ id: z.string(), version: z.string(), digest: z.string().optional() }).passthrough(),
      ]).optional().describe('op=open 可选：{id,version,digest}（试用时就是 draft 回的 trial_ref），或 "id@version"'),
      trial_of: z.string().optional().describe('试用交接：draft 返回的造包会话 id（内核核验绑定）'),
      // 3.2.0 g067：aec 只增加可选 query；不传走旧匹配，intent 永不被覆盖。
      query: z.record(z.unknown()).optional().describe('op=open 可选：aec.task-query/v1 宿主 query 理解结果'),
      // 5.1 O1-00b（5.1-R-011）：可选 conversation_id，仅分线程、不授权；绝不加 user_id。
      conversation_id: z.string().max(128).optional().describe('op=open 可选：线程分隔 id（≤128）；不用于身份/授权'),
    },
  }, async args => {
    try { return await handlers[args.op || 'open'](args); }
    catch (e) {
      const receipt = errorReceipt(e);
      return { isError: true, content: [{ type: 'text', text: receipt.text }], structuredContent: receipt.pub };
    }
  });
  // aec_setup（密钥模式 2026-11-19）：首次使用的唯一入口。模型向用户要到密钥后
  // 提交到这里：云端 keys/verify 校验 → 成功写入本机凭证文件（0600）→ 之后
  // aec/aec_author 每次调用带 Bearer api_key 由云端快速校验。密钥原文不进回执。
  server.registerTool('aec_setup', {
    description: 'AEC 密钥配置（首次使用时调用）。当 aec/aec_author 报"尚未配置密钥"时：向用户要一枚 AEC 密钥（aec_key_ 开头，管理员从 AEC 服务器生成），然后调用本工具提交。校验成功后密钥保存在本机（Windows %APPDATA%\\aec / macOS·Linux ~/.config/aec，文件 0600），之后无需重复配置。',
    inputSchema: {
      api_key: z.string().describe('AEC 密钥原文（aec_key_ 开头），由用户从 AEC 服务器获取后提供'),
    },
  }, async args => {
    try {
      const result = await verifyApiKey({ endpoint, api_key: args.api_key });
      const seg = {
        api_key: String(args.api_key).trim(),
        key_id: result.key_id ?? null, label: result.label ?? null,
        role: result.role ?? (profile === 'author' ? 'publisher' : 'consumer'),
        tenant: result.tenant ?? null, expires_at: result.expires_at ?? null,
        verified_at: new Date().toISOString(),
      };
      const doc = saveCredentials(credentialsFile || credentialsPath({ env }), { endpoint, [profile]: seg });
      if (rolesDb) {
        try {
          const dev = rolesDb.upsertDevice({ machine_code: `api-key:${result.key_id}`, machine_source: 'api_key', label: result.label || hostname(), role: seg.role, endpoint, tenant: seg.tenant });
          rolesDb.putToken({ device_id: dev.device_id, token: seg.api_key, host_id: result.key_id, host_salt: null, role: seg.role, endpoint, expires_at: seg.expires_at });
          rolesDb.grantRole({ subject: result.key_id || seg.api_key, role: seg.role, endpoint, source: 'api_key' });
        } catch (e) {
          warn(`本地角色库记录失败（不影响使用）：${e.message}`);
        }
      }
      return {
        content: [{ type: 'text', text: `[AEC] 密钥校验通过，已保存到本机凭证文件（profile=${profile}，Windows: %APPDATA%\\aec；macOS/Linux: ~/.config/aec）。\n- key_id：${result.key_id}\n- 标签：${result.label ?? '—'}\n- 角色：${result.role}\n- 租户：${result.tenant}\n- 有效期至：${result.expires_at ?? '—'}\n现在可以直接使用 aec 工具了（每次调用云端快速校验密钥）。` }],
        structuredContent: { code: 'ready', profile, key_id: result.key_id, label: result.label, role: result.role, tenant: result.tenant, expires_at: result.expires_at, credentials_file: doc ? credentialsFile || credentialsPath({ env }) : null },
      };
    } catch (e) {
      const receipt = errorReceipt(e);
      return { isError: true, content: [{ type: 'text', text: receipt.text }], structuredContent: receipt.pub };
    }
  });
  if (profile === 'author') {
    server.registerTool('aec_author', {
      description: '经验包创作。仅当用户明确要求"用 AEC 做一个经验包/技能"时调用。五阶段：open（八维需求卡 + 资源需求）→ learn（本库检索）→ plan（HTML 一页：三张图 + 资源表 + 判据表，打开给用户确认）→ draft（A/D 门，登记草稿）→ 试用（沙箱，验证不是交付）→ publish（四门 + 用户许可）。契约较大时把 loop.json 写盘后用 pkg_dir 传路径。图示用 HTML 文件展示，不要贴 mermaid。',
      inputSchema: {
        op: z.enum(['open', 'learn', 'plan', 'draft', 'publish', 'ontology']),
        intent: z.string().optional(), session: z.string().optional(),
        // B-20：必须是"有类型的 object"声明。z.unknown() 的 JSON Schema 是 {}（无类型），
        // 宿主对无类型参数会按字符串序列化——真实发生过：整个 loop 变成一段 JSON 文本，
        // 内核只回"需要 loop 对象"，模型无限重发。z.record 声明出 type:object 后宿主不会串化。
        loop: z.record(z.unknown()).optional()
          .describe('op=plan/draft：完整 aec.loop/v3 契约对象（schema_revision 3.0/3.1/3.2；aec.loop/v2 旧包仍兼容读取）。较大时不要塞参数——把 loop.json 写到磁盘，用 pkg_dir 传目录路径'),
        trial: z.string().optional(), confirm: z.boolean().optional(),
        brief: z.object({ confirmed: z.boolean() }).passthrough().optional()
          .describe('需求卡：{confirmed, card:{scene,artifact,success,inputs,not_for,failure,environment,resources:[…]}, decisions:[{question,chosen,source}]}'),
        plan: z.object({ confirmed: z.boolean() }).passthrough().optional()
          .describe('op=draft 必带：{confirmed:true, digest:"plan 回执里的计划摘要", ack:"用户确认计划的原话"}'),
        // B-6 决策①：作者把新包写在本目录（loop.json + resources/）。draft 快照
        // resources/ 随提交（资源字节不经模型转述）；B-20 起 plan/draft 都可只传
        // pkg_dir，边端读 <pkg_dir>/loop.json 作为 loop——大契约写盘比走参数可靠。
        pkg_dir: z.string().optional().describe('op=plan/draft 可选：新包目录路径。plan 读 <目录>/loop.json 当 loop（不必再传 loop 参数）；draft 读 loop.json + 快照 resources/'),
        // 3.2.0 §8.2：只增可选字段，五个 op 不变、工具面仍是 2 工具 9 op。
        source: z.record(z.unknown()).optional().describe('ingest：{kind:"github",url,ref?,subdir?,commit?,files?}'),
        cases: z.unknown().optional().describe('ingest：管理员提供的真实案例（≥3 含负例），不得由模型编造'),
        security_waiver: z.record(z.unknown()).optional().describe('ingest：warn 需具名豁免 {reason,scope,approved_by,expires_at}'),
        query: z.record(z.unknown()).optional().describe('op=learn/plan 可选：宿主 LLM 的 aec.task-query/v1 query 理解（归一化检索文本，不改写 intent 原话）'),
        extraction_candidates: z.unknown().optional().describe('ingest：aec.extraction-candidate/v1 宿主 LLM 候选'),
        extraction_file: z.string().optional().describe('ingest：候选 JSON 的本地路径'),
        snapshot: z.record(z.unknown()).optional().describe('ingest：宿主/边端只读快照 {files,manifest?,sandbox_report?}'),
        commit: z.string().optional().describe('ingest：把 ref 固定为 40 位 commit SHA'),
        security_report: z.unknown().optional().describe('ingest：宿主提供的 aec.security-report/v1'),
        candidate: z.unknown().optional().describe('ingest：同 extraction_candidates'),
        visibility: z.string().optional().describe('ingest publish：public|private'),
        // AEC 5.2（ADR §5.2）：op=ontology 五 action，与内核仓 mcp2 同源。draft 产
        // candidate 骨架；release/promote 需要用户明确许可（confirm:true 第二遍）。
        action: z.enum(['draft', 'validate', 'release', 'promote', 'diff']).optional()
          .describe('op=ontology 必填：draft=从需求卡出 BO 草稿（candidate） validate=纯函数校验（不写库） release=发 BO release（confirm） promote=delta 晋升新 BO release（confirm，不发新包） diff=两版本差异'),
        business_ontology: z.record(z.unknown()).optional()
          .describe('op=ontology：完整 aec.business-ontology/v1 文档；pkg_dir 传入时边端自动读 <pkg_dir>/resources/ontology/business.json'),
        compatibility: z.record(z.unknown()).optional().describe('op=ontology,release 可选：{packages:[{id,version_range}], aec:{…}}'),
        bo_id: z.string().optional().describe('op=ontology,diff/promote：BO id'),
        from: z.string().optional().describe('op=ontology,diff：起始版本'),
        to: z.string().optional().describe('op=ontology,diff：目标版本'),
        delta_id: z.string().optional().describe('op=ontology,promote：host_delta id（边端从 Host MKS 读出并随 delta_id 带审计）'),
        delta: z.record(z.unknown()).optional().describe('op=ontology,promote：{base_digest, patch:[RFC6902 子集]}（给 delta_id 时由边端读出，二选一）'),
        target_version: z.string().optional().describe('op=ontology,promote：新 BO 版本号'),
      },
    }, async args => {
      try {
      // B-20：plan/draft 允许只传 pkg_dir——边端读 <pkg_dir>/loop.json 当 loop。
      // 大契约走文件而不是 MCP 参数：序列化/转义/长度三类故障（宿主串化、类型
      // 校验拒绝、特殊字符炸传输）从此与参数内容无关。
      let loopArg = args.loop;
      if (!loopArg && args.pkg_dir && (args.op === 'plan' || args.op === 'draft')) {
        const loopPath = join(args.pkg_dir, 'loop.json');
        const text = readFileSync(loopPath, 'utf8');
        loopArg = JSON.parse(text.replace(/^\uFEFF/, '').trim());
      }
      // AEC 5.2：op=ontology 的 BO 文档内联（pkg_dir 读 resources/ontology/business.json 或
      // ontology/business.json，与内核仓 mcp2 同源防漂移）；promote 的 delta 缺省时由
      // Host MKS 按 delta_id 读出（本边端是唯一持有者）。
      let boArg = args.business_ontology;
      if (!boArg && args.pkg_dir && args.op === 'ontology') {
        for (const p of [join(args.pkg_dir, 'resources', 'ontology', 'business.json'), join(args.pkg_dir, 'ontology', 'business.json')]) {
          if (existsSync(p)) { boArg = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim()); break; }
        }
      }
      let deltaArg = args.delta;
      if (!deltaArg && args.delta_id && args.op === 'ontology' && args.action === 'promote') {
        const store = await (ontologyCtx?.getStore?.() ?? null);
        const row = store ? store.getHostDelta({ delta_id: args.delta_id }) : null;
        if (!row) throw Object.assign(new Error(`host_delta_not_found: delta_id ${args.delta_id} 在 Host MKS 里不存在（宿主事实由本边端写入；换目标主机或核对 id）`), { code: 'host_delta_not_found' });
        deltaArg = { base_digest: row.base_digest, patch: row.patch, evidence: row.evidence ?? undefined };
        try { store.markHostDelta({ delta_id: args.delta_id, status: 'approved' }); } catch { /* 标记失败不阻断晋升 */ }
      }
      let draftFiles = [];
      if (args.op === 'draft' && args.pkg_dir) {
        const { readdirSync, statSync } = await import('node:fs');
        const resDir = join(args.pkg_dir, 'resources');
        const snap = (rel = '') => readdirSync(join(resDir, rel), { withFileTypes: true }).flatMap(e =>
          e.isDirectory() ? snap(`${rel}${e.name}/`) : [`${rel}${e.name}`]);
        try {
          draftFiles = snap().map(p => ({ path: p, content_base64: readFileSync(join(resDir, p)).toString('base64') }));
        } catch (e) {
          if (e.code !== 'ENOENT') throw e; // 没有 resources/ 的包是合法的
        }
      }
      // R5-P1-1（R5-G01）：extraction_file 是边端本地路径，远端内核读不到宿主盘——
      // 发送前读取并转成 extraction_candidates，同时删除 extraction_file。
      // 读取/解析失败与本地内核同码 invalid_extraction_file，绝不静默吞掉。
      const authorArgs = inlineExtractionFile({ ...args, loop: loopArg, ...(boArg ? { business_ontology: boArg } : {}), ...(deltaArg ? { delta: deltaArg } : {}), ...(args.op === 'draft' ? { files: draftFiles } : {}) });
      const result = await kernel.call('aec_author', authorArgs);
      // 图示落盘：plan/draft 的表格版 HTML 写成本地文件（兼容/降级通道）。
      materializeAuthorHtml(result, args.op);
      // AEC 3.1.1：live 页落盘（同一路径覆盖写；回执只给 index.html 路径）。
      materializeAuthorLive(result);
      // AEC 4.0.2：裁决唯一主页面 —— 优先 live，失败才 fallback -plan.html。
      materializeAuthorPage(result);
      materializeLoopTemplate(result); // B-23：open 随回执下发官方契约骨架
      return { content: [{ type: 'text', text: result.message || JSON.stringify(result) }], structuredContent: result };
      } catch (e) {
        const receipt = errorReceipt(e);
        return { isError: true, content: [{ type: 'text', text: receipt.text }], structuredContent: receipt.pub };
      }
    });
  }

  // ---- 5.2.0 O2-01：内置本地记忆域（单入口完整能力，owner 决策 2026-11-27）----
  // 统一工具 aec_local（op 参数化 8 操作），与 --profile local 兼容入口共用
  // src/mks/local-handlers.mjs（单一实现，防漂移）。store 懒加载：首次调用才
  // 判定形态/建库（lite / 判定不过 → 结构化降级回执 host_mks_lite，不建库不落盘）；
  // 建库失败不拖垮任务面。只访问 host-mks.sqlite，绝不触远端 kernel 业务数据。
  {
    let _store = null; let _storeReady = false;
    let _domain = null;
    const getStore = async () => {
      if (_storeReady) return _store;
      _storeReady = true;
      try {
        const { detectLocalHostMode } = await import('./mcp-local.mjs');
        const { HostMksStore, resolveHostMksPath } = await import('./mks/store.mjs');
        const mode = detectLocalHostMode({ env });
        if (mode !== 'node' && mode !== 'sovereign') return null;
        _store = new HostMksStore({ path: resolveHostMksPath({ env }), env: { ...env, AEC_MCP_LOCAL_MEMORY: mode } });
      } catch { _store = null; }
      return _store;
    };
    const getDomain = (store) => _domain ??= createLocalHandlers(store, { env, rerankFn, rerankMeta });
    server._hostMks = { // main() 退出时关闭；测试可经它探测懒建库行为
      getStore,
      close: () => { try { _store?.close(); } catch { /* ignore */ } _store = null; _storeReady = true; },
    };
    ontologyCtx.getStore = getStore; // AEC 5.2：op=ontology 与 aec_local 共用同一 store
    server.registerTool('aec_local', {
      description: '宿主本地记忆/知识基座（Host MKS，host-mks.sqlite）。op=describe 看已沉淀什么（任务前）| recall 按 critic 高分检索上下文（query 用用户原话）| remember 记候选记忆（任务后，只写 candidate）| list/show/edit/forget 管理 | export 导出 bundle 备份。lite 形态（未满足 Node22+/≥2GB 或显式 lite）返回 host_mks_lite 降级回执。',
      inputSchema: {
        op: z.enum(['describe', 'recall', 'remember', 'list', 'show', 'edit', 'forget', 'export'])
          .describe('describe=本地沉淀摘要 recall=检索 remember=记候选 list=列表 show=详情 edit=编辑候选 forget=遗忘 export=导出'),
        aspect: z.enum(['status', 'ontology', 'experience']).optional().describe('op=describe：摘要侧面'),
        query: z.string().optional().describe('op=recall 必填：检索意图/原话'),
        kinds: z.array(z.string()).optional().describe('op=recall：限定 memory kind'),
        top_k: z.number().int().min(3).max(5).optional().describe('op=recall：注入条数 3–5'),
        kind: z.string().optional().describe('op=remember：episodic/semantic/procedural/business/reflective/normative；op=list：按 kind 过滤'),
        summary: z.string().optional().describe('op=remember 必填：记忆要点'),
        title: z.string().optional().describe('op=remember/edit：标题'),
        content: z.record(z.unknown()).optional().describe('op=remember：结构化内容'),
        scope: z.enum(['session', 'project', 'tenant', 'global']).optional().describe('op=remember：作用域'),
        confidence: z.number().min(0).max(1).optional().describe('op=remember/edit：置信度'),
        status: z.string().optional().describe('op=list：按 status 过滤'),
        limit: z.number().int().min(1).max(5000).optional().describe('op=list/export：条数上限'),
        legacy: z.boolean().optional().describe('op=list：true=列无作用域链接的旧数据（隔离区）'),
        object_type: z.enum(['memory', 'business_term', 'preference', 'episode', 'chunk', 'claim', 'element']).optional().describe('op=list：对象类型'),
        memory_id: z.string().optional().describe('op=show/edit/forget 必填：记忆 id'),
      },
    }, async args => {
      const failR = (code, error) => ({ isError: true, content: [{ type: 'text', text: `[aec_local] ${code}: ${error}` }], structuredContent: { code, error } });
      try {
        const op = args.op || 'describe';
        const vErr = validateLocalOp(op, args);
        if (vErr) return failR(vErr.code, vErr.error);
        const store = await getStore();
        const def = getDomain(store)[op];
        return await def.handler(args);
      } catch (e) {
        return failR(e?.code || 'error', e?.message || String(e));
      }
    });
  }
  return server;
}

// --- stdio main (pure remote client) ---------------------------------------
export async function main() {
  const profile = process.argv.includes('--profile', 2) ? process.argv[process.argv.indexOf('--profile', 2) + 1] : 'run';
  requireThat(['run', 'author', 'local'].includes(profile), 'invalid_profile', `未知 profile：${profile}（可选 run/author/local）`);

  // P2-2：`--profile local` = aec_local 宿主本地工具面，独立路径，不建远端
  // kernel、不探测端点、不提示密钥（5.0-R-098）。只访问 host-mks.sqlite。
  if (profile === 'local') {
    const { createLocalMcp, detectLocalHostMode } = await import('./mcp-local.mjs');
    const { HostMksStore } = await import('./mks/store.mjs');
    const { resolveHostMksPath } = await import('./mks/store.mjs');
    const mode = detectLocalHostMode({ env: process.env });
    let store = null;
    if (mode === 'node' || mode === 'sovereign') {
      store = new HostMksStore({ path: resolveHostMksPath(), env: { ...process.env, AEC_MCP_LOCAL_MEMORY: mode } });
    }
    const server = createLocalMcp(store, { env: process.env });
    const close = () => { try { store?.close(); } catch { /* ignore */ } };
    for (const event of ['end', 'close']) process.stdin.once(event, close);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, close);
    await server.connect(new StdioServerTransport());
    return;
  }

  // run profile 免配置：未设 AEC_KERNEL_URL 时回落官方云端（首次连接自动提示）；
  // author 端点公网不可用，resolveEndpoint 强制显式提供。
  const endpoint = resolveEndpoint({ profile });
  if (!process.env.AEC_KERNEL_URL && profile === 'run')
    warn(`未配置 AEC_KERNEL_URL：使用官方云端 ${DEFAULT_KERNEL_URL}（自托管时设置该环境变量覆盖）。`);
  // 密钥模式提示（不阻断启动）：宿主仍可完成 MCP 握手；首次业务调用缺密钥时
  // 回执会指引模型向用户要密钥并经 aec_setup 提交。检测到旧机器绑定 identity.json
  // 时提示迁移（v2.0 不再读取机器绑定令牌）。
  try {
    const legacy = detectLegacyIdentity(join(defaultIdentityDir(), 'identity.json'));
    if (legacy) warn(`检测到旧版机器绑定文件 ${legacy}：v2.0 已改用密钥模式，旧文件不再读取（可删除）；请向管理员索取 aec_key_ 密钥并用 aec_setup 提交。`);
    if (!(process.env.AEC_API_KEY || '').trim() && !loadCredentials(credentialsPath())?.[profile]?.api_key)
      warn(`尚未配置 AEC 密钥：首次调用 aec 时会引导向用户索取密钥（aec_key_ 开头，经 aec_setup 提交），或由宿主 env AEC_API_KEY 注入。`);
  } catch { /* 提示失败不影响启动 */ }

  const rolesDb = new RolesDB(resolveRolesDbPath());
  const kernel = createRemoteKernel({ endpoint, profile, rolesDb });
  // 启动期连通性自检（P1；2.2.0 修订为降级启动）：占位域名已在 validateEndpoint
  // 拒绝（配置错误仍 fail fast）；"域名合法但暂不可达"（内核重启窗口 / VPN·tailnet
  // 断连等**暂态**故障）不再打死 server——2.1.x 的 failOnStartupError 在宿主侧
  // 表现为 `MCP error -32000: Connection closed`，模型毫无解释且必须重启会话才能
  // 恢复（2026-11-27 事故：本机 Tailscale offline → aec-author ECONNREFUSED →
  // Connection closed）。降级启动后 warn 说明原因与恢复路径，调用时 kernel.call
  // 给 typed 网络错误，网络恢复后**无需重启宿主**。任何 HTTP 响应（含 401/404）
  // 即通过；AEC_STARTUP_PROBE=0 可显式跳过探测。
  if (process.env.AEC_STARTUP_PROBE !== '0') {
    try { await probeEndpoint(validateEndpoint(endpoint)); }
    catch (e) {
      warn(`[AEC] 启动自检：内核 ${endpoint} 暂不可达（${e?.code || 'error'}：${e?.cause || e?.message || ''}）。本 server 仍已启动——调用时将收到带指引的网络错误；网络/内核恢复后无需重启宿主即可重试。常见原因：内核服务未运行、VPN/tailnet 断连（如 Tailscale offline）。`);
    }
  }
  const server = createMcpV2(kernel, { profile, endpoint, rolesDb });
  let closing;
  const close = () => closing ??= (async () => { try { server._hostMks?.close(); } catch { /* ignore */ } try { await server.close(); } finally { rolesDb.close(); } })();
  for (const event of ['end', 'close']) process.stdin.once(event, () => { void close(); });
  await server.connect(new StdioServerTransport());
  if (process.stdin.readableEnded || process.stdin.destroyed) void close();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void close(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (e) {
    process.stderr.write(`[aec-mcp] 启动失败：${e.message}（code=${e.code || 'unknown'}）\n`);
    process.exit(1);
  }
}
