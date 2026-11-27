// AEC 5.2：上游 aec_author(op=ontology) 边端测试。
// promote 走 Host MKS 直读（delta_id → host_delta → 标 approved 后交内核）；
// pkg_dir 内联读 BO 文档；内核只收 business_ontology/delta，不写宿主库。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpV2 } from '../src/mcp.mjs';
import { HostMksStore } from '../src/mks/store.mjs';

const call = (s, name, args = {}) => s._registeredTools[name].handler(args);
const envNode = { AEC_MCP_LOCAL_MEMORY: 'node' };
const BO = { schema: 'aec.business-ontology/v1', id: 'bo:auth-edge', version: '1.0.0', profile: 'core', goals: [{ id: 'G-1', statement: '发帖', outcomes: ['O-1'] }], bindings: [{ slot: 'x.key', kind: 'secret_ref', required: true, sensitive: true, source: 'host' }], provenance: { author: 't', sources: [] } };
const norm = d => d; // HostMksStore 不校验 BO 形状，原样存

test('author op=ontology：promote 按 delta_id 从 Host MKS 读出并交内核（读后标 approved）', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-auth-ont-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  const prev = process.env.AEC_IDENTITY_DIR;
  process.env.AEC_IDENTITY_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.AEC_IDENTITY_DIR; else process.env.AEC_IDENTITY_DIR = prev; });
  const env = { AEC_IDENTITY_DIR: dir, AEC_MCP_HOST_MKS_DB: join(dir, 'host-mks.sqlite'), AEC_MCP_LOCAL_MEMORY: 'node', ...envNode };
  // 宿主库里先落一条 candidate delta（真实形状：observe 流程由 run 侧边端写入）
  let captured = null;
  const kernelCapture = { async call(name, args) { captured = { name, args }; return { v: 'aec/v2', message: 'BO 1.1.0 released' }; } };
  const s = createMcpV2(kernelCapture, { profile: 'author', env });
  const store = await s._hostMks.getStore();
  const d = store.putHostDelta({ bo_id: 'bo:auth-edge', base_digest: 'a'.repeat(64), patch: [{ op: 'replace', path: '/goals/0/statement', value: '宿主修正后的目标' }], source: 'run', status: 'candidate' });

  const s2 = createMcpV2(kernelCapture, { profile: 'author', env });
  const r = await call(s2, 'aec_author', { op: 'ontology', action: 'promote', delta_id: d.delta_id, target_version: '1.1.0', bo_id: 'bo:auth-edge', confirm: true });
  assert.equal(r.isError, undefined);
  assert.equal(captured.name, 'aec_author');
  assert.equal(captured.args.op, 'ontology');
  assert.equal(captured.args.delta.base_digest, 'a'.repeat(64), 'delta 从 Host MKS 读出并随调用交内核');
  assert.deepEqual(captured.args.delta.patch, [{ op: 'replace', path: '/goals/0/statement', value: '宿主修正后的目标' }]);
  assert.equal(captured.args.delta_id, d.delta_id);
  assert.equal(captured.args.confirm, true, 'confirm 第二遍显式传递');
  const after = store.getHostDelta({ delta_id: d.delta_id });
  assert.equal(after.status, 'approved', '读到即标 approved（审计）');
  // 内核返回原样透传
  assert.match(r.content[0].text, /1\.1\.0 released/);
  // 清理：显式 close 再删目录
  t.after(() => { try { s._hostMks.close(); s2._hostMks.close(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* win */ } });
});

test('author op=ontology：pkg_dir 内联读 BO 文档（validate 不写库）', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-auth-ont2-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  const prev = process.env.AEC_IDENTITY_DIR;
  process.env.AEC_IDENTITY_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.AEC_IDENTITY_DIR; else process.env.AEC_IDENTITY_DIR = prev; });
  const env = { AEC_IDENTITY_DIR: dir, AEC_MCP_HOST_MKS_DB: join(dir, 'host-mks.sqlite'), AEC_MCP_LOCAL_MEMORY: 'node', ...envNode };
  const pkg = join(dir, 'pkg');
  mkdirSync(join(pkg, 'resources', 'ontology'), { recursive: true });
  writeFileSync(join(pkg, 'resources', 'ontology', 'business.json'), JSON.stringify(BO));
  let captured = null;
  const kernelCapture = { async call(name, args) { captured = { name, args }; return { v: 'aec/v2', message: 'BO ok' }; } };
  const s = createMcpV2(kernelCapture, { profile: 'author', env });
  t.after(() => { try { s._hostMks.close(); } catch { /* ignore */ } });
  const r = await call(s, 'aec_author', { op: 'ontology', action: 'validate', pkg_dir: pkg });
  assert.equal(r.isError, undefined);
  assert.equal(captured.args.business_ontology?.id, 'bo:auth-edge', 'BO 文档由 pkg_dir 内联');
  assert.equal(captured.args.action, 'validate');
});

test('author op=ontology：delta_id 不存在 → host_delta_not_found（不伪造）', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-auth-ont3-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  const prev = process.env.AEC_IDENTITY_DIR;
  process.env.AEC_IDENTITY_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.AEC_IDENTITY_DIR; else process.env.AEC_IDENTITY_DIR = prev; });
  const env = { AEC_IDENTITY_DIR: dir, AEC_MCP_HOST_MKS_DB: join(dir, 'host-mks.sqlite'), AEC_MCP_LOCAL_MEMORY: 'node', ...envNode };
  const s = createMcpV2({ async call() { throw new Error('unmocked'); } }, { profile: 'author', env });
  t.after(() => { try { s._hostMks.close(); } catch { /* ignore */ } });
  const r = await call(s, 'aec_author', { op: 'ontology', action: 'promote', delta_id: 'missing', target_version: '1.1.0', confirm: true });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, 'host_delta_not_found');
});
