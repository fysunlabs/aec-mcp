// P2-2：aec_local 独立 profile 三工具面测试（5.0-R-098/R-004）。
// 硬约束：describe/recall/remember 只访问 Host MKS；公共 aec/aec_author 零改动；
// remember 候选写；lite 形态明确降级不建库。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMcp, detectLocalHostMode } from '../src/mcp-local.mjs';
import { createMcpV2 } from '../src/mcp.mjs';
import { HostMksStore } from '../src/mks/store.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'aec-local-'));
const envNode = { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_NODE_ID: 'host:local-1' };
const call = (s, name, args = {}) => s._registeredTools[name].handler(args);

test('工具面隔离：local 含 describe/recall/remember + 5.1 控制面 5 工具；公共 run/author 不含它们', () => {
  const local = createLocalMcp(null);
  assert.deepEqual(Object.keys(local._registeredTools).sort(),
    ['describe', 'recall', 'remember', 'list', 'show', 'edit', 'forget', 'export'].sort());
  const fakeKernel = { async call() { return { code: 'no_match' }; } };
  const localTools = ['describe', 'recall', 'remember', 'list', 'show', 'edit', 'forget', 'export'];
  for (const profile of ['run', 'author']) {
    const pub = createMcpV2(fakeKernel, { profile });
    const tools = Object.keys(pub._registeredTools);
    assert.ok(localTools.every(t => !tools.includes(t)), `${profile} 不含任何 local 工具`);
    assert.ok(tools.includes('aec') && tools.includes('aec_setup'));
  }
});

test('形态判定：显式优先；未显式时 Node22+磁盘达标→node，不达标→lite', () => {
  const ok = { env: {}, probe: () => 3 * 1024 ** 3 };
  assert.equal(detectLocalHostMode({ env: { AEC_MCP_LOCAL_MEMORY: 'sovereign' }, probe: ok.probe }), 'sovereign');
  assert.equal(detectLocalHostMode({ env: {}, probe: ok.probe }), 'node');
  assert.equal(detectLocalHostMode({ env: {}, probe: () => 100 }), 'lite');
  assert.equal(detectLocalHostMode({ env: { AEC_MCP_LOCAL_MEMORY: 'node' }, probe: () => 0 }), 'node', '显式 node 忽略判定');
});

test('lite 降级：store=null 时全部工具都返回 host_mks_lite，不崩溃', async () => {
  const s = createLocalMcp(null);
  const cases = [
    ['describe', {}], ['recall', { query: 'x' }], ['remember', { kind: 'episodic', summary: 'x' }],
    ['list', {}], ['show', { memory_id: 'x' }], ['edit', { memory_id: 'x', summary: 'y' }],
    ['forget', { memory_id: 'x' }], ['export', {}],
  ];
  for (const [name, args] of cases) {
    const r = await call(s, name, args);
    assert.equal(r.isError, true, `${name} 应降级`);
    assert.equal(r.structuredContent.code, 'host_mks_lite');
  }
});

test('remember 只写 candidate；describe 只读可见；recall 经 critic 注入', async () => {
  const dir = tmp();
  const store = new HostMksStore({ path: join(dir, 'host-mks.sqlite'), env: envNode });
  const s = createLocalMcp(store, { env: envNode });
  const w = await call(s, 'remember', { kind: 'semantic', summary: 'staging canary 部署流程', title: '部署手册', confidence: 0.95 });
  assert.equal(w.structuredContent.code, 'remembered');
  assert.equal(w.structuredContent.status, 'candidate', 'remember 不直接 verified');
  const mem = store.getMemory({ memory_id: w.structuredContent.memory_id });
  assert.equal(mem.status, 'candidate');

  const d = await call(s, 'describe', { aspect: 'status' });
  assert.equal(d.structuredContent.aspect, 'status');
  assert.equal(d.structuredContent.counts.memory, 1);

  // verified 后 recall 应注入（高相关 + 高置信 + 近期）
  store.verifyMemory({ memory_id: mem.memory_id, reviewed_by: 'test' });
  const r = await call(s, 'recall', { query: '部署流程' });
  assert.equal(r.structuredContent.code, 'ok');
  assert.ok(r.structuredContent.items.length >= 1, '高分记忆注入');
  assert.ok(r.structuredContent.items[0].citation && r.structuredContent.items[0].why);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('O1-05 控制面：list/show/edit/forget/export 全链路', async () => {
  const dir = tmp();
  const store = new HostMksStore({ path: join(dir, 'host-mks.sqlite'), env: envNode });
  const s = createLocalMcp(store, { env: envNode });
  const w = await call(s, 'remember', { kind: 'semantic', summary: '候选记忆摘要', title: '旧标题', confidence: 0.6 });
  const id = w.structuredContent.memory_id;

  const listed = await call(s, 'list', {});
  assert.equal(listed.structuredContent.code, 'ok');
  assert.ok(listed.structuredContent.items.some(m => m.memory_id === id));

  const shown = await call(s, 'show', { memory_id: id });
  assert.equal(shown.structuredContent.code, 'ok');
  assert.equal(shown.structuredContent.memory.title, '旧标题');

  const edited = await call(s, 'edit', { memory_id: id, summary: '改后摘要' });
  assert.equal(edited.structuredContent.code, 'edited');
  assert.equal(store.getMemory({ memory_id: id }).summary, '改后摘要');

  const exported = await call(s, 'export', { limit: 10 });
  assert.equal(exported.structuredContent.code, 'ok');
  assert.ok(exported.structuredContent.bundle, '导出 bundle 存在');

  const forgot = await call(s, 'forget', { memory_id: id });
  assert.equal(forgot.structuredContent.code, 'forgotten');
  assert.equal(store.getMemory({ memory_id: id }).status, 'forgotten');

  // verified 记忆不可直接 edit
  const w2 = await call(s, 'remember', { kind: 'semantic', summary: 'verified 测试' });
  const id2 = w2.structuredContent.memory_id;
  store.verifyMemory({ memory_id: id2, reviewed_by: 'test' });
  const denied = await call(s, 'edit', { memory_id: id2, summary: 'x' });
  assert.equal(denied.structuredContent.code, 'edit_verified_denied');

  // list --legacy：无 scope link 的旧对象
  store.db.prepare('INSERT INTO host_memory(memory_id,kind,scope,title,summary,content_json,confidence,status,source_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('legacy-x', 'semantic', 'tenant', '旧', '旧数据', '{}', 0.5, 'verified', '{}', new Date().toISOString(), new Date().toISOString());
  const legacy = await call(s, 'list', { legacy: true, object_type: 'memory' });
  assert.ok(legacy.structuredContent.items.some(m => m.memory_id === 'legacy-x'));

  store.close();
  rmSync(dir, { recursive: true, force: true });
});
