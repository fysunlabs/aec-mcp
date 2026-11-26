// 试用会话现场定位回归（Windows 路径往返 / 零副作用 / open→close→turn）
// 全部用临时目录 + fake kernel，确定性、不联网、不碰真实 mcp.json 指向的索引。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { aecEdgeHandlers, indexPut, locateSession, sessionSceneNotFound, maskHomePath, markSessionClosed } from '../src/mcp.mjs';

const SES = 'ses_384b4e91-ad28-4a34-82b5-4de38bb54d92';
const OTHER = 'ses_0cd405e0-0225-4a32-9cdb-14872f4107bd';

function envSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'ses-locate-'));
  const identity = join(root, 'identity');
  const trials = join(root, 'trials');
  mkdirSync(identity, { recursive: true });
  mkdirSync(trials, { recursive: true });
  const prev = { AEC_IDENTITY_DIR: process.env.AEC_IDENTITY_DIR, AEC_TRIAL_ROOT: process.env.AEC_TRIAL_ROOT };
  process.env.AEC_IDENTITY_DIR = identity;
  process.env.AEC_TRIAL_ROOT = trials;
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响断言 */ }
  });
  return { root, identity, trials, index: join(identity, 'sessions-index.json') };
}
const readIndex = p => JSON.parse(readFileSync(p, 'utf8'));
const makeSession = (workspace, session, { loop = true } = {}) => {
  const sessionDir = join(workspace, '.aec', 'sessions', session);
  mkdirSync(sessionDir, { recursive: true });
  if (loop) writeFileSync(join(sessionDir, 'loop.json'), JSON.stringify({ id: 'demo', steps: [] }));
  return sessionDir;
};
const matchPayload = session => ({
  code: 'match', session,
  package: { id: 'demo@1.0.0', digest: 'sha256:test' },
  match: { package_id: 'demo', version: '1.0.0', source: 'rules', confidence: 1, chosen: 'demo@1.0.0' },
  loop: { id: 'demo', version: '1.0.0', schema_revision: '3.2',
    steps: [{ id: 's1', kind: 'produce', instruction: 'x', done_when: 'x', produces: ['out.txt'] }],
    resources: { api: [], files: [] }, when: { description: 'd', not_for: [] } },
  resources: { api: [], files: [] }, params: {}, opened_at: new Date().toISOString(),
});
function fakeKernel() {
  const calls = [];
  return { calls, async call(name, args) {
    calls.push({ name, args });
    if (name === 'aec' && args.op === 'open') return matchPayload(`ses_${calls.length.toString(16).padStart(8, '0')}`);
    if (name === 'aec' && args.op === 'close') return { grade: 'authoritative', checks: [], artifacts: [], reason: null, cleanup: {} };
    if (name === 'aec' && args.op === 'turn') return { step: { id: null }, judgement: null, hint: 'ok' };
    if (name === 'aec' && args.op === 'resource') return { api: [], files: [] };
    return {};
  } };
}

test('F1-1 indexPut 写结构化工作区根（win32 反斜杠 sessionDir）+ 原子写不丢其它键', t => {
  const s = envSandbox(t);
  const root = win32.join('C:', 'Users', 'wuron', '.aec-trials', 'ases_demo');
  const sessionDir = win32.join(root, '.aec', 'sessions', SES);
  assert.ok(sessionDir.includes('\\'), '构造出的应是反斜杠路径');
  indexPut(OTHER, { v: 2, workspace: 'D:/old', session_dir: win32.join('D:', 'old', '.aec', 'sessions', OTHER), trial_of: null });
  indexPut(SES, { v: 2, workspace: root, session_dir: sessionDir, trial_of: 'auth_ses' });
  const doc = readIndex(s.index);
  assert.equal(doc[SES].workspace, root, '索引存的是工作区根，不是完整会话目录');
  assert.equal(doc[SES].session_dir, sessionDir);
  assert.equal(doc[SES].trial_of, 'auth_ses');
  assert.ok(doc[OTHER], '读改写保留其它会话键');
  assert.equal(readdirSync(s.identity).filter(f => f.includes('.tmp-')).length, 0, '临时文件已 rename，不残留');
});

test('F1-2 旧格式：完整会话目录（反斜杠）与工作区根都能被 locateSession 找回', t => {
  const s = envSandbox(t);
  const ws = join(s.root, 'ws'), sessionDir = makeSession(ws, SES);
  const backslash = sessionDir.replaceAll('/', '\\');
  indexPut(SES, backslash);
  const a = locateSession({ session: SES });
  assert.equal(a.ok, true);
  assert.equal(a.sessionDir, sessionDir);
  assert.match(a.label, /索引旧值/);
  assert.equal(a.aecDir, join(ws, '.aec'));
  assert.equal(a.ledgerPath, join(ws, '.aec', 'ledger.jsonl'));
  indexPut(SES, ws); // 工作区根字符串
  const b = locateSession({ session: SES });
  assert.equal(b.ok, true);
  assert.equal(b.sessionDir, sessionDir);
  indexPut(SES, sessionDir.replaceAll('\\', '/').split('/.aec/')[0] + '/.aec/sessions/' + SES); // 正斜杠完整目录
  assert.equal(locateSession({ session: SES }).ok, true);
});

test('F1-3 索引优先；试用条目忽略 args.workspace；失败零 mkdir 且报错可诊断', t => {
  const s = envSandbox(t);
  const ws = join(s.root, 'ws'), sessionDir = makeSession(ws, SES);
  const wrong = join(s.root, 'wrong-ws'), wrongDir = makeSession(wrong, SES);
  indexPut(SES, { v: 2, workspace: ws, session_dir: sessionDir, trial_of: null });
  const a = locateSession({ session: SES, workspace: wrong });
  assert.equal(a.sessionDir, sessionDir, '索引优先于 args.workspace');
  // 试用标记：只给错误 workspace，真实现场在试用根扫描里
  const trialWs = join(s.trials, 'ases_auth'), trialDir = makeSession(trialWs, OTHER);
  indexPut(OTHER, { v: 2, workspace: null, session_dir: null, trial_of: 'auth_ses' });
  const b = locateSession({ session: OTHER, workspace: wrong });
  assert.equal(b.sessionDir, trialDir, '试用条目忽略 args.workspace，走试用根扫描');
  assert.match(b.label, /试用根扫描/);
  assert.equal(existsSync(join(wrongDir, 'loop.json')), true, '错误 workspace 下的诱饵未被误命中');
  // 失败路径：只做 existsSync 探测，任何目录都不创建
  const missing = 'ses_ffffffff-0000-4000-8000-000000000000';
  const ghost = join(s.root, 'ghost');
  indexPut(missing, join(ghost, '.aec', 'sessions', missing));
  const c = locateSession({ session: missing, workspace: join(ghost, 'ws') });
  assert.equal(c.ok, false);
  assert.equal(existsSync(ghost), false, '定位失败不得 mkdir');
  assert.equal(existsSync(join(ghost, 'ws')), false, 'args.workspace 也不得 mkdir');
  const receipt = sessionSceneNotFound({ session: missing }, c);
  assert.equal(receipt.isError, true);
  assert.match(receipt.content[0].text, /只读探测/);
  assert.match(receipt.content[0].text, /没有创建任何目录/);
  assert.doesNotMatch(receipt.content[0].text, /可能已清理/);
  assert.ok(c.tried.length >= 4, '列出尝试过的路径');
});

test('F1-4 home 脱敏 + 归档会话报「已 close 并归档」而非「不存在/可能已清理」', t => {
  const s = envSandbox(t);
  const masked = maskHomePath(join(homedir(), '.aec-trials', 'ases_x', 'loop.json'));
  assert.ok(masked.startsWith('~'), `home 应脱敏为 ~，实际 ${masked}`);
  assert.ok(!masked.includes(homedir()));
  const ws = join(s.root, 'ws'), sessionDir = makeSession(ws, SES, { loop: false });
  const archive = join(ws, '.aec', 'archive', SES);
  mkdirSync(archive, { recursive: true });
  indexPut(SES, { v: 2, workspace: ws, session_dir: sessionDir, trial_of: null });
  const loc = locateSession({ session: SES });
  assert.equal(loc.ok, false);
  assert.equal(loc.archived, archive);
  const receipt = sessionSceneNotFound({ session: SES }, loc);
  assert.match(receipt.content[0].text, /已 close 并归档/);
  assert.doesNotMatch(receipt.content[0].text, /可能已清理/);
});

test('F1-5 集成：open(trial_of) → close 仅 session → 重复 close 报已归档', async t => {
  const s = envSandbox(t);
  const kernel = fakeKernel();
  const edge = aecEdgeHandlers(kernel);
  const opened = await edge.open({ intent: '试用回归', experience_ref: { id: 'demo', version: '1.0.0' }, trial_of: 'auth_ses' });
  assert.equal(opened.isError, undefined);
  const ses = opened.structuredContent.session;
  const sandbox = opened.structuredContent.trial.sandbox;
  const doc = readIndex(s.index);
  assert.equal(doc[ses].workspace, sandbox, '索引 workspace 必须是工作区根');
  assert.ok(doc[ses].session_dir.endsWith(join('.aec', 'sessions', ses)), '索引 session_dir 是精确会话目录');
  assert.equal(doc[ses].trial_of, 'auth_ses');
  const closed = await edge.close({ session: ses });
  assert.equal(closed.isError, undefined, JSON.stringify(closed));
  assert.equal(kernel.calls.at(-1).args.op, 'close');
  assert.equal(existsSync(join(sandbox, '.aec', 'archive', ses)), true, 'close 后归档');
  assert.equal(existsSync(join(sandbox, '.aec', 'sessions', ses, '.aec')), false, '不产生嵌套 .aec 垃圾目录');
  assert.equal(readIndex(s.index)[ses].closed, true, '索引条目标记 closed');
  const again = await edge.close({ session: ses });
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /已 close 并归档/);
});

test('F1-6 集成：close 带错误 workspace 仍成功；turn 仅 session 成功；新 handlers 重启后 close 成功', async t => {
  const s = envSandbox(t);
  // (a) 错误 workspace
  const k1 = fakeKernel(), e1 = aecEdgeHandlers(k1);
  const o1 = await e1.open({ intent: 'x', trial_of: 'auth_ses' });
  const ses1 = o1.structuredContent.session;
  const c1 = await e1.close({ session: ses1, workspace: join(s.root, 'not-a-workspace') });
  assert.equal(c1.isError, undefined, JSON.stringify(c1));
  // (b) turn 仅 session
  const k2 = fakeKernel(), e2 = aecEdgeHandlers(k2);
  const o2 = await e2.open({ intent: 'y', trial_of: 'auth_ses' });
  const ses2 = o2.structuredContent.session;
  const turn = await e2.turn({ session: ses2, note: 'n' });
  assert.equal(turn.isError, undefined, JSON.stringify(turn));
  assert.equal(k2.calls.at(-1).args.op, 'turn');
  // (c) 新建 handlers（模拟进程重启）后 close
  const k3 = fakeKernel(), e3 = aecEdgeHandlers(k3);
  const c3 = await e3.close({ session: ses2 });
  assert.equal(c3.isError, undefined, JSON.stringify(c3));
  assert.equal(k3.calls.at(-1).args.op, 'close');
});

test('F1-7 markSessionClosed 保留 trial_of 并写工作区根', t => {
  const s = envSandbox(t);
  const ws = join(s.root, 'ws'), sessionDir = makeSession(ws, SES);
  indexPut(SES, { v: 2, workspace: ws, session_dir: sessionDir, trial_of: 'auth_ses' });
  markSessionClosed(SES, sessionDir);
  const e = readIndex(s.index)[SES];
  assert.equal(e.closed, true);
  assert.equal(e.trial_of, 'auth_ses');
  assert.equal(e.workspace, resolve(ws));
  assert.equal(e.session_dir, sessionDir);
});
