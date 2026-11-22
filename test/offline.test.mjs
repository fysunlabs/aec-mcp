// AEC 5.1.0 O1-08 / A21a：离线独立测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { kernelReachable, offlineCapability, OFFLINE_CODE } from '../src/offline.mjs';

test('kernel 可达判定', () => {
  const ok = kernelReachable({ ok: true, latency_ms: 5 });
  assert.equal(ok.reachable, true);
  assert.equal(ok.code, null);
  const off = kernelReachable({ ok: false, code: 'ECONNREFUSED' });
  assert.equal(off.reachable, false);
  assert.equal(off.code, 'ECONNREFUSED');
  assert.match(off.hint, /Host 本地记忆/);
  assert.match(off.hint, /仍可用/);
  assert.equal(kernelReachable({}).code, OFFLINE_CODE);
});

test('A21a：离线时 Host 本地能力全部可用', () => {
  for (const op of ['recall', 'remember', 'list', 'show', 'edit', 'forget', 'export', 'describe']) {
    const r = offlineCapability(op, false);
    assert.equal(r.available, true, `${op} 离线可用`);
    assert.equal(r.scope, 'host_local');
  }
});

test('A21a：离线时 kernel op 明确失败不挂起', () => {
  for (const op of ['open', 'resource', 'turn', 'close', 'aec_author']) {
    const r = offlineCapability(op, false);
    assert.equal(r.available, false, `${op} 离线失败`);
    assert.equal(r.code, OFFLINE_CODE);
    assert.match(r.message, /deferred_with_adr/);
  }
});

test('在线时 kernel op 可用', () => {
  const r = offlineCapability('open', true);
  assert.equal(r.available, true);
  assert.equal(r.scope, 'kernel');
});
