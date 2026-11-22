// AEC 5.0.0 P2-2：`aec_local` 宿主本地工具面（aec-mcp --profile local）。
//
// 硬约束：
//   - 独立 profile：只注册 describe/recall/remember 三工具；公共 aec(4 op)+
//     aec_author(5 op) 工具面零改动（R-004）。
//   - 只访问 Host MKS（host-mks.sqlite），绝不触远端 kernel / roles.sqlite 业务数据。
//   - remember 候选写（candidate），不直接 verified（5.0-R-098 表）。
//   - recall 过 critic，低分不注入 + gaps（5.0-R-099，见 critic.mjs）。
//
// 形态判定（§5.9）：run/author 保持 P0 的 lite 默认（2.0.0 逐字节等价不变）；
// local profile 是显式 opt-in，这里按 Node 22+ / ≥2GB 可用磁盘做判定，不满足
// 自动降级 lite 并给出提示。显式 AEC_MCP_LOCAL_MEMORY 优先（尊重用户）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { warn } from './edge/util.mjs';
import { localMemoryMode } from './mks/flags.mjs';
import { resolveHostMksPath } from './mks/store.mjs';

const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // ≥2GB（§5.9）

/**
 * local profile 的 Host MKS 形态判定（可注入 probe 便于测试）。
 * 返回值：'node' | 'sovereign' | 'lite'。
 */
export function detectLocalHostMode({ env = process.env, probe = null } = {}) {
  const explicit = String(env.AEC_MCP_LOCAL_MEMORY ?? '').trim().toLowerCase();
  if (['node', 'lite', 'sovereign'].includes(explicit)) return explicit; // 显式优先

  // 未显式设置：local profile 显式 opt-in → 尝试 Node 判定，不满足降级 lite。
  const nodeOk = Number((process.versions.node || '0').split('.')[0]) >= 22;
  let diskOk = false;
  const check = probe || ((p) => {
    try { return statfsSync(p).bavail * statfsSync(p).bsize; } catch { return 0; }
  });
  try { diskOk = check(dirname(resolveHostMksPath({ env }))) >= MIN_FREE_BYTES; } catch { diskOk = false; }

  if (nodeOk && diskOk) return 'node';
  warn(`[aec_local] 宿主未满足 Node 判定（Node22+=${nodeOk} / 可用磁盘≥2GB=${diskOk}）：Host MKS 降级为 lite，本地记忆不可用。如需强制启用请设 AEC_MCP_LOCAL_MEMORY=node。`);
  return 'lite';
}

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], structuredContent: obj });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `[aec_local] ${e?.code || 'error'}: ${e?.message || String(e)}` }], structuredContent: { code: e?.code || 'error', error: e?.message || String(e) } });

/**
 * 创建 aec_local MCP server（仅三工具）。
 * @param {HostMksStore} store 已按 detectLocalHostMode 构造的 Host MKS 实例
 *        （lite 形态传 null，此时三工具返回明确降级回执，不建库）。
 */
export function createLocalMcp(store = null, { env = process.env } = {}) {
  const server = new McpServer({ name: 'aec-mcp-local', version: '2.0.0' }, {
    instructions: '宿主本地语义/记忆面（Host MKS）。任务前 describe+recall 取上下文，任务后 remember 记候选记忆。只读工具不写宿主项目；remember 只写本机 host-mks.sqlite 的 candidate，不直接改用户项目。与公共 aec/aec_author 完全独立。',
  });
  const needStore = () => {
    if (!store) throw Object.assign(new Error('Host MKS 处于 lite 形态（未建库）：本地记忆不可用。设 AEC_MCP_LOCAL_MEMORY=node 后重连。'), { code: 'host_mks_lite' });
    return store;
  };

  // describe：Host MKS 摘要（只读）。aspect=status|ontology|experience。
  server.registerTool('describe', {
    description: '宿主本地 MKS 摘要（只读）。aspect=status（库/形态/计数，默认）| ontology（本地概念）| experience（本地经验元素）。任务前先看本地已沉淀了什么。',
    inputSchema: { aspect: z.enum(['status', 'ontology', 'experience']).default('status').optional() },
  }, async (args) => {
    try {
      const s = needStore();
      const aspect = args.aspect || 'status';
      if (aspect === 'ontology') return text({ aspect, concepts: s.listOntologyConcepts({ limit: 100 }) });
      if (aspect === 'experience') return text({ aspect, elements: s.listElements({ latest_only: true, limit: 100 }) });
      return text({ aspect, ...s.status() });
    } catch (e) { return fail(e); }
  });

  // recall：过 critic 的本地检索（只读）。
  server.registerTool('recall', {
    description: '宿主本地记忆/知识检索（只读）。返回经 critic 筛选的高分记忆（带 citation/why/gaps），低分不注入。query 用使用者原话。',
    inputSchema: {
      query: z.string().describe('检索意图/原话'),
      kinds: z.array(z.string()).optional().describe('可选：限定 memory kind'),
      top_k: z.number().int().min(3).max(5).optional().describe('可选：注入条数 3–5'),
    },
  }, async (args) => {
    try {
      const s = needStore();
      const r = s.recall({ query: args.query, kinds: args.kinds || null, opts: args.top_k ? { top_k: args.top_k } : {} });
      return text({ code: 'ok', ...r });
    } catch (e) { return fail(e); }
  });

  // remember：候选写（默认 candidate），绝不直接 verified。
  server.registerTool('remember', {
    description: '写一条宿主本地候选记忆（任务后的 episode/偏好/纠正）。只写 candidate，需人工核验才 verified。',
    inputSchema: {
      kind: z.enum(['episodic', 'semantic', 'procedural', 'business', 'reflective', 'normative']).describe('记忆类型'),
      summary: z.string().describe('记忆要点（一句话）'),
      title: z.string().optional(),
      content: z.record(z.unknown()).optional(),
      scope: z.enum(['session', 'project', 'tenant', 'global']).optional(),
      confidence: z.number().min(0).max(1).optional(),
    },
  }, async (args) => {
    try {
      const s = needStore();
      const m = s.putMemory({
        kind: args.kind, summary: args.summary, title: args.title || null,
        content: args.content || {}, scope: args.scope || 'tenant',
        confidence: args.confidence ?? 0.5, status: 'candidate',
        source: { via: 'aec_local.remember' },
      });
      return text({ code: 'remembered', memory_id: m.memory_id, status: m.status });
    } catch (e) { return fail(e); }
  });

  // ---- AEC 5.1 O1-05：用户控制面（list/show/edit/forget/export）----
  // 统一 ADR 用词 edit（非 correct）；list --legacy 用于确认旧数据归属。
  server.registerTool('list', {
    description: '列出宿主本地记忆（只读）。legacy=true 列出无作用域链接的旧数据（unknown_owner 隔离区）供归属确认。',
    inputSchema: {
      kind: z.string().optional(), status: z.string().optional(), limit: z.number().int().min(1).max(500).optional(),
      legacy: z.boolean().optional().describe('true=列出无 scope link 的旧对象（默认不注入隔离区）'),
      object_type: z.enum(['memory', 'business_term', 'preference', 'episode', 'chunk', 'claim', 'element']).optional(),
    },
  }, async (args) => {
    try {
      const s = needStore();
      if (args.legacy) return text({ code: 'ok', legacy: true, object_type: args.object_type || 'memory',
        items: s.listLegacy({ object_type: args.object_type || 'memory', limit: args.limit || 500 }) });
      return text({ code: 'ok', items: s.listMemories({ kind: args.kind, status: args.status, limit: args.limit || 100 }) });
    } catch (e) { return fail(e); }
  });

  server.registerTool('show', {
    description: '查看一条宿主本地记忆详情（只读）。',
    inputSchema: { memory_id: z.string().describe('记忆 id') },
  }, async (args) => {
    try {
      const s = needStore();
      const m = s.getMemory({ memory_id: args.memory_id });
      if (!m) return text({ code: 'not_found', memory_id: args.memory_id });
      return text({ code: 'ok', memory: m, scope_link: s.getScopeLink?.({ object_type: 'memory', object_id: args.memory_id }) ?? null });
    } catch (e) { return fail(e); }
  });

  server.registerTool('edit', {
    description: '编辑一条候选记忆（title/summary/confidence）。仅 candidate 可改；verified 需人工走审计。',
    inputSchema: {
      memory_id: z.string(), title: z.string().optional(), summary: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
    },
  }, async (args) => {
    try {
      const s = needStore();
      const cur = s.getMemory({ memory_id: args.memory_id });
      if (!cur) return text({ code: 'not_found', memory_id: args.memory_id });
      if (cur.status === 'verified') return text({ code: 'edit_verified_denied', hint: 'verified 记忆不可直接编辑；请新建候选并用 supersedes 关联。' });
      const m = s.updateMemory({ memory_id: args.memory_id, title: args.title, summary: args.summary, confidence: args.confidence });
      return text({ code: 'edited', memory_id: m.memory_id, status: m.status });
    } catch (e) { return fail(e); }
  });

  server.registerTool('forget', {
    description: '遗忘一条记忆：status=forgotten，FTS 删除，永不召回（幂等）。',
    inputSchema: { memory_id: z.string() },
  }, async (args) => {
    try {
      const s = needStore();
      const n = s.forgetMemory({ memory_id: args.memory_id });
      return text({ code: n ? 'forgotten' : 'not_found', memory_id: args.memory_id });
    } catch (e) { return fail(e); }
  });

  server.registerTool('export', {
    description: '导出宿主本地 bundle（只读，签名前草案）；用于联邦 export 与备份。',
    inputSchema: { limit: z.number().int().min(1).max(5000).optional() },
  }, async (args) => {
    try {
      const s = needStore();
      return text({ code: 'ok', bundle: s.exportBundle({ limit: args.limit || 1000 }) });
    } catch (e) { return fail(e); }
  });

  return server;
}
