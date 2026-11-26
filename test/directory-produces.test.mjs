// 防回归（2026-11-26 EISDIR）：宿主实际执行的是本包 edge/session.mjs 与
// edge/runner.mjs。produces 声明目录（{{out}}-drafts/ 等）时，旧实现裸
// readFileSync(dir) → EISDIR 且无 try/catch，close 被打挂成「无法自动处理」。
// 锁定：目录产物零抛、递归展开、摘要确定、两份边端 artifactFromPath 不漂移。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { artifactFromPath, collectCloseEvidence } from '../src/edge/session.mjs';
import { generateRunners } from '../src/edge/runner.mjs';

const sha = b => 'sha256:' + createHash('sha256').update(b).digest('hex');

test('artifactFromPath: 目录递归展开 + 聚合 digest，不抛 EISDIR', t => {
  const root = mkdtempSync(join(tmpdir(), 'aec-dirart-'));
  const dir = join(root, 'drafts');
  mkdirSync(join(dir, 'nested'), { recursive: true });
  writeFileSync(join(dir, 'b.md'), 'beta');
  writeFileSync(join(dir, 'a.md'), 'alpha');
  writeFileSync(join(dir, 'nested', 'c.md'), 'gamma');
  const arts = artifactFromPath(dir);
  const d = arts.find(a => a.kind === 'directory');
  assert.ok(d);
  assert.equal(d.file_count, 3);
  assert.equal(d.size, 14);
  assert.match(d.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(arts.find(a => a.path === join(dir, 'a.md')).digest, sha('alpha'));
  assert.ok(arts.find(a => a.path === join(dir, 'nested', 'c.md')));
});

test('artifactFromPath: digest 确定（相对路径参与，绝对路径不参与）', t => {
  const root = mkdtempSync(join(tmpdir(), 'aec-dirart-det-'));
  const a = join(root, 'A'), b = join(root, 'B');
  for (const d of [a, b]) { mkdirSync(d); writeFileSync(join(d, 'x'), 'x'); writeFileSync(join(d, 'y'), 'y'); }
  const da = artifactFromPath(a).find(x => x.kind === 'directory');
  const db = artifactFromPath(b).find(x => x.kind === 'directory');
  assert.equal(da.digest, db.digest);
  assert.equal(da.digest, artifactFromPath(a).find(x => x.kind === 'directory').digest);
});

test('artifactFromPath: 缺失路径降级 missing，不抛', t => {
  const arts = artifactFromPath(join(tmpdir(), 'aec-nope-' + Date.now()));
  assert.equal(arts.length, 1);
  assert.equal(arts[0].missing, true);
});

test('两份边端 artifactFromPath 实现一致（防漂移）', t => {
  const up = readFileSync(new URL('../src/edge/session.mjs', import.meta.url), 'utf8');
  const inner = readFileSync('D:/AEC/aec/src/session.mjs', 'utf8');
  const extract = src => {
    const i = src.indexOf('export function artifactFromPath(path) {');
    const j = src.indexOf('\n}\n', i) + 3;
    return src.slice(i, j).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  };
  assert.equal(extract(up), extract(inner), 'upstream 与 aec/src 的 artifactFromPath 函数体必须一致');
});

test('两份边端 runner 模板 shaFile 目录安全实现一致（防漂移）', t => {
  const up = readFileSync(new URL('../src/edge/runner.mjs', import.meta.url), 'utf8');
  const inner = readFileSync('D:/AEC/aec/src/runner.mjs', 'utf8');
  for (const marker of ['function shaFile(p) {', 'function produceDigest(p) {']) {
    const pick = src => {
      const i = src.indexOf(marker); const j = src.indexOf('\n}', i) + 2;
      return src.slice(i, j).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    };
    assert.equal(pick(up), pick(inner), marker + ' 两份 runner 模板必须一致');
  }
});

test('generated runner: 目录 produce 不抛 EISDIR 且 digest 为聚合值', t => {
  const root = mkdtempSync(join(tmpdir(), 'aec-runner-dir-'));
  const out = join(root, 'out');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'a.md'), 'alpha');
  writeFileSync(join(out, 'b.md'), 'beta');
  generateRunners({ sessionDir: root, steps: [{ id: 's1', kind: 'run', argv: [process.execPath, '-e', 'process.exit(0)'], cwd: root, produces: [out] }], sessionId: 'dir-test' });
  const launcher = readFileSync(join(root, 'run', 's1.mjs'), 'utf8');
  assert.match(launcher, /function shaFile\(p\)/);
  assert.match(launcher, /readdirSync/);
  // 直接执行生成的 launcher（它自己会 shaFile(produces)）
  const r = spawnSync(process.execPath, [join(root, 'run', 's1.mjs')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, 'runner 正常退出（无 EISDIR）：' + (r.stderr || ''));
});
