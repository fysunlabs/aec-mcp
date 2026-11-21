// P2-3：knowledge ingestion（MD/HTML 先行）测试（5.0-R-020：citation 可回指）。
// 结构感知 chunk + FTS + claim；citation 含 document_id/digest/ordinal/section；
// PDF/DOCX 留后续 worker（本测试只覆盖 MD/HTML + 纯文本）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { HostMksStore } from '../src/mks/store.mjs';
import { splitIntoChunks, ingestDocument } from '../src/mks/ingest.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'aec-ingest-'));
const envNode = { AEC_MCP_LOCAL_MEMORY: 'node', AEC_MCP_NODE_ID: 'host:ingest-1' };

test('splitIntoChunks：Markdown 按标题分节，section_path 可回指', () => {
  const md = '# 部署手册\n\n先跑 staging。\n\n## Canary\n\n再跑 canary，观察 25s。\n\n## 回滚\n\n失败就回滚。';
  const chunks = splitIntoChunks(md, 'md', { maxChars: 200 });
  assert.ok(chunks.length >= 3, `实际 ${chunks.length} chunks`);
  assert.ok(chunks.some(c => c.section.includes('部署手册')), '顶层标题进 section');
  assert.ok(chunks.some(c => c.section.includes('Canary')), '二级标题进 section');
  assert.ok(chunks.every(c => c.text && c.ordinal >= 0));
});

test('splitIntoChunks：HTML 去标签 + 按标题分节；超长段落再切', () => {
  const html = '<h1>API 指南</h1><p>鉴权用 key。</p><h2>限流</h2><p>每分钟 100 次。</p>';
  const chunks = splitIntoChunks(html, 'html', { maxChars: 200 });
  assert.ok(chunks.length >= 2);
  assert.ok(!chunks.some(c => c.text.includes('<')), '不含 HTML 标签');
  assert.ok(chunks.some(c => c.text.includes('鉴权用 key') || c.text.includes('鉴权')));

  const long = '# 长文\n\n' + '部署流程说明'.repeat(100);
  const many = splitIntoChunks(long, 'md', { maxChars: 120 });
  assert.ok(many.length >= 5, '超长段落按 maxChars 再切');
  assert.deepEqual(many.map(c => c.ordinal), many.map((_, i) => i), 'ordinal 连续');
});

test('ingestDocument：document + chunks + claim 入库，FTS 可检索，citation 可回指 digest+section', () => {
  const dir = tmp();
  const store = new HostMksStore({ path: join(dir, 'host-mks.sqlite'), env: envNode });
  const content = '# 部署手册\n\n生产部署必须先 staging 再 canary。\n\n## 回滚\n\n失败就回滚。';
  const res = ingestDocument(store, {
    title: '部署手册', source_uri: 'file:///manual.md', media_type: 'text/markdown',
    content, format: 'md', extractClaims: true,
  });
  assert.equal(res.format, 'md');
  assert.ok(res.chunks >= 2, `chunks=${res.chunks}`);
  const digest = createHash('sha256').update(content).digest('hex');
  assert.equal(res.citation.document_id, res.document_id);
  assert.equal(res.citation.digest, digest);
  const doc = store.db.prepare('SELECT * FROM host_document WHERE document_id=?').get(res.document_id);
  assert.equal(doc.digest, digest, 'document.digest = 内容 sha256（citation 锚点）');
  const chunks = store.listChunks({ document_id: res.document_id });
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every(c => c.text.includes('[')), 'text 内嵌 section 前缀便于回指');
  const hits = store.searchChunks({ query: 'staging' });
  assert.ok(hits.length >= 1, 'FTS 命中 chunk');
  const claims = store.listClaims();
  assert.ok(claims.length >= 1, '抽取 claim 入库');

  // citation 可回指：用 citation 找到 chunk
  const byCitation = store.listChunks({ document_id: res.citation.document_id }).find(c => c.ordinal === res.citation.first_ordinal);
  assert.ok(byCitation, 'citation.first_ordinal 对应真实 chunk');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('ingestDocument：不支持的 media_type/format 明确拒绝（不静默吞）', () => {
  const dir = tmp();
  const store = new HostMksStore({ path: join(dir, 'host-mks.sqlite'), env: envNode });
  assert.throws(() => ingestDocument(store, { content: 'x', format: 'pdf' }), (e) => e.code === 'unsupported_format');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
