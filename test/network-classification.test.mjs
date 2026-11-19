// 网络错误分类与凭证保护回归（2026-11-19 安装复盘 P0 项；同日改密钥模式）：
//   P0#3/#6  fetch failed 不得误分类为 internal_error，文案带端点与失败类别
//   P0#4     网络类失败用同一凭证原样重试一次（无任何客户端侧换钥/重绑）
//   P1#5     占位域名启动期拒绝 + probeEndpoint 连通性自检
// 密钥模式：身份 = Bearer api_key（env 注入，测试里给假密钥）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteKernel, validateEndpoint, probeEndpoint } from '../src/transport.mjs';
import { humanError } from '../src/mcp.mjs';

const KEY = 'aec_key_NETTEST0123456789';
const KEY_ENV = { AEC_API_KEY: KEY };

const silentServer = () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 'no_match' }));
  });
  server.listen(0, '127.0.0.1');
  return server;
};

test('P0#3: connection refused is typed network_error, not internal_error', async () => {
  const server = silentServer();
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  const kernel = createRemoteKernel({ endpoint: `http://127.0.0.1:${port}`, profile: 'run', env: KEY_ENV });
  await assert.rejects(
    () => kernel.call('aec', { op: 'open', intent: 'x' }),
    e => {
      assert.equal(e.code, 'network_error');
      assert.match(e.message, /不是 AEC 的缺陷/);
      assert.match(e.message, /connection_refused|ECONNREFUSED/);
      assert.match(e.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
      assert.equal(e.details?.category, 'connection_refused');
      return true;
    }
  );
});

test('P0#4: network failure never mutates the local credentials file (key is user-held)', async () => {
  const server = silentServer();
  await once(server, 'listening');
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), 'aec-mcp-keykeep-'));
  const credFile = join(dir, 'credentials.json');
  writeFileSync(credFile, JSON.stringify({ schema: 'aec.credentials/v1', endpoint: null, run: { api_key: KEY, key_id: 'host_k' }, author: null }));
  const kernel = createRemoteKernel({ endpoint: `http://127.0.0.1:${port}`, profile: 'run', credentialsFile: credFile, env: {} });
  const cred = kernel.credential();
  assert.equal(cred.api_key, KEY); // 来自文件，不是 env
  server.close();
  await once(server, 'close');
  await assert.rejects(() => kernel.call('aec', { op: 'open', intent: 'x' }), e => e.code === 'network_error');
  const after = readFileSync(credFile, 'utf8');
  assert.match(after, /aec_key_NETTEST/, 'network failure must NOT mutate or delete the credentials file');
});

test('P0#4: transient socket reset retries once with the SAME key (no re-key, no extra auth roundtrip)', async () => {
  let opens = 0;
  const seenKeys = [];
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/aec/v2/open') {
      opens++;
      seenKeys.push(String(req.headers.authorization || ''));
      if (opens === 1) { req.socket.destroy(); return; } // 第一次连接被重置 → 网络类失败
      res.end(JSON.stringify({ code: 'no_match' }));
      return;
    }
    res.end(JSON.stringify({}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const kernel = createRemoteKernel({ endpoint: `http://127.0.0.1:${server.address().port}`, profile: 'run', env: KEY_ENV });
    const result = await kernel.call('aec', { op: 'open', intent: 'x' });
    assert.equal(result.code, 'no_match');
    assert.equal(opens, 2, 'first attempt reset, second attempt succeeded');
    assert.deepEqual(seenKeys, [`Bearer ${KEY}`, `Bearer ${KEY}`], 'same key on both attempts');
  } finally { server.close(); }
});

test('P0#4: auth failure (401) is surfaced as typed error — no retry, no re-key', async () => {
  let opens = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/aec/v2/open') {
      opens++;
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { code: 'key_invalid', message: 'This API key does not match any active AEC key' } }));
      return;
    }
    res.end(JSON.stringify({}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const kernel = createRemoteKernel({ endpoint: `http://127.0.0.1:${server.address().port}`, profile: 'run', env: KEY_ENV });
    await assert.rejects(
      () => kernel.call('aec', { op: 'open', intent: 'x' }),
      e => e.code === 'key_invalid'
    );
    assert.equal(opens, 1, 'auth failure must not be retried client-side');
  } finally { server.close(); }
});

test('P1#5: placeholder endpoints are refused at validation time', () => {
  for (const bad of ['https://aec-api.your-domain.example', 'https://x.invalid', 'http://host.test:8000']) {
    assert.throws(() => validateEndpoint(bad, {}), e => e.code === 'endpoint_placeholder', bad);
  }
  // 文档/测试惯用的 example.com 子域不在占位拒绝范围（RFC 2606 只保留 TLD .example）。
  const u = validateEndpoint('https://aec.example.com/aec/v2', {});
  assert.equal(u.hostname, 'aec.example.com');
});

test('P1#5: probeEndpoint passes on any HTTP response, throws endpoint_unreachable on refused', async () => {
  const server = silentServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const live = validateEndpoint(`http://127.0.0.1:${port}`, {});
  assert.equal(await probeEndpoint(live), true);
  server.close();
  await once(server, 'close');
  await assert.rejects(() => probeEndpoint(live), e => {
    assert.equal(e.code, 'endpoint_unreachable');
    assert.match(e.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
    return true;
  });
});

test('humanError: key-mode guidance exists for all key codes; network text unchanged', () => {
  for (const code of ['api_key_required', 'key_invalid', 'key_revoked', 'key_expired', 'unauthorized', 'host_fingerprint_missing']) {
    const text = humanError(code);
    assert.ok(text, `${code} must have a human guidance entry`);
    assert.match(text, /aec_key_/, `${code} guidance must mention the key format`);
  }
  const net = humanError('network_error');
  assert.match(net, /不是 AEC 的缺陷/);
  assert.match(net, /AEC_KERNEL_URL/);
});
