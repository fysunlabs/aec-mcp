// Edge-side session materialization, extracted from AEC's session.mjs.
// These functions are deterministic local-file helpers: the kernel never reads
// the host disk, so all fact collection and file layout happens here.
// Kept byte-for-byte in behavior with aec/src/session.mjs §"edge side"; only
// imports are rewired to this standalone package's local modules.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, appendFileSync, renameSync, cpSync } from 'node:fs';
import { join, resolve, isAbsolute, basename, dirname, relative } from 'node:path';
import { now, requireThat } from './util.mjs';
import { resolveParams, renderArgv, expandTemplate, parseRunIf } from './loop.mjs';
import { generateRunners, runnerCommand } from './runner.mjs';
import { renderOpen } from './render.mjs';
import { hostPolicyFromEnv, hostCapabilitiesFromEnv } from './l0.mjs';

const SWEEP_TTL_MS = 24 * 60 * 60 * 1000;
const flat = r => String(r).replaceAll('/', '-');
const dig = (value, path) => String(path || '').split('.').filter(Boolean).reduce((v, key) => (v == null ? undefined : v[key]), value);
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

// Workspace resolution (§8.1c, §11.1): explicit wins, else git root, else cwd.
export function resolveWorkspace(explicit = null, cwd = process.cwd()) {
  let root;
  if (explicit) root = resolve(explicit);
  else {
    root = resolve(cwd);
    let dir = root;
    while (dir !== dirname(dir)) { if (existsSync(join(dir, '.git'))) { root = dir; break; } dir = dirname(dir); }
  }
  const aecDir = join(root, '.aec');
  mkdirSync(join(aecDir, 'sessions'), { recursive: true, mode: 0o700 });
  if (existsSync(join(root, '.git'))) {
    const gi = join(root, '.gitignore');
    const existing = existsSync(gi) ? readFileSync(gi, 'utf8').split('\n').map(l => l.trim()) : [];
    const missing = ['.aec/', 'aec-out/'].filter(e => !existing.includes(e));
    if (missing.length) appendFileSync(gi, missing.join('\n') + '\n');
  }
  return { root, aecDir, sessionsDir: join(aecDir, 'sessions'), outRoot: join(root, 'aec-out') };
}

// Orphan sweep + hint (§11.5, B6).
export function sweepSessions({ sessionsDir, ledgerPath, ttl_ms = SWEEP_TTL_MS }) {
  const hint = { orphan: null, swept: [] };
  let entries = [];
  try { entries = readdirSync(sessionsDir).map(name => join(sessionsDir, name)); } catch { return hint; }
  for (const dir of entries) {
    let stat; try { stat = statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const age = Date.now() - stat.mtimeMs;
    if (age > ttl_ms) {
      appendFileSync(ledgerPath, JSON.stringify({ at: now(), session_id: basename(dir), grade: 'abandoned', reason: 'ttl_sweep' }) + '\n');
      rmSync(dir, { recursive: true, force: true });
      hint.swept.push(basename(dir));
    } else {
      const state = readJson(join(dir, 'state.json'));
      if (state && !hint.orphan) {
        const loop = readJson(join(dir, 'loop.json'));
        hint.orphan = {
          session: state.session, age: age > 3600000 ? `${Math.round(age / 3600000)} 小时前` : `${Math.round(age / 60000)} 分钟前`,
          step: 1, steps: (loop?.steps || []).length, stepId: loop?.steps?.[0]?.id || null,
          dir,
        };
      }
    }
  }
  return hint;
}

// Tool probe (§7.8): read-only execFile of the package's declared probes.
export function probeTools(tools = []) {
  return tools.map(t => {
    try {
      const out = execFileSync(t.probe[0], t.probe.slice(1), { encoding: 'utf8', timeout: 800 });
      const found = (out.split('\n')[0] || '').trim().match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] || 'unknown';
      let status = 'ok';
      if (t.min && found !== 'unknown' && cmpVersion(found, t.min) < 0) status = 'too_old';
      return { name: t.name, status, found, min: t.min || null, required: !!t.required };
    } catch (e) {
      return { name: t.name, status: e.code === 'ENOENT' ? 'missing' : 'unknown', found: null, min: t.min || null, required: !!t.required };
    }
  });
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

// Materialize an open payload into the local session directory and render the
// two exits. This is the aec-mcp half of op=open (§2.2).
export function materializeOpen({ payload, workspace, execPath = process.execPath, keepSessions = false, hostPolicy = null }) {
  requireThat(payload.code === 'match', 'open_failed', payload.code || 'open 失败');
  const loop = payload.loop;
  const ws = resolveWorkspace(workspace);
  const sessionDir = join(ws.sessionsDir, payload.session);
  const aecOut = join(ws.outRoot, loop.id);
  mkdirSync(aecOut, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(sessionDir, 'resources', 'tickets'), { recursive: true });

  const tickets = new Map();
  for (const api of payload.resources.api || []) {
    const file = `tickets/${flat(api.ref)}.ticket`;
    writeFileSync(join(sessionDir, 'resources', file), api.ticket, { mode: 0o600 });
    tickets.set(api.ref, file);
  }
  const assets = new Set();
  for (const f of payload.resources.files || []) {
    const dir = f.stage ? join(sessionDir, 'resources', f.stage) : join(sessionDir, 'resources', 'shared');
    mkdirSync(dir, { recursive: true });
    const dst = join(dir, f.to);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, Buffer.from(f.content_base64, 'base64'), { mode: 0o600 });
    assets.add(f.to);
  }

  const { bind, missing } = resolveParams(loop, payload.params || {}, { outRoot: ws.outRoot, packageId: loop.id });
  requireThat(!missing.length, 'binding_missing', `参数缺绑定：${missing.join(', ')}`, { missing });
  const ctx = { bind, inputs: payload.inputs || {}, assets, tickets, execPath };
  const planSteps = payload.plan?.steps || loop.steps || [];
  const rendered = planSteps.filter(s => s.kind === 'run').map(step => {
    const argv = renderArgv(step.run.argv, ctx);
    const produces = (step.produces || []).map(p => expandTemplate(p, bind));
    const runIf = step.run_if ? parseRunIf(step.run_if) : null;
    return {
      id: step.id, kind: step.kind, argv, cwd: join(sessionDir, 'resources'), produces,
      timeout_ms: 120000, wait: step.run.wait ? renderArgv(step.run.wait, ctx) : undefined,
      needs: step.needs || [],
      run_if_atoms: runIf?.ok ? runIf.atoms : [],
      retry: step.retry, idempotency: step.idempotency,
      artifact_isolation: step.artifact_isolation, side_effect: step.side_effect,
    };
  });
  const effectivePolicy = hostPolicy ?? hostPolicyFromEnv();
  if (effectivePolicy?.denied_argv0?.length) {
    const denied = rendered.filter(s => effectivePolicy.denied_argv0.some(p => String(s.argv.join(' ')).includes(p)));
    if (denied.length) {
      requireThat(false, 'l0_policy_denied',
        `L0 拒绝：步骤 ${denied.map(s => s.id).join('、')} 命中宿主策略禁止的执行来源（${effectivePolicy.denied_argv0.join('、')}）——宿主策略覆盖包契约，先解决策略冲突再重试`,
        { denied_steps: denied.map(s => s.id), policy: 'host_policy' });
    }
  }
  const hostCapabilities = hostCapabilitiesFromEnv();
  const runners = generateRunners({ sessionDir, steps: rendered, sessionId: payload.session, hostCapabilities });

  writeFileSync(join(sessionDir, 'loop.json'), JSON.stringify(loop, null, 2));
  if (payload.goal_frame) writeFileSync(join(sessionDir, 'goal.json'), JSON.stringify(payload.goal_frame, null, 2), { mode: 0o600 });
  if (payload.plan) writeFileSync(join(sessionDir, 'plan.json'), JSON.stringify(payload.plan, null, 2), { mode: 0o600 });
  writeFileSync(join(sessionDir, 'prompt.md'), 'prompt snapshot rendered by aec-mcp\n');
  const manifest = {
    package: { id: loop.id, version: loop.version, digest: payload.package.digest },
    node: { version: process.version, exec_path: execPath },
    files: (payload.resources.files || []).map(f => ({ path: f.to, digest: f.digest, size: f.size })),
    tickets: [...tickets.keys()],
    at: now(),
  };
  writeFileSync(join(sessionDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const state = { session: payload.session, package_id: loop.id, version: loop.version, opened_at: payload.opened_at, bind, out_root: ws.outRoot, aec_out: aecOut, steps_total: loop.steps.length };
  writeFileSync(join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));

  const env = probeTools(loop.tools || []);
  const actions = rendered.map(step => {
    const cmd = runnerCommand(sessionDir, step.id, execPath);
    return { step: step.id, kind: 'exec', argv: cmd.argv, cwd: cmd.cwd, raw_argv: step.argv,
      expect: { exit: 0, produces: step.produces }, then: 'turn' };
  });
  const actionBundle = { list: actions, cwd: join(sessionDir, 'resources'), stage: rendered[0]?.id || null, files: (payload.resources.files || []).map(f => ({ path: f.to, digest: f.digest, size: f.size })), api: (payload.resources.api || []).map(a => ({ ref: a.ref, ticket_file: tickets.get(a.ref), expires_at: a.expires_at })), aecOut };
  const { markdown, structuredContent } = renderOpen({
    session: payload.session, sessionDir, workspace: ws.root, match: { ...payload.match, digest: payload.package.digest },
    loop, env, actions: actionBundle, orphan: null, next: `按第 1 步执行 ${rendered[0]?.id || ''}`,
    goalFrame: payload.goal_frame ?? null, plan: payload.plan ?? null, trust: payload.trust ?? null,
  });
  return { session: payload.session, sessionDir, aecOut, markdown, structuredContent, commands: runners.commands };
}

// Close evidence: facts from report.json (process) and a disk scan (truth).
// Artifact collection: files AND directories (§8.4). produces may declare a
// directory (e.g. `out-drafts/`, `out-visuals/`); existsSync() is true for dirs,
// so a bare readFileSync() throws EISDIR and — with no try/catch — aborts the
// whole close into the "无法自动处理" catch-all. Keep this byte-identical in
// behavior to aec/src/session.mjs artifactFromPath (two edges must not drift):
//   file → { path, size, digest }  |  dir → recursive files + aggregate dir
//   artifact |  read error → { path, missing:true, error:<code> }, never throws.
// Symlinks are not followed (security: never pull arbitrary host paths in).
export function artifactFromPath(path) {
  const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const missing = e => [{ path, missing: true, ...(e?.code ? { error: e.code } : {}) }];
  let st;
  try { st = statSync(path); } catch (e) { return missing(e); }
  if (!st.isDirectory()) {
    try { const bytes = readFileSync(path); return [{ path, size: bytes.length, digest: sha(bytes) }]; }
    catch (e) { return missing(e); }
  }
  const out = []; const pieces = [];
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          const bytes = readFileSync(full); const d = sha(bytes);
          out.push({ path: full, size: bytes.length, digest: d });
          pieces.push(`${relative(path, full)}:${d}`);
        } catch { /* 单文件读失败不连累目录，内核侧如实判失败 */ }
      }
    }
  };
  walk(path);
  pieces.sort();
  out.push({ path, kind: 'directory', file_count: out.length,
    size: out.reduce((s, a) => s + (a.size || 0), 0),
    digest: 'sha256:' + createHash('sha256').update(pieces.join('\n')).digest('hex') });
  return out;
}

export function collectCloseEvidence({ sessionDir, loop }) {
  const report = readJson(join(sessionDir, 'run', 'report.json')) || { steps: [] };
  const state = readJson(join(sessionDir, 'state.json')) || {};
  const goalFrame = readJson(join(sessionDir, 'goal.json'));
  const plan = readJson(join(sessionDir, 'plan.json'));
  const bind = state.bind || {};
  const artifacts = []; const fields = {}; const counts = {}; const durations = {}; const files = {};
  const seen = new Set();
  const inSession = pp => (isAbsolute(pp) ? pp : join(sessionDir, pp));
  for (const step of loop.steps || []) {
    for (const produce of step.produces || []) {
      const path = inSession(expandTemplate(produce, bind));
      if (seen.has(path)) continue;
      seen.add(path);
      artifacts.push(...artifactFromPath(path));
    }
  }
  for (const c of loop.checks || []) {
    if (!c.path) continue;
    const path = inSession(expandTemplate(c.path, bind));
    if (!existsSync(path)) continue;
    const art = artifacts.find(a => a.path === path);
    if (art) { art.checks = art.checks || []; art.checks.push(c.id); }
    if (c.evidence === 'field') {
      let value;
      try {
        const raw = readFileSync(path, 'utf8');
        if (c.field) { const doc = JSON.parse(raw); value = dig(doc, c.field); }
        else value = raw;
      } catch { value = undefined; }
      if (value !== undefined && value !== null && value !== '') fields[c.id] = String(value);
    }
    if (c.evidence === 'file' || c.type === 'lint' || c.type === 'json_shape') {
      try {
        const bytes = readFileSync(path);
        if (bytes.length <= 256 * 1024) files[c.id] = bytes.toString('utf8');
      } catch { /* 读不到就缺证据，内核侧如实判失败 */ }
    }
  }
  for (const s of report.steps || []) if (s.ms !== undefined) durations[`${s.id}.ms`] = s.ms;
  return { report, artifacts, fields, counts, durations, files, ...(goalFrame ? { goal_frame: goalFrame } : {}), ...(plan ? { plan } : {}) };
}

// W23: close archives instead of deleting.
export function edgeCleanup({ sessionDir, ledgerPath, result }) {
  const state = readJson(join(sessionDir, 'state.json')) || {};
  appendFileSync(ledgerPath, JSON.stringify({
    at: now(), session_id: basename(sessionDir), package_id: state.package_id || null, grade: result.grade,
    checks_passed: (result.checks || []).filter(c => c.passed === true).length, checks_total: (result.checks || []).length,
    artifacts: (result.artifacts || []).map(a => a.path),
  }) + '\n');
  const aecDir = dirname(join(sessionDir, '..'));
  const archiveDir = join(aecDir, 'archive', basename(sessionDir));
  mkdirSync(dirname(archiveDir), { recursive: true, mode: 0o700 });
  if (existsSync(archiveDir)) rmSync(archiveDir, { recursive: true, force: true });
  try { renameOrCopy(sessionDir, archiveDir); } catch { /* 归档失败不阻断 close 结果返回 */ }
  return { archived: archiveDir, removed: null, removed_confirmed: !existsSync(sessionDir) };
}

function renameOrCopy(from, to) {
  try { renameSync(from, to); }
  catch { cpSync(from, to, { recursive: true }); rmSync(from, { recursive: true, force: true }); }
}
