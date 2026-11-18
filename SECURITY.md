# 安全说明

`aec-mcp` 持有用户设备上的身份令牌，安全设计围绕"令牌不出本机、不进模型、不被重定向劫持"展开。

## 传输安全

| 机制 | 实现 | 防护目标 |
|------|------|----------|
| HTTPS 强制 | `validateEndpoint()`：非回环地址必须 `https:`，明文 HTTP 需 `AEC_ALLOW_INSECURE_HTTP=1` 显式确认 | 中间人窃听令牌 |
| 端点 allowlist | `AEC_KERNEL_ALLOWLIST`（可选，逗号分隔源） | 配置错误/注入导致令牌发往恶意域 |
| 禁止重定向跟随 | `safeFetch()` 使用 `redirect:'manual'`，任何 3xx 直接拒绝 | 通过 302 把 `Authorization` 带到攻击者域 |
| 超时 | 绑定 10s / 业务 30s（`AbortSignal.timeout`） | 挂起连接耗尽资源 |
| 错误脱敏 | `redact()` 过滤 `aec_host_*` / `Bearer xxx` / `token|secret|key|code` 查询参数 | 令牌经错误信息泄露到模型或日志 |

## 身份认证

- **机器码本地派生**：`machineCode()` 读取 `IOPlatformUUID` / `MachineGuid` / `machine-id`，取不到就**拒绝绑定**（不降级为无指纹令牌）。
- **机器证明**：每次业务请求携带 `x-aec-machine-proof = sha256(host_salt + machine_code)`；机器码原文永不出现在请求体。服务端只存 `sha256(proof)`，因此：复制令牌到别的机器无效；服务端库泄漏也无法重放。
- **双因子**：`Authorization: Bearer <host_token>` + 机器证明，缺一不可。
- **死令牌自愈**：`unauthorized` / `host_expired` / `host_inactive` / `host_fingerprint_mismatch` 触发一次强制重绑并重试；重绑本身需密钥，不会因此越权。
- **创作密钥**：`author` profile 必须有 `AEC_AUTHOR_SECRET`，否则进程退出且不注册任何工具。密钥支持 env 与 `~/.config/aec/author.key`（0600）两处，env 失效可回退文件。

## 本地数据

- `identity.json`、`roles.sqlite`、`author.key` 均写入 `~/.config/aec`（目录 0700、文件 0600）。
- `roles.sqlite` 的令牌以 SHA-256 存储，不保存原文；令牌轮换保留 10 分钟宽限（`prev_token_hash`），与内核一致。
- 用户资料（昵称、邮箱、偏好）只存本地，不上传。

## 已知边界（如实说明）

- `activate` 是唯一无鉴权端点，靠服务端的一次性码 + 限速保护；请在内网或 HTTPS 下使用，并监控异常激活。
- 令牌轮换后旧令牌有 10 分钟宽限期；撤销是"软撤销"，紧急吊销需服务端停用主机。
- `AEC_ALLOW_INSECURE_HTTP=1` 会关闭 scheme 保护，仅应在隔离的 tailnet / 本机调试使用，切勿在公网开启。

## 报告安全问题

请通过 GitHub 私密渠道（Security 标签或邮件给维护者）报告，不要在公开 issue 中附令牌、日志或复现凭据。
