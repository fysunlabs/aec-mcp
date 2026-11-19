# 安全说明

`aec-mcp` 持有用户设备上的 AEC 密钥（api key），安全设计围绕"密钥不出本机、不进模型、不被重定向劫持"展开。

## 传输安全

| 机制 | 实现 | 防护目标 |
|------|------|----------|
| HTTPS 强制 | `validateEndpoint()`：非回环地址必须 `https:`，明文 HTTP 需 `AEC_ALLOW_INSECURE_HTTP=1` 显式确认 | 中间人窃听密钥 |
| 端点 allowlist | `AEC_KERNEL_ALLOWLIST`（可选，逗号分隔源） | 配置错误/注入导致密钥发往恶意域 |
| 禁止重定向跟随 | `safeFetch()` 使用 `redirect:'manual'`，任何 3xx 直接拒绝 | 通过 302 把 `Authorization` 带到攻击者域 |
| 超时 | 密钥校验 10s / 业务 30s（`AbortSignal.timeout`） | 挂起连接耗尽资源 |
| 启动自检 | 占位域名（`*.example` 等）直接拒绝；启动时连通性探测（`AEC_STARTUP_PROBE=0` 跳过），不可达即退出 | 占位/不可达配置"看似配置成功、调用全失败" |
| 错误脱敏 | `redact()` 过滤 `aec_host_*` / `aec_key_*` / `Bearer xxx` / `token|secret|key|code` 查询参数 | 密钥经错误信息泄露到模型或日志 |
| 网络错误分类 | 连接/DNS/TLS/超时单独归为 `network_error`，文案带端点与失败类别 | 网络故障被误报为"内核缺陷"，把排障引向错误方向 |

## 身份认证（密钥模式，2026-11-19）

- **用户持票**：身份 = AEC 密钥（`aec_key_` 前缀，服务器铸造，32 字节 base64url ≈ 256bit 熵）。每次业务请求 `Authorization: Bearer <api_key>`，服务端逐请求查表校验（状态/过期/撤销即时生效）。
- **首次校验**：用户提供的密钥经 `POST /aec/v2/keys/verify` 云端确认后才写入本机；`aec_setup` 的回执只含元数据（key_id/角色/有效期），**密钥原文不回显**。
- **本地存储**：密钥明文只存本机 `credentials.json`（0600，目录 0700）——客户端必须每次发送原文，这是"持票"语义的必然；服务端只存 SHA-256 哈希，数据库泄漏无法还原密钥。
- **无客户端侧重绑**：鉴权失败（`key_invalid` / `key_revoked` / `key_expired` / 401）没有任何自动重试/换钥——密钥是用户持有的，失败如实回执并指引，绝不在用户背后换凭证。
- **与旧机器绑定的关系**：v2.0 起机器绑定（machineCode/machineProof/机器激活）整体移除——机器码依赖平台命令（win32 `reg query` 等），在安全软件黑名单主机上直接不可用。服务器端机器绑定路径仍保留（对安全敏感的部署可用），但本客户端不再使用；检测到旧 `aec_host_` 令牌会明确提示换密钥。
- **密钥生命周期**：服务器生成时只显示一次；默认 90 天过期；泄露/离职等场景由管理员撤销，下一次请求即被拒。

## 本地数据

- 全部本机状态共用一个基础目录：默认 `~/.config/aec`（**Windows 为 `%APPDATA%\aec`**；`AEC_IDENTITY_DIR` 或 `XDG_CONFIG_HOME` 可覆盖，目录 0700、文件 0600）。其中：`credentials.json`（AEC 密钥）、`roles.sqlite`（本地角色库）、`sessions-index.json`（会话现场指针）。旧版 `identity.json` / `author.key`（机器绑定形态）v2.0 起不再读取，可删。
- `roles.sqlite` 的密钥以 SHA-256 存储不保存原文；用户资料（昵称、邮箱、偏好）只存本地，不上传。

## 已知边界（如实说明）

- 密钥本身可被复制：与旧机器绑定不同，密钥拿到哪台机器都能用。对冲手段是 256bit 熵（在线爆破不可行）+ 0600 存储 + 有效期 + 服务端即时撤销；对单机绑定有硬需求的部署请在服务端使用保留的机器绑定路径。
- `keys/verify` 是无预置鉴权端点（密钥本身即鉴权），请在 HTTPS 下使用。
- `AEC_ALLOW_INSECURE_HTTP=1` 会关闭 scheme 保护，仅应在隔离的 tailnet / 本机调试使用，切勿在公网开启。

## 报告安全问题

请通过 GitHub 私密渠道（Security 标签或邮件给维护者）报告，不要在公开 issue 中附密钥、日志或复现凭据。
