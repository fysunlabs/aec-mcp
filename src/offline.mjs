// AEC 5.1.0 O1-08 / A21a：离线独立判定（plan.3 §5.2 / §1.1）
//
// 5.1 范围：断网（kernel 不可达）时 Host recall/remember/aec_local 可用；
// open 在超时内明确失败（给出离线原因），不挂起。「离线运行」（本地 released 包缓存）
// 不做，矩阵标 A21b=deferred_with_adr。
//
// 纯逻辑：给定 kernel 探测结果与操作类型，返回是否可用 + 失败码（明确、不挂起）。

export const OFFLINE_CODE = 'kernel_offline';

// kernel 可达性判定：probe 返回 { ok, latency_ms, code? }。
// 有明确失败码或超时 → offline；不可用一律快速失败，不等待。
export function kernelReachable(probeResult = {}) {
  if (probeResult.ok === true) return { reachable: true, code: null };
  return { reachable: false, code: probeResult.code || OFFLINE_CODE,
    hint: '内核不可达：Host 本地记忆（recall/remember/aec_local）仍可用；aec open 已明确失败，请检查网络/kernel 后重试。' };
}

// 操作在离线时是否可用：Host 本地能力（recall/remember/list/show/edit/forget/export）离线可用；
// 需要 kernel 的 op（open/resource/turn/close/author）离线明确失败。
const HOST_LOCAL_OPS = new Set(['recall', 'remember', 'list', 'show', 'edit', 'forget', 'export', 'describe']);
const KERNEL_OPS = new Set(['open', 'resource', 'turn', 'close', 'aec_author']);

export function offlineCapability(op, reachable) {
  if (HOST_LOCAL_OPS.has(op)) return { available: true, code: null, scope: 'host_local' };
  if (KERNEL_OPS.has(op) && !reachable) {
    return { available: false, code: OFFLINE_CODE, scope: 'kernel',
      message: `op=${op} 需要 kernel，当前离线：明确失败，不挂起（A21a）；A21b 离线运行 deferred_with_adr。` };
  }
  return { available: true, code: null, scope: 'kernel' };
}
