import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEndpoint, inlineExtractionFile } from '../src/transport.mjs';
import { RolesDB } from '../src/db/roles.mjs';
import { machineProof } from '../src/identity.mjs';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('validateEndpoint: https accepted', () => {
  const u = validateEndpoint('https://aec.example.com/aec/v2', {});
  assert.equal(u.protocol, 'https:');
});

test('validateEndpoint: public http refused without opt-in', () => {
  assert.throws(() => validateEndpoint('http://aec.example.com/', {}), /insecure_endpoint|明文 HTTP/);
});

test('validateEndpoint: loopback http allowed', () => {
  const u = validateEndpoint('http://127.0.0.1:18041', {});
  assert.equal(u.hostname, '127.0.0.1');
});

test('validateEndpoint: tailnet http allowed', () => {
  const u = validateEndpoint('http://100.64.0.1:18041', {});
  assert.equal(u.protocol, 'http:');
});

test('validateEndpoint: allowlist enforced', () => {
  assert.throws(
    () => validateEndpoint('https://evil.com/', { AEC_KERNEL_ALLOWLIST: 'https://good.com' }),
    e => e.code === 'endpoint_not_allowed'
  );
  const u = validateEndpoint('https://good.com/', { AEC_KERNEL_ALLOWLIST: 'https://good.com' });
  assert.equal(u.origin, 'https://good.com');
});

test('machineProof is sha256(salt\\ncode) and never equals raw code', () => {
  const p = machineProof('salt123', 'machine-uuid');
  assert.equal(p, createHash('sha256').update('salt123\nmachine-uuid').digest('hex'));
  assert.notEqual(p.includes('machine-uuid'), true);
});

test('inlineExtractionFile converts path to candidates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-mcp-test-'));
  const f = join(dir, 'cand.json');
  const obj = { candidates: [{ id: 'x' }] };
  writeFileSync(f, JSON.stringify(obj));
  const out = inlineExtractionFile({ op: 'publish', extraction_file: f });
  assert.deepEqual(out.extraction_candidates, obj);
  assert.equal(out.extraction_file, undefined);
});

test('inlineExtractionFile rejects non-object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-mcp-test-'));
  const f = join(dir, 'cand.json');
  writeFileSync(f, '[1,2,3]');
  assert.throws(() => inlineExtractionFile({ extraction_file: f }), e => e.code === 'invalid_extraction_file');
});

test('RolesDB CRUD + token rotation grace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-mcp-dbtest-'));
  const db = new RolesDB(join(dir, 'roles.sqlite'));
  assert.equal(db.schemaVersion, 1);
  const dev = db.upsertDevice({ machine_code: 'mc1', role: 'consumer', label: 'mac' });
  assert.equal(dev.status, 'active');
  db.putToken({ device_id: dev.device_id, token: 'tok1', role: 'consumer', endpoint: 'https://x' });
  assert.ok(db.resolveToken('tok1'));
  db.putToken({ device_id: dev.device_id, token: 'tok2', role: 'consumer', endpoint: 'https://x' });
  assert.ok(db.resolveToken('tok2'));
  assert.ok(db.resolveToken('tok1'), 'old token still valid within grace');
  db.upsertProfile({ subject: 'u1', display_name: 'Alice', prefs: { theme: 'light' } });
  assert.equal(db.getProfile('u1').prefs.theme, 'light');
  db.grantRole({ subject: 'u1', role: 'publisher', endpoint: 'https://x' });
  assert.equal(db.rolesFor('u1', 'https://x').length, 1);
  db.revokeRole({ subject: 'u1', role: 'publisher', endpoint: 'https://x' });
  assert.equal(db.rolesFor('u1', 'https://x').length, 0);
  db.close();
});
