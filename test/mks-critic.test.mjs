// P2-1：memory critic 确定性单测（relevance/recency/confidence/utility 四因子）。
// 设计：5.0-R-099 四因子；低分不注入 + 返回 gaps；默认 top-k 3-5，禁止批量灌入。
// 权重/阈值设计未规定 -> 实现取可注入默认值（见 P2.md D-x），这里锁定行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scoreMemory, recallRank, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD, DEFAULT_TOP_K,
} from '../src/mks/critic.mjs';
import { HostMksStore } from '../src/mks/store.mjs';

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const envNode = { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_NODE_ID: 'host:critic-1' };
const tmp = () => mkdtempSync(join(tmpdir(), 'aec-critic-'));

const mem = (over = {}) => ({
  memory_id: 'm1', kind: 'semantic', scope: 'tenant', title: '部署流程',
  summary: '生产部署需要 staging 与 canary', confidence: 0.9,
  status: 'verified', created_at: '2026-11-20T12:00:00.000Z',
  relevance: 1, ...over,
});

test('四因子权重和 = 1；默认阈值/top-k 在规格区间', () => {
  const w = DEFAULT_WEIGHTS;
  assert.equal(+(w.relevance + w.recency + w.confidence + w.utility).toFixed(6), 1);
  assert.ok(DEFAULT_THRESHOLD > 0 && DEFAULT_THRESHOLD < 1);
  assert.ok(DEFAULT_TOP_K >= 3 && DEFAULT_TOP_K <= 5);
});

test('scoreMemory：四因子单调性 —— 高相关/新/高置信/verified 得分更高', () => {
  const base = mem();
  const s = scoreMemory(base, { now: NOW });
  assert.ok(s.factors.relevance > 0 && s.factors.recency > 0);
  assert.ok(s.score > 0 && s.score <= 1);
  assert.ok(scoreMemory({ ...base, relevance: 0.2 }, { now: NOW }).score < s.score, 'relevance 单调');
  assert.ok(scoreMemory({ ...base, created_at: '2026-01-01T00:00:00.000Z' }, { now: NOW }).score < s.score, 'recency 单调');
  assert.ok(scoreMemory({ ...base, confidence: 0.2 }, { now: NOW }).score < s.score, 'confidence 单调');
  assert.ok(scoreMemory({ ...base, status: 'candidate' }, { now: NOW }).score < s.score, 'utility(status) 单调');
});

test('scoreMemory：权重可注入（全给 relevance 时只随 relevance 变）', () => {
  const w = { relevance: 1, recency: 0, confidence: 0, utility: 0 };
  const a = scoreMemory(mem({ relevance: 1 }), { now: NOW, weights: w });
  const b = scoreMemory(mem({ relevance: 0.5 }), { now: NOW, weights: w });
  assert.equal(a.score, 1);
  assert.equal(b.score, 0.5);
});

test('recallRank：低分不注入 + gaps + top-k 上限 + 排序', () => {
  const now = NOW;
  const cands = [
    mem({ memory_id: 'hi', relevance: 1, confidence: 0.95, created_at: '2026-11-21T11:00:00.000Z' }),
    mem({ memory_id: 'mid', relevance: 0.6, confidence: 0.6, created_at: '2026-11-18T12:00:00.000Z' }),
    mem({ memory_id: 'low', relevance: 0.1, confidence: 0.2, created_at: '2026-06-01T12:00:00.000Z' }),
  ];
  const r = recallRank(cands, { now, threshold: 0.5, top_k: 3 });
  assert.equal(r.injected.length, 2, '低分不注入');
  assert.equal(r.injected[0].memory_id, 'hi', '按 score 降序');
  assert.ok(r.dropped.some(d => d.memory_id === 'low'), '低分进 dropped（审计用）');
  assert.ok(r.gaps.length >= 1, '有 gaps');
});

test('recallRank：空候选 → 空注入 + no_match gap（不硬凑）', () => {
  const r = recallRank([], { now: NOW });
  assert.equal(r.injected.length, 0);
  assert.ok(r.gaps.includes('no_match'));
});

test('HostMksStore.recall：FTS 候选 → critic 注入，带 citation/why，off 面不建库', () => {
  const dir = tmp();
  const store = new HostMksStore({ path: join(dir, 'host-mks.sqlite'), env: envNode });
  store.putMemory({ kind: 'semantic', title: '部署手册', summary: 'staging canary 部署流程', confidence: 0.95, status: 'candidate' });
  store.verifyMemory({ memory_id: store.listMemories()[0].memory_id, reviewed_by: 'test' });
  store.putMemory({ kind: 'episodic', title: '无关', summary: '今天吃了苹果', confidence: 0.3 });
  const r = store.recall({ query: '部署流程', now: NOW, top_k: 4 });
  assert.ok(r.items.length >= 1, '命中部署记忆');
  assert.ok(r.items[0].citation, '带 citation');
  assert.ok(r.items[0].why, '带 why');
  assert.equal(r.items[0].status, 'verified', 'verified 优先注入');
  assert.ok(Array.isArray(r.gaps));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
