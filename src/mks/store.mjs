// AEC 5.0.0 P1-05：Host MKS（aec-mcp 侧，host-mks.sqlite）。
//
// 边界与硬约束（ADR-AEC-5.0-host-local-memory）：
//   - 独立库：host-mks.sqlite，绝不复用/触碰 roles.sqlite（用户侧身份库）；两者
//     仅共享 identity 基础目录。路径解析见 resolveHostMksPath()。
//   - 三形态（§3.3）：lite（P0 默认）不建库——构造即 mks_lite_disabled，2.0.0 边端
//     行为逐字节不变；node/sovereign 才开库（本文件）。
//   - 本地不存 secrets（API key/密码/私钥不进 host_* 表）；0700 目录 + WAL。
//   - 候选优先：本地写 memory/claim/term 默认 candidate；高影响业务项必须人工
//     confirmBusinessTerm 才 verified（§5.7）。
//   - outbox 幂等：UNIQUE(node_id, local_event_id)（§3.5 push 协议）。
//   - 独立迁移版本号（从 1 起），与内核 aec 迁移 v1–v20 无关；meta 表记录
//     schema = aec-mcp.host-mks/v1。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { defaultIdentityDir } from '../identity.mjs';
import { localMemoryMode, federationMode, DB_SCHEMA } from './flags.mjs';
import { ftsText, ftsQuery, mksTokens } from './fts.mjs';
import { recallRank } from './critic.mjs';

export const HOST_MKS_SCHEMA = 'aec-mcp.host-mks/v1';
export const BUNDLE_VERSION = '1';

/** Host MKS 库路径：与 roles.sqlite 同基础目录但不同文件（节点独立，不复用）。 */
export function resolveHostMksPath({ env = process.env, explicit = null } = {}) {
  if (explicit) return explicit;
  if (env.AEC_MCP_HOST_MKS_DB) return env.AEC_MCP_HOST_MKS_DB;
  return join(defaultIdentityDir({ env }), 'host-mks.sqlite');
}

const j = v => JSON.stringify(v ?? null);
const pj = (v, d = null) => { try { return JSON.parse(v ?? 'null') ?? d; } catch { return d; } };
const nowIso = () => new Date().toISOString();
function require2(ok, code, message) {
  if (!ok) throw Object.assign(new Error(message), { code });
}
const rowToMemory = r => r && { ...r, source: pj(r.source_json, {}), content: pj(r.content_json, {}), origin: { node: r.origin_node, id: r.origin_id }, source_json: undefined, content_json: undefined, origin_node: undefined, origin_id: undefined };
const rowToElement = r => r && { ...r, applicability: pj(r.applicability_json, {}), source_refs: pj(r.source_refs_json, []), applicability_json: undefined, source_refs_json: undefined };

// Host MKS 独立迁移（v1 起，与内核 v1–v20 编号无关）。只加不改 + IF NOT EXISTS 可重入。
const HOST_MIGRATIONS = [
  {
    version: 1,
    description: 'host-mks/v1: four modules (ontology/knowledge/experience/memory+business) + outbox + governance',
    sql: `
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
      -- memory 模块（§5.1 词表；本地含 episode/业务/用户/反思记忆）
      CREATE TABLE IF NOT EXISTS host_memory(
        memory_id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'tenant',
        title TEXT, summary TEXT, content_json TEXT NOT NULL DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 0.5, sensitivity TEXT, status TEXT NOT NULL DEFAULT 'candidate',
        source_json TEXT NOT NULL DEFAULT '{}', supersedes TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reviewed_by TEXT,
        origin_node TEXT, origin_id TEXT, UNIQUE(origin_node, origin_id));
      CREATE INDEX IF NOT EXISTS idx_host_memory_kind ON host_memory(kind, scope, status);
      CREATE VIRTUAL TABLE IF NOT EXISTS host_memory_fts USING fts5(text, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS host_memory_link(
        memory_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(memory_id, target_id, relation));
      -- knowledge 模块（本地文档/切片/claim）
      CREATE TABLE IF NOT EXISTS host_document(
        document_id TEXT PRIMARY KEY, source_uri TEXT, title TEXT, media_type TEXT,
        digest TEXT, status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        origin_node TEXT, origin_id TEXT);
      CREATE TABLE IF NOT EXISTS host_chunk(
        chunk_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(document_id, ordinal));
      CREATE VIRTUAL TABLE IF NOT EXISTS host_chunk_fts USING fts5(text, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS host_claim(
        claim_id TEXT PRIMARY KEY, subject TEXT NOT NULL, predicate TEXT NOT NULL,
        object TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'candidate', created_at TEXT NOT NULL,
        origin_node TEXT, origin_id TEXT, UNIQUE(subject, predicate, object));
      -- experience 模块（本地元素/包绑定）
      CREATE TABLE IF NOT EXISTS host_element(
        element_id TEXT NOT NULL, version INTEGER NOT NULL, element_kind TEXT NOT NULL,
        title TEXT NOT NULL, statement TEXT NOT NULL, applicability_json TEXT,
        source_refs_json TEXT, state TEXT NOT NULL DEFAULT 'candidate',
        created_at TEXT NOT NULL, origin_node TEXT, origin_id TEXT,
        PRIMARY KEY(element_id, version), UNIQUE(origin_node, origin_id, version));
      CREATE TABLE IF NOT EXISTS host_package_element(
        package_id TEXT NOT NULL, package_version TEXT NOT NULL, element_id TEXT NOT NULL,
        element_version INTEGER NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(package_id, package_version, element_id, element_version, role));
      -- business 模块（本地术语/偏好/实体/政策；高影响必须人工确认）
      CREATE TABLE IF NOT EXISTS host_business_term(
        term_id TEXT PRIMARY KEY, kind TEXT NOT NULL, term TEXT NOT NULL, detail TEXT,
        impact TEXT NOT NULL DEFAULT 'low', status TEXT NOT NULL DEFAULT 'candidate',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reviewed_by TEXT,
        origin_node TEXT, origin_id TEXT, UNIQUE(kind, term));
      -- ontology 模块（本地本体/映射）
      CREATE TABLE IF NOT EXISTS host_ontology(
        concept_id TEXT PRIMARY KEY, module_id TEXT NOT NULL, parent_id TEXT,
        label TEXT NOT NULL, definition TEXT, status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_ontology_mapping(
        concept_id TEXT NOT NULL, source_schema TEXT NOT NULL, source_pointer TEXT NOT NULL,
        transform TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY(concept_id, source_schema, source_pointer));
      -- 待同步 outbox（§3.5 push：UNIQUE(node_id, local_event_id) 幂等）
      CREATE TABLE IF NOT EXISTS local_outbox(
        outbox_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, local_event_id TEXT NOT NULL,
        kind TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, sent_at TEXT,
        UNIQUE(node_id, local_event_id));
      -- 治理：审计 + 联邦账（R-005）
      CREATE TABLE IF NOT EXISTS host_audit(
        audit_id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
        target TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_federation_log(
        log_id TEXT PRIMARY KEY, direction TEXT NOT NULL, peer_node TEXT NOT NULL,
        bundle_digest TEXT, tables_json TEXT, counts_json TEXT, status TEXT NOT NULL,
        at TEXT NOT NULL);
    `,
  },
  {
    version: 2,
    description: 'host-mks/v2 (AEC 5.1 O1-00c/O1-01): scope link + thread/episode/preference + retrieval event + package guidance (O2 mirror). Additive only, reentrant.',
    sql: `
      -- 5.1-R-014：统一作用域链接，覆盖 memory/business_term/preference/episode/chunk/claim/element
      -- （含 knowledge 与 experience）。无链接的旧行 → unknown_owner 隔离区，默认不注入。
      CREATE TABLE IF NOT EXISTS host_scope_link(
        object_type TEXT NOT NULL, object_id TEXT NOT NULL,
        tenant_id TEXT, user_id TEXT, project_id TEXT, thread_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(object_type, object_id));
      CREATE INDEX IF NOT EXISTS idx_host_scope_link_subject ON host_scope_link(tenant_id, user_id, thread_id);
      -- 会话线程（O1-01）
      CREATE TABLE IF NOT EXISTS host_thread(
        thread_id TEXT PRIMARY KEY, user_id TEXT, tenant_id TEXT,
        title TEXT, status TEXT NOT NULL DEFAULT 'open',
        last_episode_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      -- episode（O1-03 close 写入）
      CREATE TABLE IF NOT EXISTS host_episode(
        episode_id TEXT PRIMARY KEY, thread_id TEXT, user_id TEXT, tenant_id TEXT,
        package_id TEXT, summary TEXT, outcome TEXT, status TEXT,
        open_items_json TEXT NOT NULL DEFAULT '[]',
        correction_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_host_episode_thread ON host_episode(thread_id, created_at);
      -- 偏好（O1-04）：显式 > 推断；supersedes；do_not_use 永不召回；candidate 0.5
      CREATE TABLE IF NOT EXISTS host_preference(
        preference_id TEXT PRIMARY KEY, user_id TEXT, tenant_id TEXT,
        key TEXT NOT NULL, value TEXT, source TEXT NOT NULL DEFAULT 'explicit',
        scope TEXT NOT NULL DEFAULT 'session', confidence REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'candidate', supersedes TEXT,
        do_not_use INTEGER NOT NULL DEFAULT 0,
        last_confirmed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      -- 留出对照事件（O1-07 / 5.1-R-012）：utility 只由对照差异更新
      CREATE TABLE IF NOT EXISTS host_memory_retrieval_event(
        event_id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, thread_id TEXT,
        user_id TEXT, tenant_id TEXT, held_out INTEGER NOT NULL DEFAULT 0,
        injected INTEGER NOT NULL DEFAULT 0, task_success INTEGER,
        observed_at TEXT NOT NULL);
      -- 包级带教镜像（O2-11，只读表；Cloud export → Host import）
      CREATE TABLE IF NOT EXISTS host_package_guidance(
        guidance_id TEXT PRIMARY KEY, origin_node TEXT, tenant_id TEXT, project_id TEXT,
        user_id TEXT, package_id TEXT, version_range TEXT, scope TEXT, kind TEXT,
        applies_to_json TEXT, statement TEXT, source TEXT, source_refs_json TEXT,
        user_quote TEXT, author TEXT, status TEXT, codified_in TEXT,
        expires_at TEXT, usage_count INTEGER NOT NULL DEFAULT 0,
        helped INTEGER NOT NULL DEFAULT 0, hurt INTEGER NOT NULL DEFAULT 0,
        created_at TEXT, updated_at TEXT,
        UNIQUE(origin_node, guidance_id, updated_at));
    `,
  },
];

export function migrateHostMks(db) {
  const from = db.prepare('PRAGMA user_version').get().user_version;
  const applied = [];
  for (const step of HOST_MIGRATIONS) {
    if (step.version <= from) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(step.sql);
      db.exec(`PRAGMA user_version=${Number(step.version)}`);
      db.exec('COMMIT');
      applied.push(step.version);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return { from, to: db.prepare('PRAGMA user_version').get().user_version, applied };
}

export class HostMksStore {
  constructor({ path, env = process.env, node_id = null, actor = 'local' } = {}) {
    const mode = localMemoryMode(env);
    if (mode === 'lite') {
      throw Object.assign(new Error('mks_lite_disabled: AEC_MCP_LOCAL_MEMORY=lite 不建本地库（ADR §3.3，检索走云端）'), { code: 'mks_lite_disabled' });
    }
    require2(path, 'host_mks_path_required', '需要 path（host-mks.sqlite 路径）');
    this.path = path;
    this.mode = mode;
    this.node_id = node_id ?? env.AEC_MCP_NODE_ID ?? `host:${hostname()}`;
    this.actor = actor;
    this.federation = federationMode(env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.migration = migrateHostMks(this.db);
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('schema', HOST_MKS_SCHEMA);
  }

  _audit({ actor = this.actor, action, target = null } = {}) {
    this.db.prepare('INSERT INTO host_audit(audit_id,actor,action,target,at) VALUES(?,?,?,?,?)')
      .run(randomUUID(), actor, action, target, nowIso());
  }

  listAudit({ action_prefix, limit = 100 } = {}) {
    const where = ['1=1']; const args = [];
    if (action_prefix) { where.push("action LIKE ? || '%'"); args.push(action_prefix); }
    args.push(limit);
    return this.db.prepare(`SELECT * FROM host_audit WHERE ${where.join(' AND ')} ORDER BY at, rowid DESC LIMIT ?`).all(...args);
  }

  status() {
    const c = t => this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    return {
      schema: HOST_MKS_SCHEMA,
      db_schema: DB_SCHEMA,
      mode: this.mode,
      node_id: this.node_id,
      federation_mode: this.federation,
      user_version: this.db.prepare('PRAGMA user_version').get().user_version,
      counts: {
        memory: c('host_memory'), document: c('host_document'), chunk: c('host_chunk'),
        claim: c('host_claim'), element: c('host_element'), business_term: c('host_business_term'),
        ontology_concept: c('host_ontology'),
      },
      outbox: {
        pending: c("local_outbox WHERE state='pending'"),
        sent: c("local_outbox WHERE state='sent'"),
        failed: c("local_outbox WHERE state='failed'"),
      },
    };
  }
  // --- memory 模块 ---------------------------------------------------------------
  putMemory({ kind, scope = 'tenant', title = null, summary = null, content = {}, confidence = 0.5, sensitivity = null, status = 'candidate', source = {}, supersedes = null } = {}) {
    require2(kind, 'memory_required', 'kind 必填（§5.1）');
    require2(typeof confidence === 'number' && confidence >= 0 && confidence <= 1, 'memory_confidence_range', 'confidence ∈ [0,1]');
    const KINDS = ['episodic', 'semantic', 'procedural', 'business', 'reflective', 'normative'];
    const SCOPES = ['session', 'project', 'tenant', 'global'];
    require2(KINDS.includes(kind), 'memory_kind_invalid', `kind 必须是 ${KINDS.join('|')}`);
    require2(SCOPES.includes(scope), 'memory_scope_invalid', `scope 必须是 ${SCOPES.join('|')}`);
    const memory_id = randomUUID();
    const at = nowIso();
    this.db.prepare(
      'INSERT INTO host_memory(memory_id,kind,scope,title,summary,content_json,confidence,sensitivity,status,source_json,supersedes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(memory_id, kind, scope, title, summary, j(content), confidence, sensitivity, 'candidate', j(source ?? {}), supersedes, at, at);
    const rowid = Number(this.db.prepare('SELECT rowid FROM host_memory WHERE memory_id=?').get(memory_id).rowid);
    this.db.prepare('INSERT INTO host_memory_fts(rowid,text) VALUES(?,?)').run(rowid, ftsText([title, summary]));
    this._audit({ action: 'host.memory.put', target: memory_id });
    return this.getMemory({ memory_id });
  }
  getMemory({ memory_id }) {
    return rowToMemory(this.db.prepare('SELECT * FROM host_memory WHERE memory_id=?').get(memory_id));
  }
  listMemories({ kind, scope, status, limit = 500 } = {}) {
    const where = ["status != 'forgotten'"]; const args = [];
    if (kind) { where.push('kind = ?'); args.push(kind); }
    if (scope) { where.push('scope = ?'); args.push(scope); }
    if (status) { where.splice(0, 1); where.push('status = ?'); args.unshift(status); }
    args.push(limit);
    return this.db.prepare(`SELECT * FROM host_memory WHERE ${where.join(' AND ')} ORDER BY created_at, rowid LIMIT ?`)
      .all(...args).map(rowToMemory);
  }
  verifyMemory({ memory_id, reviewed_by = null }) {
    require2(memory_id, 'memory_required', 'memory_id 必填');
    this.db.prepare("UPDATE host_memory SET status='verified', reviewed_by=?, updated_at=? WHERE memory_id=?")
      .run(reviewed_by, nowIso(), memory_id);
    this._audit({ action: 'host.memory.verify', target: memory_id });
    return this.getMemory({ memory_id });
  }
  forgetMemory({ memory_id }) {
    require2(memory_id, 'memory_required', 'memory_id 必填');
    const r = this.db.prepare('SELECT rowid FROM host_memory WHERE memory_id=?').get(memory_id);
    if (!r) return 0;
    this.db.prepare("UPDATE host_memory SET status='forgotten', updated_at=? WHERE memory_id=?").run(nowIso(), memory_id);
    this.db.prepare('DELETE FROM host_memory_fts WHERE rowid=?').run(r.rowid);
    this._audit({ action: 'host.memory.forget', target: memory_id });
    return 1;
  }
  // O1-05 aec_local edit：更新候选记忆的可编辑字段（title/summary/confidence）；同步 FTS。
  updateMemory({ memory_id, title = undefined, summary = undefined, confidence = undefined }) {
    require2(memory_id, 'memory_required', 'memory_id 必填');
    const cur = this.db.prepare('SELECT * FROM host_memory WHERE memory_id=?').get(memory_id);
    if (!cur) throw Object.assign(new Error('memory_not_found'), { code: 'memory_not_found' });
    const next = {
      title: title === undefined ? cur.title : title,
      summary: summary === undefined ? cur.summary : summary,
      confidence: confidence === undefined ? cur.confidence : confidence,
    };
    this.db.prepare('UPDATE host_memory SET title=?, summary=?, confidence=?, updated_at=? WHERE memory_id=?')
      .run(next.title, next.summary, next.confidence, nowIso(), memory_id);
    // 重建该行 FTS（SELECT * 不含隐式 rowid，需单独取）
    const rowid = Number(this.db.prepare('SELECT rowid FROM host_memory WHERE memory_id=?').get(memory_id).rowid);
    this.db.prepare('DELETE FROM host_memory_fts WHERE rowid=?').run(rowid);
    this.db.prepare('INSERT INTO host_memory_fts(rowid,text) VALUES(?,?)').run(rowid, ftsText([next.title, next.summary]));
    this._audit({ action: 'host.memory.edit', target: memory_id });
    return this.getMemory({ memory_id });
  }
  searchMemories({ query, limit = 20 } = {}) {
    const match = ftsQuery(query);
    if (!match) return [];
    return this.db.prepare(
      `SELECT m.* FROM host_memory_fts f JOIN host_memory m ON m.rowid = f.rowid
       WHERE host_memory_fts MATCH ? AND m.status != 'forgotten' ORDER BY rank LIMIT ?`
    ).all(match, limit).map(rowToMemory);
  }

  // ---- AEC 5.1 O1-00c：统一作用域链接（5.1-R-011/R-014，只加不改）----------------
  // 覆盖 7 类对象（memory/business_term/preference/episode/chunk/claim/element，
  // 含 knowledge 与 experience）。新写入必须有链接；旧行无链接 → unknown_owner 隔离区。
  putScopeLink({ object_type, object_id, tenant_id = null, user_id = null, project_id = null, thread_id = null }) {
    const TYPES = ['memory', 'business_term', 'preference', 'episode', 'chunk', 'claim', 'element'];
    require2(TYPES.includes(object_type) && object_id, 'scope_link_invalid', `object_type∈{${TYPES.join(',')}} 且 object_id 必填`);
    this.db.prepare(`INSERT INTO host_scope_link(object_type,object_id,tenant_id,user_id,project_id,thread_id,created_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(object_type,object_id) DO UPDATE SET
      tenant_id=excluded.tenant_id, user_id=excluded.user_id, project_id=excluded.project_id, thread_id=excluded.thread_id`)
      .run(object_type, object_id, tenant_id, user_id, project_id, thread_id, nowIso());
    return { object_type, object_id, tenant_id, user_id, project_id, thread_id };
  }
  getScopeLink({ object_type, object_id }) {
    return this.db.prepare('SELECT * FROM host_scope_link WHERE object_type=? AND object_id=?').get(object_type, object_id) || null;
  }
  // 旧数据（无链接）清单——供 `aec_local list --legacy` 与一次性迁移确认。
  // object_type→(表,主键列) 显式映射，避免字符串拼接猜测列名。
  listLegacy({ object_type = 'memory', limit = 500 } = {}) {
    const MAP = {
      memory: ['host_memory', 'memory_id'],
      business_term: ['host_business_term', 'term_id'],
      preference: ['host_preference', 'preference_id'],
      chunk: ['host_chunk', 'chunk_id'],
      claim: ['host_claim', 'claim_id'],
      element: ['host_element', 'element_id'],
      episode: ['host_episode', 'episode_id'],
    };
    const m = MAP[object_type];
    require2(m, 'scope_type_invalid', `object_type 必须是 ${Object.keys(MAP).join('|')}`);
    const [table, pk] = m;
    return this.db.prepare(`SELECT o.* FROM ${table} o
      WHERE NOT EXISTS (SELECT 1 FROM host_scope_link l WHERE l.object_type=? AND l.object_id=o.${pk})
      ORDER BY o.rowid LIMIT ?`).all(object_type, limit);
  }
  // 一次性迁移绑定：仅当本机该 tenant 只有一个 subject 时可自动绑定，否则需逐条确认。
  claimLegacy({ object_type, object_id, tenant_id, user_id }) {
    require2(user_id, 'subject_required', 'claim-legacy 需要显式 subject（不自动推断）');
    return this.putScopeLink({ object_type, object_id, tenant_id, user_id });
  }
  // 作用域过滤召回（O1-02/O1-03 sidecar 用）：默认排除 unknown_owner（无链接）。
  // 只返回链接 user_id/tenant_id/thread_id 与请求主体匹配的对象；传 allowUnknown=true
  // 仅供已确认归属的迁移场景（需用户确认后才可调用），默认 false。
  recallScoped({ query, user_id, tenant_id = null, thread_id = null, allowUnknown = false, opts = {}, now = Date.now() } = {}) {
    const cands = this.searchMemories({ query, limit: 50 }).map((m) => {
      const link = this.getScopeLink({ object_type: 'memory', object_id: m.memory_id });
      if (!link) return allowUnknown ? { ...m, _scoped: false } : null; // unknown_owner 默认不注入
      if (user_id && link.user_id !== user_id) return null;
      if (tenant_id && link.tenant_id !== tenant_id) return null;
      if (thread_id && link.thread_id && link.thread_id !== thread_id) return null; // 线程作用域（NULL=跨线程可见）
      const qTokens = mksTokens(query);
      const textTokens = new Set(mksTokens([m.title, m.summary, m.content && JSON.stringify(m.content)].filter(Boolean).join(' ')));
      const hit = qTokens.filter(t => textTokens.has(t)).length;
      const relevance = qTokens.length ? hit / qTokens.length : 0;
      return { ...m, relevance, _scoped: true, citation: { source: 'host_memory', id: m.memory_id, origin: m.origin } };
    }).filter(Boolean);
    const ranked = recallRank(cands, { ...opts, now, query });
    return { ...ranked, items: ranked.injected, limits: ['fts_only', 'scope_filtered'],
      meta: { ...(ranked.meta || {}), unknown_owner_excluded: !allowUnknown } };
  }

  /**
   * P2-1（5.0-R-099）：召回过 memory critic。FTS 候选 → token 覆盖率作 relevance →
   * 四因子评分 → 低分不注入 + gaps + citation/why。默认 top-k 3–5。
   * 只读：不写任何表（auditing 在写路径，recall 不产生审计行）。
   */
  recall({ query, kinds = null, scopes = null, opts = {}, now = Date.now() } = {}) {
    const cands = this.searchMemories({ query, limit: 50 }).map((m) => {
      if (kinds && !kinds.includes(m.kind)) return null;
      if (scopes && !scopes.includes(m.scope)) return null;
      const qTokens = mksTokens(query);
      const textTokens = new Set(mksTokens([m.title, m.summary, m.content && JSON.stringify(m.content)].filter(Boolean).join(' ')));
      const hit = qTokens.filter(t => textTokens.has(t)).length;
      const relevance = qTokens.length ? hit / qTokens.length : 0;
      return { ...m, relevance, citation: { source: 'host_memory', id: m.memory_id, origin: m.origin } };
    }).filter(Boolean);
    const ranked = recallRank(cands, { ...opts, now, query });
    return {
      ...ranked,
      items: ranked.injected,
      limits: ['fts_only'], // P2 边界：graph/business/vector 融合在 P3
    };
  }

  // --- knowledge 模块 -------------------------------------------------------------
  addDocument({ source_uri = null, title = null, media_type = null, digest = null } = {}) {
    const document_id = randomUUID();
    const at = nowIso();
    this.db.prepare(
      'INSERT INTO host_document(document_id,source_uri,title,media_type,digest,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)'
    ).run(document_id, source_uri, title, media_type, digest, 'active', at, at);
    this._audit({ action: 'host.document.add', target: document_id });
    return this.db.prepare('SELECT * FROM host_document WHERE document_id=?').get(document_id);
  }
  putChunk({ document_id, ordinal, text } = {}) {
    require2(document_id && Number.isInteger(ordinal) && text != null, 'chunk_required', 'document_id/ordinal/text 必填');
    const existing = this.db.prepare('SELECT rowid, chunk_id FROM host_chunk WHERE document_id=? AND ordinal=?').get(document_id, ordinal);
    if (existing) {
      this.db.prepare('UPDATE host_chunk SET text=? WHERE rowid=?').run(text, existing.rowid);
      this.db.prepare('DELETE FROM host_chunk_fts WHERE rowid=?').run(existing.rowid);
      this.db.prepare('INSERT INTO host_chunk_fts(rowid,text) VALUES(?,?)').run(existing.rowid, ftsText([text]));
      this._audit({ action: 'host.chunk.put', target: existing.chunk_id });
      return { chunk_id: existing.chunk_id, document_id, ordinal };
    }
    const chunk_id = randomUUID();
    const res = this.db.prepare('INSERT INTO host_chunk(chunk_id,document_id,ordinal,text,created_at) VALUES(?,?,?,?,?)')
      .run(chunk_id, document_id, ordinal, text, nowIso());
    this.db.prepare('INSERT INTO host_chunk_fts(rowid,text) VALUES(?,?)').run(Number(res.lastInsertRowid), ftsText([text]));
    this._audit({ action: 'host.chunk.put', target: chunk_id });
    return { chunk_id, document_id, ordinal };
  }
  listChunks({ document_id, limit = 1000 } = {}) {
    require2(document_id, 'chunk_required', 'document_id 必填');
    return this.db.prepare('SELECT * FROM host_chunk WHERE document_id=? ORDER BY ordinal LIMIT ?').all(document_id, limit);
  }
  searchChunks({ query, limit = 20 } = {}) {
    const match = ftsQuery(query);
    if (!match) return [];
    return this.db.prepare(
      `SELECT c.* FROM host_chunk_fts f JOIN host_chunk c ON c.rowid = f.rowid
       WHERE host_chunk_fts MATCH ? ORDER BY rank LIMIT ?`
    ).all(match, limit);
  }
  putClaim({ subject, predicate, object, confidence = 0.5 } = {}) {
    require2(subject && predicate && object != null, 'claim_required', 'subject/predicate/object 必填');
    const existing = this.db.prepare('SELECT claim_id FROM host_claim WHERE subject=? AND predicate=? AND object=?').get(subject, predicate, object);
    const at = nowIso();
    if (existing) {
      this.db.prepare('UPDATE host_claim SET confidence=?, status=?, created_at=? WHERE claim_id=?').run(confidence, 'candidate', at, existing.claim_id);
      return this.db.prepare('SELECT * FROM host_claim WHERE claim_id=?').get(existing.claim_id);
    }
    const claim_id = randomUUID();
    this.db.prepare('INSERT INTO host_claim(claim_id,subject,predicate,object,confidence,status,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(claim_id, subject, predicate, object, confidence, 'candidate', at);
    this._audit({ action: 'host.claim.put', target: claim_id });
    return this.db.prepare('SELECT * FROM host_claim WHERE claim_id=?').get(claim_id);
  }
  listClaims({ limit = 500 } = {}) {
    return this.db.prepare("SELECT * FROM host_claim WHERE status != 'superseded' ORDER BY created_at, rowid LIMIT ?").all(limit);
  }
  // --- experience 模块 -------------------------------------------------------------
  putElement({ element_id = null, element_kind, title, statement, applicability = {}, source_refs = [], state = 'candidate' } = {}) {
    require2(element_kind && title && statement, 'element_required', 'element_kind/title/statement 必填');
    const at = nowIso();
    let version = 1;
    let id = element_id;
    if (id) {
      const mx = this.db.prepare('SELECT MAX(version) AS v FROM host_element WHERE element_id=?').get(id);
      version = (mx?.v ?? 0) + 1;
    } else {
      id = randomUUID();
    }
    this.db.prepare(
      'INSERT INTO host_element(element_id,version,element_kind,title,statement,applicability_json,source_refs_json,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(id, version, element_kind, title, statement, j(applicability), j(source_refs), state, at);
    this._audit({ action: 'host.element.put', target: `${id}@${version}` });
    return this.getElement({ element_id: id, version });
  }
  getElement({ element_id, version = null }) {
    const r = version == null
      ? this.db.prepare('SELECT * FROM host_element WHERE element_id=? ORDER BY version DESC LIMIT 1').get(element_id)
      : this.db.prepare('SELECT * FROM host_element WHERE element_id=? AND version=?').get(element_id, version);
    return rowToElement(r);
  }
  listElements({ element_kind, state, latest_only = false, limit = 500 } = {}) {
    const where = ['1=1']; const args = [];
    if (latest_only) where.push('version = (SELECT MAX(version) FROM host_element e2 WHERE e2.element_id=host_element.element_id)');
    if (element_kind) { where.push('element_kind = ?'); args.push(element_kind); }
    if (state) { where.push('state = ?'); args.push(state); }
    args.push(limit);
    return this.db.prepare(`SELECT * FROM host_element WHERE ${where.join(' AND ')} ORDER BY title, version LIMIT ?`)
      .all(...args).map(rowToElement);
  }
  linkPackageElement({ package_id, package_version, element_id, element_version, role = 'serves' } = {}) {
    require2(package_id && package_version && element_id && element_version != null, 'package_element_required', 'package/element 必填');
    this.db.prepare(
      'INSERT OR IGNORE INTO host_package_element(package_id,package_version,element_id,element_version,role,created_at) VALUES(?,?,?,?,?,?)'
    ).run(package_id, package_version, element_id, element_version, role, nowIso());
    this._audit({ action: 'host.package_element.link', target: `${package_id}@${package_version}~${element_id}@${element_version}` });
  }
  listPackageElements({ package_id, package_version } = {}) {
    require2(package_id, 'package_element_required', 'package_id 必填');
    const where = ['package_id = ?']; const args = [package_id];
    if (package_version) { where.push('package_version = ?'); args.push(package_version); }
    return this.db.prepare(`SELECT * FROM host_package_element WHERE ${where.join(' AND ')} ORDER BY element_id`).all(...args);
  }

  // --- business 模块（高影响必须人工确认，§5.7） ------------------------------------
  putBusinessTerm({ kind, term, detail = null, impact = 'low' } = {}) {
    require2(kind && term, 'business_term_required', 'kind/term 必填');
    require2(['terminology', 'preference', 'entity', 'policy'].includes(kind), 'business_kind_invalid', 'kind ∈ terminology|preference|entity|policy');
    require2(['low', 'high'].includes(impact), 'business_impact_invalid', 'impact ∈ low|high');
    const at = nowIso();
    const existing = this.db.prepare('SELECT term_id FROM host_business_term WHERE kind=? AND term=?').get(kind, term);
    if (existing) {
      this.db.prepare('UPDATE host_business_term SET detail=?, impact=?, updated_at=? WHERE term_id=?').run(detail, impact, at, existing.term_id);
      return this.getBusinessTerm({ term_id: existing.term_id });
    }
    const term_id = randomUUID();
    this.db.prepare(
      'INSERT INTO host_business_term(term_id,kind,term,detail,impact,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)'
    ).run(term_id, kind, term, detail, impact, 'candidate', at, at);
    this._audit({ action: 'host.business.put', target: term_id });
    return this.getBusinessTerm({ term_id });
  }
  getBusinessTerm({ term_id }) {
    return this.db.prepare('SELECT * FROM host_business_term WHERE term_id=?').get(term_id);
  }
  listBusinessTerms({ kind, status, limit = 500 } = {}) {
    const where = ['1=1']; const args = [];
    if (kind) { where.push('kind = ?'); args.push(kind); }
    if (status) { where.push('status = ?'); args.push(status); }
    args.push(limit);
    return this.db.prepare(`SELECT * FROM host_business_term WHERE ${where.join(' AND ')} ORDER BY kind, term LIMIT ?`).all(...args);
  }
  confirmBusinessTerm({ term_id, reviewed_by = null }) {
    require2(term_id, 'business_term_required', 'term_id 必填');
    this.db.prepare("UPDATE host_business_term SET status='confirmed', reviewed_by=?, updated_at=? WHERE term_id=?")
      .run(reviewed_by, nowIso(), term_id);
    this._audit({ action: 'host.business.confirm', target: term_id });
    return this.getBusinessTerm({ term_id });
  }

  // --- ontology 模块 ---------------------------------------------------------------
  putOntologyConcept({ concept_id, module_id, parent_id = null, label, definition = null, status = 'active' } = {}) {
    require2(concept_id && module_id && label, 'ontology_concept_required', 'concept_id/module_id/label 必填');
    this.db.prepare(
      'INSERT INTO host_ontology(concept_id,module_id,parent_id,label,definition,status,created_at) VALUES(?,?,?,?,?,?,?)' +
      ' ON CONFLICT(concept_id) DO UPDATE SET module_id=excluded.module_id, parent_id=excluded.parent_id, label=excluded.label, definition=excluded.definition, status=excluded.status'
    ).run(concept_id, module_id, parent_id, label, definition, status, nowIso());
    this._audit({ action: 'host.ontology.put', target: concept_id });
    return this.db.prepare('SELECT * FROM host_ontology WHERE concept_id=?').get(concept_id);
  }
  listOntologyConcepts({ module_id, limit = 500 } = {}) {
    const where = ['1=1']; const args = [];
    if (module_id) { where.push('module_id = ?'); args.push(module_id); }
    args.push(limit);
    return this.db.prepare(`SELECT * FROM host_ontology WHERE ${where.join(' AND ')} ORDER BY concept_id LIMIT ?`).all(...args);
  }
  putOntologyMapping({ concept_id, source_schema, source_pointer, transform = null } = {}) {
    require2(concept_id && source_schema && source_pointer, 'ontology_mapping_required', 'concept_id/source_schema/source_pointer 必填');
    this.db.prepare(
      'INSERT OR REPLACE INTO host_ontology_mapping(concept_id,source_schema,source_pointer,transform,created_at) VALUES(?,?,?,?,?)'
    ).run(concept_id, source_schema, source_pointer, transform, nowIso());
    this._audit({ action: 'host.ontology.mapping.put', target: `${concept_id}<-${source_schema}` });
  }

  // --- outbox（push 幂等基础） ------------------------------------------------------
  enqueueOutbox({ kind, local_event_id, payload } = {}) {
    require2(kind && local_event_id, 'outbox_required', 'kind/local_event_id 必填');
    const existing = this.db.prepare('SELECT outbox_id FROM local_outbox WHERE node_id=? AND local_event_id=?').get(this.node_id, local_event_id);
    if (existing) return this.db.prepare('SELECT * FROM local_outbox WHERE outbox_id=?').get(existing.outbox_id);
    const outbox_id = randomUUID();
    this.db.prepare(
      'INSERT INTO local_outbox(outbox_id,node_id,local_event_id,kind,payload_json,state,created_at) VALUES(?,?,?,?,?,?,?)'
    ).run(outbox_id, this.node_id, local_event_id, kind, j(payload ?? {}), 'pending', nowIso());
    this._audit({ action: 'host.outbox.enqueue', target: `${this.node_id}/${local_event_id}` });
    return this.db.prepare('SELECT * FROM local_outbox WHERE outbox_id=?').get(outbox_id);
  }
  listOutbox({ state = 'pending', limit = 500 } = {}) {
    return this.db.prepare('SELECT * FROM local_outbox WHERE state=? ORDER BY created_at, rowid LIMIT ?').all(state, limit);
  }
  markOutboxSent(ids = []) {
    if (!ids.length) return 0;
    const stmt = this.db.prepare("UPDATE local_outbox SET state='sent', sent_at=?, attempts=attempts+1 WHERE outbox_id=? AND state='pending'");
    let n = 0;
    for (const id of ids) n += stmt.run(nowIso(), id).changes;
    return n;
  }
  // --- 联邦（aec.federation/v1；P1 只 export/import，push/pull 网络传输在 P6） -------
  exportBundle({ scopes = ['memory', 'knowledge', 'experience', 'business'], limit = 1000 } = {}) {
    const items = [];
    if (scopes.includes('memory')) {
      for (const r of this.db.prepare("SELECT * FROM host_memory WHERE status != 'forgotten' ORDER BY created_at LIMIT ?").all(limit)) {
        items.push({ kind: 'memory', ref: r.memory_id, payload: rowToMemory(r) });
      }
    }
    if (scopes.includes('knowledge')) {
      for (const r of this.db.prepare('SELECT * FROM host_document ORDER BY created_at LIMIT ?').all(limit)) {
        items.push({ kind: 'knowledge.document', ref: r.document_id, payload: r });
      }
      for (const r of this.db.prepare('SELECT * FROM host_chunk ORDER BY document_id, ordinal LIMIT ?').all(limit)) {
        items.push({ kind: 'knowledge.chunk', ref: r.chunk_id, payload: r });
      }
      for (const r of this.db.prepare("SELECT * FROM host_claim WHERE status != 'superseded' ORDER BY created_at LIMIT ?").all(limit)) {
        items.push({ kind: 'knowledge.claim', ref: r.claim_id, payload: r });
      }
    }
    if (scopes.includes('experience')) {
      for (const r of this.db.prepare('SELECT * FROM host_element ORDER BY element_id, version LIMIT ?').all(limit)) {
        items.push({ kind: 'experience.element', ref: `${r.element_id}@${r.version}`, payload: rowToElement(r) });
      }
    }
    if (scopes.includes('business')) {
      for (const r of this.db.prepare('SELECT * FROM host_business_term ORDER BY kind, term LIMIT ?').all(limit)) {
        items.push({ kind: 'business.term', ref: r.term_id, payload: r });
      }
    }
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(items)).digest('hex')}`;
    const bundle = { bundle_version: BUNDLE_VERSION, node_id: this.node_id, generated_at: nowIso(), tables: scopes, items, digest };
    this.db.prepare(
      'INSERT INTO host_federation_log(log_id,direction,peer_node,bundle_digest,tables_json,counts_json,status,at) VALUES(?,?,?,?,?,?,?,?)'
    ).run(randomUUID(), 'export', '<file>', digest, JSON.stringify(scopes), JSON.stringify({ items: items.length }), 'ok', nowIso());
    return bundle;
  }
  /** 幂等导入：UNIQUE(origin_node, origin_id) 之下重复 bundle 全部 duplicate（ADR §3.5）。 */
  importBundle(bundle, { peer_node = null } = {}) {
    require2(bundle?.bundle_version === BUNDLE_VERSION, 'bundle_version_invalid', `bundle_version 必须 ${BUNDLE_VERSION}`);
    require2(Array.isArray(bundle.items), 'bundle_items_invalid', 'items 必须是数组');
    require2(bundle.node_id, 'bundle_node_invalid', 'node_id 必填');
    const origin = bundle.node_id;
    let accepted = 0; let duplicate = 0; const rejected = [];
    for (const it of bundle.items) {
      try {
        if (it.kind === 'memory') {
          const p = it.payload;
          const dup = this.db.prepare('SELECT 1 FROM host_memory WHERE origin_node=? AND origin_id=?').get(origin, it.ref);
          if (dup) { duplicate++; continue; }
          const at = nowIso();
          const memory_id = p.memory_id ?? randomUUID();
          this.db.prepare(
            'INSERT INTO host_memory(memory_id,kind,scope,title,summary,content_json,confidence,sensitivity,status,source_json,created_at,updated_at,origin_node,origin_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
          ).run(memory_id, p.kind, p.scope ?? 'tenant', p.title ?? null, p.summary ?? null, j(p.content ?? {}), p.confidence ?? 0.5, p.sensitivity ?? null, 'candidate', j(p.source ?? {}), at, at, origin, it.ref);
          const rowid = Number(this.db.prepare('SELECT rowid FROM host_memory WHERE memory_id=?').get(memory_id).rowid);
          this.db.prepare('INSERT INTO host_memory_fts(rowid,text) VALUES(?,?)').run(rowid, ftsText([p.title, p.summary]));
          accepted++;
        } else if (it.kind === 'knowledge.claim') {
          const p = it.payload;
          const dup = this.db.prepare('SELECT 1 FROM host_claim WHERE origin_node=? AND origin_id=?').get(origin, it.ref);
          if (dup) { duplicate++; continue; }
          const claim_id = p.claim_id ?? randomUUID();
          this.db.prepare(
            'INSERT OR IGNORE INTO host_claim(claim_id,subject,predicate,object,confidence,status,created_at,origin_node,origin_id) VALUES(?,?,?,?,?,?,?,?,?)'
          ).run(claim_id, p.subject, p.predicate, p.object, p.confidence ?? 0.5, 'candidate', nowIso(), origin, it.ref);
          accepted++;
        } else if (it.kind === 'business.term') {
          const p = it.payload;
          const dup = this.db.prepare('SELECT 1 FROM host_business_term WHERE origin_node=? AND origin_id=?').get(origin, it.ref);
          if (dup) { duplicate++; continue; }
          const at = nowIso();
          const term_id = randomUUID();
          this.db.prepare(
            'INSERT OR IGNORE INTO host_business_term(term_id,kind,term,detail,impact,status,created_at,updated_at,origin_node,origin_id) VALUES(?,?,?,?,?,?,?,?,?,?)'
          ).run(term_id, p.kind, p.term, p.detail ?? null, p.impact ?? 'low', 'candidate', at, at, origin, it.ref);
          accepted++;
        } else {
          rejected.push({ ref: it.ref, kind: it.kind, reason: 'kind_not_importable_yet' });
        }
      } catch (e) {
        rejected.push({ ref: it.ref, kind: it.kind, reason: e.code ?? String(e.message ?? e) });
      }
    }
    this.db.prepare(
      'INSERT INTO host_federation_log(log_id,direction,peer_node,bundle_digest,tables_json,counts_json,status,at) VALUES(?,?,?,?,?,?,?,?)'
    ).run(randomUUID(), 'import', peer_node ?? origin, bundle.digest ?? null, JSON.stringify(bundle.tables ?? []), JSON.stringify({ accepted, duplicate, rejected: rejected.length }), 'ok', nowIso());
    this._audit({ action: 'host.federation.import', target: `${origin}/${bundle.digest?.slice(0, 18)}` });
    return { accepted, duplicate, rejected };
  }
  listFederationLog({ direction, limit = 100 } = {}) {
    const where = ['1=1']; const args = [];
    if (direction) { where.push('direction = ?'); args.push(direction); }
    args.push(limit);
    return this.db.prepare(`SELECT * FROM host_federation_log WHERE ${where.join(' AND ')} ORDER BY at, rowid DESC LIMIT ?`).all(...args);
  }

  // --- purge / rebuild（卸载与维护命令的数据面；CLI 只在此之上包壳） -----------------
  purge() {
    const counts = {};
    for (const [key, t] of Object.entries({
      memory: 'host_memory', memory_link: 'host_memory_link', document: 'host_document',
      chunk: 'host_chunk', claim: 'host_claim', element: 'host_element',
      package_element: 'host_package_element', business_term: 'host_business_term',
      ontology: 'host_ontology', ontology_mapping: 'host_ontology_mapping',
      local_outbox: 'local_outbox', audit: 'host_audit', federation_log: 'host_federation_log',
    })) {
      counts[key] = this.db.prepare(`DELETE FROM ${t}`).run().changes;
    }
    this.rebuildFts();
    this._audit({ action: 'host.purge' });
    return counts;
  }
  rebuildFts() {
    this.db.exec('DELETE FROM host_memory_fts; DELETE FROM host_chunk_fts;');
    for (const r of this.db.prepare("SELECT rowid, title, summary FROM host_memory WHERE status != 'forgotten'").all()) {
      this.db.prepare('INSERT INTO host_memory_fts(rowid,text) VALUES(?,?)').run(r.rowid, ftsText([r.title, r.summary]));
    }
    for (const r of this.db.prepare('SELECT rowid, text FROM host_chunk').all()) {
      this.db.prepare('INSERT INTO host_chunk_fts(rowid,text) VALUES(?,?)').run(r.rowid, ftsText([r.text]));
    }
  }
  close() { this.db.close(); }
}
