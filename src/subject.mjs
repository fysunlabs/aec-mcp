// AEC 5.1.0 O1-00a：aec-mcp 侧 subject 解析（plan.3 §5.1 / GAP-25 / 5.1-R-011）
//
// 两条凭证路径都要支持：
//   ① 凭证文件（aec_setup 写入）：credentials.json 的 profile 段带 subject（可选字段，旧文件兼容）；
//   ② env AEC_API_KEY：resolveApiKey(source='env') 无 subject → 首次调用时用该 key 调
//      POST /aec/v2/keys/verify 取 subject，缓存在进程内存（不落盘明文 key）。
// 取不到 subject → 返回 null → sidecar 返回 continuity.status=no_identity，Host 记忆零读写。
// 不得用 label / key_id 冒充 subject。
//
// 本模块不挂任何行为：只有 O1-03 sidecar（AEC_MCP_CONTINUITY=1 + node）才调用它。
// 纯函数式：verify 通过参数注入，便于单测，不 import transport 避免循环依赖。

export function createSubjectResolver({ verify = null, cache = new Map() } = {}) {
  let cached = null; // { api_key_fingerprint, subject } —— 只缓存 subject，不缓存明文 key

  // 指纹只用于判断「是否同一把 key」，存 hash 不存原文（进程内存，不落盘）。
  const fingerprint = (apiKey) => {
    let h = 0;
    for (let i = 0; i < apiKey.length; i++) h = ((h << 5) - h + apiKey.charCodeAt(i)) | 0;
    return String(h);
  };
  const clean = (s) => (typeof s === 'string' && s.trim() && s.trim() !== 'unknown_owner') ? s.trim() : null;

  return {
    // 凭证文件路径：subject 来自 credentials 段（aec_setup 写入的可选字段）。
    fromCredential(subject) {
      return clean(subject); // null → no_identity（旧凭证文件无 subject 字段时）
    },

    // env key 路径：首次用 verify(api_key) 取 subject 并缓存；后续同 key 走缓存。
    // verify 抛错或返回无 subject → null（no_identity），不伪装。
    async fromEnvKey(apiKey, verifyFn = verify) {
      if (!apiKey || typeof apiKey !== 'string') return null;
      const fp = fingerprint(apiKey);
      if (cached && cached.fp === fp) return cached.subject; // 含 subject=null 的负缓存
      if (typeof verifyFn !== 'function') return null;
      let subject = null;
      try {
        const meta = await verifyFn(apiKey);
        subject = clean(meta?.subject);
      } catch { subject = null; }
      cached = { fp, subject };
      return subject;
    },

    // 清缓存（key 轮换时由调用方触发）。
    clear() { cached = null; cache.clear?.(); },
  };
}
