// L0 — 宿主策略层（主文档 §16.4/§9.8.1；W25；B8）。
//
// L0 只看动作风险，不看步骤声明（§28.11：binding 不是安全开关）。来源：
// AEC_HOST_POLICY 环境变量（JSON）——宿主运维注入，包契约不可伪造。
//   {
//     "denied_argv0": ["ssh", "curl"],                 // 运行前拒绝的执行来源
//     "required_method_steps": ["sign", "publish"],    // B8：宿主叠加为 required_method
//   }
//
// 两个时点（P1-13 修正）：运行前已知 → 拒绝继续（materializeOpen 层直接报
// l0_policy_denied）；运行后发现 → host_policy_violated=true → grade 走 A2
// abandoned + policy_violation（session.close 的 evidence 承接）。
import { now } from './util.mjs';

export function hostPolicyFromEnv(env = process.env) {
  const raw = env.AEC_HOST_POLICY;
  if (!raw || !String(raw).trim()) return null;
  try { return JSON.parse(String(raw)); } catch {
    return { malformed: true, raw: String(raw).slice(0, 200) };
  }
}

// #10（§9.4.2 R1）：宿主能力清单——环境判定的最小本体。来源 AEC_HOST_CAPABILITIES
//（JSON）。runner 用它与作者声明合成 side_effect 的最终口径：声明比环境乐观时
// 如实升级为 unclassified（只升不降），写进 report 与 ExecutionEvent。
export function hostCapabilitiesFromEnv(env = process.env) {
  const raw = env.AEC_HOST_CAPABILITIES;
  if (!raw || !String(raw).trim()) return null;
  try { return JSON.parse(String(raw)); } catch { return { malformed: true }; }
}

// §9.4.2（R1/R7，a144）：side_effect 是执行环境的输出，不是作者的填表项；
// 声明只能提高风险等级，不能降低。与 runner.mjs 的 effSideEffect 同一口径（口径唯一性）。
//   · 环境授予外部能力 → external（声明 none 压不过事实 → declared_none_but_capable 警告）；
//   · 无外部能力的沙箱 → 纯内部零申报按 write；显式声明只升不降（external 保持 external）；
//   · 环境不可知 → 显式声明豁免；零申报 unclassified（消费方按 external 处理）。
export function effectiveSideEffect(declared, capabilities) {
  const capable = !!(capabilities && !capabilities.malformed
    && (capabilities.external_network === true || capabilities.writable_outside_out === true));
  const known = !!(capabilities && !capabilities.malformed);
  if (capable) return 'external';
  if (known) return declared === 'external' ? 'external' : 'write';
  return declared || 'unclassified';
}
// 规则 2 的警告通道：声明 none 而环境实际授予外部能力。
export function sideEffectWarning(declared, capabilities) {
  const capable = !!(capabilities && !capabilities.malformed
    && (capabilities.external_network === true || capabilities.writable_outside_out === true));
  return capable && declared === 'none' ? ['declared_none_but_capable'] : [];
}

// B8：宿主策略叠加。策略只能加强（把 delivery_step 提升为 required_method），
// 不能放松包内的 required_method；grade 对 runtime_required_method 与包内同权
//（A1/C1/R_meth_runtime，ADR-041 §2.1）。
export function overlayRuntimePolicy(plan, policy) {
  if (!policy?.required_method_steps?.length || !plan?.steps) return plan;
  return {
    ...plan,
    steps: plan.steps.map(s =>
      policy.required_method_steps.includes(s.id) ? { ...s, runtime_required_method: true } : s),
  };
}

// 运行后发现的违反（§16.4 L0 运行期）：evidence 里出现命中 denied_argv0 的
// report 步骤（边端据此在 close 时置 host_policy_violated=true）。
export function detectPolicyViolation(report, policy) {
  if (!policy?.denied_argv0?.length || !report?.steps?.length) return null;
  const hit = report.steps.filter(s => policy.denied_argv0.some(p => String(s.argv0 || '').includes(p)));
  return hit.length ? { violated: true, hit_steps: hit.map(s => s.id), detected_at: now() } : null;
}
