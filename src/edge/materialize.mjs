// Author-view materializers (extracted from mcp2.mjs). These take kernel-
// produced HTML/state and write local files, returning paths (not large blobs)
// to the model. Pure edge behavior; no kernel dependency.
import { mkdirSync, writeFileSync, renameSync, chmodSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export const LIVE_SCHEMA = 'aec.authoring-live/v1';
export const SESSION_ID_RE = /^ases_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const SEECODE_FALLBACK_NOTICE = 'SeeCode 不可用，以下为表格版';
export function withFallbackNotice(html) {
  const banner = `<div class="gaps" style="margin-bottom:16px"><h3>${SEECODE_FALLBACK_NOTICE}</h3>` +
    `<p class="q" style="margin:6px 0 0">SeeCode 三图构建失败，本页是契约派生的表格视图；它不是实时视图，也不是本次的主页面伪装。作者链路不受影响，下次 op 会重建实时视图。</p></div>`;
  return String(html).replace('<main>', `<main>\n${banner}`);
}

export function materializeAuthorHtml(result, op = 'plan') {
  if (!result || typeof result.views_html !== 'string' || !result.views_html.trim()) return null;
  const dir = process.env.AEC_AUTHOR_HTML_DIR || join(homedir(), '.aec-author', 'html');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${result.session || 'unknown'}-${op}.html`);
  const html = result.author_page_kind === 'fallback' && result.author_page_degraded === true
    ? withFallbackNotice(result.views_html) : result.views_html;
  writeFileSync(file, html, 'utf8');
  if (typeof result.message === 'string') result.message = result.message.replaceAll('{{views_html_path}}', file);
  result.views_html_path = file;
  delete result.views_html;
  return file;
}

export function materializeLoopTemplate(result) {
  if (!result || typeof result.loop_template !== 'string' || !result.loop_template.trim()) return null;
  const dir = process.env.AEC_AUTHOR_HTML_DIR ? join(process.env.AEC_AUTHOR_HTML_DIR, '..') : join(homedir(), '.aec-author');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'loop-template.json');
  writeFileSync(file, result.loop_template, 'utf8');
  if (typeof result.message === 'string') result.message = result.message.replaceAll('{{loop_template_path}}', file);
  result.loop_template_path = file;
  delete result.loop_template;
  return file;
}

export function materializeAuthorLive(result) {
  const lv = result?.live_view;
  if (!lv || lv.schema !== LIVE_SCHEMA || typeof lv.html !== 'string' || typeof lv.session !== 'string') return null;
  if (!SESSION_ID_RE.test(lv.session)) return null;
  const dir = process.env.AEC_AUTHOR_LIVE_DIR || join(homedir(), '.aec-author', 'live');
  const root = resolve(dir);
  const sdir = resolve(root, lv.session);
  if (!sdir.startsWith(root + sep)) return null;
  mkdirSync(sdir, { recursive: true, mode: 0o700 });
  try { chmodSync(sdir, 0o700); } catch { /* best-effort */ }

  let history = [];
  try { history = JSON.parse(readFileSync(join(sdir, 'state.json'), 'utf8')).history || []; } catch { /* first run */ }
  const state = JSON.parse(lv.state_json);
  const last = history[history.length - 1];
  if (!last || last.revision !== state.revision) {
    history.push({ revision: state.revision, state: state.state, digest: state.digest, at: state.updated_at, note: state.phase_note });
  }
  if (history.length > 20) history = history.slice(-20);
  const stateObj = { ...state, history };

  const writeAtomic = (file, content) => {
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, file);
    try { chmodSync(file, 0o600); } catch { /* best-effort */ }
  };
  for (const a of lv.assets || []) writeAtomic(join(sdir, a.name), a.html);
  writeAtomic(join(sdir, 'state.js'), `window.__AEC_LIVE_STATE__ = ${JSON.stringify(stateObj)};`);
  writeAtomic(join(sdir, 'state.json'), `${JSON.stringify(stateObj)}\n`);
  writeAtomic(join(sdir, 'index.html'), lv.html);

  const path = join(sdir, 'index.html');
  if (typeof result.message === 'string') result.message = result.message.replaceAll('{{live_view_path}}', path);
  result.live_view_path = path;
  result.live_revision = stateObj.revision;
  result.live_state = stateObj.state;
  result.live_final = stateObj.final;
  result.live_degraded = stateObj.degraded;
  delete result.live_view;
  return path;
}

export function materializeAuthorPage(result) {
  if (!result) return null;
  const livePath = typeof result.live_view_path === 'string' && result.live_view_path ? result.live_view_path : null;
  const liveUsable = !!livePath && result.live_degraded !== true;
  const fallbackPath = typeof result.views_html_path === 'string' && result.views_html_path ? result.views_html_path : null;
  const path = liveUsable ? livePath : (fallbackPath || livePath);
  if (!path) return null;
  result.author_page_path = path;
  result.author_page_kind = liveUsable ? 'live' : 'fallback';
  result.author_page_degraded = !!livePath && result.live_degraded === true;
  if (typeof result.message === 'string') {
    result.message = result.message.replaceAll('{{author_page_path}}', path).replaceAll('{{views_html_path}}', path);
    if (liveUsable && fallbackPath && fallbackPath !== path) result.message = result.message.replaceAll(fallbackPath, path);
  }
  delete result.live_view;
  delete result.views_html;
  return path;
}
