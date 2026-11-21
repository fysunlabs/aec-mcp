// P2-4：MVP 性能门槛（recall P95 <150ms @ 10k memory / 1k docs）。
// 设计：reports/v5.0 P2 门槛。用真实 Host MKS（SQLite+FTS5），灌数据后
// 多次 recall，取 P95；阈值按规格 150ms。CI/本机慢时可用 AEC_PERF_SCALE 缩放。
// 注意：这是门槛测试，数据量按规格；如本机不达标如实失败，不放宽阈值。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { HostMksStore } from '../src/mks/store.mjs';

const envNode = { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_NODE_ID: 'host:perf' };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]; };

test('recall P95 <150ms（10k memory / 1k docs，100 次查询）', { timeout: 300000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aec-perf-'));
  const store = new HostMksStore({ path: join(dir, 'host-mks.sqlite'), env: envNode });
  const N = Number(process.env.AEC_PERF_SCALE || 1);
  const nMem = 10000 * N, nDoc = 1000 * N;
  const themes = ['部署', '回滚', '鉴权', '检索', '发布', '缓存', '联邦', '经验', '知识', '记忆'];

  // 批量写入（事务内）以减少灌数据时间
  store.db.exec('BEGIN');
  for (let i = 0; i < nMem; i++) {
    const t = themes[i % themes.length];
    store.db.prepare('INSERT INTO host_memory(memory_id,kind,scope,title,summary,content_json,confidence,sensitivity,status,source_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(`perf-m-${i}`, 'semantic', 'tenant', `${t} Note ${i}`, `${t} 流程说明第 ${i} 条`, '{}', 0.8, null, 'verified', '{}', new Date().toISOString(), new Date().toISOString());
    const rowid = Number(store.db.prepare('SELECT rowid FROM host_memory WHERE memory_id=?').get(`perf-m-${i}`).rowid);
    store.db.prepare('INSERT INTO host_memory_fts(rowid,text) VALUES(?,?)').run(rowid, `${t} 流程说明第 ${i} 条 Note`);
  }
  for (let i = 0; i < nDoc; i++) {
    const t = themes[i % themes.length];
    const did = `perf-d-${i}`;
    store.db.prepare('INSERT INTO host_document(document_id,source_uri,title,media_type,digest,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(did, `file:///d${i}.md`, `${t} doc ${i}`, 'text/markdown', 'x', 'active', new Date().toISOString(), new Date().toISOString());
    store.db.prepare('INSERT INTO host_chunk(chunk_id,document_id,ordinal,text,created_at) VALUES(?,?,?,?,?)')
      .run(`perf-c-${i}`, did, 0, `${t} 文档正文第 ${i} 篇`, new Date().toISOString());
    const rowid = Number(store.db.prepare('SELECT rowid FROM host_chunk WHERE chunk_id=?').get(`perf-c-${i}`).rowid);
    store.db.prepare('INSERT INTO host_chunk_fts(rowid,text) VALUES(?,?)').run(rowid, `${t} 文档正文第 ${i} 篇`);
  }
  store.db.exec('COMMIT');

  // 预热
  for (let i = 0; i < 10; i++) store.recall({ query: '部署流程' });
  const times = [];
  for (let i = 0; i < 100; i++) {
    const q = themes[i % themes.length] + ' 流程';
    const t0 = performance.now();
    store.recall({ query: q, top_k: 4 });
    times.push(performance.now() - t0);
  }
  const p = p95(times);
  const msg = `recall P95 = ${p.toFixed(2)}ms（n=${times.length}, scale=${N}）`;
  t.diagnostic(msg);
  if (process.stdout.isTTY) console.log(msg);
  assert.ok(p < 150, `${msg} —— 应 <150ms（门槛不放宽；本机慢则如实失败，Linux 参考机为准）`);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
