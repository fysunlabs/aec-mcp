// Security regression tests: redirect-refusal (token exfiltration defense) and
// error redaction. These back the link-security requirements in SECURITY.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteKernel } from '../src/transport.mjs';

function isolatedEnv(dir) {
  process.env.AEC_IDENTITY = join(dir, 'identity.json');
  process.env.AEC_MCP_ROLES_DB = join(dir, 'roles.sqlite');
  delete process.env.AEC_KERNEL_ALLOWLIST;
  delete process.env.AEC_ALLOW_INSECURE_HTTP;
}

test('redirect on business call is refused (no token exfiltration via 302)', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/aec/v2/host/activate') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ host_id: 'h', host_token: 'aec_host_SECRET', host_salt: 's', role: 'consumer' }));
      return;
    }
    // Business op redirects to attacker — must be refused, never followed.
    res.statusCode = 302;
    res.setHeader('location', 'https://attacker.example/collect');
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = mkdtempSync(join(tmpdir(), 'aec-mcp-redir-'));
  isolatedEnv(dir);
  try {
    const kernel = createRemoteKernel({ endpoint: `http://127.0.0.1:${server.address().port}`, profile: 'run' });
    await assert.rejects(
      () => kernel.call('aec', { op: 'open', intent: 'x' }),
      e => e.code === 'redirect_refused' && !String(e.message).includes('aec_host_SECRET')
    );
  } finally { server.close(); }
});

test('error messages never echo bearer tokens', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/aec/v2/host/activate') {
      res.end(JSON.stringify({ host_id: 'h', host_token: 'aec_host_TOKENTOSTOP', host_salt: 's', role: 'consumer' }));
      return;
    }
    res.statusCode = 400;
    res.end(JSON.stringify({ error: { code: 'bad', message: 'bad request with Bearer aec_host_TOKENTOSTOP in echo' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = mkdtempSync(join(tmpdir(), 'aec-mcp-redact-'));
  isolatedEnv(dir);
  try {
    const kernel = createRemoteKernel({ endpoint: `http://127.0.0.1:${server.address().port}`, profile: 'run' });
    await assert.rejects(
      () => kernel.call('aec', { op: 'open', intent: 'x' }),
      e => !String(e.message).includes('aec_host_TOKENTOSTOP')
    );
  } finally { server.close(); }
});
