// AEC 5.1 O3-08：联邦 bundle Ed25519 签名（A22 联邦 5.1 范围）。
//
// 设计：
//   - export 侧用 Ed25519 私钥对 bundle.digest 签名（signature + signing_pubkey 入 bundle）；
//   - import 侧先验签：无签名 → 放行（向后兼容，旧 bundle 不破坏）；有签名但验签失败 →
//     整包拒绝（signature_invalid），不接受任何 item；
//   - 密钥只从 0600 文件或调用方注入；本模块不落盘、不回显私钥。
//
// 只加不改：既有 exportBundle/importBundle 语义零变化（无签名路径不变）。
import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

export function digestOf(items) {
  return `sha256:${createHash('sha256').update(JSON.stringify(items)).digest('hex')}`;
}

/** 生成 Ed25519 密钥对（测试/初始化用）；返回 {privateKey(PEM), publicKey(PEM)}。 */
export function generateSigningKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

/** 对 digest 签名（privateKeyPem 为 PEM 字符串或 Buffer）。返回 base64。 */
export function signDigest(digest, privateKeyPem) {
  const sig = cryptoSign(null, Buffer.from(String(digest), 'utf8'), privateKeyPem);
  return sig.toString('base64');
}

/** 验签：signature(base64) + digest + publicKeyPem → boolean。 */
export function verifySignature(digest, signatureB64, publicKeyPem) {
  try {
    return cryptoVerify(null, Buffer.from(String(digest), 'utf8'), publicKeyPem, Buffer.from(String(signatureB64), 'base64'));
  } catch { return false; }
}

/** 给既有 bundle 对象附加签名字段（不改动 items/digest 语义）。 */
export function attachSignature(bundle, privateKeyPem) {
  if (!bundle?.digest) throw Object.assign(new Error('bundle_digest_required'), { code: 'bundle_digest_required' });
  return { ...bundle, signature: signDigest(bundle.digest, privateKeyPem) };
}
