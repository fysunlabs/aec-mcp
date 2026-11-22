// AEC 5.1.0 O1-00c/O1-01：Host MKS 迁移 v2（只加表 + 可重入 + 旧数据不变）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostMksStore, migrateHostMks } from '../src/mks/store.mjs';

const env = { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_NODE_ID: 'host:mig-v2' };
const V2_TABLES = ['host_scope_link', 'host_thread', 'host_episode', 'host_preference',
  'host_memory_retrieval_event', 'host_package_guidance'];

test('migrate v1→v2：只加 6 张表，旧 host_memory 数据保留，user_version=2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmig2-'));
  const store = new HostMksStore({ path: join(dir, 'h.sqlite'), env });
  try {
    // 灌一条 v1 旧对象（无 scope link → 应进 unknown_owner 隔离区）
    store.db.prepare('INSERT INTO host_memory(memory_id,kind,scope,title,summary,content_json,confidence,status,source_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('legacy-1', 'semantic', 'tenant', '旧记忆', '无归属旧数据', '{}', 0.5, 'verified', '{}', new Date().toISOString(), new Date().toISOString());
    const before = store.db.prepare('SELECT count(*) c FROM host_memory').get().c;
    assert.equal(store.migration.to, 2);

    for (const t of V2_TABLES) {
      const row = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      assert.ok(row, `表 ${t} 应存在`);
    }
    assert.equal(store.db.prepare('SELECT count(*) c FROM host_memory').get().c, before, '旧数据行数不变');

    // 新表列结构抽查（scope_link 覆盖 7 类对象所需的字段）
    const cols = store.db.prepare('PRAGMA table_info(host_scope_link)').all().map(c => c.name);
    for (const k of ['object_type', 'object_id', 'tenant_id', 'user_id', 'project_id', 'thread_id']) {
      assert.ok(cols.includes(k), `host_scope_link 应有列 ${k}`);
    }
    // 旧记忆无 scope link → unknown_owner（默认不注入）
    const link = store.db.prepare('SELECT * FROM host_scope_link WHERE object_id=?').get('legacy-1');
    assert.equal(link, undefined, '旧数据无 scope link（隔离区）');
    // episode / thread / preference 存在且可写
    store.db.prepare('INSERT INTO host_thread(thread_id,user_id,tenant_id,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('t1', 'user:alice', 'default', '会话', 'open', new Date().toISOString(), new Date().toISOString());
    assert.equal(store.db.prepare('SELECT count(*) c FROM host_thread').get().c, 1);
  } finally { store.close(); }
});

test('迁移可重入：重复 migrate 无新步骤，数据不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmig2r-'));
  const dbPath = join(dir, 'h.sqlite');
  const s1 = new HostMksStore({ path: dbPath, env });
  s1.close();
  const s2 = new HostMksStore({ path: dbPath, env });
  try {
    assert.equal(s2.migration.applied.length, 0, '第二次构造无新迁移');
    assert.equal(s2.migration.from, 2);
    assert.equal(s2.migration.to, 2);
  } finally { s2.close(); }
});

test('lite 模式仍不建库（2.0.0 边端行为逐字节不变）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmig2l-'));
  assert.throws(() => new HostMksStore({ path: join(dir, 'h.sqlite'), env: { AEC_MCP_LOCAL_MEMORY: 'lite' } }),
    e => e.code === 'mks_lite_disabled');
});
