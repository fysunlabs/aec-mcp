// AEC 5.1.0 O1-00a：aec-mcp subject 解析单测（两条凭证路径 + 六种身份情况）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubjectResolver } from '../src/subject.mjs';

test('凭证文件路径：有 subject 用它，无则 null（no_identity）', () => {
  const r = createSubjectResolver();
  assert.equal(r.fromCredential('user:alice'), 'user:alice');
  assert.equal(r.fromCredential(undefined), null); // 旧凭证文件兼容
  assert.equal(r.fromCredential('  '), null);
  assert.equal(r.fromCredential('unknown_owner'), null);
});

test('env key 路径：verify 返回 subject，缓存复用（只验一次）', async () => {
  let calls = 0;
  const verify = async (k) => { calls++; return { subject: k === 'k1' ? 'user:env-alice' : 'user:env-bob', key_id: 'kid' }; };
  const r = createSubjectResolver({ verify });
  assert.equal(await r.fromEnvKey('k1'), 'user:env-alice');
  assert.equal(await r.fromEnvKey('k1'), 'user:env-alice');
  assert.equal(calls, 1, '同 key 只 verify 一次');
});

test('env key 轮换 → 重新 verify', async () => {
  let calls = 0;
  const verify = async (k) => { calls++; return { subject: `user:${k}` }; };
  const r = createSubjectResolver({ verify });
  assert.equal(await r.fromEnvKey('k1'), 'user:k1');
  assert.equal(await r.fromEnvKey('k2'), 'user:k2');
  assert.equal(calls, 2);
});

test('env key 校验失败 / 无 subject → null（no_identity，不冒充 key_id）', async () => {
  const fail = createSubjectResolver({ verify: async () => { throw new Error('key_invalid'); } });
  assert.equal(await fail.fromEnvKey('bad'), null);
  const noSubj = createSubjectResolver({ verify: async () => ({ key_id: 'kid', label: 'my-host' }) });
  assert.equal(await noSubj.fromEnvKey('k'), null, 'key_id/label 不得冒充 subject');
});

test('无 verify 函数 → null（不伪造身份）', async () => {
  const r = createSubjectResolver();
  assert.equal(await r.fromEnvKey('k'), null);
});

test('clear 后可重新解析', async () => {
  let subject = 'user:first';
  const r = createSubjectResolver({ verify: async () => ({ subject }) });
  assert.equal(await r.fromEnvKey('k'), 'user:first');
  subject = 'user:second';
  r.clear();
  assert.equal(await r.fromEnvKey('k'), 'user:second');
});
