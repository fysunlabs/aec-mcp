// AEC 5.1 O3-08（A22 联邦 5.1 范围）：Ed25519 bundle 签名 + Host 导入校验。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostMksStore } from '../src/mks/store.mjs';
import { generateSigningKeypair, signDigest, verifySignature, digestOf } from '../src/mks/federation-sign.mjs';

const envNode = { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_NODE_ID: 'host:o3-fed' };
const mkHost = () => new HostMksStore({ path: join(mkdtempSync(join(tmpdir(), 'o3-fed-')), 'h.sqlite'), env: envNode });

test('O3-08 签名原语：generate/sign/verify 往返 + 篡改拒绝', () => {
  const kp = generateSigningKeypair();
  const digest = digestOf([{ a: 1 }]);
  const sig = signDigest(digest, kp.privateKey);
  assert.equal(verifySignature(digest, sig, kp.publicKey), true);
  assert.equal(verifySignature(digest + 'x', sig, kp.publicKey), false, 'digest 篡改拒绝');
  const tamperedSig = (sig.slice(0, 10) === 'A' ? 'B' + sig.slice(1) : 'A' + sig.slice(1));
  assert.equal(verifySignature(digest, tamperedSig, kp.publicKey), false, '签名篡改拒绝');
});

test('O3-08 Host importBundle：有签名验签失败整包拒绝（fail-closed）；无签名路径不变', () => {
  const dst = mkHost();
  const item = { kind: 'package.guidance', ref: 'gd-sig', payload: { guidance_id: 'gd-sig', package_id: 'p', statement: 'x', updated_at: '2026-03-01' } };
  const base = { bundle_version: '1', node_id: 'cloud:node', tables: ['guidance'], items: [item], digest: digestOf([item]) };
  const r0 = dst.importBundle(base); // 无签名 → 兼容放行
  assert.equal(r0.accepted, 1);
  // 有签名但公钥缺失 → 无法验证 → fail-closed
  const bad = { ...base, signature: 'AAAAnotarealsignature=' };
  const r1 = dst.importBundle(bad);
  assert.equal(r1.accepted, 0);
  assert.ok(r1.rejected.every(x => x.reason === 'signature_invalid'));
  // 正确签名 → 通过（同幂等键 duplicate）
  const kp = generateSigningKeypair();
  const good = { ...base, signature: signDigest(base.digest, kp.privateKey), signing_pubkey: kp.publicKey };
  const r2 = dst.importBundle(good);
  assert.equal(r2.duplicate, 1, '同幂等键 duplicate（此前已 accepted）');
  dst.close();
});

test('O3-08 同 ID 不同 updated_at：不覆盖并保留双方', () => {
  const dst = mkHost();
  const mkItem = (updated_at) => ({ kind: 'package.guidance', ref: 'gd-dual',
    payload: { guidance_id: 'gd-dual', package_id: 'p', statement: `v@${updated_at}`, updated_at } });
  const r1 = dst.importBundle({ bundle_version: '1', node_id: 'cloud:node', items: [mkItem('2026-03-01T00:00:00Z')], digest: digestOf([mkItem('2026-03-01T00:00:00Z')]) });
  const r2 = dst.importBundle({ bundle_version: '1', node_id: 'cloud:node', items: [mkItem('2026-03-02T00:00:00Z')], digest: digestOf([mkItem('2026-03-02T00:00:00Z')]) });
  assert.equal(r1.accepted, 1);
  assert.equal(r2.accepted, 1, 'updated_at 不同 → 新行（保留双方，不覆盖）');
  const rows = dst.db.prepare("SELECT guidance_id, updated_at, statement FROM host_package_guidance WHERE guidance_id='gd-dual' ORDER BY updated_at").all();
  assert.equal(rows.length, 2);
  dst.close();
});
