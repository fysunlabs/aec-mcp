// O3-14 接线（aec_local.recall）：宿主在线工具路径的 rerank 门控与密钥 hygiene（确定性、不联网）。
// 覆盖：flag 关逐字节等价 / flag 开注入 rerankFn / 失败回落原序 / 回执不暴露 usage 与密钥。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMcp } from '../src/mcp-local.mjs';
import { HostMksStore } from '../src/mks/store.mjs';

const mkStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-local-rr-'));
  return { dir, store: new HostMksStore({ path: join(dir, 'host-mks.sqlite'), env: { AEC_MCP_LOCAL_MEMORY: 'node' } }) };
};
const call = (s, name, args = {}) => s._registeredTools[name].handler(args);
const seed = (store) => {
  // 两条 verified 记忆：低相关的放前面，高相关放后面，rerank 应把它们换序。
  const a = store.putMemory({ kind: 'semantic', title: '无关', summary: '咖啡店的营业时间', status: 'verified', source: {} });
  const b = store.putMemory({ kind: 'semantic', title: '相关', summary: 'staging rerank 门禁与精度门槛', status: 'verified', source: {} });
  store.putScopeLink({ object_type: 'memory', object_id: a.memory_id, user_id: 'u-test' });
  store.putScopeLink({ object_type: 'memory', object_id: b.memory_id, user_id: 'u-test' });
  return { a, b };
};

test('flag 关：recall 不含 rerank 字段（逐字节等价旧路径）', async () => {
  const { dir, store } = mkStore();
  try {
    seed(store);
    const s = createLocalMcp(store, { env: { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MKS_RERANK: '0' } });
    const r = (await call(s, 'recall', { query: 'rerank' })).structuredContent;
    assert.equal(r.code, 'ok');
    assert.equal('rerank' in r, false, '不应出现 rerank 字段');
    assert.ok(Array.isArray(r.items));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('flag 开 + 注入 rerankFn：items 重排、applied=true，回执无 usage 无密钥', async () => {
  const { dir, store } = mkStore();
  try {
    const { a, b } = seed(store);
    const env = { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MKS_RERANK: '1' };
    const rerankFn = async (q, items) => ({
      ok: true, model: 'mock-model', prompt_version: 'mks-rerank/v1',
      ranked: [{ ref: b.memory_id, why: '直接相关' }, { ref: a.memory_id, why: '弱相关' }],
      usage: { prompt_tokens: 999999 }, // 必须被剥离
    });
    const s = createLocalMcp(store, { env, rerankFn, rerankMeta: { endpoint_host: '127.0.0.1:17869' } });
    const r = (await call(s, 'recall', { query: 'rerank' })).structuredContent;
    assert.equal(r.code, 'ok');
    assert.equal(r.rerank.applied, true);
    const ids = r.items.map(x => x.ref ?? x.memory_id);
    assert.equal(ids[0], b.memory_id, 'rerank 应把相关项置顶');
    assert.equal('usage' in r.rerank, false, 'usage 不得进入工具回执');
    assert.equal(r.rerank.endpoint_host, '127.0.0.1:17869');
    const blob = JSON.stringify(r);
    assert.equal(blob.includes('999999'), false, 'token 用量不得泄漏');
    assert.equal(/bearer|secret|api[_-]?key/i.test(blob), false, '回执不得含密钥字样');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('flag 开 + rerankFn 抛错：回落词法原序、applied=false，检索不失败', async () => {
  const { dir, store } = mkStore();
  try {
    seed(store);
    const env = { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MKS_RERANK: '1' };
    const rerankFn = async () => { throw new Error('net down'); };
    const s = createLocalMcp(store, { env, rerankFn });
    const r = (await call(s, 'recall', { query: 'rerank' })).structuredContent;
    assert.equal(r.code, 'ok');
    assert.equal(r.rerank.applied, false);
    assert.ok(Array.isArray(r.items));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
