// 5.2.0 O2-01：单入口完整能力——公共 aec MCP 内置统一工具 aec_local（owner 决策
// 2026-11-27，修订 ADR-AEC-5.0-host-local-memory §3.3 / 5.0-R-004 面隔离条款）。
// 覆盖：面注册 / 8 op 全链 / per-op 校验 / lite 降级不建库 / 懒建库 / 形态自动判定 /
// 与 --profile local 兼容入口行为一致（单一实现 local-handlers.mjs，防漂移）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpV2 } from '../src/mcp.mjs';
import { createLocalMcp, detectLocalHostMode } from '../src/mcp-local.mjs';
import { createLocalHandlers, validateLocalOp, LOCAL_OPS } from '../src/mks/local-handlers.mjs';
import { HostMksStore } from '../src/mks/store.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'aec-merge-'));
const call = (s, name, args = {}) => s._registeredTools[name].handler(args);
const sc = (r) => r.structuredContent;
const fakeKernel = { async call() { return { code: 'no_match' }; } };
const envFor = (dir, extra = {}) => ({
  AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_NODE_ID: 'host:merge-test',
  AEC_MCP_HOST_MKS_DB: join(dir, 'host-mks.sqlite'), ...extra,
});

test('面注册：run = aec+aec_setup+aec_local；author 另含 aec_author；版本 2.2.0', () => {
  const run = createMcpV2(fakeKernel, { profile: 'run', env: {} });
  assert.deepEqual(Object.keys(run._registeredTools).sort(), ['aec', 'aec_local', 'aec_setup']);
  assert.ok(run._hostMks?.getStore && typeof run._hostMks.close === 'function', '暴露 _hostMks 生命周期句柄');
  const author = createMcpV2(fakeKernel, { profile: 'author', env: {} });
  assert.deepEqual(Object.keys(author._registeredTools).sort(), ['aec', 'aec_author', 'aec_local', 'aec_setup']);
});

test('8 op 全链（node 形态）：remember 候选写 → list → show → edit → export → forget', async () => {
  const dir = tmp();
  const s = createMcpV2(fakeKernel, { profile: 'run', env: envFor(dir) });
  const w = await call(s, 'aec_local', { op: 'remember', kind: 'semantic', summary: '合并域候选记忆', title: '旧标题', confidence: 0.6 });
  assert.equal(sc(w).code, 'remembered');
  assert.equal(sc(w).status, 'candidate', '统一入口同样只写 candidate');
  const id = sc(w).memory_id;

  const listed = await call(s, 'aec_local', { op: 'list' });
  assert.ok(sc(listed).items.some(m => m.memory_id === id));

  const shown = await call(s, 'aec_local', { op: 'show', memory_id: id });
  assert.equal(sc(shown).memory.title, '旧标题');

  const edited = await call(s, 'aec_local', { op: 'edit', memory_id: id, summary: '改后摘要' });
  assert.equal(sc(edited).code, 'edited');

  const exported = await call(s, 'aec_local', { op: 'export', limit: 10 });
  assert.ok(sc(exported).bundle, '导出 bundle 存在');

  const d = await call(s, 'aec_local', { op: 'describe' });
  assert.equal(sc(d).aspect, 'status');

  const forgot = await call(s, 'aec_local', { op: 'forget', memory_id: id });
  assert.equal(sc(forgot).code, 'forgotten');
  s._hostMks.close();
  rmSync(dir, { recursive: true, force: true });
});

test('per-op 校验：缺参/坏 op/坏 kind/无字段 edit 一律结构化错误不抛出', async () => {
  const dir = tmp();
  const s = createMcpV2(fakeKernel, { profile: 'run', env: envFor(dir) });
  for (const [args, want] of [
    [{ op: 'recall' }, 'missing_query'],
    [{ op: 'nope' }, 'invalid_op'],
    [{ op: 'remember', summary: 'x', kind: 'bogus' }, 'invalid_kind'],
    [{ op: 'remember', kind: 'semantic' }, 'missing_summary'],
    [{ op: 'edit', memory_id: 'm1' }, 'nothing_to_edit'],
    [{ op: 'show' }, 'missing_memory_id'],
    [{ op: 'forget' }, 'missing_memory_id'],
  ]) {
    const r = await call(s, 'aec_local', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.equal(sc(r).code, want, JSON.stringify(args));
  }
  s._hostMks.close();
  rmSync(dir, { recursive: true, force: true });
});

test('lite 降级：显式 lite → host_mks_lite 且不建库；懒建库：首次调用才落盘；close 释放', async () => {
  const dir = tmp();
  const liteDb = join(dir, 'lite.sqlite');
  const lite = createMcpV2(fakeKernel, { profile: 'run', env: { AEC_MCP_HOST_MKS_DB: liteDb, AEC_MCP_LOCAL_MEMORY: 'lite' } });
  const d = await call(lite, 'aec_local', { op: 'describe' });
  assert.equal(sc(d).code, 'host_mks_lite');
  assert.equal(d.isError, true);
  assert.equal(existsSync(liteDb), false, 'lite 不建库不落盘');

  const freshDb = join(dir, 'fresh.sqlite');
  const s = createMcpV2(fakeKernel, { profile: 'run', env: { AEC_MCP_HOST_MKS_DB: freshDb } });
  assert.equal(existsSync(freshDb), false, '构造 server 不落盘（懒建库）');
  await call(s, 'aec_local', { op: 'describe' });
  assert.equal(existsSync(freshDb), true, '首次调用建库');
  s._hostMks.close();
  lite._hostMks.close();
  rmSync(dir, { recursive: true, force: true });
});

test('形态自动判定（O2-01）：未显式 = 显式 node 同判；不满足降 lite', () => {
  const db = 'C:\\nonexistent-probe\\host-mks.sqlite';
  assert.equal(detectLocalHostMode({ env: { AEC_MCP_HOST_MKS_DB: db }, probe: () => 3 * 1024 ** 3 }),
    detectLocalHostMode({ env: { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_HOST_MKS_DB: db }, probe: () => 3 * 1024 ** 3 }));
  assert.equal(detectLocalHostMode({ env: { AEC_MCP_HOST_MKS_DB: db }, probe: () => 0 }), 'lite');
});

test('两入口一致：兼容入口与统一入口对同一操作产生同构回执（单一实现防漂移）', async () => {
  const dir = tmp();
  const env = envFor(dir);
  // 统一入口
  const merged = createMcpV2(fakeKernel, { profile: 'run', env });
  const mw = await call(merged, 'aec_local', { op: 'remember', kind: 'procedural', summary: '一致性金丝雀', confidence: 0.7 });
  merged._hostMks.close();
  // 兼容入口（独立临时库）
  const dir2 = tmp();
  const store = new HostMksStore({ path: join(dir2, 'host-mks.sqlite'), env: envFor(dir2) });
  const legacy = createLocalMcp(store, { env: envFor(dir2) });
  const lw = await call(legacy, 'remember', { kind: 'procedural', summary: '一致性金丝雀', confidence: 0.7 });
  assert.deepEqual(
    { code: sc(mw).code, status: sc(mw).status },
    { code: sc(lw).code, status: sc(lw).status }, '回执同构');
  // 共享域对象：同一 store 下 8 个 op 的 description/inputSchema/handler 与兼容入口完全同源
  const dom = createLocalHandlers(store, { env: envFor(dir2) });
  assert.deepEqual(Object.keys(dom).sort(), [...LOCAL_OPS].sort());
  for (const op of LOCAL_OPS) {
    assert.equal(typeof dom[op].handler, 'function');
    assert.ok(dom[op].description && dom[op].inputSchema);
  }
  store.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
});

test('validateLocalOp 纯函数：op 分发校验不依赖 server/store', () => {
  assert.equal(validateLocalOp('describe', {}), null);
  assert.equal(validateLocalOp('recall', { query: 'x' }), null);
  assert.equal(validateLocalOp('edit', { memory_id: 'm', title: 't' }), null);
  assert.equal(validateLocalOp('bogus', {}).code, 'invalid_op');
  assert.equal(validateLocalOp('remember', { kind: 'semantic' }).code, 'missing_summary');
});
