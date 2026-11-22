// AEC 5.1.0 O1-07 / O2-06：utility 因果更新（plan.3 §5.2 / 5.1-R-012）
//
// 硬约束：memory / guidance 的 utility（helped/hurt）只能由留出对照更新；
// 没有对照的观察只记 observed，不改权重。ε=0.1 概率 leave-one-out（随机留出一条
// 本应注入的项），记录「注入 vs 留出」的任务成功差异，据此更新 utility（带上限+衰减）。
//
// 纯函数模块：不建库、不挂行为；调用方（recall / guidance 注入）在 O1/O2 接线时
// 把事件写入 host_memory_retrieval_event（Host）或对应 Cloud 表。

export const HOLDOUT_EPS = 0.1;
export const UTILITY_CLAMP = 0.9;
export const DECAY = 0.95;

// 是否对本轮留出一条：随机 r<ε。rand 注入便于确定性测试。
export function shouldHoldOut({ rand = Math.random, eps = HOLDOUT_EPS } = {}) {
  return rand() < eps;
}

// 选择留出项（leave-one-out）：从候选中选一条，返回 { kept, heldOut }。
export function selectHoldout(items = [], { rand = Math.random, eps = HOLDOUT_EPS } = {}) {
  if (!items.length || !shouldHoldOut({ rand, eps })) return { kept: [...items], heldOut: null, held_out: false };
  const idx = Math.min(items.length - 1, Math.floor(rand() * items.length));
  return { kept: items.filter((_, i) => i !== idx), heldOut: items[idx], held_out: true };
}

// 从对照事件更新 utility。
// events: [{ item_id, held_out:boolean, task_success:boolean|null }]
// 只有同一 item 同时有 held_out 与 injected 两类样本，且 task_success 非空时，
// 才算「有对照」：Δ = P(success|injected) − P(success|held_out)。
// 无对照 → observed（不改 utility）。带上限 clamp 与衰减 decay。
export function updateUtility(itemId, events = [], { current = 0.5, clamp = UTILITY_CLAMP, decay = DECAY } = {}) {
  const mine = events.filter(e => e.item_id === itemId && e.task_success !== null && e.task_success !== undefined);
  const injected = mine.filter(e => !e.held_out);
  const held = mine.filter(e => e.held_out);
  if (!injected.length || !held.length) {
    return { utility: current, has_control: false, status: 'observed', samples: { injected: injected.length, held_out: held.length } };
  }
  const pInj = injected.filter(e => e.task_success === true).length / injected.length;
  const pHold = held.filter(e => e.task_success === true).length / held.length;
  const delta = pInj - pHold;
  // utility = decay*current + (1-decay)*normalized_delta；归一化到 [0,1]，再 clamp。
  const normalized = Math.max(-1, Math.min(1, delta));
  const raw = decay * current + (1 - decay) * (0.5 + 0.5 * normalized);
  const utility = Math.max(-clamp, Math.min(clamp, raw));
  return {
    utility: Number(utility.toFixed(4)), delta: Number(delta.toFixed(4)),
    has_control: true, status: delta > 0.05 ? 'helped' : delta < -0.05 ? 'hurt' : 'neutral',
    samples: { injected: injected.length, held_out: held.length },
  };
}

// 连续 hurt（连续 N 次 status=hurt）→ 自动降为 candidate 并告警（由调用方执行降级）。
export function shouldDowngrade(history = [], { threshold = 3 } = {}) {
  if (history.length < threshold) return false;
  return history.slice(-threshold).every(h => h === 'hurt');
}
