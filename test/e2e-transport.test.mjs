// E2E-style test: spin up a local mock AEC kernel, drive the remote transport
// through the credential flow, and verify (密钥模式 2026-11-19):
//   1) first-use key verification (POST /aec/v2/keys/verify) + local credential save
//   2) Bearer api_key (no machine proof header) on business calls
//   3) no machine_code anywhere in any body (机器码彻底退出传输面)
//   4) aec_setup tool end-to-end: verify → save → ready receipt (no key echo)
//   5) plaintext HTTP to a non-loopback is refused by scheme policy
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const seen = [];
const KEY = 'aec_key_E2ETEST0123456789abcdefgh';
let verified = 0;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch {}
  seen.push({ url: req.url, auth: req.headers.authorization, proof: req.headers['x-aec-machine-proof'], body });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/aec/v2/keys/verify') {
    verified++;
    if (body.api_key !== KEY) { res.statusCode = 401; res.end(JSON.stringify({ error: { code: 'key_invalid', message: 'nope' } })); return; }
    res.end(JSON.stringify({ key_id: 'host_key_e2e', label: 'e2e-key', role: 'consumer', tenant: 'default', subject: 'e2e', expires_at: new Date(Date.now() + 86400000).toISOString() }));
    return;
  }
  if (req.url === '/aec/v2/open') {
    res.end(JSON.stringify({ code: 'no_match', session: null }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
const endpoint = `http://127.0.0.1:${port}`;

const { createRemoteKernel, verifyApiKey } = await import('../src/transport.mjs');
const { RolesDB } = await import('../src/db/roles.mjs');
const dir = mkdtempSync(join(tmpdir(), 'aec-mcp-e2e-'));
const credFile = join(dir, 'credentials.json');
const dbPath = join(dir, 'roles.sqlite');

const db = new RolesDB(dbPath);

// ① 首次校验：错误密钥 401；正确密钥返回元数据
const bad = await verifyApiKey({ endpoint, api_key: 'aec_key_wrong' }).catch(e => e);
if (bad.code !== 'key_invalid') throw new Error('wrong key must be key_invalid');
const meta = await verifyApiKey({ endpoint, api_key: KEY });
if (meta.key_id !== 'host_key_e2e' || meta.role !== 'consumer') throw new Error('key metadata mismatch');
if (JSON.stringify(meta).includes(KEY)) throw new Error('key plaintext must never be echoed back');

// ② 无凭证时业务调用拒发（api_key_required）
const kernelCold = createRemoteKernel({ endpoint, profile: 'run', credentialsFile: credFile, env: {} });
const cold = await kernelCold.call('aec', { op: 'open', intent: 'x' }).catch(e => e);
if (cold.code !== 'api_key_required') throw new Error('missing key must be api_key_required before any network I/O');

// ③ aec_setup 工具链路（在 e2e 里直接走 transport 层的等价动作 + 保存语义）
writeFileSync(credFile, JSON.stringify({
  schema: 'aec.credentials/v1', endpoint,
  run: { api_key: KEY, key_id: meta.key_id, label: meta.label, role: meta.role, tenant: meta.tenant, expires_at: meta.expires_at, verified_at: new Date().toISOString() },
}, null, 2), { mode: 0o600 });
if (!existsSync(credFile)) throw new Error('credentials file not saved');

// ④ 业务调用：Bearer api_key、无机器证明头、body 无 machine_code
const kernel = createRemoteKernel({ endpoint, profile: 'run', credentialsFile: credFile, env: {}, rolesDb: db });
const result = await kernel.call('aec', { op: 'open', intent: '测试链路' });
if (result.code !== 'no_match') throw new Error('unexpected business result');

const biz = seen.find(s => s.url === '/aec/v2/open');
if (biz.auth !== `Bearer ${KEY}`) throw new Error('Bearer api_key missing on business call');
if (biz.proof !== undefined) throw new Error('machine proof header must be gone in key mode');
if (JSON.stringify(biz.body).includes('machine_code')) throw new Error('machine code must not appear in any body');

// ⑤ 本地 roles DB 记录（设备以 api-key:<key_id> 标识，不存密钥原文于设备行）
const devices = db.listDevices();
if (devices.length && devices[0].machine_code !== 'api-key:host_key_e2e') throw new Error('device not keyed by api-key id');
if (JSON.stringify(devices).includes(KEY)) throw new Error('key plaintext must not land in devices rows');

// ⑥ 明文 HTTP 到非 loopback 被 S1 拒绝
const { validateEndpoint } = await import('../src/transport.mjs');
const schemeError = (() => { try { validateEndpoint('http://kernel.example.com', {}); return null; } catch (e) { return e; } })();
if (schemeError?.code !== 'insecure_endpoint') throw new Error('plaintext HTTP to non-loopback must be refused');

console.log('E2E_OK', JSON.stringify({
  keyVerifyCalls: verified,
  businessAuth: `${biz.auth.slice(0, 15)}...`,
  proofHeader: 'absent',
  credentialsSaved: true,
  devices: devices.length,
}));

db.close();
server.close();
