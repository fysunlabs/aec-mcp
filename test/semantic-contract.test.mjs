// AEC 5.1 O3-07：语义契约 —— Host 侧 vendored 副本 digest 校验 + Host 行为一致性。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { HostMksStore } from '../src/mks/store.mjs';

const envNode = { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_NODE_ID: 'host:contract' };
const VENDORED = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../contracts/mks-semantic-vendored.json'), 'utf8'));
// kernel 原版（工作区相邻部署：/tmp/aec 与 /tmp/upstream 同级；本地 D:\AEC 同理）。
// 不存在时跳过同步校验（独立部署 aec-mcp 是合法形态，vendored 即真源）。
const KERNEL_CONTRACT = (() => {
  try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../aec/contracts/mks-semantic/contract.json'), 'utf8')); }
  catch { return null; }
})();

test('O3-07 vendored 契约自带 source_digest 且结构完整', () => {
  assert.equal(VENDORED.schema, 'aec.mks-semantic-contract/v1');
  assert.ok(VENDORED.source_digest?.startsWith('sha256:'), 'vendored 带 source_digest');
  assert.ok(VENDORED.concepts?.memory && VENDORED.status_enums?.guidance);
});

test('O3-07 vendored digest 与 kernel 原版一致（同仓部署时校验同步；独立部署跳过）', () => {
  if (!KERNEL_CONTRACT) return; // 独立部署：vendored 即真源
  const kernelDigest = 'sha256:' + createHash('sha256').update(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../aec/contracts/mks-semantic/contract.json'))).digest('hex');
  // vendored 附加了 vendored_from/source_digest 字段，去掉后与原版逐字节一致
  const strip = ({ vendored_from, source_digest, ...rest }) => rest;
  assert.deepEqual(strip(VENDORED), KERNEL_CONTRACT, 'vendored 内容与 kernel 原版一致（附加字段除外）');
  assert.equal(VENDORED.source_digest, kernelDigest, 'source_digest 指向当前原版');
});

test('O3-07 fixture memory-kind-roundtrip/invalid：Host 行为与契约一致', () => {
  const s = new HostMksStore({ path: join(mkdtempSync(join(tmpdir(), 'o3-hct-')), 'h.sqlite'), env: envNode });
  try {
    const kinds = VENDORED.field_mappings.find(m => m.field === 'memory.kind');
    for (const k of kinds.host_values) {
      const m = s.putMemory({ kind: k, scope: 'tenant', title: k, summary: k });
      assert.equal(m.kind, k);
    }
    const f = VENDORED.fixtures.find(x => x.name === 'memory-kind-invalid');
    assert.throws(() => s.putMemory({ ...f.input, title: 'x' }), e => e.code === f.expect.both_sides_reject);
    const f2 = VENDORED.fixtures.find(x => x.name === 'memory-scope-invalid');
    assert.throws(() => s.putMemory({ ...f2.input, title: 'x' }), e => e.code === f2.expect.both_sides_reject);
  } finally { s.close(); }
});
