# aec-mcp/src/mks — Host MKS（AEC 5.0.0 / aec-mcp 3.0.0）

> 状态：**P0 骨架（flags 空实现）**。Host MKS 实装在 P1；`aec_local` 工具面实装在 P2。
> 本目录当前只有 `flags.mjs`——宿主侧 feature flag 读取面。

## 计划布局（实施计划 §8.4/§9，`host-mks.sqlite`）

| 文件 | 职责 | 阶段 |
|---|---|---|
| `flags.mjs` | `AEC_MCP_LOCAL_MEMORY` / `AEC_FEDERATION` 读取面 | **P0 已落地** |
| `host-mks.mjs` | `DatabaseSync`、PRAGMA WAL/foreign_keys/busy_timeout、迁移、四模块表、outbox | P1 |
| `schema.mjs` | 本地 schema（与 Cloud MKS 共享 core schema，各自迁移） | P1 |
| `tools.mjs` | `aec_local`：describe/recall/remember（3 工具，candidate 写） | P2 |
| `memory.mjs` | memory critic：relevance/recency/confidence/utility；top-k 3–5 | P2 |
| `knowledge.mjs` | 本地文档 chunk/FTS/citation | P2 |
| `federation.mjs` | outbox 幂等 `(node_id, local_event_id)`、export/push | P2/P6 |

## 硬约束

1. **独立 DB**：`host-mks.sqlite`（`~/.config/aec/` / Win `%APPDATA%\aec\`），0700，
   不复用/污染 `roles.sqlite`（角色身份 ≠ 业务记忆）；不存 secrets；可 purge/export。
2. **aec_local 独立 profile**：`--profile local`；`describe/recall/remember` 只访问 Host MKS；
   `remember` 默认 candidate；不改变公共 `aec`（4 op）/`aec_author`（5 op）。
3. **flags off 等价**：不设置任何 5.0 env 时，2.0.0 边端行为逐字节不变。
4. **离线可用**：Host MKS 不依赖云端在线（R-096/FED-01）。

## 设计真相

- 架构说明书 §5.9/§5.10；ADR-AEC-5.0-host-local-memory；ADR-AEC-5.0-federated-planes
- reports/v5.0/AEC_5.0.0_开发实施计划_20261121.md §8.4/§9
