// P1-07：`aec-mcp mks` CLI 测试（status 只读不建库 / purge 需 --yes / memory 子命令）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HostMksStore } from '../src/mks/store.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'aec-mks-cli-'));
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, 'mks', ...args], {
  encoding: 'utf8',
  env: { ...process.env, AEC_IDENTITY_DIR: env.dir, AEC_MCP_LOCAL_MEMORY: env.mode ?? 'node', AEC_MCP_NODE_ID: 'host:cli-test', ...env.extra },
});

test('mks status：只读——lite 报 mode 且不建库；node 无库报 db_exists=false', () => {
  const dir = tmp();
  const lite = run(['status'], { dir, mode: 'lite' });
  assert.equal(lite.status, 0);
  const liteOut = JSON.parse(lite.stdout);
  assert.equal(liteOut.local_memory_mode, 'lite');
  assert.equal(existsSync(join(dir, 'host-mks.sqlite')), false, 'status 不得建库');

  const off = run(['status'], { dir, mode: 'node' });
  assert.equal(off.status, 0);
  assert.equal(JSON.parse(off.stdout).db_exists, false);
  assert.equal(existsSync(join(dir, 'host-mks.sqlite')), false, 'status 仍不建库');
});

test('mks status / memory list / purge --yes / export / rebuild 全链路', () => {
  const dir = tmp();
  // 先用 store 放两条记忆 + 一个待同步事件
  const mks = new HostMksStore({ path: join(dir, 'host-mks.sqlite'), env: { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_NODE_ID: 'host:cli-test' } });
  const m1 = mks.putMemory({ kind: 'business', title: '部署窗口', summary: '部署只允许周五晚间' });
  mks.enqueueOutbox({ kind: 'memory.put', local_event_id: 'e1', payload: {} });
  mks.close();

  const st = run(['status'], { dir });
  assert.equal(st.status, 0);
  const stOut = JSON.parse(st.stdout);
  assert.equal(stOut.db_exists, true);
  assert.equal(stOut.counts.memory, 1);
  assert.equal(stOut.outbox.pending, 1);

  const list = run(['memory', 'list'], { dir });
  const listOut = JSON.parse(list.stdout);
  assert.equal(listOut.items.length, 1);
  assert.equal(listOut.items[0].memory_id, m1.memory_id);

  const show = run(['memory', 'show', m1.memory_id], { dir });
  assert.equal(JSON.parse(show.stdout).item.title, '部署窗口');

  // export → 文件
  const bundlePath = join(dir, 'bundle.json');
  const exp = run(['export', '--out', bundlePath], { dir });
  assert.equal(exp.status, 0);
  const bundle = readJson(bundlePath);
  assert.equal(bundle.bundle_version, '1');
  assert.ok(bundle.items.length >= 1);

  // forget 后 list 为空
  const forget = run(['memory', 'forget', m1.memory_id], { dir });
  assert.equal(forget.status, 0);
  const list2 = JSON.parse(run(['memory', 'list'], { dir }).stdout);
  assert.equal(list2.items.length, 0);

  // purge 无 --yes 拒绝（防误删）
  const noYes = run(['purge'], { dir });
  assert.notEqual(noYes.status, 0, 'purge 必须 --yes');
  const yes = run(['purge', '--yes'], { dir });
  assert.equal(yes.status, 0);
  const st2 = JSON.parse(run(['status'], { dir }).stdout);
  assert.equal(st2.counts.memory, 0);
  assert.equal(st2.outbox.pending, 0);

  // rebuild 正常退出
  const rb = run(['rebuild'], { dir });
  assert.equal(rb.status, 0);
});

test('mks ingest <file> + memory export：P2 知识入库与用户导出', () => {
  const dir = tmp();
  const mdFile = join(dir, 'manual.md');
  writeFileSync(mdFile, '# 部署手册\n\n生产部署必须先 staging 再 canary。\n\n## 回滚\n\n失败就回滚。');
  const ing = run(['ingest', mdFile, '--claims', '--title', '部署手册'], { dir });
  assert.equal(ing.status, 0, ing.stderr);
  const ingOut = JSON.parse(ing.stdout);
  assert.equal(ingOut.ok, true);
  assert.ok(ingOut.chunks >= 2);
  assert.ok(ingOut.citation.digest);

  const st = JSON.parse(run(['status'], { dir }).stdout);
  assert.ok(st.counts.document >= 1 && st.counts.chunk >= 2, 'document/chunk 入库');

  // memory export（含 forgotten）：导出为可读 JSON
  const expOut = join(dir, 'mem.json');
  const exp = run(['memory', 'export', '--out', expOut], { dir });
  assert.equal(exp.status, 0, exp.stderr);
  const doc = readJson(expOut);
  assert.equal(doc.schema, 'aec.memory-export/v1');
  assert.ok(Array.isArray(doc.items));
});

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }
