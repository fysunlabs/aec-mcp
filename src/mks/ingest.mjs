// AEC 5.0.0 P2-3：知识入库编排（MD/HTML 先行，5.0-R-020 citation 可回指）。
//
// 边界：
//   - 只做结构感知 chunk + FTS + claim；PDF/DOCX 用 Python/Docling worker（后续），
//     本模块对不支持格式明确拒绝，不静默降级。
//   - citation = { source:'host_document', document_id, digest, first_ordinal,
//     section, source_uri }：document.digest（内容 sha256）+ chunk.ordinal 可回指。
//     P1 的 host_chunk 没有 section_path/page 列（P1 DDL 简化），section 以
//     `[section:...]` 前缀内嵌在 text 中，既满足 FTS 又可回指；加列属迁移变更，
//     不回改已提交字节（见 P2.md 偏差 D-x）。
//   - 零外部依赖：HTML 标签剥离用保守正则（非完整 DOM 解析），不引入 jsdom。
//   - claim 抽取规则保守，抽不到就空（不硬凑）；全部 candidate。
import { createHash } from 'node:crypto';
import { ftsText } from './fts.mjs';

const DEFAULT_MAX_CHARS = 600;
const SUPPORTED = new Set(['md', 'markdown', 'html', 'htm', 'text', 'txt']);
const digestOf = (s) => createHash('sha256').update(String(s ?? '')).digest('hex');

/** HTML → 纯文本 + 把 h1-h6 转成 `# 标题` 供统一分块。保守、零依赖。 */
function htmlToMarkdown(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/h[1-6][^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|section|article)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 结构感知分块：先按 Markdown 标题切节，超长段再按 maxChars 切（句/词边界优先）。
 * @returns {Array<{ordinal:number, text:string, section:string}>}
 */
export function splitIntoChunks(content, format = 'md', { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const fmt = String(format || 'md').toLowerCase();
  if (!SUPPORTED.has(fmt)) throw Object.assign(new Error(`不支持的格式：${fmt}（首期支持 md/html/text；PDF/DOCX 用 Docling worker）`), { code: 'unsupported_format' });
  const src = fmt === 'html' || fmt === 'htm' ? htmlToMarkdown(content) : String(content ?? '');
  if (!src.trim()) return [];

  // 1) 按 ATX 标题分节
  const sections = [];
  let section = '正文';
  let buf = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) sections.push({ section, text });
    buf = [];
  };
  for (const line of src.split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (m) { flush(); section = m[2].trim(); }
    else buf.push(line);
  }
  flush();

  // 2) 每节超长再切（段落 > 句 > 硬切）
  const out = [];
  for (const s of sections) {
    for (const part of splitLong(s.text, maxChars)) {
      out.push({ ordinal: out.length, section: s.section, text: part });
    }
  }
  return out;
}

function splitLong(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const out = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    const win = rest.slice(0, maxChars);
    let cut = Math.max(win.lastIndexOf('\n\n'), win.lastIndexOf('。'), win.lastIndexOf('. '));
    if (cut < maxChars * 0.4) cut = maxChars;
    else if (cut < maxChars) cut += 1;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** 保守 claim 抽取：命中显式规范句式才产 claim；抽不到返回 []。 */
function extractClaims(chunks) {
  const claims = [];
  const RULES = [
    { re: /(.{2,30}?)\s*(必须|需要|应当)\s*(.{2,50}?)[。；\n]/g, predicate: 'requires' },
    { re: /(.{2,30}?)\s*(用|使用)\s*(.{2,30}?)\s*(鉴权|部署|检索|发布)/g, predicate: 'uses' },
  ];
  for (const c of chunks) {
    for (const r of RULES) {
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(c.text))) {
        const subject = (m[1] || '').trim();
        const object = (m[3] || '').trim();
        if (subject && object) claims.push({ subject, predicate: r.predicate, object, confidence: 0.6 });
        if (claims.length >= 20) return claims; // 防止病态文档 Claims 爆炸
      }
    }
  }
  return claims;
}

/**
 * 入库编排：写 document → chunks（section 前缀 + FTS）→ claims，返回 citation。
 */
export function ingestDocument(store, {
  title = null, source_uri = null, media_type = null, content = '',
  format = null, extractClaims: wantClaims = false, maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  const fmt = String(format || media_type || 'md').toLowerCase();
  const chunks = splitIntoChunks(content, fmt, { maxChars });
  const digest = digestOf(content);
  const doc = store.addDocument({
    source_uri, title, media_type: media_type || fmt, digest,
  });
  for (const c of chunks) {
    store.putChunk({
      document_id: doc.document_id, ordinal: c.ordinal,
      text: `[section:${c.section}] ${c.text}`,
    });
  }
  let claims = [];
  if (wantClaims) {
    claims = extractClaims(chunks).map(cl => store.putClaim(cl));
  }
  const citation = {
    source: 'host_document',
    document_id: doc.document_id,
    digest,
    source_uri: source_uri || null,
    first_ordinal: chunks.length ? 0 : null,
    section: chunks.length ? chunks[0].section : null,
  };
  return {
    document_id: doc.document_id, format: fmt, digest,
    chunks: chunks.length, claims: claims.length, citation,
  };
}

// 供检索侧复用：把 FTS chunk 命中转成 citation（document.digest + ordinal 可回指）。
export function chunkCitation(store, chunk) {
  const doc = store.db.prepare('SELECT document_id,digest,source_uri FROM host_document WHERE document_id=?').get(chunk.document_id);
  return {
    source: 'host_chunk', document_id: chunk.document_id, digest: doc?.digest || null,
    chunk_id: chunk.chunk_id, ordinal: chunk.ordinal, source_uri: doc?.source_uri || null,
  };
}

export { ftsText };
