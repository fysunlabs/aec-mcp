// Machine-level identity primitives, extracted from AEC's hosts.mjs + config.mjs.
// The machine code is NEVER transmitted in clear and NEVER stored server-side:
// only proof = sha256(host_salt + machine_code) leaves this machine, and only
// sha256(proof) is stored by the kernel. A copied token cannot work elsewhere.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { requireThat } from './edge/util.mjs';

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
export const machineProof = (salt, machineCode) => sha256(`${salt}\n${machineCode}`);

export function machineCode() {
  const read = path => readFileSync(path, 'utf8').trim();
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return { code: m[1], source: 'IOPlatformUUID' };
    } else if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8' });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
      if (m) return { code: m[1], source: 'MachineGuid' };
    } else {
      for (const path of ['/etc/machine-id', '/sys/class/dmi/id/product_uuid']) {
        try { const code = read(path); if (code) return { code, source: path }; } catch { /* next */ }
      }
    }
  } catch { /* fall through to refusal */ }
  requireThat(false, 'machine_code_required',
    'This machine exposes no stable identifier (IOPlatformUUID / machine-id / MachineGuid), so it cannot be bound. Refusing to enrol instead of issuing an unbound token.');
}

export function resolveIdentityPath({ env = process.env, explicit = null, workspaceAecDir = null } = {}) {
  const candidates = [];
  if (explicit) candidates.push({ path: resolve(explicit), level: 'explicit' });
  else if (env.AEC_IDENTITY) candidates.push({ path: resolve(env.AEC_IDENTITY), level: 'explicit' });
  if (env.XDG_CONFIG_HOME) candidates.push({ path: join(env.XDG_CONFIG_HOME, 'aec', 'identity.json'), level: 'xdg' });
  else if (process.platform === 'win32' && env.APPDATA) candidates.push({ path: join(env.APPDATA, 'aec', 'identity.json'), level: 'appdata' });
  else if (env.HOME) candidates.push({ path: join(env.HOME, '.config', 'aec', 'identity.json'), level: 'home' });
  if (workspaceAecDir) candidates.push({ path: join(workspaceAecDir, 'identity.json'), level: 'workspace' });
  for (const candidate of candidates) {
    try { mkdirSync(join(candidate.path, '..'), { recursive: true, mode: 0o700 }); return candidate; }
    catch { /* not writable → next */ }
  }
  return candidates[candidates.length - 1] || null;
}

export function loadIdentity(path) {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return doc?.schema === 'aec.identity/v2' ? doc : null;
  } catch { return null; }
}

export function saveIdentity(path, segment, { replace = false } = {}) {
  const doc = replace ? {} : (loadIdentity(path) || { schema: 'aec.identity/v2', endpoint: null, run: null, author: null });
  const merged = { ...doc, ...segment, schema: 'aec.identity/v2' };
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}
