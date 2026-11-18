# aec-mcp

> 开源的 [MCP](https://modelcontextprotocol.io) 客户端，用于连接 [AEC（Agent Experience Center）](https://github.com/fysunlabs/agent-experience-center) 内核。

`aec-mcp` 是一个**纯客户端**：它本身不包含 AEC 内核、不存储经验包、不访问任何模型。它只做三件事——向宿主持久暴露 MCP 工具、通过加固的 HTTP 链路把工具调用转发给远端的 AEC 内核、以及在本机维护设备码与身份资料。所有业务逻辑（匹配、渲染、判级、造包）都在你指向的 AEC 内核服务上完成。

## 特性

- **零内核依赖**：一个 `node` 进程 + 两个 npm 依赖即可运行，不需要 AEC 源码或数据库。
- **两个工具 / 九个操作**：`aec`（消费：`open` / `resource` / `turn` / `close`）与 `aec_author`（创作：`open` / `learn` / `plan` / `draft` / `publish`）。
- **设备级身份绑定**：机器码永不出本机；请求携带 `Bearer <token>` + `sha256(salt + 机器码)` 证明，服务端只存证明的哈希。复制令牌在别的机器上无效。
- **本地角色库**：SQLite 记录设备码、令牌（含轮换宽限）、用户资料与角色绑定，可用 `aec-mcp roles` 查看。
- **链路安全加固**：强制 HTTPS（内网可显式放行）、端点 allowlist、禁止重定向跟随（防令牌外泄）、脱敏错误、超时与死令牌自愈。

## 运行环境

- Node.js **>= 22.5.0**（使用内置 `node:sqlite`，无原生编译依赖）

## 安装

```bash
npm install -g @fysunlabs/aec-mcp
# 或在项目内
npm install @fysunlabs/aec-mcp
```

## 配置

`aec-mcp` 是纯远程客户端，必须通过 `AEC_KERNEL_URL` 指向一个 AEC 内核服务。把它加入你的 MCP Host 配置（以 WorkBuddy / Claude Desktop 的 `mcp.json` 为例）：

```json
{
  "mcpServers": {
    "aec": {
      "type": "stdio",
      "command": "aec-mcp",
      "args": ["--profile", "run"],
      "env": {
        "AEC_KERNEL_URL": "https://aec-api.your-domain.example"
      }
    }
  }
}
```

创作（造包）需要额外的密钥，单独注册一个 profile：

```json
{
  "mcpServers": {
    "aec-author": {
      "type": "stdio",
      "command": "aec-mcp",
      "args": ["--profile", "author"],
      "env": {
        "AEC_KERNEL_URL": "https://aec-api.your-domain.example",
        "AEC_AUTHOR_SECRET": "<由 AEC 内核运维下发>"
      }
    }
  }
}
```

也可先阅读 [`config/mcp.example.json`](./config/mcp.example.json) 获取带注释的完整样例。

### 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `AEC_KERNEL_URL` | 是 | AEC 内核服务地址，例如 `https://aec-api.example.com` |
| `--profile run\|author` | 否 | `run`（默认，消费）；`author`（创作，需密钥） |
| `AEC_AUTHOR_SECRET` | author 必填 | 创作密钥；缺省回退到 `~/.config/aec/author.key` |
| `AEC_ENROLL_SECRET` | 否 | 首次绑定的一次性注册码（如内核要求） |
| `AEC_KERNEL_ALLOWLIST` | 否 | 允许的端点源白名单，逗号分隔；设置后仅允许列表内源 |
| `AEC_ALLOW_INSECURE_HTTP` | 否 | 设为 `1` 才允许非回环明文 HTTP（tailnet/本地调试） |
| `AEC_IDENTITY_DIR` | 否 | 身份/角色库目录，默认 `~/.config/aec` |
| `AEC_MCP_ROLES_DB` | 否 | 角色库路径，默认 `~/.config/aec/roles.sqlite` |
| `AEC_IDENTITY` | 否 | 显式身份文件路径（CI / 多身份） |
| `AEC_TRIAL_ROOT` | 否 | 试用沙箱根目录，默认 `~/.aec-trials` |

> 安全提示：公网部署务必使用 HTTPS。`http://` 仅在 `127.0.0.1` / `localhost` / `100.64.x.x`（tailnet）被接受；其它明文地址会直接拒绝启动，除非显式设置 `AEC_ALLOW_INSECURE_HTTP=1`。

## 用法

启动后你在宿主里看到的是工具，而不是命令。典型流程：

1. 用户明确要求「使用 AEC」时，调用 `aec`，`op=open`，`intent` 填**用户原话**（不要改写、不要总结）。
2. 回执给出阶段指引与「会话 ses_…」；后续用 `op=turn` / `op=resource` / `op=close`，`session` 填这个 id。
3. 创作走 `aec_author` 五阶段：`open` → `learn` → `plan`（回执给出 HTML 一页，打开给用户确认）→ `draft` → 试用 → `publish`。图示一律用回执给的 HTML 文件展示，不要贴 mermaid 源码。

`op=close` 不需要也不接受 `acceptance` 入参；验收由内核独立判定。

## 查看本地角色与设备

```bash
aec-mcp roles            # 列出 schema 版本、设备、令牌数量、用户资料
aec-mcp roles profile <subject>   # 查看某个用户的资料
```

角色库存放的是**你本机的**设备码派生标识、令牌与你填的用户资料，不会上传到内核，也不含任何密钥原文。

## 与 AEC 主仓库的关系

本仓库由 AEC 主仓库 `agent-experience-center` 通过 **git subtree** 管理。以主仓库为开发主场时：

- 涉及 `aec-mcp` 的改动请在主仓库的 `aec-mcp/` 目录修改；
- 提交后用主仓库的同步脚本推送到本仓库：

```bash
# 主仓库根目录
bash scripts/aec-mcp-subtree.sh push   # 主仓 -> aec-mcp
bash scripts/aec-mcp-subtree.sh pull   # aec-mcp -> 主仓
```

详见主仓库文档 `docs/MCP_仓库与同步.md` 与 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 开发

```bash
npm install
npm test
```

## 安全

链路与身份的安全设计见 [SECURITY.md](./SECURITY.md)。如发现安全问题，请勿公开提交 issue，按 SECURITY.md 中的方式私下报告。

## 许可

MIT © fysunlabs
