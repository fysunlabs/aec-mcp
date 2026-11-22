// AEC 5.1.0 O1-07 / O2-06：utility 因果更新单测（5.1-R-012）
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldHoldOut, selectHoldout, updateUtility, shouldDowngrade, HOLDOUT_EPS } from '../src/mks/utility.mjs';

test('ε=0.1 留出概率', () => {
  assert.equal(HOLDOUT_EPS, 0.1);
  assert.equal(shouldHoldOut({ rand: () => 0.05 }), true);
  assert.equal(shouldHoldOut({ rand: () => 0.5 }), false);
});

test('selectHoldout：留出一个，其余保留；不出时全保留', () => {
  const items = ['a', 'b', 'c'];
  const out = selectHoldout(items, { rand: (() => { let i = 0; return () => [0.05, 0.5][i++]; })() });
  assert.equal(out.held_out, true);
  assert.equal(out.kept.length, 2);
  assert.ok(out.heldOut);
  const no = selectHoldout(items, { rand: () => 0.9 });
  assert.equal(no.held_out, false);
  assert.deepEqual(no.kept, items);
});

test('无对照 → observed，不改 utility（5.1-R-012）', () => {
  const r1 = updateUtility('m1', [{ item_id: 'm1', held_out: false, task_success: true }], { current: 0.5 });
  assert.equal(r1.has_control, false);
  assert.equal(r1.status, 'observed');
  assert.equal(r1.utility, 0.5, 'utility 不变');
  const r2 = updateUtility('m1', [{ item_id: 'm1', held_out: true, task_success: false }], { current: 0.5 });
  assert.equal(r2.status, 'observed');
});

test('有对照：injected 全成功 / held_out 全失败 → helped，utility 上升', () => {
  const r = updateUtility('m1', [
    { item_id: 'm1', held_out: false, task_success: true },
    { item_id: 'm1', held_out: false, task_success: true },
    { item_id: 'm1', held_out: true, task_success: false },
    { item_id: 'm1', held_out: true, task_success: false },
  ], { current: 0.5 });
  assert.equal(r.has_control, true);
  assert.equal(r.status, 'helped');
  assert.equal(r.delta, 1);
  assert.ok(r.utility > 0.5);
  assert.ok(r.utility <= 0.9, 'clamp 上限');
});

test('有对照：injected 失败 / held_out 成功 → hurt，utility 下降', () => {
  const r = updateUtility('m1', [
    { item_id: 'm1', held_out: false, task_success: false },
    { item_id: 'm1', held_out: false, task_success: false },
    { item_id: 'm1', held_out: true, task_success: true },
    { item_id: 'm1', held_out: true, task_success: true },
  ], { current: 0.5 });
  assert.equal(r.status, 'hurt');
  assert.equal(r.delta, -1);
  assert.ok(r.utility < 0.5);
});

test('task_success=null 的观察不参与对照', () => {
  const r = updateUtility('m1', [
    { item_id: 'm1', held_out: false, task_success: null },
    { item_id: 'm1', held_out: true, task_success: true },
  ], { current: 0.5 });
  assert.equal(r.has_control, false, '有一类样本 success=null → 无对照');
});

test('连续 hurt 3 次 → 降级为 candidate', () => {
  assert.equal(shouldDowngrade(['helped', 'hurt', 'hurt']), false);
  assert.equal(shouldDowngrade(['hurt', 'hurt', 'hurt']), true);
  assert.equal(shouldDowngrade(['hurt', 'hurt']), false);
});
