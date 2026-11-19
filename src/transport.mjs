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
import { requireThat, warn } from './edge/util.mjs';
import { machineCode, machineProof, resolveIdentityPath, loadIdentity, saveIdentity, defaultIdentityDir } from './identity.mjs';

const readDefaultAuthorKeyFile = () => {
  try { return readFileSync(join(defaultIdentityDir(), 'author.key'), 'utf8').trim() || null; }
  catch { return null; }
};
export { readDefaultAuthorKeyFile };

// --- S1/S2: endpoint validation -------------------------------------------
// RFC 2606/6761 保留 TLD 与 README 占位写法：它们永远不可达，放进配置只会把
// "配置看起来成功、功能实际不可用"的排查成本压给用户，启动期直接拒绝。
const PLACEHOLDER_HOST = /\.(example|invalid|test|localhost)$/i;
const PLACEHOLDER_HINT = /your-domain|replace_me/i;

// 官方云端 run 端点（nginx 终止 TLS；公网仅 run 四 op + 机器绑定 + 证据上传）。
// 使用者 profile 免配置：安装后只需完成一次机器码校验（设备绑定）即可用，
// 自托管 / 私有部署时用 AEC_KERNEL_URL 显式覆盖。
export const DEFAULT_KERNEL_URL = 'https://aec-api.cursor-free.site';

// 端点解析：显式 env 永远优先；run profile 缺省回落官方云端；author 端点公网
// 不可用（403），必须显式提供，绝不能静默回落——静默只会把 403 变成谜题。
export function resolveEndpoint({ profile, env = process.env } = {}) {
  const explicit = (env.AEC_KERNEL_URL || '').trim() || null;
  if (explicit) return explicit;
  if (profile === 'run') return DEFAULT_KERNEL_URL;
  requireThat(false, 'endpoint_missing',
    '--profile author 需要显式配置 AEC_KERNEL_URL（创作端点仅内网可用，不会回落官方云端）：请填入运维提供的内核服务地址。');
}

export function validateEndpoint(endpoint, env = process.env) {
  requireThat(endpoint, 'endpoint_missing', '需要配置 AEC_KERNEL_URL');
  let url;
  try { url = new URL(endpoint); } catch { requireThat(false, 'endpoint_invalid', `AEC_KERNEL_URL 不是合法 URL：${redact(endpoint)}`); }
  requireThat(url.protocol === 'https:' || url.protocol === 'http:', 'endpoint_invalid', 'AEC_KERNEL_URL 仅支持 http/https');
  if (PLACEHOLDER_HOST.test(url.hostname) || PLACEHOLDER_HINT.test(String(endpoint)))
    requireThat(false, 'endpoint_placeholder',
      `AEC_KERNEL_URL 仍是文档占位值（${url.origin}）：请填入 AEC 管理员提供的真实服务地址，不要照抄 README 样例。`);
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

// --- 网络错误分类（P0：fetch failed 不得被误报为内核缺陷）------------------
// undici 的网络失败是原生 TypeError（"fetch failed"），真正的错误码在 e.cause.code；
// 不分类就会落进 internal_error 的"这是 AEC 缺陷"文案，把排障引向错误方向。
const NET_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_FAILED',
]);
export function classifyNetworkError(e) {
  const cause = e?.cause ?? e;
  const code = String(cause?.code || '');
  if (e?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT'
    || code === 'UND_ERR_BODY_TIMEOUT' || code === 'ETIMEDOUT') return { category: 'timeout', cause: code || 'TimeoutError' };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { category: 'dns', cause: code };
  if (code === 'ECONNREFUSED') return { category: 'connection_refused', cause: code };
  if (code.startsWith('CERT') || code.startsWith('ERR_TLS') || code.startsWith('SSL')
    || /certificate|ssl|tls/i.test(String(cause?.message || ''))) return { category: 'tls', cause: code || undefined };
  return { category: 'connection', cause: code || undefined };
}
export function isNetworkError(e) {
  if (!e) return false;
  if (e instanceof TypeError && /fetch failed/i.test(String(e.message))) return true; // undici 原生网络失败
  if (e.name === 'TimeoutError') return true;
  const cause = e?.cause ?? e;
  const code = String(cause?.code || '');
  return NET_CODES.has(code) || code.startsWith('UND_ERR');
}
// typed network_error：文案自带端点与失败类别（P0#6），绝不写"内核缺陷"。
function networkFailure(url, e) {
  const { category, cause } = classifyNetworkError(e);
  const origin = url?.origin || '(未知端点)';
  const msg = `无法连接 AEC 内核 ${origin}（${category}${cause ? `：${cause}` : ''}）。这不是 AEC 的缺陷，也不是调用参数写错：请检查 AEC_KERNEL_URL 是否为管理员给的真实地址、本机网络/DNS/代理是否可达，修正后重试同一调用即可。`;
  return Object.assign(new Error(redact(msg)), { code: 'network_error', details: { endpoint: origin, category, cause_code: cause || null } });
}
// P1#5：启动期轻量连通性探测——任何 HTTP 响应（含 401/404/5xx）即视为可达；
// 只有连接层失败（DNS/拒连/TLS/超时）才算不可达，让宿主的 failOnStartupError 真正生效。
export async function probeEndpoint(url, { timeoutMs = 5000 } = {}) {
  try {
    await fetch(url.origin, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch (e) {
    const { category, cause } = classifyNetworkError(e);
    requireThat(false, 'endpoint_unreachable',
      `启动自检无法连接 AEC 内核 ${url.origin}（${category}${cause ? `：${cause}` : ''}）。请确认 AEC_KERNEL_URL 是真实地址且网络可达；如确需跳过启动自检，设置 AEC_STARTUP_PROBE=0。`);
  }
}

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
  }).catch(e => {
    if (!isNetworkError(e)) throw e; // 激活期的连接失败同样是网络问题，不是内核缺陷
    throw networkFailure(endpointUrl, e);
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
      // S4 边界（SECURITY.md 对齐）：只有鉴权类响应码才允许 force rebind（删本地令牌重建）。
      // 网络类失败（连接/DNS/TLS/超时）与令牌有效性无关——用同一身份原样重试一次，
      // 仍失败则抛 typed network_error；绝不为网络抖动销毁本机已绑定的有效身份。
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          res = await post(id, path, args);
          body = await res.json().catch(() => ({}));
          break;
        } catch (e) {
          if (!isNetworkError(e)) throw e;
          if (attempt === 1) throw networkFailure(url, e);
        }
      }
      if (retriable(body?.error?.code)) {
        id = await identity({ force: true });
        try { res = await post(id, path, args); }
        catch (e) { if (!isNetworkError(e)) throw e; throw networkFailure(url, e); }
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
