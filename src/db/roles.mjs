// aec-mcp client-side role & identity store.
//
// Stores USER-SIDE data only: device codes, authentication tokens/segments,
// user profile, and role bindings. This is a LOCAL database on the user's
// machine (0600 file). It never holds kernel secrets (author key / ticket key),
// never holds package/catalog data, and is never read by the server.
//
// The server-side counterpart lives in AEC's kernel state.sqlite (hosts table).
// See docs/ARCHITECTURE.md for the split rationale.

import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultIdentityDir } from '../identity.mjs';

export const DB_SCHEMA = 'aec-mcp.roles/v1';
export const TOKEN_GRACE_MS = 10 * 60 * 1000;

// v1 tables:
//   meta            — schema/version bookkeeping
//   devices         — one row per machine+role binding (device code, token, salt)
//   auth_tokens     — token segments with rotation grace, keyed by device
//   user_profiles   — user-side profile data (display name, prefs, arbitrary JSON)
//   role_bindings   — effective role grants (consumer|publisher/author) per endpoint
const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS devices (
    device_id      TEXT PRIMARY KEY,
    machine_code   TEXT NOT NULL,
    machine_source TEXT,
    label          TEXT,
    role           TEXT NOT NULL CHECK(role IN ('consumer','publisher')),
    endpoint       TEXT,
    tenant         TEXT,
    status         TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending','active','revoked')),
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    last_seen_at   TEXT,
    note           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_devices_machine_role ON devices(machine_code, role);
  CREATE INDEX IF NOT EXISTS idx_devices_endpoint ON devices(endpoint);

  CREATE TABLE IF NOT EXISTS auth_tokens (
    token_id        TEXT PRIMARY KEY,
    device_id       TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL,
    host_salt       TEXT,
    host_id         TEXT,
    role            TEXT NOT NULL,
    endpoint        TEXT,
    expires_at      TEXT,
    rotated_at      TEXT,
    prev_token_hash TEXT,
    prev_expires_at TEXT,
    created_at      TEXT NOT NULL,
    seq             INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_auth_device ON auth_tokens(device_id);
  CREATE INDEX IF NOT EXISTS idx_auth_hash ON auth_tokens(token_hash);
  CREATE INDEX IF NOT EXISTS idx_auth_prev_hash ON auth_tokens(prev_token_hash);

  CREATE TABLE IF NOT EXISTS user_profiles (
    profile_id   TEXT PRIMARY KEY,
    subject      TEXT NOT NULL UNIQUE,
    display_name TEXT,
    email        TEXT,
    avatar_url   TEXT,
    locale       TEXT,
    prefs        TEXT NOT NULL DEFAULT '{}',
    extra        TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS role_bindings (
    binding_id TEXT PRIMARY KEY,
    subject    TEXT NOT NULL,
    role       TEXT NOT NULL,
    endpoint   TEXT,
    scope      TEXT NOT NULL DEFAULT '*',
    granted_at TEXT NOT NULL,
    revoked_at TEXT,
    source     TEXT NOT NULL DEFAULT 'local',
    UNIQUE(subject, role, endpoint, scope)
  );
  CREATE INDEX IF NOT EXISTS idx_role_subject ON role_bindings(subject);
  `,
];

export function resolveRolesDbPath({ env = process.env, explicit = null } = {}) {
  if (explicit) return explicit;
  if (env.AEC_MCP_ROLES_DB) return env.AEC_MCP_ROLES_DB;
  // 与 identity.json / author.key / sessions-index.json 同一基础目录
  // （AEC_IDENTITY_DIR > XDG_CONFIG_HOME > win32 %APPDATA%\aec > ~/.config/aec）。
  return join(defaultIdentityDir({ env }), 'roles.sqlite');
}

const hashToken = token => `sha256:${createHash('sha256').update(String(token)).digest('hex')}`;

export class RolesDB {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }

  migrate() {
    let version;
    try { version = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value; }
    catch { version = null; /* meta table not created yet on first run */ }
    let v = version ? Number(version) : 0;
    if (Number.isNaN(v)) v = 0;
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[i]);
        this.db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(i + 1));
        this.db.prepare("INSERT INTO meta(key,value) VALUES('schema',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(DB_SCHEMA);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  get schemaVersion() { return Number(this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value || 0); }

  // ---- devices ------------------------------------------------------------
  upsertDevice(d) {
    const at = d.updated_at || new Date().toISOString();
    const existing = this.db.prepare('SELECT device_id FROM devices WHERE machine_code=? AND role=?').get(d.machine_code, d.role);
    const deviceId = d.device_id || existing?.device_id || `dev_${randomUUID()}`;
    if (existing) {
      this.db.prepare(`UPDATE devices SET label=?,endpoint=?,tenant=?,status=?,updated_at=?,last_seen_at=?,note=? WHERE device_id=?`).run(
        d.label ?? null, d.endpoint ?? null, d.tenant ?? null, d.status || 'active', at, d.last_seen_at ?? null, d.note ?? null, deviceId);
    } else {
      this.db.prepare(`INSERT INTO devices(device_id,machine_code,machine_source,label,role,endpoint,tenant,status,created_at,updated_at,last_seen_at,note)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        deviceId, d.machine_code, d.machine_source ?? null, d.label ?? null, d.role, d.endpoint ?? null, d.tenant ?? null,
        d.status || 'active', at, at, d.last_seen_at ?? null, d.note ?? null);
    }
    return this.getDevice(deviceId);
  }

  getDevice(deviceId) { return this.db.prepare('SELECT * FROM devices WHERE device_id=?').get(deviceId) || null; }
  getDeviceByMachine(machineCode, role) { return this.db.prepare('SELECT * FROM devices WHERE machine_code=? AND role=?').get(machineCode, role) || null; }
  listDevices() { return this.db.prepare('SELECT * FROM devices ORDER BY updated_at DESC').all(); }
  revokeDevice(deviceId) {
    this.db.prepare("UPDATE devices SET status='revoked',updated_at=? WHERE device_id=?").run(new Date().toISOString(), deviceId);
  }

  // ---- auth tokens --------------------------------------------------------
  // putToken rotates a device's token: the previous hash is retained with a
  // 10-minute grace window (matches the kernel's TOKEN_GRACE_MS), so an in-flight
  // request from another process is not killed mid-flight.
  putToken({ device_id, token, host_id, host_salt, role, endpoint, expires_at, token_id }) {
    const prev = this.db.prepare('SELECT * FROM auth_tokens WHERE device_id=? ORDER BY seq DESC LIMIT 1').get(device_id);
    const nowIso = new Date().toISOString();
    if (prev) {
      this.db.prepare('UPDATE auth_tokens SET prev_token_hash=?,prev_expires_at=?,rotated_at=? WHERE token_id=?').run(
        prev.token_hash, new Date(Date.now() + TOKEN_GRACE_MS).toISOString(), nowIso, prev.token_id);
    }
    const seq = (prev?.seq ?? 0) + 1;
    const id = token_id || `tok_${randomUUID()}`;
    this.db.prepare(`INSERT INTO auth_tokens(token_id,device_id,token_hash,host_salt,host_id,role,endpoint,expires_at,rotated_at,created_at,seq)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, device_id, hashToken(token), host_salt ?? null, host_id ?? null, role, endpoint ?? null,
      expires_at ?? null, null, nowIso, seq);
    return this.getToken(hashToken(token));
  }

  // Resolve a presented token within its rotation grace window.
  resolveToken(token) {
    const h = hashToken(token);
    return this.db.prepare(`SELECT * FROM auth_tokens WHERE token_hash=? OR (prev_token_hash=? AND prev_expires_at>?)`)
      .get(h, h, new Date().toISOString()) || null;
  }
  getToken(tokenHash) { return this.db.prepare('SELECT * FROM auth_tokens WHERE token_hash=?').get(tokenHash) || null; }
  listTokens(deviceId) { return deviceId ? this.db.prepare('SELECT * FROM auth_tokens WHERE device_id=? ORDER BY seq DESC').all(deviceId) : this.db.prepare('SELECT * FROM auth_tokens ORDER BY seq DESC').all(); }

  // ---- user profiles ------------------------------------------------------
  upsertProfile(p) {
    const at = new Date().toISOString();
    const existing = this.db.prepare('SELECT profile_id FROM user_profiles WHERE subject=?').get(p.subject);
    const profileId = existing?.profile_id || `usr_${randomUUID()}`;
    if (existing) {
      this.db.prepare(`UPDATE user_profiles SET display_name=?,email=?,avatar_url=?,locale=?,prefs=?,extra=?,updated_at=? WHERE profile_id=?`).run(
        p.display_name ?? null, p.email ?? null, p.avatar_url ?? null, p.locale ?? null,
        JSON.stringify(p.prefs ?? {}), JSON.stringify(p.extra ?? {}), at, profileId);
    } else {
      this.db.prepare(`INSERT INTO user_profiles(profile_id,subject,display_name,email,avatar_url,locale,prefs,extra,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        profileId, p.subject, p.display_name ?? null, p.email ?? null, p.avatar_url ?? null, p.locale ?? null,
        JSON.stringify(p.prefs ?? {}), JSON.stringify(p.extra ?? {}), at, at);
    }
    return this.getProfile(p.subject);
  }
  getProfile(subject) {
    const row = this.db.prepare('SELECT * FROM user_profiles WHERE subject=?').get(subject);
    if (!row) return null;
    return { ...row, prefs: JSON.parse(row.prefs || '{}'), extra: JSON.parse(row.extra || '{}') };
  }
  listProfiles() { return this.db.prepare('SELECT subject,display_name,email,locale,updated_at FROM user_profiles ORDER BY updated_at DESC').all(); }

  // ---- role bindings ------------------------------------------------------
  grantRole({ subject, role, endpoint = null, scope = '*', source = 'local' }) {
    this.db.prepare(`INSERT INTO role_bindings(binding_id,subject,role,endpoint,scope,granted_at,source)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(subject,role,endpoint,scope) DO UPDATE SET granted_at=excluded.granted_at,revoked_at=NULL,source=excluded.source`)
      .run(`rb_${randomUUID()}`, subject, role, endpoint, scope, new Date().toISOString(), source);
  }
  revokeRole({ subject, role, endpoint = null, scope = '*' }) {
    this.db.prepare('UPDATE role_bindings SET revoked_at=? WHERE subject=? AND role=? AND endpoint IS ? AND scope=?')
      .run(new Date().toISOString(), subject, role, endpoint, scope);
  }
  rolesFor(subject, endpoint = null) {
    return this.db.prepare(`SELECT role,scope,endpoint,granted_at FROM role_bindings
      WHERE subject=? AND revoked_at IS NULL AND (endpoint IS NULL OR endpoint=?) ORDER BY granted_at DESC`).all(subject, endpoint);
  }

  close() { this.db.close(); }
}
