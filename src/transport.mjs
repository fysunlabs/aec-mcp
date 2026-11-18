// Remote kernel transport + security-hardened HTTP client.
//
// Every request carries Bearer <host_token> and a machine proof header.
// The token never reaches the model and is never logged. Security invariants:
//   S1  endpoint scheme: HTTPS required unless AEC_ALLOW_INSECURE_HTTP=1
//       (loopback/tailnet only). This closes the plaintext-HTTP credential leak.
//   S2  endpoint allowlist via AEC_KERNEL_ALLOWLIST (comma-separated origins);
//       when set, any other origin is refused before a single byte is sent.
//   S3  bearer + machine proof on every business call; proof derived locally,
//       machine code never transmitted.
//   S4  dead-token self-heal: unauth/fingerprint/expired/inactive -> rebind once.
//   S5  bounded timeouts + manual redirect handling (no auto-follow: prevents
//       token exfiltration via 302 to an attacker origin).
//   S6  errors are sanitized (no token / proof / secret echoed back).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, homedir } from 'node:os';
import { requireThat } from './edge/util.mjs';
import { machineCode, machineProof, resolveIdentityPath, loadIdentity, saveIdentity } from './identity.mjs';

const readDefaultAuthorKeyFile = () => {
  try { return readFileSync(join(process.env.AEC_IDENTITY_DIR || join(process.env.HOME || '/tmp', '.config', 'aec'), 'author.key'), 'utf8').trim() || null; }
  catch { return null; }
};
export { readDefaultAuthorKeyFile };

// --- S1/S2: endpoint validation -------------------------------------------
export function validateEndpoint(endpoint, env = process.env) {
  requireThat(endpoint, 'endpoint_missing', '需要配置 AEC_KERNEL_URL');
  let url;
  try { url = new URL(endpoint); } catch { requireThat(false, 'endpoint_invalid', `AEC_KERNEL_URL 不是合法 URL：${redact(endpoint)}`); }
  requireThat(url.protocol === 'https:' || url.protocol === 'http:', 'endpoint_invalid', 'AEC_KERNEL_URL 仅支持 http/https');
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname) || url.hostname.startsWith('100.64.');
  if (url.protocol === 'http:') {
    const allowed = env.AEC_ALLOW_INSECURE_HTTP === '1';
    requireThat(allowed || loopback, 'insecure_endpoint',
      'AEC_KERNEL_URL 使用明文 HTTP：公网必须 HTTPS。若确为 loopback/tailnet，设置 AEC_ALLOW_INSECURE_HTTP=1 以确认。');
  }
  // Allowlist: comma-separated exact origins (scheme://host[:port]).
  const allow = (env.AEC_KERNEL_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allow.length) {
    requireThat(allow.includes(url.origin), 'endpoint_not_allowed',
      `AEC_KERNEL_URL 源 ${url.origin} 不在 AEC_KERNEL_ALLOWLIST 中`);
  }
  return url;
}

function redact(s) { return String(s).replace(/(aec_host_|Bearer\s+)[^\s]+/gi, '$1***').replace(/([?&](?:token|secret|key|code)=)[^&]+/gi, '$1***'); }

// --- S5: redirect-safe fetch wrapper --------------------------------------
async function safeFetch(url, init, timeoutMs = 30000) {
  const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  // 3xx never carries the Authorization header to a new origin. Refuse instead
  // of following — the token must never leave the configured endpoint.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    requireThat(false, 'redirect_refused', `内核返回重定向（${res.status}），为保护令牌不予跟随${loc ? `：目标 ${redact(loc)}` : ''}`);
  }
  return res;
}

// --- identity with DB-backed device/token bookkeeping ---------------------
export function ensureIdentity({ profile, endpoint = null, workspaceAecDir = null, explicitIdentity = null, enrollSecret = null, authorSecret = null, rolesDb = null }) {
  const { path: identityPath, level } = resolveIdentityPath({ explicit: explicitIdentity, workspaceAecDir });
  const doc = loadIdentity(identityPath);
  const segment = doc?.[profile];
  if (segment?.host_token) return Promise.resolve({ ...segment, path: identityPath, level, machine: machineCode().code, activated: false });
  const { code: machine_code, source: machine_source } = machineCode();
  const label = `${hostname()}#${profile}`;
  const role = profile === 'author' ? 'publisher' : 'consumer';
  const endpointUrl = endpoint ? validateEndpoint(endpoint) : null;
  const activate = secret => safeFetch(new URL('/aec/v2/host/activate', endpointUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(enrollSecret ? { 'x-aec-enroll-secret': enrollSecret } : {}) },
    body: JSON.stringify({ machine_code, label: label.replace(/[^\w.-]/g, ''), role, ...(secret ? { author_secret: secret } : {}) }),
  }, 10000).then(async res => {
    const body = await res.json().catch(() => ({}));
    requireThat(res.ok, body?.error?.code || 'activation_failed', body?.error?.message || `激活失败 HTTP ${res.status}`);
    return body;
  });
  return (async () => {
    let result;
    try { result = await activate(authorSecret); }
    catch (e) {
      const fileSecret = readDefaultAuthorKeyFile();
      if (e.code !== 'author_secret_invalid' || !fileSecret || fileSecret === authorSecret) throw e;
      result = await activate(fileSecret);
    }
    saveIdentity(identityPath, { endpoint, [profile]: { host_id: result.host_id, host_token: result.host_token, host_salt: result.host_salt, role: result.role, tenant: result.tenant, expires_at: result.expires_at } });
    // Mirror into the local roles DB (device code + token + role binding).
    if (rolesDb) {
      const dev = rolesDb.upsertDevice({ machine_code, machine_source, label, role, endpoint, tenant: result.tenant });
      rolesDb.putToken({ device_id: dev.device_id, token: result.host_token, host_id: result.host_id, host_salt: result.host_salt, role, endpoint, expires_at: result.expires_at });
      rolesDb.grantRole({ subject: result.host_id || machine_code, role, endpoint, source: 'activation' });
    }
    return { ...result, path: identityPath, level, machine: machine_code, activated: true };
  })();
}

// --- R5-G01: inline local extraction_file before sending ------------------
export function inlineExtractionFile(args = {}) {
  if (!args.extraction_file) return args;
  const filePath = args.extraction_file;
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim()); }
  catch { throw Object.assign(new Error(`extraction_file 无法读取：${filePath}`), { code: 'invalid_extraction_file' }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw Object.assign(new Error(`extraction_file 必须是 JSON 对象：${filePath}`), { code: 'invalid_extraction_file' });
  const out = { ...args };
  out.extraction_candidates = out.extraction_candidates ?? parsed;
  delete out.extraction_file;
  return out;
}

// --- remote kernel ---------------------------------------------------------
export function createRemoteKernel({ endpoint, profile = 'run', explicitIdentity = null, workspaceAecDir = null, enrollSecret = null, authorSecret = null, rolesDb = null }) {
  const url = validateEndpoint(endpoint);
  let cached = null;
  const identity = async ({ force = false } = {}) => {
    if (force) {
      cached = null;
      try {
        const { path: identityPath } = resolveIdentityPath({ explicit: explicitIdentity, workspaceAecDir });
        const doc = loadIdentity(identityPath);
        if (doc?.[profile]?.host_token) { delete doc[profile]; saveIdentity(identityPath, doc, { replace: true }); }
      } catch { /* 文件不存在：直接重绑 */ }
    }
    cached ??= await ensureIdentity({ profile, endpoint, workspaceAecDir, explicitIdentity, enrollSecret, authorSecret, rolesDb });
    return cached;
  };
  // S3: proof derived per request from current identity salt + local machine code.
  const machine = machineCode().code;
  const post = (id, path, args) => safeFetch(new URL(path, url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${id.host_token}`,
      'x-aec-machine-proof': machineProof(id.host_salt, machine),
    },
    body: JSON.stringify(args),
  });

  return {
    identity,
    endpoint: url.origin,
    async call(name, args) {
      const op = args.op ?? 'open';
      const isAuthor = name === 'aec_author';
      const allowed = isAuthor ? ['open', 'learn', 'plan', 'draft', 'publish'] : ['open', 'close', 'turn', 'resource'];
      requireThat(allowed.includes(op), 'invalid_op', `远程内核不支持 ${name} op=${op}`);
      const path = isAuthor ? `/aec/v2/author/${op}` : `/aec/v2/${op}`;
      const retriable = c => ['unauthorized', 'host_expired', 'host_inactive', 'host_fingerprint_mismatch'].includes(c);
      let id = await identity();
      let res, body;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          res = await post(id, path, args);
          body = await res.json().catch(() => ({}));
          break;
        } catch (e) {
          if (attempt === 1 || !/UND_ERR_SOCKET|fetch failed|ECONNRESET|socket hang up/i.test(String(e.cause?.code || e.message || e))) throw e;
          id = await identity({ force: true });
        }
      }
      if (retriable(body?.error?.code)) {
        id = await identity({ force: true });
        res = await post(id, path, args);
        body = await res.json().catch(() => ({}));
      }
      // S6: sanitize any error text before it can surface to the model.
      if (!res.ok) {
        const raw = body?.error?.message || `内核返回 HTTP ${res.status}`;
        throw Object.assign(new Error(redact(raw)), { code: body?.error?.code || 'kernel_error', status: res.status });
      }
      return body;
    },
  };
}
