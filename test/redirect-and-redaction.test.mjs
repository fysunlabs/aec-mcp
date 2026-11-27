// Security regression tests: redirect-refusal (token exfiltration defense) and
// error redaction. These back the link-security requirements in SECURITY.md.
// 密钥模式（2026-11-19）：身份 = Bearer api_key（env 注入，测试里给假密钥）。
// 测试隔离（2026-11-27）：resolveApiKey 会回落本机凭证文件（credentialsPath →
// os.homedir()）；宿主装过 AEC 时真实凭证会让「缺密钥应拒绝」用例真的发网络
// 请求而超时误报。这里把 homedir 相关 env 指到一次性目录（Windows 上
// os.homedir() 读 USERPROFILE，不是 HOME）。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const _isoDir = mkdtempSync(join(tmpdir(), 'aec-iso-'));
for (const k of ['USERPROFILE', 'HOME', 'APPDATA', 'XDG_CONFIG_HOME']) process.env[k] = _isoDir;
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRemoteKernel } from '../src/transport.mjs';

const KEY_ENV = { AEC_API_KEY: 'aec_key_TESTKEY0123456789' };

test('redirect on business call is refused (no token exfiltration via 302)', async () => {
  const server = createServer((req, res) => {
    // Business op redirects to attacker — must be refused, never followed.
    res.statusCode = 302;
    res.setHeader('location', 'https://attacker.example/collect');
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const kernel = createRemoteKernel({ endpoint: `http://127.0.0.1:${server.address().port}`, profile: 'run', env: KEY_ENV });
    await assert.rejects(
      () => kernel.call('aec', { op: 'open', intent: 'x' }),
      e => e.code === 'redirect_refused' && !String(e.message).includes(KEY_ENV.AEC_API_KEY)
    );
  } finally { server.close(); }
});

test('error messages never echo bearer tokens or api keys', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.statusCode = 400;
    res.end(JSON.stringify({ error: { code: 'bad', message: 'bad request with Bearer aec_host_TOKENTOSTOP and Bearer aec_key_TESTKEY0123456789 in echo' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const kernel = createRemoteKernel({ endpoint: `http://127.0.0.1:${server.address().port}`, profile: 'run', env: KEY_ENV });
    await assert.rejects(
      () => kernel.call('aec', { op: 'open', intent: 'x' }),
      e => !String(e.message).includes('aec_host_TOKENTOSTOP') && !String(e.message).includes(KEY_ENV.AEC_API_KEY)
    );
  } finally { server.close(); }
});

test('missing api key: business call refuses BEFORE any network I/O with actionable guidance', async () => {
  let hits = 0;
  const server = createServer(() => { hits++; });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const kernel = createRemoteKernel({ endpoint: `http://127.0.0.1:${server.address().port}`, profile: 'run', env: {} });
    await assert.rejects(
      () => kernel.call('aec', { op: 'open', intent: 'x' }),
      e => e.code === 'api_key_required' && /aec_setup/.test(e.message)
    );
    assert.equal(hits, 0); // 缺密钥一个字节都不该发出去
  } finally { server.close(); }
});
