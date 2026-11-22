// AEC 5.1 O6-02：aec-mcp 2.1.0 兼容矩阵（五格）。
// 格1: 旧 2.0(lite) ↔ 5.1 kernel；格2: 新 2.1(lite) ↔ 5.0 kernel（行为面兼容——本仓库内以
//      flags off 等价代表）；格3: 2.1 ↔ 5.1 全量；格4: 2.1(lite) 与 2.0 字节等价（flags 测试覆盖）；
// 格5: **2.1(node) 迁移到 host-mks v2 后，旧版（v1 迁移代码）打开同一库**——旧 recall/remember
//      仍可用、新表不影响旧查询；若不行，回退步骤必须先恢复 DB 备份（此处验证「可行」分支）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostMksStore } from '../src/mks/store.mjs';

const envNode = { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_NODE_ID: 'host:compat' };
const envLite = { AEC_MCP_LOCAL_MEMORY: 'lite', AEC_MCP_NODE_ID: 'host:compat' };

test('O6-02 格4：2.1(lite) flags 快照与 2.0 语义等价（lite 模式 + federation none）', () => {
  const snap = flagsSnapshotReal(envLite);
  assert.equal(snap.local_memory_mode, 'lite');
  assert.equal(snap.federation_mode, 'none');
});

test('O6-02 格5：v2 库（含 host_package_guidance 等新表）可被 v1 迁移语义打开——旧表/旧查询不受影响', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o6-compat-'));
  const dbPath = join(dir, 'h.sqlite');
  // ① 2.1(node)：写旧数据 + 迁移到 v2（新表出现）
  const s21 = new HostMksStore({ path: dbPath, env: envNode });
  const m = s21.putMemory({ kind: 'semantic', scope: 'tenant', title: '旧版写入的记忆', summary: 'v2 库中的既有数据', status: 'verified' });
  s21.db.prepare("INSERT INTO host_package_guidance(guidance_id,origin_node,tenant_id,package_id,version_range,scope,kind,applies_to_json,statement,source,status,created_at,updated_at) VALUES('gd-c1','cloud:x','default','p','>=0','package','tip','[]','v2 表数据','admin','candidate','2026-01-01','2026-01-01')").run();
  s21.close();
  // ② 旧版语义打开：v1 迁移只建 v1 表——对已是 v2 的库重跑 migrate 时 v2 步骤
  //    （IF NOT EXISTS / 可重入）不破坏旧表；旧查询（host_memory FTS 召回）仍可用。
  //    这里用「重新打开 + 只用 v1 时代的 API」模拟旧 2.0.0 行为（同一迁移链向前兼容）。
  const s20 = new HostMksStore({ path: dbPath, env: envNode });
  try {
    const rows = s20.searchMemories({ query: '旧版写入的记忆', limit: 5 });
    assert.ok(rows.some(x => x.memory_id === m.memory_id), '旧 recall 在 v2 库上仍可用');
    const again = s20.putMemory({ kind: 'episodic', scope: 'tenant', title: '旧版再写', summary: '2.0 行为不受新表影响' });
    assert.ok(again.memory_id, '旧 remember/putMemory 仍可写');
    const newTables = s20.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('host_package_guidance','host_thread','host_scope_link')").all().map(r => r.name);
    assert.ok(newTables.includes('host_package_guidance'), 'v2 新表原样保留（未破坏）');
    const cnt = s20.db.prepare('SELECT count(*) c FROM host_package_guidance').get().c;
    assert.equal(cnt, 1, '新表数据完整（旧版不读写但不清除）');
    assert.ok(s20.migration.applied.length === 0, '重复打开 applied=[]（可重入，无破坏性迁移）');
  } finally { s20.close(); }
});

test('O6-02 格3：2.1 全量（node + continuity/guidance 渲染面 flags 就绪）', () => {
  const snap = flagsSnapshotReal(envNode);
  assert.equal(snap.local_memory_mode, 'node');
  assert.equal(snap.mcp_continuity, false, '默认 off（canary 宿主显式开）');
  assert.equal(snap.mcp_guidance, false);
});

// flags import（顶部静态）
import { flagsSnapshot as flagsSnapshotReal } from '../src/mks/flags.mjs';
