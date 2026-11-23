// O3-14（Host 侧）：recallScopedRerank 钩子确定性测试（mock rerankFn，绝不联网）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostMksStore } from '../src/mks/store.mjs';

const envNode = { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_NODE_ID: 'host:rerank-test', AEC_MKS_SEARCH_V2: '1' };
const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mks-rerank-'));
  return new HostMksStore({ path: join(dir, 'host-mks.sqlite'), env: envNode });
};
const refOf = x => x.ref ?? x.memory_id;

test('recallScopedRerank：未注入 rerankFn → applied:false，items 与 recallScoped 一致', async () => {
  const mks = mk();
  try {
    const m = mks.putMemory({ kind: 'episodic', scope: 'tenant', title: '代理备忘', summary: 'Clash 本地 7897；100.64/10 必须 bypass。', status: 'verified', source: {} });
    mks.putScopeLink({ object_type: 'memory', object_id: m.memory_id, user_id: 'u-hal', thread_id: null });
    const base = mks.recallScoped({ query: '代理', user_id: 'u-hal' });
    const r = await mks.recallScopedRerank({ query: '代理', user_id: 'u-hal' });
    assert.equal(r.rerank.applied, false);
    assert.equal(r.rerank.reason, 'rerank_fn_absent');
    assert.deepEqual(r.items.map(refOf), base.items.map(refOf));
  } finally { mks.close(); }
});

test('recallScopedRerank：mock rerankFn 重排置前 + rerank_why；越权 ref 丢弃', async () => {
  const mks = mk();
  try {
    const ids = [];
    for (const [t, s] of [['代理备忘', 'Clash 本地 7897；100.64/10 必须 bypass。'], ['下载工作流', '先 open 拿 loop，再下载入交付目录。']]) {
      const m = mks.putMemory({ kind: 'episodic', scope: 'tenant', title: t, summary: s, status: 'verified', source: {} });
      mks.putScopeLink({ object_type: 'memory', object_id: m.memory_id, user_id: 'u-hal', thread_id: null });
      ids.push(m.memory_id);
    }
    const r = await mks.recallScopedRerank({
      query: '代理', user_id: 'u-hal', enabled: true,
      rerankFn: async (q, items) => {
        assert.equal(items.length, 1, 'AND 命中的唯一候选进重排');
        assert.ok(typeof items[0].ref === 'string', '候选带归一化 ref');
        return { ok: true, ranked: [{ ref: ids[1], why: '越权幻觉' }, { ref: ids[0], why: '最相关' }] };
      },
    });
    assert.equal(r.rerank.applied, true);
    assert.equal(r.rerank.out_of_scope, 1, '不在候选集的 ref 丢弃计数');
    assert.deepEqual(r.items.map(x => refOf(x)), [ids[0]]);
    assert.equal(r.items[0].rerank_why, '最相关');
    assert.ok(r.items[0].why.includes(`rerank:最相关`), 'why 追加 rerank 标签');
  } finally { mks.close(); }
});

test('recallScopedRerank：rerankFn 失败 → 词法原序回落，不抛错', async () => {
  const mks = mk();
  try {
    const m = mks.putMemory({ kind: 'episodic', scope: 'tenant', title: '代理备忘', summary: 'bypass 100.64/10。', status: 'verified', source: {} });
    mks.putScopeLink({ object_type: 'memory', object_id: m.memory_id, user_id: 'u-hal', thread_id: null });
    const r = await mks.recallScopedRerank({
      query: '代理', user_id: 'u-hal', enabled: true,
      rerankFn: async () => { throw new Error('net down'); },
    });
    assert.equal(r.rerank.applied, false);
    assert.equal(r.rerank.reason, 'rerank_threw');
    assert.deepEqual(r.items.map(refOf), [m.memory_id]);
  } finally { mks.close(); }
});
