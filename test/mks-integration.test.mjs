// P1-08：aec-mcp 侧集成——跨端契约（Cloud 形状 bundle → Host import）+ 旧 2.0.0 库共存。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostMksStore } from '../src/mks/store.mjs';
import { RolesDB } from '../src/db/roles.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'aec-mks-x-'));
const envNode = { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_NODE_ID: 'host:x-1' };

test('跨端契约：Cloud MKS（aec/src/mks/schema.mjs FederationBundle v1 形状）可被 Host import', () => {
  const dir = tmp();
  const mks = new HostMksStore({ path: join(dir, 'host-mks.sqlite'), env: envNode });
  try {
    // 与内核 MksStore.search/export 对齐的最小 Cloud bundle 形状
    //（字段名以 aec/src/mks/schema.mjs FederationBundle + mks_memory 行为准，两侧同步维护）。
    const cloudBundle = {
      bundle_version: '1',
      node_id: 'cloud-aec-node',
      generated_at: '2026-11-21T00:00:00.000Z',
      tables: ['memory'],
      items: [
        { kind: 'memory', ref: 'mem_cloud_1', payload: {
          memory_id: 'mem_cloud_1', kind: 'business', scope: 'tenant',
          title: '客户A偏好周报', summary: '客户A偏好每周五收到部署周报',
          content: {}, confidence: 0.9, sensitivity: 'internal', status: 'candidate',
          source: { session_id: 'cloud-sess-1' }, supersedes: null,
          created_at: '2026-11-21T00:00:00.000Z', updated_at: '2026-11-21T00:00:00.000Z',
        } },
      ],
      digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    };
    const imp = mks.importBundle(cloudBundle, { peer_node: 'cloud-aec-node' });
    assert.equal(imp.accepted, 1);
    const got = mks.getMemory({ memory_id: 'mem_cloud_1' });
    assert.equal(got.kind, 'business');
    assert.equal(got.origin.node, 'cloud-aec-node');
    assert.equal(mks.searchMemories({ query: '部署' }).length, 1, '导入后本地可检索');
    const imp2 = mks.importBundle(cloudBundle);
    assert.equal(imp2.accepted, 0);
    assert.equal(imp2.duplicate, 1);
  } finally { mks.close(); }
  rmSync(dir, { recursive: true, force: true });
});

test('旧 2.0.0 库共存：既有 roles.sqlite 数据在 Host MKS 引入后原样保留', () => {
  const dir = tmp();
  const rolesPath = join(dir, 'roles.sqlite');
  const roles = new RolesDB(rolesPath);
  const before = { schema: roles.schemaVersion, devices: roles.listDevices().length, profiles: roles.listProfiles().length };
  roles.close();
  const mks = new HostMksStore({ path: join(dir, 'host-mks.sqlite'), env: envNode });
  mks.putMemory({ kind: 'semantic', title: '共存', summary: '部署共存' });
  mks.close();
  const roles2 = new RolesDB(rolesPath);
  const after = { schema: roles2.schemaVersion, devices: roles2.listDevices().length, profiles: roles2.listProfiles().length };
  roles2.close();
  assert.deepEqual(after, before, 'roles 数据零变化');
  rmSync(dir, { recursive: true, force: true });
});
