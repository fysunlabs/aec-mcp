// AEC 5.1.0 O1-04：偏好规则单测
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePreference, resolveConflict, recallPreferences } from '../src/mks/preference.mjs';

test('显式 > 推断：explicit 置信度 0.9，inferred 0.5', () => {
  const e = normalizePreference({ key: '发布方式', value: '蓝绿', source: 'user' });
  const i = normalizePreference({ key: '发布方式', value: '滚动', source: 'inferred' });
  assert.equal(e.source, 'explicit');
  assert.equal(e.confidence, 0.9);
  assert.equal(i.source, 'inferred');
  assert.equal(i.confidence, 0.5);
});

test('一次性要求默认 session scope', () => {
  const p = normalizePreference({ key: '本次输出', value: '简短', source: 'inferred' });
  assert.equal(p.scope, 'session');
  const e = normalizePreference({ key: '长期格式', value: 'markdown', source: 'explicit' });
  assert.equal(e.scope, 'user');
});

test('do_not_use 永不召回', () => {
  const prefs = [
    { key: 'x', value: 'a', source: 'explicit', confidence: 0.9, status: 'verified' },
    { key: 'y', value: 'b', source: 'explicit', confidence: 0.9, do_not_use: true },
  ];
  const r = recallPreferences(prefs);
  assert.equal(r.length, 1);
  assert.equal(r[0].key, 'x');
});

test('冲突裁决：显式胜推断；同级高置信度胜；do_not_use 阻断', () => {
  const inferred = { key: 'k', value: 'old-i', source: 'inferred', confidence: 0.5, preference_id: 'p1' };
  const explicit = normalizePreference({ key: 'k', value: 'new-e', source: 'explicit' });
  const r1 = resolveConflict([inferred], explicit);
  assert.equal(r1.action, 'supersede');
  assert.equal(r1.supersedes, 'p1');

  const r2 = resolveConflict([explicit], { ...inferred, preference_id: 'p2' });
  assert.equal(r2.action, 'keep_existing');

  const disabled = { key: 'k', value: 'x', source: 'explicit', confidence: 0.9, do_not_use: true };
  const r3 = resolveConflict([disabled], explicit);
  assert.equal(r3.action, 'blocked_by_do_not_use');
});

test('session scope 只在同 session 召回', () => {
  const prefs = [
    { key: 'a', source: 'explicit', scope: 'session', session_id: 's1' },
    { key: 'b', source: 'explicit', scope: 'user' },
  ];
  assert.deepEqual(recallPreferences(prefs, { sessionId: 's1' }).map(p => p.key), ['a', 'b']);
  assert.deepEqual(recallPreferences(prefs, { sessionId: 's2' }).map(p => p.key), ['b']);
});

test('inferred 可开关', () => {
  const prefs = [
    { key: 'e', source: 'explicit' },
    { key: 'i', source: 'inferred' },
  ];
  assert.equal(recallPreferences(prefs, { includeInferred: false }).length, 1);
});

test('非法 key/scope 拒绝', () => {
  assert.throws(() => normalizePreference({ key: '' }), e => e.code === 'preference_key_required');
  assert.throws(() => normalizePreference({ key: 'x', scope: 'global' }), e => e.code === 'preference_scope_invalid');
});
