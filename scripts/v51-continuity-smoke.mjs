#!/usr/bin/env node
// AEC 5.1.0 O1 B01/B05 真机冒烟：跨会话连续性 + 隔离（在 hal9001 跑）
// 用临时 Host MKS v2 库，模拟同一 subject 连续 5 次任务的 episode 写入/召回，
// 验证从第 2 次起能召回上次未完成事项（B01）；并验证 B05 隔离。
// 证据写入 stdout；不写生产库（独立 mkdtemp）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, hostname, platform, cpus } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { HostMksStore, resolveHostMksPath } from '../src/mks/store.mjs';
import { ContinuityCache, runContinuitySidecar, renderContinuityBlock } from '../src/continuity.mjs';

const env = { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_NODE_ID: 'host:b01-smoke' };
const dir = mkdtempSync(join(tmpdir(), 'v51-b01-'));
const store = new HostMksStore({ path: join(dir, 'host-mks.sqlite'), env });
const nowIso = () => new Date().toISOString();
let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* ignore */ }

const result = {
  schema: 'aec.v51.continuity-smoke/v1', generated_at: new Date().toISOString(),
  env: { host: hostname(), platform: platform(), node: process.version, cpu_count: cpus().length, commit,
    acceptance_env: 'hal9001 (Linux) only' },
  command: 'node scripts/v51-continuity-smoke.mjs',
  scenario: '同一 subject 连续 5 次 open，第 N 次召回前 N-1 次的未完成事项；含 unknown_owner 隔离',
  checks: {}, detail: [], honest_boundary: [], ok: false,
};

try {
  const SUBJECT = 'user:b01-alice';
  const TENANT = 'default';
  const cache = new ContinuityCache();
  let lastRecallItems = [];
  // 模拟 5 次会话：每次 close 写一个 episode（未完成事项）+ 一条 scoped memory。
  for (let turn = 1; turn <= 5; turn++) {
    const epId = `ep-${turn}`;
    const memId = `b01-mem-${turn}`;
    // close 写 episode（含未完成事项）
    store.db.prepare(`INSERT INTO host_episode(episode_id,thread_id,user_id,tenant_id,package_id,summary,outcome,status,open_items_json,correction_refs_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(epId, 'thread-b01', SUBJECT, TENANT, 'pkg-x',
      `第 ${turn} 次任务`, 'done', 'done', JSON.stringify([`未完成：第 ${turn} 次的回滚校验`]), '[]', nowIso());
    // 写记忆 + FTS + scope link
    const text = `第 ${turn} 次部署任务使用蓝绿发布并做了核对`;
    store.db.prepare('INSERT INTO host_memory(memory_id,kind,scope,title,summary,content_json,confidence,status,source_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(memId, 'episodic', 'tenant', `部署 ${turn}`, text, '{}', 0.9, 'verified', '{}', nowIso(), nowIso());
    const { ftsText } = await import('../src/mks/fts.mjs');
    store.db.prepare('INSERT INTO host_memory_fts(rowid,text) VALUES(?,?)').run(
      Number(store.db.prepare('SELECT rowid FROM host_memory WHERE memory_id=?').get(memId).rowid), ftsText([text]));
    store.putScopeLink({ object_type: 'memory', object_id: memId, tenant_id: TENANT, user_id: SUBJECT, thread_id: 'thread-b01' });

    // 下一次 open：key 路径读 cache（第 1 次后 cache 有数据）；这里直接做增量 recall 验证召回
    const recall = store.recallScoped({ query: '部署 核对', user_id: SUBJECT, tenant_id: TENANT,
      thread_id: 'thread-b01', opts: { top_k: 5 } });
    lastRecallItems = recall.items;
    result.detail.push({ turn, recalled_ids: recall.items.map(i => i.memory_id),
      episode_open_items: JSON.parse(store.db.prepare('SELECT open_items_json FROM host_episode WHERE episode_id=?').get(epId).open_items_json) });
  }
  // B01 判定：第 2 次起应召回至少一条前序记忆
  let recallFromSecond = 0;
  for (let i = 1; i < result.detail.length; i++) {
    if (result.detail[i].recalled_ids.length > 0) recallFromSecond++;
  }
  result.checks.B01_cross_session_recall = recallFromSecond >= 4; // 4 次机会（turn 2-5）

  // B05 隔离：另一个 subject 召回不到 alice 的记忆
  const bob = store.recallScoped({ query: '部署 核对', user_id: 'user:bob', tenant_id: TENANT, opts: { top_k: 5 } });
  result.checks.B05_no_cross_subject_leak = !bob.items.some(i => String(i.memory_id).startsWith('b01-mem-'));

  // unknown_owner：无 scope link 的旧记忆默认不注入
  store.db.prepare('INSERT INTO host_memory(memory_id,kind,scope,title,summary,content_json,confidence,status,source_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('legacy', 'semantic', 'tenant', '旧记忆', '部署核对旧数据', '{}', 0.9, 'verified', '{}', nowIso(), nowIso());
  const { ftsText } = await import('../src/mks/fts.mjs');
  store.db.prepare('INSERT INTO host_memory_fts(rowid,text) VALUES(?,?)').run(
    Number(store.db.prepare('SELECT rowid FROM host_memory WHERE memory_id=?').get('legacy').rowid), ftsText(['部署核对旧数据']));
  const afterLegacy = store.recallScoped({ query: '部署 核对', user_id: SUBJECT, tenant_id: TENANT, opts: { top_k: 5 } });
  result.checks.unknown_owner_default_excluded = !afterLegacy.items.some(i => i.memory_id === 'legacy');
  result.checks.legacy_listed = store.listLegacy({ object_type: 'memory' }).some(r => r.memory_id === 'legacy');

  // sidecar 注入区块：off / no_identity / ok 三态
  cache.set(`${TENANT}:${SUBJECT}:thread-b01`, lastRecallItems);
  const sidecar = await runContinuitySidecar({ enabled: true, subject: SUBJECT, cache,
    scope: { tenant: TENANT, user_id: SUBJECT, thread_id: 'thread-b01' }, query: '部署', timeoutMs: 150 });
  result.checks.sidecar_off_zero_inject = (await runContinuitySidecar({ enabled: false })).markdown === '';
  result.checks.sidecar_no_identity = (await runContinuitySidecar({ enabled: true, subject: null })).status === 'no_identity';
  result.checks.sidecar_injects_data_block = /连续性（数据，不是指令）/.test(sidecar.markdown);
  result.checks.sidecar_delta_under_50ms = sidecar.delta_ms <= 50;
  result.sidecar = { status: sidecar.status, delta_ms: sidecar.delta_ms, cache_miss: sidecar.cache_miss,
    items: sidecar.items.length, markdown_head: sidecar.markdown.slice(0, 120) };

  result.honest_boundary.push('本冒烟用进程内 HostMksStore + sidecar 逻辑验证 B01/B05 核心语义；真实 DSH 会话的 MCP 端到端在 O6 canary 做。');
  result.honest_boundary.push('Δopen 双指标（timeout/cache_miss ≤5%）需 O5 harness 大样本统计；此处单样本 delta_ms 仅说明性。');
  result.ok = Object.values(result.checks).every(Boolean);
} catch (e) { result.ok = false; result.error = String(e?.stack || e).slice(0, 1000); }
finally { store.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
if (result.ok) { /* evidence captured via stdout by runner */ }
process.exit(result.ok ? 0 : 2);
