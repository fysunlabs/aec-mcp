// 2.2.0 启动韧性回归：内核暂不可达（connection_refused/超时等暂态故障）时
// stdio server 必须降级启动（stderr warn + initialize 握手成功），而不是
// failOnStartupError 退出导致宿主 `MCP error -32000: Connection closed`。
// 事故背景（2026-11-27）：本机 Tailscale offline → aec-author 探测 100.64.0.1:18041
// ECONNREFUSED → 进程退出 → 宿主 MCP 全断。配置错误（占位域名）仍 fail fast。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli.mjs');
const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1.0' } } }) + '\n';

// 异步握手：mock server 在本进程 event loop 上，必须用 spawn（spawnSync 会阻塞
// 本进程 event loop，mock 无法响应子进程 probe → 假超时）。
const handshakeAsync = async (env, { expectWarn = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-startup-'));
  const child = spawn(process.execPath, [cli, '--profile', 'author'], {
    env: { ...process.env, ...env, AEC_IDENTITY_DIR: dir },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.stdin.write(INIT);
  const ok = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 20000);
    child.stdout.on('data', function check(d) { if (String(d).includes('"serverInfo"')) { clearTimeout(t); child.kill(); resolve(true); } });
  });
  rmSync(dir, { recursive: true, force: true });
  return { ok, stdout, stderr };
};

test('内核 connection_refused：stderr 降级警告 + initialize 握手仍成功（不再 Connection closed）', async () => {
  // 死端口：连接层立刻 refused，精确复现 tailnet 断连时的故障形态
  const r = await handshakeAsync({ AEC_KERNEL_URL: 'http://127.0.0.1:19998' });
  assert.ok(r.ok, '握手响应存在（server 未退出）');
  assert.ok(r.stdout.includes('"name":"aec-mcp"'), 'serverInfo 正常返回');
  assert.ok(r.stderr.includes('暂不可达'), 'stderr 含降级警告');
  assert.ok(r.stderr.includes('Tailscale offline'), '警告含常见原因指引');
});

test('内核可达：无降级警告，握手照常', async () => {
  const server = createServer((req, res) => { res.statusCode = 404; res.end(); });
  server.listen(0, '127.0.0.1');
  await new Promise(res => server.once('listening', res));
  try {
    const r = await handshakeAsync({ AEC_KERNEL_URL: `http://127.0.0.1:${server.address().port}` });
    assert.ok(r.ok, '握手响应存在');
    assert.ok(!r.stderr.includes('暂不可达'), '可达时无降级警告');
  } finally { server.close(); }
});
