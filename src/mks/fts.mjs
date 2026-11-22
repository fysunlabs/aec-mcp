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

// ---- AEC 5.1 O3-11/O3-13：查询构造辅助（与 kernel 侧 fts.mjs 同名同语义） ----

/** 查询 → FTS5 OR 表达式（v2 分层查询的 OR 层；与 kernel ftsQueryOr 同语义）。 */
export function ftsQueryOr(q) {
  const toks = mksTokens(String(q ?? ''));
  if (!toks.length) return null;
  return toks.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** 查询 token 序列 → FTS5 MATCH 表达式（token 已由调用方剥停用词/加别名）。 */
export function ftsMatchExpr(tokens, op = 'AND') {
  const toks = (tokens ?? []).map(String).filter(Boolean);
  if (!toks.length) return null;
  return toks.map(t => `"${t.replace(/"/g, '""')}"`).join(` ${op} `);
}

// AEC 5.1 O3-11：词段覆盖率——按 CJK 连续段（伪词）/ASCII token 计覆盖，
// 段内 ≥50% gram 命中即整段覆盖，coverage = 覆盖字符数 / 总字符数。
// 相比「全部 bigram 命中数 / 全部 bigram 数」，消除跨词噪声 gram 对分母的系统性放大。
export function segmentCoverage(query, textTokenSet) {
  const CJK_RUN = /([㐀-鿿぀-ヿ가-힯]+)|([a-z0-9_./:@#+~-]+)/gi;
  let total = 0, covered = 0, m;
  const src = String(query ?? '').toLowerCase();
  CJK_RUN.lastIndex = 0;
  while ((m = CJK_RUN.exec(src))) {
    const seg = m[0];
    const grams = mksTokens(seg);
    if (!grams.length) continue;
    const hits = grams.filter(g => textTokenSet.has(g)).length;
    total += seg.length;
    if (hits / grams.length >= 0.5) covered += seg.length;
  }
  return total ? covered / total : 0;
}
