// 网络错误分类与令牌保护回归（2026-11-19 安装复盘 P0 项）：
//   P0#3/#6  fetch failed 不得误分类为 internal_error，文案带端点与失败类别
//   P0#4     网络类失败绝不 force rebind（不删除本机有效令牌）
//   P1#5     占位域名启动期拒绝 + probeEndpoint 连通性自检
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteKernel, validateEndpoint, probeEndpoint } from '../src/transport.mjs';
import { humanError } from '../src/mcp.mjs';

function isolatedEnv(dir) {
  process.env.AEC_IDENTITY = join(dir, 'identity.json');
  process.env.AEC_MCP_ROLES_DB = join(dir, 'roles.sqlite');
  delete process.env.AEC_KERNEL_ALLOWLIST;
  delete process.env.AEC_ALLOW_INSECURE_HTTP;
}

const activateServer = () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/aec/v2/host/activate') {
      res.end(JSON.stringify({ host_id: 'h', host_token: 'aec_host_NETTEST', host_salt: 's', role: 'consumer' }));
      return;
    }
    res.end(JSON.stringify({ code: 'no_match' }));
  });
  server.listen(0, '127.0.0.1');
  return server;
};

test('P0#3: connection refused is typed network_error, not internal_error', async () => {
  const server = activateServer();
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  const dir = mkdtempSync(join(tmpdir(), 'aec-mcp-netcls-'));
  isolatedEnv(dir);
  const kernel = createRemoteKernel({ endpoint: `http://127.0.0.1:${port}`, profile: 'run' });
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

test('P0#4: network failure after successful binding never deletes local token', async () => {
  const server = activateServer();
  await once(server, 'listening');
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), 'aec-mcp-tokkeep-'));
  isolatedEnv(dir);
  const kernel = createRemoteKernel({ endpoint: `http://127.0.0.1:${port}`, profile: 'run' });
  const id = await kernel.identity();
  assert.ok(id.host_token);
  const fileBefore = readFileSync(join(dir, 'identity.json'), 'utf8');
  assert.match(fileBefore, /aec_host_NETTEST/);

  server.close();
  await once(server, 'close');
  // 同一内核（令牌已在文件与本进程缓存中）：网络失败 → 重试一次 → typed 错误。
  await assert.rejects(() => kernel.call('aec', { op: 'open', intent: 'x' }), e => e.code === 'network_error');
  const fileAfter = readFileSync(join(dir, 'identity.json'), 'utf8');
  assert.match(fileAfter, /aec_host_NETTEST/, 'network failure must NOT trigger force rebind / token deletion');
});

test('P0#4: transient socket reset retries once with the SAME identity (no rebind)', async () => {
  let opens = 0, activations = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/aec/v2/host/activate') {
      activations++;
      res.end(JSON.stringify({ host_id: 'h', host_token: 'aec_host_TRANSIENT', host_salt: 's', role: 'consumer' }));
      return;
    }
    if (req.url === '/aec/v2/open') {
      opens++;
      if (opens === 1) { req.socket.destroy(); return; } // 第一次连接被重置 → 网络类失败
      res.end(JSON.stringify({ code: 'no_match' }));
      return;
    }
    res.end(JSON.stringify({}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = mkdtempSync(join(tmpdir(), 'aec-mcp-transient-'));
  isolatedEnv(dir);
  try {
    const kernel = createRemoteKernel({ endpoint: `http://127.0.0.1:${server.address().port}`, profile: 'run' });
    const result = await kernel.call('aec', { op: 'open', intent: 'x' });
    assert.equal(result.code, 'no_match');
    assert.equal(opens, 2, 'first attempt reset, second attempt succeeded');
    assert.equal(activations, 1, 'transient network error must not re-activate / rebind');
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
  const server = activateServer();
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

test('humanError: network_error guidance exists and does not blame the kernel', () => {
  const text = humanError('network_error');
  assert.ok(text, 'network_error must have a human guidance entry');
  assert.match(text, /不是 AEC 的缺陷/);
  assert.match(text, /AEC_KERNEL_URL/);
});
