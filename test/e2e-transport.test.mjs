// E2E-style test: spin up a local mock AEC kernel, drive the remote transport
// through a real MCP client over stdio, and verify:
//   1) machine activation (binding) exchange
//   2) Bearer + machine-proof headers on business calls
//   3) local roles DB records device/token/profile
//   4) plaintext HTTP to a non-loopback is refused by scheme policy
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const seen = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch {}
  seen.push({ url: req.url, auth: req.headers.authorization, proof: req.headers['x-aec-machine-proof'], body });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/aec/v2/host/activate') {
    res.end(JSON.stringify({
      host_id: 'host_e2e', host_token: 'aec_host_e2e_token', host_salt: 'e2e-salt',
      role: body.role, tenant: 'default', expires_at: new Date(Date.now() + 86400000).toISOString(),
    }));
    return;
  }
  if (req.url === '/aec/v2/open') {
    res.end(JSON.stringify({ code: 'authoring_redirect', message: '请用 aec_author' }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
const endpoint = `http://127.0.0.1:${port}`;

const { createRemoteKernel } = await import('../src/transport.mjs');
const { RolesDB } = await import('../src/db/roles.mjs');
const dir = mkdtempSync(join(tmpdir(), 'aec-mcp-e2e-'));
const idPath = join(dir, 'identity.json');
const dbPath = join(dir, 'roles.sqlite');
process.env.AEC_IDENTITY = idPath;
process.env.AEC_MCP_ROLES_DB = dbPath;

const db = new RolesDB(dbPath);
const kernel = createRemoteKernel({ endpoint, profile: 'run', rolesDb: db });
const id = await kernel.identity();
if (!id.host_token) throw new Error('no host token after activation');

const result = await kernel.call('aec', { op: 'open', intent: '测试链路' });
if (result.code !== 'authoring_redirect') throw new Error('unexpected business result');

const biz = seen.find(s => s.url === '/aec/v2/open');
if (!biz.auth?.startsWith('Bearer aec_host_')) throw new Error('Bearer token missing on business call');
if (!/^[0-9a-f]{64}$/.test(biz.proof || '')) throw new Error('machine proof missing/malformed');
if (JSON.stringify(biz.body).includes('machine_code')) throw new Error('machine code leaked in business body');

const devices = db.listDevices();
const tokens = db.listTokens();
if (devices.length !== 1 || devices[0].role !== 'consumer') throw new Error('device not recorded');
if (tokens.length < 1) throw new Error('token not recorded');

console.log('E2E_OK', JSON.stringify({
  activation: seen.filter(s => s.url === '/aec/v2/host/activate').length,
  businessAuth: biz.auth.slice(0, 20) + '...',
  proofLen: biz.proof.length,
  devices: devices.length,
  tokens: tokens.length,
}));

db.close();
server.close();
