// AEC 5.0.0 P0 骨架：aec-mcp 侧 Host MKS flags 读取面。
//
// 与内核侧 aec/src/mks/flags.mjs 保持同一语义（P1 起共享 core schema 时同步对齐，
// 见实施计划 §8.4 与 ADR-AEC-5.0-federated-planes「两套 schema 漂移」缓解条款）。
// 本文件只读 env，不建库、不拉行为——Host MKS 实装在 P1（host-mks.sqlite），
// aec_local 实装在 P2（--profile local）。
//
// 锚点：架构说明书 §5.9 / §5.10、R-096/R-098/R-099、
// ADR-AEC-5.0-host-local-memory §3.3（Lite/Node/Sovereign）。

export const DB_SCHEMA = 'aec.mks.flags/v1';

const LOCAL_MEMORY_MODES = ['node', 'lite', 'sovereign'];
const FEDERATION_MODES = ['none', 'export', 'push', 'pull', 'bidirectional'];

// Host MKS 形态。P0 保守默认 lite（不建库 → 4.2.0/2.0.0 边端行为逐字节不变）；
// P2 实装时按架构说明书 §5.9 的 Node 判定（Node 22+ / ≥2GB 可用磁盘 / 重复任务）
// 决定是否把默认升为 node，不达标自动降级 lite 并提示（F6/优雅降级）。
export const localMemoryMode = (env = process.env) => {
  const raw = String(env.AEC_MCP_LOCAL_MEMORY ?? '').trim().toLowerCase();
  return LOCAL_MEMORY_MODES.includes(raw) ? raw : 'lite';
};

// 宿主侧联邦模式：默认 none（节点完全独立，离线可用）。
export const federationMode = (env = process.env) => {
  const raw = String(env.AEC_FEDERATION ?? '').trim().toLowerCase();
  return FEDERATION_MODES.includes(raw) ? raw : 'none';
};

// ---- AEC 5.1.0 O0-06：aec-mcp 侧新增 flag（plan.3 §11.1）----
// AEC_MCP_CONTINUITY：连续性 sidecar（O1-03），依赖 local_memory_mode=node，
// 默认关闭（5.1-R-005：仅 node + continuity 同时为真时 sidecar 生效）。
// 纯 env 读取，不建库、不挂行为；行为在 O1 才接入。clean env → false。
export const mcpContinuityEnabled = (env = process.env) => env.AEC_MCP_CONTINUITY === '1';

// 快照供 `aec-mcp mks status`（P1）与验收证据使用。
// schema 保持 aec.mks.flags/v1：新增字段纯追加，off 等价测试断言默认关闭。
export function flagsSnapshot(env = process.env) {
  return {
    schema: DB_SCHEMA,
    local_memory_mode: localMemoryMode(env),
    federation_mode: federationMode(env),
    mcp_continuity: mcpContinuityEnabled(env),
  };
}
