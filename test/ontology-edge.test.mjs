// AEC 5.2（ADR §4.4/§5.3）：op=ontology 边端测试。
// 硬约束：内核只分类；本边端是唯一写 host-mks.sqlite 的进程；bind 只存引用；
// 未知 path 进 host_observation(status='unmodeled')；close 时会话缓冲成为
// evidence.ontology（内核 buildCloseOntology 只读）。lite 形态全部跳过、逐字节等价。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpV2, mergeHostOntologyState, renderBoBlock } from '../src/mcp.mjs';
import { indexPut } from '../src/mcp.mjs';

const call = (s, name, args = {}) => s._registeredTools[name].handler(args);
const BO = { bo_id: 'x-account-manager', version: '1.0.0', digest: 'a'.repeat(64) };

function sessionFixture({ root, session = 'ses_ont1' } = {}) {
  const sessionDir = join(root, '.aec', 'sessions', session);
  mkdirSync(join(sessionDir, 'run'), { recursive: true });
  writeFileSync(join(sessionDir, 'loop.json'), JSON.stringify({ steps: [], checks: [] }));
  writeFileSync(join(sessionDir, 'state.json'), JSON.stringify({ package_id: 'x-account-manager' }));
  writeFileSync(join(sessionDir, 'run', 'report.json'), JSON.stringify({ steps: [] }));
  indexPut(session, { v: 2, workspace: root, session_dir: sessionDir, trial_of: null });
  return { sessionDir, session };
}

// 模拟内核 op=ontology 分类回执（真实形状见 aec/src/session.mjs Sessions.ontology）。
function fakeKernel(handlers = {}) {
  const calls = [];
  return {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      const h = handlers[args.op + (args.op === 'ontology' ? `:${args.action ?? 'get'}` : '')];
      if (!h) throw Object.assign(new Error(`fake kernel: unexpected ${name} ${args.op}`), { code: 'unmocked' });
      return h(args);
    },
  };
}

test('observe：边端落 host_fact/host_observation/host_delta，回执带 host_applied', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-ont-'));
  const prev = process.env.AEC_IDENTITY_DIR;
  process.env.AEC_IDENTITY_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.AEC_IDENTITY_DIR; else process.env.AEC_IDENTITY_DIR = prev; });
  const env = { AEC_IDENTITY_DIR: dir, AEC_MCP_HOST_MKS_DB: join(dir, 'host-mks.sqlite'), AEC_MCP_LOCAL_MEMORY: 'node' };
  const k = fakeKernel({
    'ontology:observe': () => ({
      v: 'aec/v2', action: 'observe', bo: BO,
      accepted: [{ path: 'business.audience.primary', value: { hint: 'AI builders' }, source: 'user', observed_at: null, confidence: 0.9, status: 'observed' }],
      unmodeled: [{ path: 'brand.voice.custom', value: { tone: 'casual' }, source: 'run', status: 'unmodeled' }],
      rejected: [],
      deltas: [{ path: 'business.goal.primary', value: 'g2', source: 'run', status: 'candidate' }],
      host_writes: {
        facts: [{ path: 'business.audience.primary', value: { hint: 'AI builders' }, source: 'user', confidence: 0.9 }],
        observations: [{ path: 'brand.voice.custom', value: { tone: 'casual' }, source: 'run' }],
        deltas: [{ base_digest: BO.digest, patch: [{ op: 'replace', path: '/business/goal/primary', value: 'g2' }], source: 'run', status: 'candidate' }],
      },
      note: '内核只分类。',
    }),
  });
  const s = createMcpV2(k, { profile: 'run', env });
  t.after(() => { try { s._hostMks.close(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL 句柄可能晚一拍 */ } });
  const { sessionDir, session } = sessionFixture({ root: join(dir, 'ws') });
  const r = await call(s, 'aec', { op: 'ontology', action: 'observe', session, facts: [] });
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.structuredContent.host_applied, { facts: 1, observations: 1, deltas: 1, bindings: 0 });
  const store = await s._hostMks.getStore();
  assert.equal(store.listHostFacts({ bo_id: BO.bo_id }).length, 1, 'host_fact 落一行');
  assert.equal(store.listHostObservations({ bo_id: BO.bo_id }).length, 1, '未知 path 进 host_observation');
  assert.equal(store.listHostDeltas({ bo_id: BO.bo_id }).length, 1, '语义路径进 host_delta candidate');
  const buf = JSON.parse(readFileSync(join(sessionDir, 'ontology.json'), 'utf8'));
  assert.equal(buf.bo_id, BO.bo_id);
  assert.equal(buf.facts.length, 2, '缓冲=accepted+delta');
  assert.equal(buf.mismatches.length, 1, '语义路径观测进 mismatches');
  assert.match(r.content[0].text, /accepted 1/);
  assert.match(r.content[0].text, /facts 1、observations 1、deltas 1/);
});

test('observe：同 path 值变化 → 缓冲记 mismatch（close 时内核算 delta）', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-ont-'));
  const prev = process.env.AEC_IDENTITY_DIR;
  process.env.AEC_IDENTITY_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.AEC_IDENTITY_DIR; else process.env.AEC_IDENTITY_DIR = prev; });
  const env = { AEC_IDENTITY_DIR: dir, AEC_MCP_HOST_MKS_DB: join(dir, 'host-mks.sqlite'), AEC_MCP_LOCAL_MEMORY: 'node' };
  const k = fakeKernel({
    'ontology:observe': () => ({
      v: 'aec/v2', action: 'observe', bo: BO,
      accepted: [
        { path: 'business.audience.primary', value: 'v1', source: 'run', status: 'observed' },
        { path: 'business.audience.primary', value: 'v2', source: 'run', status: 'observed' },
      ],
      unmodeled: [], rejected: [], deltas: [],
      host_writes: { facts: [], observations: [], deltas: [] },
      note: 'x',
    }),
  });
  const s = createMcpV2(k, { profile: 'run', env });
  t.after(() => { try { s._hostMks.close(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL 句柄可能晚一拍 */ } });
  const { session, sessionDir } = sessionFixture({ root: join(dir, 'ws'), session: 'ses_ont2' });
  await call(s, 'aec', { op: 'ontology', action: 'observe', session, facts: [] });
  const buf = JSON.parse(readFileSync(join(sessionDir, 'ontology.json'), 'utf8'));
  assert.deepEqual(buf.mismatches, [{ path: 'business.audience.primary', declared: 'v1', observed: 'v2', source: 'run' }]);
  assert.equal(buf.facts.length, 2);
});

test('bind：只存 value_ref 引用；get：边端合并 host_state（bound/unknown）', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-ont-'));
  const prev = process.env.AEC_IDENTITY_DIR;
  process.env.AEC_IDENTITY_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.AEC_IDENTITY_DIR; else process.env.AEC_IDENTITY_DIR = prev; });
  const env = { AEC_IDENTITY_DIR: dir, AEC_MCP_HOST_MKS_DB: join(dir, 'host-mks.sqlite'), AEC_MCP_LOCAL_MEMORY: 'node' };
  const k = fakeKernel({
    'ontology:bind': () => ({
      v: 'aec/v2', action: 'bind', bo: BO,
      bound: { slot: 'system.x_credentials', value_ref: 'env:X_API_KEY', source: 'user' }, status: 'bound',
      host_writes: { bindings: [{ slot: 'system.x_credentials', value_ref: 'env:X_API_KEY', source: 'user' }] },
      note: '只存引用。',
    }),
    'ontology:get': args => {
      assert.equal(args.sections, null, 'get 透传 sections');
      return {
        v: 'aec/v2', action: 'get', bo: {
          bo_id: BO.bo_id, version: BO.version, digest: BO.digest, profile: 'external',
          sections: { bindings: [{ slot: 'system.x_credentials' }, { slot: 'system.proxy' }] },
          declared_paths: ['business/goal/primary', 'bindings/system.x_credentials'],
        },
        host_merge_hint: '宿主合并。',
      };
    },
  });
  const s = createMcpV2(k, { profile: 'run', env });
  t.after(() => { try { s._hostMks.close(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL 句柄可能晚一拍 */ } });
  const { session, sessionDir } = sessionFixture({ root: join(dir, 'ws'), session: 'ses_ont3' });
  const rb = await call(s, 'aec', { op: 'ontology', action: 'bind', session, slot: 'system.x_credentials', value_ref: 'env:X_API_KEY' });
  assert.deepEqual(rb.structuredContent.host_applied, { facts: 0, observations: 0, deltas: 0, bindings: 1 });
  const store = await s._hostMks.getStore();
  const b = store.listHostBindings({ bo_id: BO.bo_id })[0];
  assert.equal(b.value_ref, 'env:X_API_KEY');
  assert.match(rb.content[0].text, /只存引用/);
  const bufB = JSON.parse(readFileSync(join(sessionDir, 'ontology.json'), 'utf8'));
  assert.equal(bufB.bindings.length, 1);
  const rg = await call(s, 'aec', { op: 'ontology', action: 'get', session });
  assert.deepEqual(rg.structuredContent.host_state, {
    bindings: [{ slot: 'system.x_credentials', value_ref: 'env:X_API_KEY', source: 'user' }],
    host_facts: 0, host_facts_stale: 0,
    declared_unknown: ['system.proxy'],
  });
  assert.equal(existsSync(join(sessionDir, 'host-mks.sqlite')), false, '绝不把 host 库写进会话目录');
});

test('lite：getStore=null 时内核回执原样透传、host_applied 全 0、无缓冲崩坏', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-ont-'));
  const prev = process.env.AEC_IDENTITY_DIR;
  process.env.AEC_IDENTITY_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.AEC_IDENTITY_DIR; else process.env.AEC_IDENTITY_DIR = prev; });
  const env = { AEC_IDENTITY_DIR: dir, AEC_MCP_HOST_MKS_DB: join(dir, 'host-mks.sqlite'), AEC_MCP_LOCAL_MEMORY: 'lite' };
  const k = fakeKernel({
    'ontology:observe': () => ({
      v: 'aec/v2', action: 'observe', bo: BO,
      accepted: [{ path: 'business.audience.primary', value: 'v1', source: 'run' }],
      unmodeled: [], rejected: [], deltas: [],
      host_writes: { facts: [{ path: 'business.audience.primary', value: 'v1', source: 'run' }], observations: [], deltas: [] },
      note: 'x',
    }),
  });
  const s = createMcpV2(k, { profile: 'run', env });
  t.after(() => { try { s._hostMks.close(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL 句柄可能晚一拍 */ } });
  const { session, sessionDir } = sessionFixture({ root: join(dir, 'ws'), session: 'ses_ont4' });
  const r = await call(s, 'aec', { op: 'ontology', action: 'observe', session, facts: [] });
  assert.deepEqual(r.structuredContent.host_applied, { facts: 0, observations: 0, deltas: 0, bindings: 0 });
  assert.deepEqual(r.structuredContent.accepted, [{ path: 'business.audience.primary', value: 'v1', source: 'run' }], '内核分类原样透传');
  const buf = JSON.parse(readFileSync(join(sessionDir, 'ontology.json'), 'utf8'));
  assert.equal(buf.facts.length, 1, '会话缓冲独立于 Host MKS，lite 也记');
});

test('ontology_disabled：内核关闭态原样转告，不写任何宿主行', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-ont-'));
  const prev = process.env.AEC_IDENTITY_DIR;
  process.env.AEC_IDENTITY_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.AEC_IDENTITY_DIR; else process.env.AEC_IDENTITY_DIR = prev; });
  const env = { AEC_IDENTITY_DIR: dir, AEC_MCP_HOST_MKS_DB: join(dir, 'host-mks.sqlite'), AEC_MCP_LOCAL_MEMORY: 'node' };
  const k = fakeKernel({
    'ontology:get': () => ({ v: 'aec/v2', code: 'ontology_disabled', message: 'AEC_ONTOLOGY=0：本体 op 已关闭。' }),
  });
  const s = createMcpV2(k, { profile: 'run', env });
  t.after(() => { try { s._hostMks.close(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL 句柄可能晚一拍 */ } });
  const { session } = sessionFixture({ root: join(dir, 'ws'), session: 'ses_ont5' });
  const r = await call(s, 'aec', { op: 'ontology', action: 'get', session });
  assert.match(r.content[0].text, /op=ontology 未执行/);
  assert.equal(r.structuredContent.code, 'ontology_disabled');
});

test('close：会话本体缓冲 → evidence.ontology 传内核（mismatches/facts 同源）', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-ont-'));
  const prev = process.env.AEC_IDENTITY_DIR;
  process.env.AEC_IDENTITY_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.AEC_IDENTITY_DIR; else process.env.AEC_IDENTITY_DIR = prev; });
  const env = { AEC_IDENTITY_DIR: dir, AEC_MCP_HOST_MKS_DB: join(dir, 'host-mks.sqlite'), AEC_MCP_LOCAL_MEMORY: 'node' };
  const k = fakeKernel({
    'ontology:observe': () => ({
      v: 'aec/v2', action: 'observe', bo: BO,
      accepted: [
        { path: 'business.audience.primary', value: 'v1', source: 'run' },
        { path: 'business.audience.primary', value: 'v2', source: 'run' },
      ],
      unmodeled: [], rejected: [], deltas: [],
      host_writes: { facts: [], observations: [], deltas: [] },
      note: 'x',
    }),
    close: () => ({ cleanup: { removed: null }, grade: { level: 'authoritative' }, checks: [], artifacts: [] }),
  });
  const s = createMcpV2(k, { profile: 'run', env });
  t.after(() => { try { s._hostMks.close(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL 句柄可能晚一拍 */ } });
  const { session, sessionDir } = sessionFixture({ root: join(dir, 'ws'), session: 'ses_ont6' });
  await call(s, 'aec', { op: 'ontology', action: 'observe', session, facts: [] });
  await call(s, 'aec', { op: 'close', session, status: 'done' });
  const closeArgs = k.calls.find(c => c.name === 'aec' && c.args.op === 'close').args;
  assert.deepEqual(closeArgs.evidence.ontology, {
    mismatches: [{ path: 'business.audience.primary', declared: 'v1', observed: 'v2', source: 'run' }],
    facts: [
      { path: 'business.audience.primary', value: 'v1', source: 'run' },
      { path: 'business.audience.primary', value: 'v2', source: 'run' },
    ],
  }, 'close 的 evidence.ontology 与会话缓冲同源');
});

test('open 合并：mergeHostOntologyState 只加 bindings_bound/host_facts 字段；store 缺席透传', async t => {
  const summary = { bo_id: BO.bo_id, resolved_version: '1.0.0', digest: BO.digest, goals: 3, bindings_declared: 2 };
  const empty = await mergeHostOntologyState(summary, { getStore: null });
  assert.deepEqual(empty, summary, 'lite/关闭：原样透传（字节等价）');
  assert.equal(renderBoBlock(null), '');
  assert.match(renderBoBlock(summary), /【业务本体】BO x-account-manager@1\.0\.0/);
  assert.match(renderBoBlock(summary), /delta candidate/);
});
