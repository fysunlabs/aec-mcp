// aec-mcp — open-source stdio MCP client for AEC kernels.
// Pure remote client: no kernel code, no local DB of packages. Business ops go
// through the hardened HTTP transport; only identity + edge file layout lives here.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, basename, resolve, sep } from 'node:path';
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

const readJson = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// session → workspace 指针（机器级，§10.1 身份旁）：close/turn 只有 {op,session}，
// 不带 workspace（§8.1）。正常情况下 MCP 进程 cwd 稳定、两边解析一致；进程换了
// cwd 或重启后，用这份索引兜底找回现场目录。
const SESSION_INDEX = () => join(defaultIdentityDir(), 'sessions-index.json');
const indexGet = session => readJson(SESSION_INDEX())?.[session] ?? null;
const indexPut = (session, workspace) => {
  try {
    const p = SESSION_INDEX();
    mkdirSync(join(p, '..'), { recursive: true, mode: 0o700 });
    const doc = readJson(p) || {};
    doc[session] = workspace;
    writeFileSync(p, JSON.stringify(doc), { mode: 0o600 });
  } catch (e) {
    // 指针失败不阻断任务，但必须可观测：丢指针意味着进程重启后 close/turn 找不回现场。
    warn(`会话指针写入失败（sessions-index.json）：${e.message} —— 任务继续，进程重启后现场找回将退化为 cwd 推断。`);
  }
};
const wsFor = (args) => resolveWorkspace(args.workspace ?? indexGet(args.session) ?? null);


// The edge half of the aec/v2 tool. `kernel` is anything with .call(name, args).
// 密钥模式（2026-11-19）：身份由传输层的 Bearer api_key 承载（内核从身份强制注入
// host_id/tenant），边端不再传 host_id，也不再持有 identity 回调。
export function aecEdgeHandlers(kernel) {
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
      const payload = await kernel.call('aec', { op: 'open', intent: args.intent, experience_ref: refArg, trial_of: args.trial_of, ...(args.query ? { query: args.query } : {}) });
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
      indexPut(payload.session, mat.sessionDir.split('/.aec/')[0]);
      if (sweep.orphan) {
        mat.markdown = `[AEC] 上次有个未完成的会话（${sweep.orphan.age}，${sweep.orphan.steps} 步）——\n      如果用户这次讲的是同一件事，先说一句"上次没跑完，要不要接着做"；否则忽略这句。\n\n${mat.markdown}`;
        mat.structuredContent.orphan = { session: sweep.orphan.session, age: sweep.orphan.age };
      }
      // 阶段横幅放在最前面：模型每次回执都被重述"这轮是验证，不是交付"。
      if (trialRoot) {
        mat.markdown = `【试用 · 阶段 4/5 · 不是交付】产物写入沙箱 ${ws.root}（不在用户项目里，验证完即弃）。${args.workspace ? `\n      · 你给的 workspace=${args.workspace} 已被忽略：试用不允许写真实项目目录。` : ''}\n      · 这轮只证明循环能跑通；不要把它当成为用户实施，也不要改用户真实目录。\n      · 跑完 close 拿 grade；authoritative 才能回 author 侧 publish。\n\n${mat.markdown}`;
        mat.structuredContent.trial = { of: args.trial_of, sandbox: ws.root, delivery: false, ...(args.workspace ? { ignored_workspace: args.workspace } : {}) };
      }
      return { content: [{ type: 'text', text: mat.markdown }], structuredContent: mat.structuredContent };
    },
    async close(args) {
      if (!args.session) return { isError: true, content: [{ type: 'text', text: '[AEC] 没有进行中的会话：直接重新 open 即可（open 没建会话的场景——no_match/ambiguous——无需 close）。' }] };
      const ws = wsFor(args);
      const sessionDir = join(ws.sessionsDir, args.session);
      const loop = readJson(join(sessionDir, 'loop.json'));
      if (!loop) return { isError: true, content: [{ type: 'text', text: `[AEC] 会话 ${args.session} 的现场不存在（可能已清理）。如需重做请重新 open。` }] };
      const evidence = collectCloseEvidence({ sessionDir, loop });
      // W25（§16.4 L0 运行期）：report 里出现命中宿主策略 denied_argv0 的步骤 →
      // host_policy_violated=true → 内核 grade 走 A2 abandoned（安全优先于兼容）。
      const l0Violation = detectPolicyViolation(evidence.report, hostPolicyFromEnv());
      if (l0Violation) evidence.host_policy_violated = true;
      const result = await kernel.call('aec', { op: 'close', session: args.session, status: args.status, evidence, ...(args.acceptance !== undefined ? { acceptance: args.acceptance } : {}) });
      const cleanup = result.cleanup?.removed === null
        ? { removed: null }
        : edgeCleanup({ sessionDir, ledgerPath: join(ws.aecDir, 'ledger.jsonl'), result: { ...result, ...readJson(join(sessionDir, 'state.json')) } });
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
      return { content: [{ type: 'text', text: markdown }], structuredContent: { ...structuredContent, package_id: readJson(join(sessionDir, 'state.json'))?.package_id ?? null } };
    },
    async turn(args) {
      if (!args.session) return { isError: true, content: [{ type: 'text', text: '[AEC] 缺少会话 id：回执里的"会话 ses_…"就是它，不要自己编。没有会话就先 open。' }] };
      const ws = wsFor(args);
      const sessionDir = join(ws.sessionsDir, args.session);
      const loop = readJson(join(sessionDir, 'loop.json'));
      if (!loop) return { isError: true, content: [{ type: 'text', text: `[AEC] 会话 ${args.session} 的现场不存在。重新 open。` }] };
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
      const ws = resolveWorkspace(args.workspace ?? null);
      const sessionDir = join(ws.sessionsDir, args.session);
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
  };
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

export function createMcpV2(kernel, { profile = 'run', endpoint = null, credentialsFile = null, env = process.env, rolesDb = null } = {}) {
  const server = new McpServer({ name: 'aec-mcp', version: '2.0.0' },
    { instructions: profile === 'author'
      ? '经验包创作。仅当用户明确要求"用 AEC 做一个经验包/技能"时调用。五阶段，内核按门推进：open（八维需求卡 + 资源需求）→ learn（本库检索，可选）→ plan（HTML 一页：三张图 + 资源表 + 判据表，必须打开给用户看并确认）→ draft（A/D 门，登记草稿）→ 试用（沙箱里跑，不是交付）→ publish（四门 + 用户明确许可）。图示一律用内核给的 HTML 文件展示，不要贴 mermaid 源码。回执第一行的阶段横幅就是当前该做什么、不许做什么。'
      : '经验包下发。仅当用户明确要求"使用/调用 AEC"时调用；其余情况不要调用。op=open 时把用户原话传给 intent。' });
  const handlers = aecEdgeHandlers(kernel);
  server.registerTool('aec', {
    description: profile === 'author'
      ? '试用草稿专用（author 工作流的第 4/5 步）。仅在 aec_author draft 返回 trial_ref 后调用：op=open 带 experience_ref 与 trial_of 跑真实试用，op=close 取得 authoritative 证据。试用产物写在独立沙箱（~/.aec-trials/…），不写用户项目；这是验证，不是给用户实施。不要用它处理普通任务——普通任务用 run profile 的 aec。'
      : '经验包下发。仅当用户明确要求"使用/调用 AEC"时调用；其余情况不要调用。op=open 时把用户原话传给 intent。',
    inputSchema: {
      op: z.enum(['open', 'resource', 'turn', 'close']).describe('open=开始任务 resource=取材料 turn=失败或提问 close=结束'),
      intent: z.string().optional().describe('op=open 必填：用户原话，不改写、不总结'),
      session: z.string().optional().describe('open 之外必填'),
      workspace: z.string().optional().describe('可选：产物根目录；不传由 aec-mcp 决定。带 trial_of 的试用一律用沙箱，此参数被忽略'),
      stage: z.string().optional(), trigger: z.string().optional(), want: z.string().optional(),
      note: z.string().optional(), ask: z.string().optional(), answer: z.string().optional(),
      status: z.enum(['done', 'abandoned']).optional(),
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
        op: z.enum(['open', 'learn', 'plan', 'draft', 'publish']),
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
      const authorArgs = inlineExtractionFile({ ...args, loop: loopArg, ...(args.op === 'draft' ? { files: draftFiles } : {}) });
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
  return server;
}

// --- stdio main (pure remote client) ---------------------------------------
export async function main() {
  const profile = process.argv.includes('--profile', 2) ? process.argv[process.argv.indexOf('--profile', 2) + 1] : 'run';
  requireThat(['run', 'author'].includes(profile), 'invalid_profile', `未知 profile：${profile}（可选 run/author）`);
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
  // 启动期连通性自检（P1）：占位域名已在 validateEndpoint 拒绝；这里补"域名合法
  // 但不可达"——任何 HTTP 响应（含 401/404/5xx）即通过，只有连接层失败才退出，
  // 让宿主 failOnStartupError 的语义真正落地。AEC_STARTUP_PROBE=0 可显式跳过。
  if (process.env.AEC_STARTUP_PROBE !== '0') await probeEndpoint(validateEndpoint(endpoint));
  const server = createMcpV2(kernel, { profile, endpoint, rolesDb });
  let closing;
  const close = () => closing ??= (async () => { try { await server.close(); } finally { rolesDb.close(); } })();
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
