// aec.loop/v2 — the 2.0 package contract (design §12).
//
// One module owns everything the loop format needs:
//   ① the zod schema (what a loop.json may contain)
//   ② validateLoop / gateA / gateB — structural gates with fix-it hints
//     (every error names the field to change, never "schema invalid")
//   ③ resolveParams + renderArgv — THE single rendering source (plan §5.1).
//     The Markdown command, actions[].argv and params.json are three views of
//     one rendered object; this module is the only place that substitutes
//     {{param}} / $input: / $asset: / $ticket:, and the only place `node`
//     becomes process.execPath. User input never reaches a command line:
//     $input: values become single argv elements handed to execFile.
//
// `$from:` is forbidden (D2): step data travels through files, so a step reads
// the previous step's output file itself.
import { z } from 'zod';
import { join } from 'node:path';
import { requireThat } from './util.mjs';
import { bindTemplate, resolveBind } from './params.mjs';

export const LOOP_SCHEMA = 'aec.loop/v2';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
// 9th type `lint` (rev.3 §8.3): "does this produced loop.json pass the named
// gates + authoring lint" — the kernel already owns lint.mjs, so the check is
// a thin adapter, not an author-invented type.
//
// 词表与引擎必须一一对应（2026-11-10）：一个 check type 只有在内核真的有
// evaluator 时才算"机器判据"，否则作者按合法词表写契约、却在最后一步被判
// 不及格——那是审核点在骗人，不是审核严。所以类型分两类：
//   MACHINE     能给出 true/false 的判据（participant in grading）
//   OBSERVATION 只能记录观测值（manual/duration），不参与判级
const MACHINE_CHECK_TYPES = ['file', 'hash', 'similarity', 'contains', 'json_shape', 'count', 'lint'];
const OBSERVATION_CHECK_TYPES = ['manual', 'duration'];
const CHECK_TYPES = [...MACHINE_CHECK_TYPES, ...OBSERVATION_CHECK_TYPES];
const INPUT_INLINE_LIMIT = 2048; // bytes (D12)

const text = z.string();
const ref = z.object({ id: text, version: text, digest: text.optional() });
// Strict everywhere: an author typo must be an error, not a silently dropped key.
const obj = shape => z.object(shape).strict();

// v2 step/check shapes，导出给 loop-v3.mjs 以同一字面量派生 v3 字段集（W1）。
// 提取是纯重构：obj(shape) 的语义与原来的内联写法完全一致。
export const V2_STEP_SHAPE = {
  id: text.regex(ID), kind: z.enum(['run', 'produce']),
  instruction: text.min(1),
  watch_out: z.array(text).default([]),
  // 可选步骤（解僵化第一条）：宿主判断这一版不需要它时可以跳过，跳过必须留
  // 证据（<step>.skip.mjs 写 {skipped:true}），否则内核分不清"故意跳过"与
  // "还没做"。跳过的可选步不影响完成判定。
  // optional/idempotent 用 .optional() 而非 .default(false)：zod default 会把
  // false 注入归一化结果，所有存量包的 digest 随之改变——已发布版本会撞
  // immutable_version（2026-11-10 部署实测）。省略 = false，语义由消费方兜底。
  optional: z.boolean().optional(),
  // 条件步骤：只读前序步骤事实的受限布尔表达式（见 parseRunIf）。语义由边端
  // runner 求值，不由模型申报——模型申报条件成立就等于模型申报事实。
  run_if: text.min(3).optional(),
  // 有限重试：写在契约里，编译进 runner（不是"让模型重试"，那是 B-9 42 次调用的
  // 来源）。重试会重复副作用，因此必须同时声明 idempotent:true（gateA 强制）。
  retry: obj({
    max: z.number().int().min(2).max(5),
    on: z.array(z.number().int()).default([]),
    backoff_ms: z.number().int().min(0).max(60000).default(0),
  }).optional(),
  idempotent: z.boolean().optional(),
  run: obj({
    argv: z.array(text).min(1),
    // Optional follow-up command for long tasks that submit an async job
    // (§7.9.3): when declared and the slice elapses, the runner emits
    // <step>.wait.mjs and records `pending` instead of failing.
    wait: z.array(text).optional(),
    // B-13：步骤预算（runner 已按它生成 timeout_ms，schema 却没声明——strict 下
    // 作者声明长预算步骤会被拒）。1000s 上限罩住 runner 参数校验。
    timeout_ms: z.number().int().min(1000).max(600000).optional(),
  }).optional(),
  done_when: text.min(1),
  produces: z.array(text).default([]),
  needs: z.array(text).default([]),
};

export const V2_CHECK_SHAPE = {
  id: text.regex(ID), type: z.enum(CHECK_TYPES),
  path: text.optional(), min_bytes: z.number().int().optional(), max_bytes: z.number().int().optional(),
  equals: text.optional(),
  field: text.optional(), expect_from: text.optional(), min_overlap: z.number().min(0).max(1).optional(),
  all_of: z.array(text).optional(), any_of: z.array(text).optional(), none_of: z.array(text).optional(),
  schema: z.unknown().optional(),
  min: z.number().optional(), max: z.number().optional(),
  min_ms: z.number().optional(), max_ms: z.number().optional(),
  prompt: text.optional(),
  where: z.enum(['host', 'kernel']).default('host'),
  evidence: z.enum(['digest', 'field', 'file']).default('digest'),
  // lint-only params (rev.3): which gates the produced loop must pass and how
  // many lint warnings are tolerated (0 = the produced package must be clean).
  gates: z.array(z.enum(['A', 'B', 'C', 'D'])).optional(),
  max_warnings: z.number().int().min(0).optional(),
};

export const loopSchema = obj({
  schema: z.literal(LOOP_SCHEMA),
  id: text.regex(ID), version: text.regex(SEMVER),
  title: text.min(1), tier: z.enum(['S', 'M', 'L']),
  when: obj({
    description: text.min(1),
    requires_inputs: z.array(text).default([]),
    not_for: z.array(text).default([]),
  }),
  inputs: z.record(text, obj({
    required: z.boolean().default(true), kind: z.enum(['text', 'file', 'url']).default('text'),
    max_chars: z.number().int().positive().optional(), description: text.default(''),
  })).default({}),
  params: z.array(obj({
    id: text.regex(ID), default: text.optional(), description: text.default(''),
    // B-2 (decided 2026-11-08): an output-prefix parameter is bound to the
    // absolute artifact prefix `<out-root>/<package-id>/<value>` so produces
    // expand to absolute paths and close() scans them directly.
    scope: z.enum(['output_prefix']).optional(),
  })).default([]),
  steps: z.array(obj(V2_STEP_SHAPE)).min(1),
  checks: z.array(obj(V2_CHECK_SHAPE)).default([]),
  resources: obj({
    shared: z.array(obj({ ref: text, kind: z.enum(['helper', 'skill', 'template']), to: text })).default([]),
    stages: z.record(text, z.array(obj({
      ref: text, kind: z.enum(['helper', 'skill', 'template', 'api', 'reference']),
      provider: text.optional(), endpoint: text.optional(), method: text.optional(), auth: text.optional(),
    })).default([])).default({}),
    on_error: z.array(obj({
      when: text, hint: text.min(1), reload: z.array(text).default([]), load: z.array(text).default([]),
    })).default([]),
    on_demand: z.array(obj({ ref: text, kind: z.enum(['reference', 'helper', 'template']) })).default([]),
  }).default({}),
  tools: z.array(obj({
    name: text, probe: z.array(text).min(1), min: text.optional(),
    required: z.boolean().default(true), why: text.optional(),
  })).default([]),
  ask_user: z.array(obj({
    when: text.min(1), question: text.min(1), blocks: z.array(text).default([]),
  })).default([]),
  limits: obj({ steps: z.number().int().positive().optional(), minutes: z.number().int().positive().optional() }).default({}),
  provenance: obj({ license: text.min(1), source: text.min(1), evaluation: text.default('') }),
});

// zod issues say "String must contain..." — meaningless to an author. Every gate
// failure is re-stated as "which field, what to change" (plan P0-1 acceptance).
export function validateLoop(loop) {
  // 主文档 §7.1 / 验收 a164·a124：旧（v2）读取器遇到 aec.loop/v3 包必须报
  // schema_revision_unsupported——不得落成通用 schema 错误（否则作者无法分辨
  // "字段写错了"与"读取器太旧"）。
  if (loop && typeof loop === 'object' && loop.schema === 'aec.loop/v3') {
    const rev = loop.schema_revision ?? '(缺省按 3.0)';
    return {
      ok: false,
      errors: [{
        path: 'schema',
        code: 'schema_revision_unsupported',
        message: `这份包是 aec.loop/v3（schema_revision=${rev}）：当前 v2 边端只读 v2 包。把 v3 交给支持 schema_revision 的读取器，或继续用 v2 发布`,
        hint: '升级边端到 aec.loop/v3 读取器；v3 包按 schema_revision 分支读取，不是 v2 字段错误',
      }],
      loop: null,
    };
  }
  const errors = [];
  const parsed = loopSchema.safeParse(loop);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({ path: issue.path.join('.'), code: 'loop_schema_invalid', message: describeIssue(loop, issue) });
    }
  }
  const value = parsed.success ? parsed.data : loop;
  errors.push(...gateA(value).filter(e => !parsed.success || true));
  return { ok: errors.length === 0, errors, loop: parsed.success ? parsed.data : null };
}

// Normalize = "what the runtime is allowed to assume". zod's `.default([])` only
// fills the PARSED copy, so a loop stored raw can still miss every optional array
// (`when.not_for`, `checks`, `resources`, …) while passing the gates — which is
// exactly how B-17's `.join` crash happened. Anything that stores a loop should
// store this normalized form; anything that only compares digests should hash
// the author's bytes.
export function normalizeLoop(loop) {
  const { ok, loop: parsed } = validateLoop(loop);
  return ok ? parsed : loop;
}

function describeIssue(loop, issue) {
  const path = issue.path.join('.');
  if (issue.code === 'invalid_literal') return `字段 ${path} 必须是 "${issue.expected}"：把 ${path} 改成 ${issue.expected}（这是契约标识，不是可选项）`;
  if (issue.code === 'invalid_type') {
    const want = String(issue.expected || 'expected');
    const got = issue.received === 'undefined' ? '缺失' : `得到 ${issue.received}`;
    return `字段 ${path} 类型不对：需要 ${want}，${got}。补上或改正 ${path}`;
  }
  if (issue.code === 'unrecognized_keys') return `字段 ${issue.path.join('.')} 里有未声明的键：${issue.keys.join(', ')}。删掉它们，或改用契约里存在的字段`;
  return `字段 ${path} 不符合契约：${issue.message}`;
}

// --- step-level condition language (run_if) ----------------------------------
//
// 只支持"与前序步骤事实"的合取，刻意不含 ||、括号、函数调用：
//    expr := atom ('&&' atom)*
//    atom := ['!'] ( 'steps.<id>.ok' | 'steps.<id>.failed' | 'steps.<id>.skipped'
//                  | 'exists:<相对路径>' | 'env:<NAME>' )
//
// 为什么要限定这么死：条件必须能被静态检查（引用的步骤存在且更早）、能被
// 边端确定求值（事实来自 report.json 与磁盘），否则"条件是否成立"就只能由
// 模型口头判断——那正好是这套系统最不该依赖的东西。需要或/嵌套时，作者应当
// 拆成两步或用 optional + 宿主判断。
const RUN_IF_ATOM = /^(?:steps\.([A-Za-z0-9][A-Za-z0-9._-]*)\.(ok|failed|skipped)|exists:([^\s]+)|env:([A-Za-z_][A-Za-z0-9_]*))$/;

export function parseRunIf(expr) {
  const raw = String(expr ?? '').trim();
  if (!raw) return { ok: false, error: 'run_if 是空表达式' };
  if (/[|()]/.test(raw)) return { ok: false, error: 'run_if 只支持 && 连接的单层条件，不支持 || 或括号' };
  const atoms = [];
  for (const part of raw.split('&&')) {
    let atom = part.trim();
    if (!atom) return { ok: false, error: `run_if 里有空条件：${raw}` };
    const negate = atom.startsWith('!');
    if (negate) atom = atom.slice(1).trim();
    const m = atom.match(RUN_IF_ATOM);
    if (!m) return { ok: false, error: `run_if 片段无法解析：${atom}（可用 steps.<id>.ok|failed|skipped、exists:<路径>、env:<变量>）` };
    atoms.push({
      negate,
      kind: m[1] ? 'step' : m[3] !== undefined ? 'exists' : 'env',
      step: m[1] || null,
      field: m[2] || null,
      target: m[1] || m[3] || m[4] || null,
    });
  }
  return { ok: true, atoms };
}

// Gate A — executable (§13.5). Structural, no run needed. Returns issue list.
export function gateA(loop) {
  const issues = [];
  const push = (code, message, hint) => issues.push({ code, message, hint });
  const shared = new Set((loop.resources?.shared || []).map(r => r.to));
  const stageRefs = new Map();
  for (const [stepId, list] of Object.entries(loop.resources?.stages || {})) {
    for (const r of list || []) {
      if (r.to) stageRefs.set(`${stepId}:${r.to}`, r);
      if (r.kind === 'api') stageRefs.set(`api:${r.ref}`, r);
    }
  }
  const stepIds = new Set((loop.steps || []).map(s => s.id));
  for (const stageKey of Object.keys(loop.resources?.stages || {})) {
    if (!stepIds.has(stageKey)) push('not_executable', `resources.stages 引用不存在的步骤 ${stageKey}`, `把 stages.${stageKey} 改成已有步骤的 id，或挪进 resources.shared`);
  }
  for (const step of loop.steps || []) {
    if (!['run', 'produce'].includes(step.kind)) { push('not_executable', `step ${step.id}: kind 必须是 run 或 produce`, `把 steps[id=${step.id}].kind 改成 "run" 或 "produce"`); continue; }
    if (!step.done_when) push('not_executable', `step ${step.id}: 缺 done_when`, `给 steps[id=${step.id}] 加一句可判定的完成标志 done_when`);
    if (step.kind === 'run') {
      if (!step.run?.argv?.length) { push('not_executable', `step ${step.id}: run 步骤缺 run.argv`, `给 steps[id=${step.id}].run.argv 写要执行的命令（argv 数组）`); continue; }
      for (const a of step.run.argv) {
        const token = String(a);
        if (token.startsWith('$from:')) push('not_executable', `step ${step.id}: argv 含 $from:（2.0 禁止）`, `删掉 ${token}：把上一步输出写成文件，本步脚本自己读该文件（步骤间只传文件）`);
        if (token.startsWith('$asset:')) {
          const p = token.slice(7);
          if (!shared.has(p) && ![...stageRefs.keys()].some(k => k.endsWith(`:${p}`) && k.startsWith(`${step.id}:`)))
            push('not_executable', `step ${step.id}: $asset:${p} 没有在 resources.shared 或本步 stages 里声明`, `在 resources.shared 加 {ref:"${p}", kind:"helper", to:"${p}"}，或放进 steps[id=${step.id}] 的 stages`);
        }
        if (token.startsWith('$ticket:')) {
          const r = token.slice(8);
          if (!stageRefs.has(`api:${r}`)) push('not_executable', `step ${step.id}: $ticket:${r} 没有对应 kind:"api" 资源`, `在 steps[id=${step.id}] 的 stages 里加 {ref:"${r}", kind:"api", provider:"..."}`);
        }
      }
    }
    if (step.kind === 'produce' && !(step.produces || []).length)
      push('not_executable', `step ${step.id}: produce 步骤缺 produces`, `给 steps[id=${step.id}].produces 列出要产出的文件`);
    for (const n of step.needs || []) if (!stepIds.has(n)) push('not_executable', `step ${step.id}: needs 引用不存在的步骤 ${n}`, `把 needs 里的 ${n} 改成已存在的步骤 id`);
  }
  for (const [key, r] of stageRefs) if (key.includes(':') && r.kind !== 'api' && !key.startsWith('api:')) {
    const [stepId, to] = [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)];
    if (!stepIds.has(stepId)) push('not_executable', `resources.stages 引用不存在的步骤 ${stepId}（${to}）`, `把 stages.${stepId} 改成已有步骤的 id，或挪进 resources.shared`);
  }
  return issues;
}

// Gate B — verifiable (§13.5): at least one machine check, at least one kernel
// check, and every type comes from the 8-template directory.
export function gateB(loop) {
  const issues = [];
  for (const c of loop.checks || []) {
    if (!CHECK_TYPES.includes(c.type)) issues.push({ code: 'not_verifiable', message: `check ${c.id}: type "${c.type}" 不在 9 种模板内`, hint: `把 checks[id=${c.id}].type 换成 file/hash/similarity/contains/json_shape/count/duration/manual/lint 之一` });
    if (c.type === 'manual') issues.push({ code: 'not_verifiable', message: `check ${c.id}: manual 不满足 B 门（机器判不了）`, hint: '保留 manual 作附加观测，但至少再加一条 file/similarity/contains 等机器判据且 where:"kernel"' });
    if (c.type === 'duration') issues.push({ code: 'not_verifiable', message: `check ${c.id}: duration 只能 where:"host"（AEC 测不到宿主时延）`, hint: '保留作附加观测，另加一条 where:"kernel" 的机器判据' });
  }
  const kernel = (loop.checks || []).some(c => c.where === 'kernel' && !['manual', 'duration'].includes(c.type));
  if (!(loop.checks || []).length) issues.push({ code: 'not_verifiable', message: '没有任何判据（checks 为空）', hint: '至少加一条机器判据，其中一条 where:"kernel"' });
  else if (!kernel) issues.push({ code: 'not_verifiable', message: '没有一条 where:"kernel" 的机器判据（AEC 无法复算）', hint: '把最关键的一条判据设为 where:"kernel"、evidence:"field" 或 "file"' });
  // B-12 续：空洞 kernel 判据不算数（实测 x-search@1.0.8 用 {type:'contains',where:'kernel'}
  // 无 path/all_of 骗过 B 门）——kernel 判据必须带可复算字段。
  const NEEDS_TARGET = ['file', 'hash', 'similarity', 'contains', 'json_shape', 'count'];
  for (const c of loop.checks || []) {
    if (c.where !== 'kernel' || !NEEDS_TARGET.includes(c.type)) continue;
    if (!c.path) issues.push({ code: 'not_verifiable', message: `check ${c.id}: kernel ${c.type} 缺 path（判据对象不明，AEC 无法复算）`, hint: `给 checks[id=${c.id}] 补 path（产物相对路径）；contains 另需 all_of/any_of 关键词` });
    if (c.type === 'contains' && !c.all_of?.length && !c.any_of?.length)
      issues.push({ code: 'not_verifiable', message: `check ${c.id}: kernel contains 缺 all_of/any_of（不含任何关键词=恒真）`, hint: `给 checks[id=${c.id}] 补 all_of:["..."] 或 any_of` });
  }
  return issues;
}

// --- parameter binding (P0-2) -------------------------------------------------

// Bind declared params to concrete values. `outRoot`+`packageId` turn
// scope:"output_prefix" params into absolute artifact prefixes (B-2 decision).
export function resolveParams(loop, given = {}, { outRoot, packageId } = {}) {
  const { bind, missing } = resolveBind(loop.params || [], given);
  for (const p of loop.params || []) {
    if (p.scope === 'output_prefix' && bind[p.id] !== undefined && outRoot && packageId)
      bind[p.id] = join(outRoot, packageId, String(bind[p.id]));
  }
  return { bind, missing };
}

// Expand {{param}} in non-argv strings (done_when, check paths, produces).
export function expandTemplate(value, bind) {
  const { value: out, unresolved } = bindTemplate(value, bind);
  requireThat(unresolved.length === 0, 'binding_missing', `占位符 {{${unresolved[0]}}} 没有绑定值：补 params 或 intent`, { unresolved });
  return out;
}

// --- argv rendering: the single source (plan §5.1) ----------------------------
//
// ctx = {
//   bind:      resolved param values (absolute already where scope demands),
//   inputs:    {name: stringValue} from the user's original words,
//   assets:    Set of declared resource targets ("scripts/resolve.mjs"),
//   tickets:   Map api-ref -> ticket file path relative to resources/,
//   execPath:  process.execPath,
//   inputLimit: inline byte limit for $input: (default 2048, D12),
// }
export function renderArgv(argv, ctx) {
  const { bind, inputs = {}, assets = new Set(), tickets = new Map(), execPath, inputLimit = INPUT_INLINE_LIMIT } = ctx;
  requireThat(execPath, 'render_ctx_invalid', 'renderArgv 需要 execPath（process.execPath），不允许裸 node');
  // B-12 续：$input: 支持"独立元素"之外的串内出现（如 query 嵌进 ssh 远端 shell 的
  // JSON 体里——x-search@1.0.9 的真实需求）。逐处替换并做同样的缺失/超限检查。
  const substInputs = token => token.replace(/\$input:(\w+)/g, (_, name) => {
    const value = inputs[name];
    requireThat(value !== undefined && value !== null && String(value).length > 0, 'input_missing',
      `$input:${name} 在本次 intent 里没有值：向用户要材料，不要猜`, { input: name });
    const bytes = Buffer.byteLength(String(value), 'utf8');
    if (bytes > inputLimit) requireThat(false, 'input_too_large',
      `$input:${name} 有 ${bytes} 字节，超过 ${inputLimit} 内联上限：应落成文件后把路径作为参数（D12）`, { input: name, bytes });
    return String(value);
  });
  return argv.map((raw, index) => {
    let token = expandTemplate(String(raw), bind);
    if (token.includes('$input:')) {
      token = substInputs(token);
      if (index !== 0) return token; // 串内替换完成；独立元素（startsWith 形态）已在此覆盖
    }
    if (token.startsWith('$asset:')) {
      const p = token.slice(7);
      requireThat(assets.has(p), 'asset_undeclared', `$asset:${p} 未在 shared/stages 声明，无法投递`, { asset: p });
      return join('shared', p); // 相对 cwd=<session>/resources/（§7.5）
    }
    if (token.startsWith('$ticket:')) {
      const r = token.slice(8);
      const file = tickets.get(r);
      requireThat(file, 'ticket_unavailable', `$ticket:${r} 没有可用的票据文件`, { api: r });
      return file;
    }
    requireThat(!token.startsWith('$from:'), 'from_forbidden',
      `argv 含 $from: —— 2.0 已删除该占位符：把上一步输出写成文件，本步脚本读文件（${token}）`, { token });
    return index === 0 && token === 'node' ? execPath : token; // §5.5：裸 node 一律 execPath
  });
}

export { CHECK_TYPES, INPUT_INLINE_LIMIT };
