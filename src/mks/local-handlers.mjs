// AEC 5.2.0 O2-01：本地记忆域的共享 handler 集（单一实现，双入口复用）。
//
// 背景（owner 决策 2026-11-27，修订 ADR-AEC-5.0-host-local-memory §3.3 与
// 5.0-R-004 的面隔离条款）：用户单入口优先——公共 aec MCP 内置统一工具
// `aec_local`（op 参数化本文件 8 个操作），装一个 MCP 即获完整能力；
// `--profile local` 独立入口保留为兼容路径。两个入口共用本文件，防漂移。
//
// 硬约束（不变）：
//   - 只访问 Host MKS（host-mks.sqlite），绝不触远端 kernel / roles.sqlite 业务数据。
//   - remember 候选写（candidate），不直接 verified（5.0-R-098 表）。
//   - recall 过 critic，低分不注入 + gaps（5.0-R-099，见 critic.mjs）。
//   - O3-14 rerank：仅 recall、仅 AEC_MKS_RERANK=1 时构造；失败一律 applied:false。
//
// 形态：store=null（lite）时全部操作返回结构化降级回执 host_mks_lite，不建库。
import { z } from 'zod';
import { mksRerank, mksRerankTopN } from './flags.mjs';
import { hostRerankFromEnv, applyMksRerank } from './rerank.mjs';

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], structuredContent: obj });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `[aec_local] ${e?.code || 'error'}: ${e?.message || String(e)}` }], structuredContent: { code: e?.code || 'error', error: e?.message || String(e) } });

export const LOCAL_OPS = ['describe', 'recall', 'remember', 'list', 'show', 'edit', 'forget', 'export'];

/**
 * 共享本地记忆域：8 个操作的 { description, inputSchema, handler } 纯对象。
 * @param {HostMksStore|null} store 已按形态判定的 Host MKS 实例（lite 传 null）
 * @param {object} [opts] env / rerankFn / rerankMeta（测试可注入确定性 rerank）
 */
export function createLocalHandlers(store = null, { env = process.env, rerankFn = undefined, rerankMeta = undefined } = {}) {
  // O3-14：rerank 上下文惰性构造；密钥只从 env 读、不进任何回执/日志。
  let _rr = undefined;
  const rerankCtx = () => {
    if (_rr !== undefined) return _rr;
    const built = hostRerankFromEnv(env);
    _rr = built.ok ? { fn: built.rerankFn, meta: built.meta }
      : { fn: null, reason: built.code };
    return _rr;
  };
  const needStore = () => {
    if (!store) throw Object.assign(new Error('Host MKS 处于 lite 形态（未建库）：本地记忆不可用。设 AEC_MCP_LOCAL_MEMORY=node 后重连。'), { code: 'host_mks_lite' });
    return store;
  };

  return {
    describe: {
      description: '宿主本地 MKS 摘要（只读）。aspect=status（库/形态/计数，默认）| ontology（本地概念）| experience（本地经验元素）。任务前先看本地已沉淀了什么。',
      inputSchema: { aspect: z.enum(['status', 'ontology', 'experience']).default('status').optional() },
      handler: async (args) => {
        try {
          const s = needStore();
          const aspect = args.aspect || 'status';
          if (aspect === 'ontology') return text({ aspect, concepts: s.listOntologyConcepts({ limit: 100 }) });
          if (aspect === 'experience') return text({ aspect, elements: s.listElements({ latest_only: true, limit: 100 }) });
          return text({ aspect, ...s.status() });
        } catch (e) { return fail(e); }
      },
    },

    recall: {
      description: '宿主本地记忆/知识检索（只读）。返回经 critic 筛选的高分记忆（带 citation/why/gaps），低分不注入。query 用使用者原话。',
      inputSchema: {
        query: z.string().describe('检索意图/原话'),
        kinds: z.array(z.string()).optional().describe('可选：限定 memory kind'),
        top_k: z.number().int().min(3).max(5).optional().describe('可选：注入条数 3–5'),
      },
      handler: async (args) => {
        try {
          const s = needStore();
          const r = s.recall({ query: args.query, kinds: args.kinds || null, opts: args.top_k ? { top_k: args.top_k } : {} });
          if (mksRerank(env)) {
            const ctx = rerankCtx();
            const fn = rerankFn ?? ctx.fn;
            const meta = rerankMeta ?? ctx.meta;
            const rr = await applyMksRerank({ searched: r, rerankFn: fn, query: args.query,
              topN: mksRerankTopN(env), enabled: true });
            if (rr.rerank) {
              delete rr.rerank.usage; // token 用量只记总量于评测证据，工具回执不暴露
              if (meta) rr.rerank.endpoint_host = meta.endpoint_host;
              if (ctx.reason && rr.rerank.applied === false && !rr.rerank.reason) rr.rerank.reason = ctx.reason;
            }
            return text({ code: 'ok', ...rr });
          }
          return text({ code: 'ok', ...r });
        } catch (e) { return fail(e); }
      },
    },

    remember: {
      description: '写一条宿主本地候选记忆（任务后的 episode/偏好/纠正）。只写 candidate，需人工核验才 verified。',
      inputSchema: {
        kind: z.enum(['episodic', 'semantic', 'procedural', 'business', 'reflective', 'normative']).describe('记忆类型'),
        summary: z.string().describe('记忆要点（一句话）'),
        title: z.string().optional(),
        content: z.record(z.unknown()).optional(),
        scope: z.enum(['session', 'project', 'tenant', 'global']).optional(),
        confidence: z.number().min(0).max(1).optional(),
      },
      handler: async (args) => {
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
      },
    },

    list: {
      description: '列出宿主本地记忆（只读）。legacy=true 列出无作用域链接的旧数据（unknown_owner 隔离区）供归属确认。',
      inputSchema: {
        kind: z.string().optional(), status: z.string().optional(), limit: z.number().int().min(1).max(500).optional(),
        legacy: z.boolean().optional().describe('true=列出无 scope link 的旧对象（默认不注入隔离区）'),
        object_type: z.enum(['memory', 'business_term', 'preference', 'episode', 'chunk', 'claim', 'element']).optional(),
      },
      handler: async (args) => {
        try {
          const s = needStore();
          if (args.legacy) return text({ code: 'ok', legacy: true, object_type: args.object_type || 'memory',
            items: s.listLegacy({ object_type: args.object_type || 'memory', limit: args.limit || 500 }) });
          return text({ code: 'ok', items: s.listMemories({ kind: args.kind, status: args.status, limit: args.limit || 100 }) });
        } catch (e) { return fail(e); }
      },
    },

    show: {
      description: '查看一条宿主本地记忆详情（只读）。',
      inputSchema: { memory_id: z.string().describe('记忆 id') },
      handler: async (args) => {
        try {
          const s = needStore();
          const m = s.getMemory({ memory_id: args.memory_id });
          if (!m) return text({ code: 'not_found', memory_id: args.memory_id });
          return text({ code: 'ok', memory: m, scope_link: s.getScopeLink?.({ object_type: 'memory', object_id: args.memory_id }) ?? null });
        } catch (e) { return fail(e); }
      },
    },

    edit: {
      description: '编辑一条候选记忆（title/summary/confidence）。仅 candidate 可改；verified 需人工走审计。',
      inputSchema: {
        memory_id: z.string(), title: z.string().optional(), summary: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
      },
      handler: async (args) => {
        try {
          const s = needStore();
          const cur = s.getMemory({ memory_id: args.memory_id });
          if (!cur) return text({ code: 'not_found', memory_id: args.memory_id });
          if (cur.status === 'verified') return text({ code: 'edit_verified_denied', hint: 'verified 记忆不可直接编辑；请新建候选并用 supersedes 关联。' });
          const m = s.updateMemory({ memory_id: args.memory_id, title: args.title, summary: args.summary, confidence: args.confidence });
          return text({ code: 'edited', memory_id: m.memory_id, status: m.status });
        } catch (e) { return fail(e); }
      },
    },

    forget: {
      description: '遗忘一条记忆：status=forgotten，FTS 删除，永不召回（幂等）。',
      inputSchema: { memory_id: z.string() },
      handler: async (args) => {
        try {
          const s = needStore();
          const n = s.forgetMemory({ memory_id: args.memory_id });
          return text({ code: n ? 'forgotten' : 'not_found', memory_id: args.memory_id });
        } catch (e) { return fail(e); }
      },
    },

    export: {
      description: '导出宿主本地 bundle（只读，签名前草案）；用于联邦 export 与备份。',
      inputSchema: { limit: z.number().int().min(1).max(5000).optional() },
      handler: async (args) => {
        try {
          const s = needStore();
          return text({ code: 'ok', bundle: s.exportBundle({ limit: args.limit || 1000 }) });
        } catch (e) { return fail(e); }
      },
    },
  };
}

/**
 * aec_local 统一工具（公共 aec MCP 内置面）的分发层：per-op 必需参数校验。
 * 返回结构化错误（不抛出），与 handler 的 fail() 同格式。
 */
export function validateLocalOp(op, args = {}) {
  if (!LOCAL_OPS.includes(op)) {
    return { code: 'invalid_op', error: `未知 op：${String(op)}（可选 ${LOCAL_OPS.join('/')}）` };
  }
  const need = (field, hint) => {
    const v = args[field];
    if (v === undefined || v === null || v === '') return { code: `missing_${field}`, error: `op=${op} 必填 ${field}${hint ? '：' + hint : ''}` };
    return null;
  };
  if (op === 'recall') { const e = need('query'); if (e) return e; }
  if (op === 'remember') {
    for (const f of ['kind', 'summary']) { const e = need(f); if (e) return e; }
    const KINDS = ['episodic', 'semantic', 'procedural', 'business', 'reflective', 'normative'];
    if (!KINDS.includes(args.kind)) return { code: 'invalid_kind', error: `op=remember kind 必须是 ${KINDS.join('/')}，收到：${String(args.kind)}` };
  }
  if (op === 'show' || op === 'edit' || op === 'forget') { const e = need('memory_id'); if (e) return e; }
  if (op === 'edit') {
    const hasField = args.title !== undefined || args.summary !== undefined || args.confidence !== undefined;
    if (!hasField) return { code: 'nothing_to_edit', error: 'op=edit 至少给 title / summary / confidence 之一' };
  }
  return null;
}
