// AEC 5.1.0 O1-00c/O1-02：scope_link 隔离测试（5.1-R-014 / B05）
// 旧数据 unknown_owner 默认不注入；同机两 subject 不串；确认归属后只对确认者可见。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostMksStore } from '../src/mks/store.mjs';
import { ftsText } from '../src/mks/fts.mjs';

const env = { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_NODE_ID: 'host:scope' };
const mk = () => new HostMksStore({ path: join(mkdtempSync(join(tmpdir(), 'scope-')), 'h.sqlite'), env });
const put = (store, id, text) => {
  store.db.prepare('INSERT INTO host_memory(memory_id,kind,scope,title,summary,content_json,confidence,status,source_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'semantic', 'tenant', text, text, '{}', 0.9, 'verified', '{}', new Date().toISOString(), new Date().toISOString());
  // FTS 索引必须存 ftsText 展开的 n-gram（与生产 putMemory 一致），否则查询分词匹配不上
  store.db.prepare('INSERT INTO host_memory_fts(rowid,text) VALUES(?,?)').run(
    Number(store.db.prepare('SELECT rowid FROM host_memory WHERE memory_id=?').get(id).rowid), ftsText([text]));
};

test('旧数据无 scope link → unknown_owner，默认不注入（两个 subject 都召回不到）', () => {
  const s = mk();
  try {
    put(s, 'legacy-1', '部署流程旧记忆');
    const legacy = s.listLegacy({ object_type: 'memory' });
    assert.ok(legacy.some(r => r.memory_id === 'legacy-1'), '旧数据在 legacy 清单');
    const alice = s.recallScoped({ query: '部署流程', user_id: 'user:alice', tenant_id: 'default', opts: { top_k: 5 } });
    const bob = s.recallScoped({ query: '部署流程', user_id: 'user:bob', tenant_id: 'default', opts: { top_k: 5 } });
    assert.ok(!alice.items.some(i => i.memory_id === 'legacy-1'), 'alice 召回不到旧数据');
    assert.ok(!bob.items.some(i => i.memory_id === 'legacy-1'), 'bob 召回不到旧数据');
    assert.equal(alice.meta.unknown_owner_excluded, true);
  } finally { s.close(); }
});

test('同机两 subject：各自只能召回自己作用域的记忆（不串）', () => {
  const s = mk();
  try {
    put(s, 'a-mem', '部署流程 alice 专用');
    put(s, 'b-mem', '部署流程 bob 专用');
    s.putScopeLink({ object_type: 'memory', object_id: 'a-mem', tenant_id: 'default', user_id: 'user:alice' });
    s.putScopeLink({ object_type: 'memory', object_id: 'b-mem', tenant_id: 'default', user_id: 'user:bob' });
    const alice = s.recallScoped({ query: '部署流程', user_id: 'user:alice', tenant_id: 'default', opts: { top_k: 5 } });
    const bob = s.recallScoped({ query: '部署流程', user_id: 'user:bob', tenant_id: 'default', opts: { top_k: 5 } });
    assert.ok(alice.items.some(i => i.memory_id === 'a-mem'));
    assert.ok(!alice.items.some(i => i.memory_id === 'b-mem'), 'alice 不得召回 bob 的记忆');
    assert.ok(bob.items.some(i => i.memory_id === 'b-mem'));
    assert.ok(!bob.items.some(i => i.memory_id === 'a-mem'), 'bob 不得召回 alice 的记忆');
  } finally { s.close(); }
});

test('确认归属后（claim-legacy 绑定 subject）：只对确认者可见', () => {
  const s = mk();
  try {
    put(s, 'legacy-2', '回滚流程归属确认');
    // 确认前：两人都召回不到
    assert.ok(!s.recallScoped({ query: '回滚流程', user_id: 'user:alice' }).items.some(i => i.memory_id === 'legacy-2'));
    // 显式确认归属给 alice（需要 subject，不自动推断）
    s.claimLegacy({ object_type: 'memory', object_id: 'legacy-2', tenant_id: 'default', user_id: 'user:alice' });
    assert.ok(s.recallScoped({ query: '回滚流程', user_id: 'user:alice', tenant_id: 'default' }).items.some(i => i.memory_id === 'legacy-2'));
    assert.ok(!s.recallScoped({ query: '回滚流程', user_id: 'user:bob', tenant_id: 'default' }).items.some(i => i.memory_id === 'legacy-2'));
  } finally { s.close(); }
});

test('tenant 隔离：同 subject 不同 tenant 不串', () => {
  const s = mk();
  try {
    put(s, 't1-mem', '鉴权流程 tenant1');
    s.putScopeLink({ object_type: 'memory', object_id: 't1-mem', tenant_id: 't1', user_id: 'user:alice' });
    assert.ok(s.recallScoped({ query: '鉴权流程', user_id: 'user:alice', tenant_id: 't1' }).items.some(i => i.memory_id === 't1-mem'));
    assert.ok(!s.recallScoped({ query: '鉴权流程', user_id: 'user:alice', tenant_id: 't2' }).items.some(i => i.memory_id === 't1-mem'));
  } finally { s.close(); }
});

test('claimLegacy 无 subject → 拒（不得自动推断）', () => {
  const s = mk();
  try {
    assert.throws(() => s.claimLegacy({ object_type: 'memory', object_id: 'x', tenant_id: 'default', user_id: null }),
      e => e.code === 'subject_required');
  } finally { s.close(); }
});
