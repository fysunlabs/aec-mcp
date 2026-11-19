# 安全说明

`aec-mcp` 持有用户设备上的身份令牌，安全设计围绕"令牌不出本机、不进模型、不被重定向劫持"展开。

## 传输安全

| 机制 | 实现 | 防护目标 |
|------|------|----------|
| HTTPS 强制 | `validateEndpoint()`：非回环地址必须 `https:`，明文 HTTP 需 `AEC_ALLOW_INSECURE_HTTP=1` 显式确认 | 中间人窃听令牌 |
| 端点 allowlist | `AEC_KERNEL_ALLOWLIST`（可选，逗号分隔源） | 配置错误/注入导致令牌发往恶意域 |
| 禁止重定向跟随 | `safeFetch()` 使用 `redirect:'manual'`，任何 3xx 直接拒绝 | 通过 302 把 `Authorization` 带到攻击者域 |
| 超时 | 绑定 10s / 业务 30s（`AbortSignal.timeout`） | 挂起连接耗尽资源 |
| 启动自检 | 占位域名（`*.example` 等）直接拒绝；启动时连通性探测（`AEC_STARTUP_PROBE=0` 跳过），不可达即退出 | 占位/不可达配置"看似注册成功、调用全失败" |
| 错误脱敏 | `redact()` 过滤 `aec_host_*` / `Bearer xxx` / `token|secret|key|code` 查询参数 | 令牌经错误信息泄露到模型或日志 |
| 网络错误分类 | 连接/DNS/TLS/超时单独归为 `network_error`，文案带端点与失败类别 | 网络故障被误报为"内核缺陷"，把排障引向错误方向 |

## 身份认证

- **机器码本地派生**：`machineCode()` 读取 `IOPlatformUUID` / `MachineGuid` / `machine-id`，取不到就**拒绝绑定**（不降级为无指纹令牌）。
- **机器证明**：每次业务请求携带 `x-aec-machine-proof = sha256(host_salt + machine_code)`；机器码原文永不出现在请求体。服务端只存 `sha256(proof)`，因此：复制令牌到别的机器无效；服务端库泄漏也无法重放。
- **双因子**：`Authorization: Bearer <host_token>` + 机器证明，缺一不可。
- **死令牌自愈**：`unauthorized` / `host_expired` / `host_inactive` / `host_fingerprint_mismatch` 触发一次强制重绑并重试；重绑本身需密钥，不会因此越权。**边界（实现与文档一致）**：只有这四类响应码触发重绑——网络类失败（连接失败/DNS/TLS/超时）与令牌有效性无关，只用同一身份原样重试一次，**绝不会删除本机已绑定的有效令牌**；连接失败会归为 `network_error` 并携带端点与失败类别。
- **创作密钥**：`author` profile 必须有 `AEC_AUTHOR_SECRET`，否则进程退出且不注册任何工具。密钥支持 env 与默认目录下的 `author.key`（0600）两处，env 失效可回退文件。

## 本地数据

- 全部本机状态共用一个基础目录：默认 `~/.config/aec`（**Windows 为 `%APPDATA%\aec`**；`AEC_IDENTITY_DIR` 或 `XDG_CONFIG_HOME` 可覆盖，目录 0700、文件 0600）。其中：`identity.json`（设备绑定）、`roles.sqlite`（本地角色库）、`sessions-index.json`（会话现场指针）、`author.key`（创作者密钥）。
- `roles.sqlite` 的令牌以 SHA-256 存储，不保存原文；令牌轮换保留 10 分钟宽限（`prev_token_hash`），与内核一致。
- 用户资料（昵称、邮箱、偏好）只存本地，不上传。

## 已知边界（如实说明）

- `activate` 是唯一无鉴权端点，靠服务端的一次性码 + 限速保护；请在内网或 HTTPS 下使用，并监控异常激活。
- 令牌轮换后旧令牌有 10 分钟宽限期；撤销是"软撤销"，紧急吊销需服务端停用主机。
- `AEC_ALLOW_INSECURE_HTTP=1` 会关闭 scheme 保护，仅应在隔离的 tailnet / 本机调试使用，切勿在公网开启。

## 报告安全问题

请通过 GitHub 私密渠道（Security 标签或邮件给维护者）报告，不要在公开 issue 中附令牌、日志或复现凭据。
