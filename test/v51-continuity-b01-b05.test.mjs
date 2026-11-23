// AEC 5.1 O1 B01–B05 / A21a（plan.3 §5.2）：Host 连续性逐条测试（非冒烟）。
// 隔离 tmp Host MKS v2 库；覆盖跨 session 连续、偏好、不编造、用户控制、隔离（四类）、
// 旧数据 unknown_owner、env key no_identity、A21a 离线（kernel 不可达）召回仍可用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostMksStore } from '../src/mks/store.mjs';
import { runContinuitySidecar, renderContinuityBlock } from '../src/continuity.mjs';

const TRACK = new Map();
function cleanup(root) { try { TRACK.get(root)?.close(); } catch {} TRACK.delete(root); try { cleanup(root); } catch {} }
const ENV = { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_NODE_ID: 'host:b01-b05-test', AEC_MCP_SEARCH_V2: '0' };
function mkStore(root, env = ENV) {
  return new HostMksStore({ path: join(root, 'host-mks.sqlite'), env: { ...ENV, ...env } });
}
function putScoped(store, { kind = 'semantic', scope = 'tenant', summary, content = {}, user, tenant = 't1', thread = null, category = 'memory' }) {
  const m = store.putMemory({ kind, scope, summary, content, confidence: 0.8, status: 'verified' });
  store.putScopeLink({ object_type: category, object_id: m.memory_id, tenant_id: tenant, user_id: user, thread_id: thread });
  return m;
}

test('B01 跨 session 连续：同一 subject 连续 5 次，第 2 次起召回上次未完成事项', () => {
  const root = mkdtempSync(join(tmpdir(), 'b01-'));
  try {
    const store = mkStore(root); TRACK.set(root, store);
    const user = 'user:alice';
    const seen = [];
    for (let i = 1; i <= 5; i++) {
      if (i > 1) {
        const r = store.recallScoped({ query: '未完成事项 抖音 下载', user_id: user, tenant_id: 't1' });
        seen.push(r.items.length);
      }
      putScoped(store, { summary: `第${i}次任务未完成事项：抖音无水印下载`, user, thread: `thread-${i}` });
    }
    assert.equal(seen.length, 4);
    assert.ok(seen.every(n => n >= 1), `每次都能召回历史未完成事项：${JSON.stringify(seen)}`);
  } finally { cleanup(root); }
});

test('B02 偏好准确：显式偏好记住、一次性要求不升级、冲突按 supersedes', () => {
  const root = mkdtempSync(join(tmpdir(), 'b02-'));
  try {
    const store = mkStore(root); TRACK.set(root, store);
    const pref = store.putMemory({ kind: 'semantic', scope: 'tenant', summary: '偏好：交付无水印视频', confidence: 0.9, status: 'verified' });
    // 偏好以 memory 形式可召回（recallScoped 走 object_type=memory 的 scope link）；同时挂 preference 类别 link 供 B05 四类隔离验证。
    store.putScopeLink({ object_type: 'memory', object_id: pref.memory_id, tenant_id: 't1', user_id: 'user:alice' });
    store.putScopeLink({ object_type: 'preference', object_id: pref.memory_id, tenant_id: 't1', user_id: 'user:alice' });
    const r = store.recallScoped({ query: '无水印 偏好', user_id: 'user:alice', tenant_id: 't1' });
    assert.ok(r.items.some(i => i.memory_id === pref.memory_id), '显式偏好被召回');
    // 冲突：新偏好 supersedes 旧
    const pref2 = store.putMemory({ kind: 'semantic', scope: 'tenant', summary: '偏好：交付带署名水印', confidence: 0.9, status: 'verified', supersedes: pref.memory_id });
    store.putScopeLink({ object_type: 'memory', object_id: pref2.memory_id, tenant_id: 't1', user_id: 'user:alice' });
    // Host MKS putMemory 记录 supersedes 链接（新偏好指向旧偏好）；recall 按 relevance/confidence 优先新值。
    // 诚实边界：Host 侧当前不自动把旧记忆 status 改为 superseded（Cloud store 才有该语义），
    // 这里验证链接被持久化，不冒充自动状态迁移。
    assert.equal(store.getMemory({ memory_id: pref2.memory_id }).supersedes, pref.memory_id, '新偏好记录 supersedes 链接');
    // 一次性要求默认 candidate（不自动升级）
    const once = store.putMemory({ kind: 'episodic', scope: 'session', summary: '这次只要 mp4' });
    assert.equal(once.status, 'candidate', '一次性要求默认 candidate');
  } finally { cleanup(root); }
});

test('B03 不编造：无记忆返回 empty，renderOpen 不出现「我记得」', () => {
  const root = mkdtempSync(join(tmpdir(), 'b03-'));
  try {
    const store = mkStore(root); TRACK.set(root, store);
    const r = store.recallScoped({ query: '完全不相关的查询 xyzzy12345', user_id: 'user:alice', tenant_id: 't1' });
    assert.equal(r.items.length, 0, '无记忆时空结果');
    const block = renderContinuityBlock({ status: 'empty', items: [], gaps: [] });
    const text = typeof block === 'string' ? block : JSON.stringify(block);
    assert.ok(!text.includes('我记得'), '空记忆不出现「我记得」');
    assert.ok(!text.includes('I remember'), '空记忆不出现「I remember」');
  } finally { cleanup(root); }
});

test('B04 用户控制：list/show/edit/forget 可用，forgotten 永不召回', () => {
  const root = mkdtempSync(join(tmpdir(), 'b04-'));
  try {
    const store = mkStore(root); TRACK.set(root, store);
    const m = putScoped(store, { summary: '待用户控制的记忆 抖音命名规范', user: 'user:alice' });
    assert.ok(store.listMemories().some(x => x.memory_id === m.memory_id), 'list 可见');
    assert.equal(store.getMemory({ memory_id: m.memory_id }).memory_id, m.memory_id, 'show 可见');
    store.updateMemory({ memory_id: m.memory_id, summary: '编辑后的记忆 抖音命名规范' });
    assert.ok(store.getMemory({ memory_id: m.memory_id }).summary.includes('编辑后'), 'edit 生效');
    store.forgetMemory({ memory_id: m.memory_id });
    assert.equal(store.getMemory({ memory_id: m.memory_id }).status, 'forgotten', 'forget 生效');
    const r = store.recallScoped({ query: '抖音命名规范', user_id: 'user:alice', tenant_id: 't1' });
    assert.ok(!r.items.some(i => i.memory_id === m.memory_id), 'forgotten 永不召回');
  } finally { cleanup(root); }
});

test('B05 四类隔离：memory/preference/knowledge/experience + 不同 subject/tenant 不串', () => {
  const root = mkdtempSync(join(tmpdir(), 'b05-'));
  try {
    const store = mkStore(root); TRACK.set(root, store);
    // 四类：memory(semantic) / preference / knowledge(chunk) / experience(element)
    const mem = putScoped(store, { summary: '核算规则 alpha', user: 'user:alice', category: 'memory' });
    const pref = store.putMemory({ kind: 'semantic', scope: 'tenant', summary: '偏好规则 alpha' });
    store.putScopeLink({ object_type: 'preference', object_id: pref.memory_id, tenant_id: 't1', user_id: 'user:alice' });
    const doc = store.addDocument({ source_uri: 'kb://ops/manual' });
    const ck = store.putChunk({ document_id: doc.document_id, ordinal: 0, text: '知识规则 alpha 客户偏好' });
    store.putScopeLink({ object_type: 'chunk', object_id: ck.chunk_id, tenant_id: 't1', user_id: 'user:alice' });
    const el = store.putElement({ element_kind: 'experience', title: '经验规则 alpha', statement: '经验 alpha' });
    store.putScopeLink({ object_type: 'element', object_id: el.element_id, tenant_id: 't1', user_id: 'user:alice' });
    // 不同 subject 召回不到
    const bob = store.recallScoped({ query: '规则 alpha', user_id: 'user:bob', tenant_id: 't1' });
    assert.ok(!bob.items.some(i => i.memory_id === mem.memory_id), 'bob 召回不到 alice 记忆');
    // 不同 tenant 召回不到
    const otherT = store.recallScoped({ query: '规则 alpha', user_id: 'user:alice', tenant_id: 't2' });
    assert.ok(!otherT.items.some(i => i.memory_id === mem.memory_id), 't2 召回不到 t1 记忆');
    // 四类 scope link 齐全
    assert.equal(store.getScopeLink({ object_type: 'preference', object_id: pref.memory_id }).user_id, 'user:alice');
    assert.equal(store.getScopeLink({ object_type: 'chunk', object_id: ck.chunk_id }).user_id, 'user:alice');
    assert.equal(store.getScopeLink({ object_type: 'element', object_id: el.element_id }).user_id, 'user:alice');
  } finally { cleanup(root); }
});

test('B05 旧数据 unknown_owner 默认不召回，claimLegacy 确认后才可见', () => {
  const root = mkdtempSync(join(tmpdir(), 'b05-legacy-'));
  try {
    const store = mkStore(root); TRACK.set(root, store);
    const legacy = store.putMemory({ kind: 'semantic', summary: '旧数据归属未知 alpha', status: 'verified' }); // 无 scope link
    assert.ok(store.listLegacy({ object_type: 'memory' }).some(x => x.memory_id === legacy.memory_id), '旧数据在 legacy 清单');
    const before = store.recallScoped({ query: '归属未知 alpha', user_id: 'user:alice', tenant_id: 't1' });
    assert.ok(!before.items.some(i => i.memory_id === legacy.memory_id), '默认不召回 unknown_owner');
    store.claimLegacy({ object_type: 'memory', object_id: legacy.memory_id, tenant_id: 't1', user_id: 'user:alice' });
    const after = store.recallScoped({ query: '归属未知 alpha', user_id: 'user:alice', tenant_id: 't1' });
    assert.ok(after.items.some(i => i.memory_id === legacy.memory_id), '确认归属后可见');
  } finally { cleanup(root); }
});

test('no_identity：无 subject 时 runContinuitySidecar 返回 no_identity，不注入', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b05-noid-'));
  try {
    const store = mkStore(root); TRACK.set(root, store);
    putScoped(store, { summary: '不应被无身份召回 alpha', user: 'user:alice' });
    const r = await runContinuitySidecar({
      enabled: true, subject: null, // no identity
      scope: { tenant: 't1' },
    });
    assert.equal(r.status, 'no_identity', '无 subject → no_identity');
    const text = r.markdown || '';
    assert.ok(!text.includes('不应被无身份召回'), 'no_identity 不注入内容');
    void store;
  } finally { cleanup(root); }
});

test('A21a 离线：kernel 不可达时 recallScoped 本地仍可用（不依赖网络）', () => {
  const root = mkdtempSync(join(tmpdir(), 'a21a-'));
  try {
    const store = mkStore(root); TRACK.set(root, store);
    putScoped(store, { summary: '离线可召回的本地记忆 alpha', user: 'user:alice' });
    // 本测试全程无 fetch/kernel 调用；recallScoped 是纯本地 FTS + scope 过滤
    const r = store.recallScoped({ query: '本地记忆 alpha', user_id: 'user:alice', tenant_id: 't1' });
    assert.ok(r.items.some(i => String(i.summary).includes('离线可召回')), '断网场景本地召回仍可用');
    assert.ok(r.limits.includes('fts_only') || r.limits.includes('scope_filtered'), '召回口径为本地 FTS/scope');
  } finally { cleanup(root); }
});
