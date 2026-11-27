// P1-05/06/07：aec-mcp Host MKS 测试（host-mks.sqlite 独立库 / 四模块 / outbox 幂等 / 联邦）。
// 硬约束：不复用 roles.sqlite（ADR-AEC-5.0-host-local-memory §2）；lite 不建库；
// outbox 以 (node_id, local_event_id) 幂等；本地写 memory 默认 candidate。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostMksStore, resolveHostMksPath } from '../src/mks/store.mjs';
import { RolesDB, resolveRolesDbPath } from '../src/db/roles.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'aec-hostmks-'));
const envNode = { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_NODE_ID: 'host:test-1' };

test('lite 形态：构造即拒绝，不建库（P0 默认形态 = 2.0.0 行为不变）', () => {
  const dir = tmp();
  assert.throws(() => new HostMksStore({ path: join(dir, 'host-mks.sqlite'), env: {} }), /mks_lite_disabled/);
  assert.equal(existsSync(join(dir, 'host-mks.sqlite')), false, 'lite 不得建库文件');
  rmSync(dir, { recursive: true, force: true });
});

test('node 形态：独立 host-mks.sqlite 迁移到位；roles.sqlite 零触碰（节点独立）', () => {
  const dir = tmp();
  const rolesPath = resolveRolesDbPath({ env: { AEC_MCP_ROLES_DB: join(dir, 'roles.sqlite') } });
  const roles = new RolesDB(rolesPath);
  roles.listDevices(); roles.close(); // 让 roles.sqlite 先存在并有表
  const hostPath = resolveHostMksPath({ env: { AEC_IDENTITY_DIR: dir } });
  assert.notEqual(hostPath, rolesPath, '路径必须不同');
  const mks = new HostMksStore({ path: hostPath, env: envNode });
  try {
    const v = mks.db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(v, 3, 'Host MKS 独立迁移版本号（5.1 O1 v2 → 5.2 v3：host_fact/binding/delta/observation；与内核 v1–v26 无关）');
    const names = new Set(mks.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map(r => r.name));
    for (const t of ['host_memory', 'host_document', 'host_chunk', 'host_claim', 'host_element',
      'host_package_element', 'host_business_term', 'host_ontology', 'local_outbox',
      'host_audit', 'host_federation_log', 'host_memory_fts', 'host_chunk_fts']) {
      assert.ok(names.has(t), `缺表 ${t}`);
    }
    // roles.sqlite 未被写入任何 host_ 表
    const rdb = new RolesDB(rolesPath);
    const rnames = rdb.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    rdb.close();
    assert.equal(rnames.some(n => n.startsWith('host_') || n === 'local_outbox'), false, 'roles.sqlite 不得出现 host 表');
  } finally { mks.close(); }
  rmSync(dir, { recursive: true, force: true });
});

test('memory：candidate 默认 + 中文 2 字 FTS + forget 出检索面', () => {
  const mks = new HostMksStore({ path: join(tmp(), 'host-mks.sqlite'), env: envNode });
  try {
    const m1 = mks.putMemory({ kind: 'business', scope: 'tenant', title: '部署窗口', summary: '部署只允许周五晚间窗口', confidence: 0.9, source: { session_id: 's1' } });
    const m2 = mks.putMemory({ kind: 'semantic', title: '周报格式', summary: '周报使用固定五段结构' });
    assert.equal(m1.status, 'candidate');
    const hits = mks.searchMemories({ query: '部署' });
    assert.deepEqual(hits.map(h => h.memory_id), [m1.memory_id]);
    mks.verifyMemory({ memory_id: m2.memory_id, reviewed_by: 'op' });
    assert.equal(mks.getMemory({ memory_id: m2.memory_id }).status, 'verified');
    mks.forgetMemory({ memory_id: m1.memory_id });
    assert.equal(mks.searchMemories({ query: '部署' }).length, 0, '遗忘后 FTS 不再命中');
    assert.equal(mks.listMemories({}).length, 1);
  } finally { mks.close(); }
});

test('knowledge：文档/切片/FTS + claim', () => {
  const mks = new HostMksStore({ path: join(tmp(), 'host-mks.sqlite'), env: envNode });
  try {
    const d = mks.addDocument({ title: '本地部署手册', media_type: 'text/markdown' });
    mks.putChunk({ document_id: d.document_id, ordinal: 0, text: '升级包升版本并重过 A/B/C/D/E 门' });
    mks.putChunk({ document_id: d.document_id, ordinal: 1, text: '回滚按 digest 恢复' });
    assert.equal(mks.searchChunks({ query: '升版本' }).length, 1);
    const c = mks.putClaim({ subject: '本机', predicate: 'prefers_channel', object: 'wechat', confidence: 0.8 });
    mks.putClaim({ subject: '本机', predicate: 'prefers_channel', object: 'wechat', confidence: 0.85 }); // UNIQUE(S,P,O) 幂等
    assert.equal(mks.listClaims({}).length, 1);
    assert.equal(mks.listClaims({})[0].claim_id, c.claim_id);
  } finally { mks.close(); }
});

test('outbox：UNIQUE(node_id, local_event_id) 幂等 + pending→sent 状态机', () => {
  const mks = new HostMksStore({ path: join(tmp(), 'host-mks.sqlite'), env: envNode });
  try {
    const r1 = mks.enqueueOutbox({ kind: 'memory.put', local_event_id: 'evt-1', payload: { memory_id: 'm1' } });
    const r2 = mks.enqueueOutbox({ kind: 'memory.put', local_event_id: 'evt-1', payload: { memory_id: 'm1' } });
    assert.equal(r1.outbox_id, r2.outbox_id, '重复事件幂等');
    assert.equal(mks.listOutbox({ state: 'pending' }).length, 1);
    mks.markOutboxSent([r1.outbox_id]);
    assert.equal(mks.listOutbox({ state: 'pending' }).length, 0);
    assert.equal(mks.listOutbox({ state: 'sent' }).length, 1);
    const stats = mks.status();
    assert.equal(stats.outbox.pending, 0);
    assert.equal(stats.outbox.sent, 1);
  } finally { mks.close(); }
});

test('business：高影响默认 candidate，confirm 才 verified（高影响人工确认）', () => {
  const mks = new HostMksStore({ path: join(tmp(), 'host-mks.sqlite'), env: envNode });
  try {
    const low = mks.putBusinessTerm({ kind: 'terminology', term: '发布窗', detail: '指每日 18–20 点', impact: 'low' });
    const high = mks.putBusinessTerm({ kind: 'preference', term: '只用企业微信沟通', detail: '用户明确要求', impact: 'high' });
    assert.equal(low.status, 'candidate');
    assert.equal(high.status, 'candidate');
    assert.equal(high.impact, 'high');
    mks.confirmBusinessTerm({ term_id: high.term_id, reviewed_by: 'user' });
    assert.equal(mks.getBusinessTerm({ term_id: high.term_id }).status, 'confirmed');
    mks.putBusinessTerm({ kind: 'terminology', term: '发布窗', detail: '改为 17–19 点' }); // 同 (kind,term) 幂等更新
    assert.equal(mks.listBusinessTerms({ kind: 'terminology' }).length, 1);
    assert.equal(mks.listBusinessTerms({ kind: 'terminology' })[0].detail, '改为 17–19 点');
  } finally { mks.close(); }
});

test('联邦：export→import 往返；重复 import 全 duplicate（幂等 (node_id, local_event_id)）', () => {
  const dir = tmp();
  const a = new HostMksStore({ path: join(dir, 'a.sqlite'), env: envNode });
  const b = new HostMksStore({ path: join(dir, 'b.sqlite'), env: { ...envNode, AEC_MCP_NODE_ID: 'host:test-2' } });
  try {
    const m = a.putMemory({ kind: 'business', title: '客户A偏好', summary: '客户A偏好周报', source: { session_id: 's1' } });
    a.putClaim({ subject: '客户A', predicate: 'channel', object: 'email' });
    const bundle = a.exportBundle({ scopes: ['memory', 'knowledge'] });
    assert.equal(bundle.bundle_version, '1');
    assert.equal(bundle.node_id, 'host:test-1');
    assert.ok(bundle.items.length >= 2);
    assert.ok(bundle.digest.startsWith('sha256:'));
    const imp = b.importBundle(bundle);
    assert.equal(imp.accepted, bundle.items.length);
    assert.equal(imp.duplicate, 0);
    assert.ok(b.getMemory({ memory_id: m.memory_id }), '按原 id 落库（origin 记录）');
    const row = b.db.prepare('SELECT origin_node, origin_id FROM host_memory WHERE memory_id=?').get(m.memory_id);
    assert.equal(row.origin_node, 'host:test-1');
    assert.equal(row.origin_id, m.memory_id);
    const imp2 = b.importBundle(bundle);
    assert.equal(imp2.accepted, 0, '重复导入幂等');
    assert.equal(imp2.duplicate, bundle.items.length);
    // bundle_digest 有审计与联邦账
    assert.equal(b.listFederationLog({}).length, 2);
  } finally { a.close(); b.close(); }
  rmSync(dir, { recursive: true, force: true });
});

test('purge/rebuild：清空全部 host_* 表但保留 schema；FTS 可重建', () => {
  const mks = new HostMksStore({ path: join(tmp(), 'host-mks.sqlite'), env: envNode });
  try {
    mks.putMemory({ kind: 'business', title: '部署窗口', summary: '部署只允许周五晚间' });
    mks.putBusinessTerm({ kind: 'terminology', term: '发布窗', detail: '18–20点' });
    mks.enqueueOutbox({ kind: 'memory.put', local_event_id: 'e1', payload: {} });
    const purged = mks.purge();
    assert.ok(purged.memory >= 1 && purged.business_term >= 1 && purged.local_outbox >= 1);
    assert.equal(mks.listMemories({}).length, 0);
    assert.equal(mks.listBusinessTerms({}).length, 0);
    assert.equal(mks.db.prepare('PRAGMA user_version').get().user_version, 3, 'schema 保留（5.1 O1 v2 → 5.2 v3）');
    assert.deepEqual(mks.statusV2Counts(), { host_fact: 0, host_binding: 0, host_delta: 0, host_observation: 0 }, 'v3 四表同被清空且保留');
    // 重建 FTS：重建后可再次命中
    const m = mks.putMemory({ kind: 'business', title: '重建检查', summary: '重建后部署可命中' });
    mks.rebuildFts();
    assert.equal(mks.searchMemories({ query: '部署' }).length, 1);
  } finally { mks.close(); }
});

test('审计：变更自动落 host_audit（R-005）', () => {
  const mks = new HostMksStore({ path: join(tmp(), 'host-mks.sqlite'), env: envNode });
  try {
    mks.putMemory({ kind: 'semantic', title: 't', summary: 's' });
    const audits = mks.listAudit({ action_prefix: 'host.memory' });
    assert.ok(audits.length >= 1);
    assert.equal(audits[audits.length - 1].actor, 'local', '默认 actor=local');
  } finally { mks.close(); }
});
