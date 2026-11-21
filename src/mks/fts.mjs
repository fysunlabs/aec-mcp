// AEC 5.0.0 P1-05：Host MKS FTS 分词（与内核 aec/src/mks/fts.mjs 同算法同实现）。
//
// 两仓库各自独立发布（aec-mcp 不依赖内核），P1 起如需共享将抽公共包
//（ADR-AEC-5.0-federated-planes「两套 schema 漂移」缓解条款）。改动必须两侧同步。
//
// 与内核一致的原因：CJK n-gram 方案（trigram 需 ≥3 字符，中文 2 字查询不命中），
// 索引时 2/3-gram 展开 + unicode61；确定性同输入同 token 集 → 联邦两端检索一致。

const CJK_RUN = /([\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+)|([a-z0-9_./:@#+~-]+)/gi;

export function mksTokens(text) {
  const out = [];
  const seen = new Set();
  const push = (t) => { if (t && !seen.has(t)) { seen.add(t); out.push(t); } };
  const src = String(text ?? '').toLowerCase();
  CJK_RUN.lastIndex = 0;
  let m;
  while ((m = CJK_RUN.exec(src))) {
    if (m[1]) {
      const run = m[1];
      if (run.length === 1) { push(run); continue; }
      for (let i = 0; i + 2 <= run.length; i++) push(run.slice(i, i + 2));
      if (run.length >= 3) {
        for (let i = 0; i + 3 <= run.length; i++) push(run.slice(i, i + 3));
      }
    } else if (m[2]) push(m[2]);
  }
  return out;
}

export const ftsText = (parts) => mksTokens(parts.filter(p => p != null && p !== '').join(' ')).join(' ');

export function ftsQuery(q) {
  const toks = mksTokens(String(q ?? ''));
  if (!toks.length) return null;
  return toks.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}
