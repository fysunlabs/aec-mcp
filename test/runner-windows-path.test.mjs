// Regression: generated step runners must work on Windows drive-letter paths.
// Bug: `dirname(new URL(import.meta.url).pathname)` yields `/C:/...`; `resolve()`
// on a `D:\` cwd turns that into `D:\C:\...`, so params.json is never found.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateRunners, runnerCommand } from '../src/edge/runner.mjs';

test('generated runner resolves params.json on Windows drive paths', () => {
  const sd = mkdtempSync(join(tmpdir(), 'aec-runner-win-'));
  const cwd = join(sd, 'resources');
  mkdirSync(cwd, { recursive: true });
  const out = join(sd, 'out.txt');
  const steps = [{
    id: 'probe', kind: 'run',
    argv: [process.execPath, '-e', `require('fs').writeFileSync(process.argv[1],'ok')`, out],
    cwd, produces: [out],
  }];
  generateRunners({ sessionDir: sd, steps, sessionId: 'win-test' });

  const launcher = readFileSync(join(sd, 'run', 'probe.mjs'), 'utf8');
  assert.match(launcher, /fileURLToPath\(import\.meta\.url\)/);
  assert.match(launcher, /from 'node:url'/);
  assert.doesNotMatch(launcher, /new URL\(import\.meta\.url\)\.pathname/);

  const cmd = runnerCommand(sd, 'probe', process.execPath);
  const r = spawnSync(cmd.argv[0], cmd.argv.slice(1), { cwd: cmd.cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `runner exit: ${r.stderr || ''}`);
  const report = JSON.parse(readFileSync(join(sd, 'run', 'report.json'), 'utf8'));
  assert.equal(report.steps[0].ok, true);
  assert.ok(report.steps[0].produces[0].digest, 'produced artifact must be digested');
});
