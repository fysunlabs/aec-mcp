// AEC 5.1.0 O1-04：偏好规则（plan.3 §5.2）
// 显式 > 推断；一次性要求默认 session scope；supersedes；do_not_use 永不召回；candidate 0.5。
// 纯逻辑模块，不建库；调用方把结果写 host_preference（v2 迁移已建表）。

export const PREF_SCOPES = ['session', 'user', 'project', 'tenant'];
export const EXPLICIT_SOURCES = ['user', 'explicit', 'confirmed'];

// 归一化偏好：缺失字段取默认；source∈EXPLICIT → explicit；否则 inferred。
export function normalizePreference({ key, value, source = 'inferred', scope = null, confidence = null, do_not_use = false } = {}) {
  if (!key || typeof key !== 'string') throw Object.assign(new Error('preference_key_required'), { code: 'preference_key_required' });
  const explicit = EXPLICIT_SOURCES.includes(source);
  // 一次性要求（如"这次先不要…"）默认 session scope；显式偏好可指定 user/project/tenant。
  const effectiveScope = scope || (explicit ? 'user' : 'session');
  if (!PREF_SCOPES.includes(effectiveScope)) throw Object.assign(new Error('preference_scope_invalid'), { code: 'preference_scope_invalid' });
  return {
    key: key.trim(), value, source: explicit ? 'explicit' : 'inferred', scope: effectiveScope,
    confidence: confidence ?? (explicit ? 0.9 : 0.5), status: 'candidate',
    do_not_use: !!do_not_use,
  };
}

// 冲突裁决：显式 > 推断；同级显式取置信度高者；do_not_use 永远胜出（禁用）；supersedes 断链。
// prefs: 已有偏好数组；incoming: 新偏好。返回 { winner, supersedes, action }。
export function resolveConflict(prefs = [], incoming) {
  const sameKey = prefs.filter(p => p.key === incoming.key && !p.do_not_use);
  const anyDisabled = prefs.some(p => p.key === incoming.key && p.do_not_use);
  if (anyDisabled) return { winner: prefs.find(p => p.do_not_use), supersedes: null, action: 'blocked_by_do_not_use' };
  if (!sameKey.length) return { winner: incoming, supersedes: null, action: 'add' };
  const rank = p => (p.source === 'explicit' ? 10 : 0) + (p.confidence || 0);
  const best = sameKey.reduce((a, b) => rank(b) > rank(a) ? b : a);
  if (rank(incoming) > rank(best)) return { winner: incoming, supersedes: best.preference_id || best.key, action: 'supersede' };
  return { winner: best, supersedes: null, action: 'keep_existing' };
}

// 召回过滤：do_not_use 永不召回；一次性 session scope 只在同 thread/session 生效。
export function recallPreferences(prefs = [], { sessionId = null, includeInferred = true } = {}) {
  return prefs.filter(p => {
    if (p.do_not_use) return false;
    if (p.scope === 'session' && p.session_id && p.session_id !== sessionId) return false;
    if (!includeInferred && p.source === 'inferred') return false;
    return true;
  });
}
