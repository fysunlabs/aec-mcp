// AEC 5.0.0 P2-2：`aec_local` 宿主本地工具面（aec-mcp --profile local）。
//
// 5.2.0 O2-01 修订（owner 决策 2026-11-27）：公共 aec MCP 内置统一工具
// `aec_local`（op 参数化），单入口即完整能力；本入口保留为兼容路径，工具
// 定义与公共面共用 src/mks/local-handlers.mjs（单一实现，防漂移）。
//
// 硬约束：
//   - 只访问 Host MKS（host-mks.sqlite），绝不触远端 kernel / roles.sqlite 业务数据。
//   - remember 候选写（candidate），不直接 verified（5.0-R-098 表）。
//   - recall 过 critic，低分不注入 + gaps（5.0-R-099，见 critic.mjs）。
//
// 形态判定（§5.9）：run/author 保持 P0 的 lite 默认（2.0.0 逐字节等价不变）；
// 5.1 O1-06 曾保守「未显式默认 lite」；5.2.0 起未显式改为**自动判定**（Node 22+
// 且 ≥2GB 可用磁盘 → node，否则 lite + 提示）——单入口默认完整能力是本轮
// owner 决策的一部分。显式 AEC_MCP_LOCAL_MEMORY 永远优先（尊重用户）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { warn } from './edge/util.mjs';
import { resolveHostMksPath } from './mks/store.mjs';
import { createLocalHandlers, LOCAL_OPS } from './mks/local-handlers.mjs';

const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // ≥2GB（§5.9）

/**
 * Host MKS 形态判定（可注入 probe 便于测试）。
 * 返回值：'node' | 'sovereign' | 'lite'。
 * 显式 AEC_MCP_LOCAL_MEMORY（lite/sovereign/node）优先；node 需过 Node 判定
 * （Node 22+ / ≥2GB 磁盘），不满足降级 lite 并提示。未显式 → 自动判定
 * （5.2.0 O2-01：单入口默认完整能力；此前 5.1 默认 lite）。
 */
export function detectLocalHostMode({ env = process.env, probe = null } = {}) {
  const explicit = String(env.AEC_MCP_LOCAL_MEMORY ?? '').trim().toLowerCase();
  if (explicit === 'lite' || explicit === 'sovereign') return explicit; // 显式非 node 直接生效
  const check = probe || ((p) => {
    try { return statfsSync(p).bavail * statfsSync(p).bsize; } catch { return 0; }
  });
  const nodeOk = Number((process.versions.node || '0').split('.')[0]) >= 22;
  let diskOk = false;
  try { diskOk = check(dirname(resolveHostMksPath({ env }))) >= MIN_FREE_BYTES; } catch { diskOk = false; }
  if (nodeOk && diskOk) return 'node';
  const why = explicit === 'node'
    ? `显式 node 但未满足 Node 判定（Node22+=${nodeOk} / 可用磁盘≥2GB=${diskOk}）`
    : `自动判定未满足（Node22+=${nodeOk} / 可用磁盘≥2GB=${diskOk}）`;
  warn(`[aec_local] ${why}：Host MKS 降级为 lite，本地记忆不可用。如需强制启用请设 AEC_MCP_LOCAL_MEMORY=node。`);
  return 'lite';
}

/**
 * 创建 aec_local MCP server（兼容入口；8 工具 = 共享域的 1:1 顶级注册）。
 * @param {HostMksStore} store 已按 detectLocalHostMode 构造的 Host MKS 实例
 *        （lite 形态传 null，此时工具返回明确降级回执，不建库）。
 */
export function createLocalMcp(store = null, { env = process.env, rerankFn = undefined, rerankMeta = undefined } = {}) {
  const domain = createLocalHandlers(store, { env, rerankFn, rerankMeta });
  const server = new McpServer({ name: 'aec-mcp-local', version: '2.2.0' }, {
    instructions: '宿主本地语义/记忆面（Host MKS）。任务前 describe+recall 取上下文，任务后 remember 记候选记忆。只读工具不写宿主项目；remember 只写本机 host-mks.sqlite 的 candidate，不直接改用户项目。与公共 aec/aec_author 完全独立。（5.2.0 起这些能力已并入公共 aec MCP 的 aec_local 工具；新配置建议只用公共 aec 入口。）',
  });
  for (const op of LOCAL_OPS) {
    const def = domain[op];
    server.registerTool(op, { description: def.description, inputSchema: def.inputSchema }, def.handler);
  }
  return server;
}
