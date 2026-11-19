import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
export const uid = (prefix) => `${prefix}_${randomUUID()}`;
export const now = () => new Date().toISOString();
export const stable = (x) => JSON.stringify(sort(x));
function sort(x) { return Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sort(x[k])])) : x; }
export const hash = (x) => `sha256:${createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : stable(x)).digest('hex')}`;
export function fail(code, message, details = {}) { throw Object.assign(new Error(message), { code, details }); }
export function requireThat(ok, code, message, details) { if (!ok) fail(code, message, details); }
// Filesystem failures become semantic, actionable codes: hosts resolve paths
// themselves and must never have to guess which base a relative path used or
// which entry of a list failed. The raw OS message stays in details.
export function fsFailure(e, code, message, details = {}) {
  if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'EACCES')) return fail(code, message, { ...details, os_error: `${e.code}: ${e.message}` });
  throw e;
}
export function fileAt(root, path) {
  requireThat(typeof path === 'string' && path.length > 0, 'invalid_path', 'File path required');
  const base = realpathSync(root), full = realpathSync(resolve(base, path)), rel = relative(base, full);
  requireThat(rel && !rel.startsWith('..') && !isAbsolute(rel), 'path_escape', 'File must be inside the workspace');
  requireThat(statSync(full).isFile(), 'not_file', 'Expected a regular file');
  const bytes = readFileSync(full);
  requireThat(bytes.length <= 16 * 1024 * 1024, 'file_too_large', 'File exceeds 16 MiB');
  return { path: rel, digest: hash(bytes), size: bytes.length, bytes };
}
export function manifest(root, path) { const { bytes, ...entry } = fileAt(root, path); return entry; }
// 边端唯一的 stderr 告警出口：stdio 协议下 stdout 是协议通道，告警只能走 stderr。
// 用于"静默吞掉会丢状态"的关键 catch 点（会话指针、身份目录），不用于正常缺省路径。
export function warn(msg) { try { process.stderr.write(`[aec-mcp] ${msg}\n`); } catch { /* stderr 不可用时保持静默 */ } }
export function publicError(e) { return { code: e.code || 'invalid_request', message: e.message, details: e.details || e.issues || {} }; }
