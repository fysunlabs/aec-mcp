// Regression: materializeAuthorLive path-containment check used `sep` and must
// not throw. This bug slipped once when the client was extracted (sep import
// was dropped during import rewrite); keep this test to prevent recurrence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeAuthorLive } from '../src/mcp.mjs';
import { LIVE_SCHEMA } from '../src/edge/materialize.mjs';

const SESSION = 'ases_62004b99-a103-4056-a658-6fa4f1a6ad44';

function liveView() {
  return {
    schema: LIVE_SCHEMA,
    session: SESSION,
    html: '<!doctype html><html><body>live</body></html>',
    assets: [
      { name: 'state.js', html: '//state' },
      { name: 'state.json', html: '{}' },
      { name: 'live.js', html: '//live' },
      { name: 'goal.html', html: '<p>goal</p>' },
      { name: 'loop.html', html: '<p>loop</p>' },
      { name: 'resources.html', html: '<p>res</p>' },
    ],
    state_json: JSON.stringify({ revision: 1, state: 'open', digest: 'sha256:x', updated_at: '2026-11-19T00:00:00Z', phase_note: 'note' }),
  };
}

test('materializeAuthorLive writes files and replaces message placeholder', t => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-mcp-live-'));
  process.env.AEC_AUTHOR_LIVE_DIR = dir;
  t.after(() => { delete process.env.AEC_AUTHOR_LIVE_DIR; rmSync(dir, { recursive: true, force: true }); });
  const result = { session: SESSION, message: '打开 {{live_view_path}}', live_view: liveView() };
  const path = materializeAuthorLive(result);
  assert.ok(path, 'returns index path');
  const sdir = join(dir, SESSION);
  for (const f of ['index.html', 'state.js', 'state.json', 'live.js', 'goal.html', 'loop.html', 'resources.html']) {
    assert.ok(statSync(join(sdir, f)).isFile(), `missing ${f}`);
    // NTFS 无 POSIX 权限位：writeFileSync 的 mode 在 Windows 上不生效（观察到
    // 0o666），mode 断言只在 POSIX 主机上有意义。
    if (process.platform !== 'win32') assert.equal(statSync(join(sdir, f)).mode & 0o777, 0o600, `${f} mode 0600`);
  }
  if (process.platform !== 'win32') assert.equal(statSync(sdir).mode & 0o777, 0o700, 'dir mode 0700');
  assert.deepEqual(readdirSync(sdir).filter(f => f.includes('.tmp')), [], 'no .tmp leftovers');
  assert.equal(result.message.includes('{{live_view_path}}'), false, 'placeholder replaced');
  assert.equal(result.live_view_path, path);
});

test('materializeAuthorLive refuses path traversal session id', t => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-mcp-live-neg-'));
  process.env.AEC_AUTHOR_LIVE_DIR = dir;
  t.after(() => { delete process.env.AEC_AUTHOR_LIVE_DIR; rmSync(dir, { recursive: true, force: true }); });
  const result = { session: 'bad', message: '', live_view: { ...liveView(), session: '../../etc/passwd' } };
  assert.equal(materializeAuthorLive(result), null, 'invalid/traversal session refused');
});
