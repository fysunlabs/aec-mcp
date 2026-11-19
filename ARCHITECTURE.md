# 架构与职责边界

## 一句话

`aec-mcp` 是 AEC 的**边端（edge）**：把宿主的 MCP 工具调用翻译成对远端 AEC 内核的 HTTP 调用，并在本机完成文件落盘、证据采集与身份资料管理。它不持有内核状态。

## 分层

```
MCP Host (stdio)  ──►  aec-mcp (本仓库)  ──HTTP/HTTPS──►  AEC 内核 (主仓库)
                         │                                   │
                         ├─ 工具 schema / op 路由             ├─ /aec/v2 facade
                         ├─ 密钥凭证 (api_key)                ├─ 匹配 / 造包 / 判级
                         ├─ 边端落盘 (session/run/resources)   ├─ 能力库 / 票据
                         └─ 本地角色库 (roles.sqlite)          └─ 内核库 (state.sqlite)
```

## 为什么这样拆

- MCP 协议层（stdio 传输、工具 schema、错误指引、文件落盘）属于**用户设备**，应当开源、可审计、零内核依赖。
- 内核（匹配、渲染、判级、造包、票据签发）是需要部署与运营的**服务**，留在主仓库。
- 两者通过 `POST /aec/v2/*` 这一稳定的 HTTP facade 通信；这条缝在拆分前就已存在，因此剥离不改变契约。

## 模块地图

| 路径 | 职责 |
|------|------|
| `src/mcp.mjs` | MCP server：`createMcpV2` 注册工具（`aec` / `aec_setup` / `aec_author`）、四个 op 的边端逻辑、错误指引、作者页落盘、stdio main |
| `src/transport.mjs` | 加固的 HTTP 客户端：端点校验（含占位域名拒绝）、默认云端端点、启动连通性探测、网络错误分类（`network_error`）、密钥解析（env > 凭证文件）、`keys/verify` 首次校验、`Bearer api_key` 业务调用、重定向防护 |
| `src/identity.mjs` | 凭证文件读写（credentials.json，0600，win/mac/linux 目录差异） |
| `src/db/roles.mjs` | 本地角色库：设备记录、密钥（哈希）、用户资料、角色绑定 |
| `src/edge/` | 从主仓库提取的边端纯函数：`session.mjs`（落盘/证据）、`render.mjs`、`loop.mjs`、`runner.mjs`、`params.mjs`、`signature.mjs`、`l0.mjs`、`util.mjs`、`materialize.mjs` |
| `src/cli.mjs` | CLI：`roles` 子命令 + 默认启动 MCP server |

`src/edge/` 的纯函数与主仓库 `aec/src/` 同源。修改这些函数时须在**主仓库**统一修改并同步到本仓库（通过 subtree），避免两边漂移。

## 数据落点（为什么"两端都建"）

需求要求角色管理数据"两端都建"，原因：

- **客户端本地库**（本仓库 `roles.sqlite`）：保存密钥记录（哈希）、用户资料、角色绑定。这些是**用户侧**数据，留在用户设备，便于离线查看、避免把个人资料上传到服务。
- **服务端主库**（主仓库内核 `state.sqlite` 的 `hosts` 表）：保存密钥哈希、角色、租户、有效期。这是**鉴权权威**，客户端库只是镜像与扩展（用户资料只在客户端）。

二者通过首次校验保持一致：`aec_setup` 校验成功后客户端把 `key_id / api_key / role / tenant` 写入凭证文件与本地库；服务端在 `hosts` 表记录密钥哈希（`fingerprint` 为 NULL 是密钥行的标记）。密钥原文只出现在客户端（凭证文件 + 内存），服务端只存哈希。

## 契约一致性

工具名 / op 集合是跨仓契约，任何一侧修改都会破坏宿主：

- `aec`: `open` / `resource` / `turn` / `close`
- `aec_setup`: 密钥配置（密钥模式首次使用入口，2026-11-19 新增）
- `aec_author`: `open` / `learn` / `plan` / `draft` / `publish`

主仓库有 `console-mcp-invariance.test.mjs` 锁定该契约；本仓库的 `test/protocol.test.mjs` 做同向验证。新增 `aec_setup` 是**纯增量**（宿主按需调用），不改变既有 op 契约。
