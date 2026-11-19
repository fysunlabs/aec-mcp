# AEC · 让 AI 助手按成熟经验把事做成

> 你有没有遇到过：同一类任务，这次做成了，下次换个窗口又要从头教 AI？AEC 就是把"做成过的方法"沉淀下来，下次你说一句话，它把验证过的步骤、提示词和所需资源交给你的 AI 助手，助手照着做就行。

`aec-mcp` 是你电脑上安装的一个小工具，它把 AEC 接入你正在用的 AI 助手（如 WorkBuddy、Claude Desktop 等）。**你不需要懂 MCP、不需要装 AEC 服务端、也不需要手动管理任何数据库**（本机会自动维护一个小型本地状态库，见常见问题）——装好、在助手里登记一项、首次使用时给 AI 助手一枚密钥，就能用。

---

## 一、AEC 能帮你做什么

### 使用场景

- **重复劳动**：每次都要做同一类事（整理资料、抓取内容、生成报告、处理图片……），不想每次重新描述做法。
- **一次跑通，次次复用**：把这次摸索出来的成功流程保存下来，以后一句话调出来用。
- **借用别人的成熟经验**：直接用社区或团队里已经验证、带验收标准的经验包，而不是自己从零试错。
- **把方法沉淀成资产**：把你擅长的某件事做成"经验包"，分享给同事或用户，还能记录谁用、用得怎么样。

### 核心能力

| 能力 | 说明 |
|------|------|
| **一句话匹配经验** | 你用大白话说想做什么，AEC 从经验库里挑出最合适的做法；不确定时会把候选摆给你选，不会瞎猜。 |
| **下发可执行方案** | 匹配到经验后，给你一套完整的执行步骤、每一步的提示词、需要的素材和接口，你的 AI 助手照着执行。 |
| **自动验收** | 任务做完后，AEC 按预设标准检查结果是否达标，并记录下来——不是"做完了就算"，而是"做对了才算"。 |
| **创作经验包** | 把你的方法一点点教给 AEC：说清需求 → 参考相似经验 → 生成方案 → 起草 → 试用验证 → 发布。全程有一页可视化的图帮你确认。 |
| **资源与票据按需给** | 需要用到的接口密钥、素材文件在对应步骤才提供，用完不落地，减少泄露风险。 |

### 两个身份，各司其职

- **使用者**（默认）：消费已有经验，把事做成。人人可用。
- **创作者**（可选）：创作和发布经验包，给使用者提供能力。需要运维下发一个创作密钥。

---

## 二、快速开始

### 1. 安装

需要 Node.js **22.5 或更高版本**（无需编译任何原生组件）。

```bash
npm install -g @fysunlabs/aec-mcp
```

也可以直接从 GitHub 安装（拉取完整依赖树）：

```bash
npm install -g github:fysunlabs/aec-mcp
```

**从源码安装（开发者）**：注意 npm 对**本地目录**的 `-g` 安装是软链模式，不会复制依赖——
直接 `npm install -g D:\path\to\aec-mcp` 会安装"成功"但启动即报
`ERR_MODULE_NOT_FOUND: Cannot find package '@modelcontextprotocol/sdk'`。正确姿势二选一：

```bash
git clone https://github.com/fysunlabs/aec-mcp && cd aec-mcp
npm install          # ① 先在源码目录装全依赖
npm link             # ② 再全局链接 aec-mcp 命令
```

或跳过 clone，直接用上面的 GitHub spec 安装。装完可用 `aec-mcp --help`（或直接启动）验证。

### 2. 连接你的 AI 助手

在你的 AI 助手的 MCP 配置里（通常是 `mcp.json`）加入一项——**无需填写任何服务地址**：

```json
{
  "mcpServers": {
    "aec": {
      "type": "stdio",
      "command": "aec-mcp",
      "args": ["--profile", "run"]
    }
  }
}
```

不填 `AEC_KERNEL_URL` 时默认连接 AEC 官方云端。完整带注释的配置样例见 [`config/mcp.example.json`](./config/mcp.example.json)。

> **自托管 / 私有部署**：在 `env` 里加 `"AEC_KERNEL_URL": "<你的内核服务地址>"` 即可覆盖默认云端；占位样例值（如 `*.example`）会被启动自检拒绝。

如果你是**创作者**，再加一个创作入口（创作端点仅内网可用，需要运维提供的地址）：

```json
{
  "mcpServers": {
    "aec-author": {
      "type": "stdio",
      "command": "aec-mcp",
      "args": ["--profile", "author"],
      "env": {
        "AEC_KERNEL_URL": "<创作端点地址，仅内网可用，由运维提供>"
      }
    }
  }
}
```

### 3. 首次使用：给 AI 助手一枚密钥

AEC 用**密钥**识别用户（`aec_key_` 开头，由管理员从 AEC 服务器生成，只显示一次）。首次使用只需三步：

1. **安装配置好后，对 AI 助手说"用 AEC 做 X"**——助手会提示"AEC 尚未配置密钥"，并向你要密钥。
2. **把管理员给你的密钥发给助手**——助手调用 `aec_setup` 提交，AEC 云端校验通过后，密钥自动保存在你本机的凭证文件里（Windows 在 `%APPDATA%\aec\credentials.json`，macOS / Linux 在 `~/.config/aec/credentials.json`，文件权限 0600）。
3. **之后不再需要**——每次使用 AEC 时，密钥由云端逐次快速校验；到期/被撤销时助手会如实告诉你，找管理员换一枚新的即可。

> 密钥也可以不经对话注入：在 `mcp.json` 的 `env` 里加 `"AEC_API_KEY": "<密钥>"`，适合脚本化部署。密钥丢失/泄露找管理员撤销并换发。

**管理员侧：怎么生成密钥？** 在 AEC 服务器本机（能访问内核数据目录）执行：

```bash
node aec/scripts/key-admin.mjs create --label <用户标识> --role consumer --days 90
node aec/scripts/key-admin.mjs list      # 查看全部密钥
node aec/scripts/key-admin.mjs revoke --key-id host_xxx   # 撤销（下一次请求即失效）
```

密钥明文只在 create 时显示一次，服务器只存哈希；自托管公网部署需在反代白名单放行 `POST /aec/v2/keys/verify`（参见内核仓库 `deploy/nginx-aec-api-public.conf`）。

### 不同宿主的配置姿势

`command` 找不到 `aec-mcp` 时（非 PATH 环境、Windows 服务、DSH 等），用 **node 绝对路径 + 入口脚本绝对路径**：

```json
{
  "mcpServers": {
    "aec": {
      "type": "stdio",
      "command": "node",
      "args": ["<npm 全局目录>/node_modules/@fysunlabs/aec-mcp/src/cli.mjs", "--profile", "run"]
    }
  }
}
```

- npm 全局目录可用 `npm root -g` 查询（Windows 通常在 `%APPDATA%\npm\node_modules`）。
- **DSH**：patch loader 求值阶段宿主环境变量尚未注入，`command` 里不要写
  `!!js process.env.DSH_NODE_EXECUTABLE`（会因 `command` 缺失导致入口激活失败
  `ValidationError: expected ... command: string`）；用 `!!js process.execPath`
  或写死 node 绝对路径。
- **Claude Desktop / Cline**：均为标准 `mcpServers` JSON。
- **WorkBuddy（5.x，尤其 ≥5.11）**：既支持上面的 `mcpServers` JSON，也必须走连接器的「信任」流程——见下方「WorkBuddy 必读」。

#### WorkBuddy 必读：strict MCP config 与「信任」

WorkBuddy 5.x（尤其 ≥5.11）默认启用 **strict MCP config**：会话只加载「在连接器管理页信任过」的 MCP。
仅把 `aec` 写进 `~/.workbuddy/mcp.json`，宿主会判为 `scope=user blocked by strict MCP config` 而**完全不加载**——
表现是「配置写了、命令行能跑通，但界面里看不到 AEC、对话里没有 `mcp__aec__*` 工具」。
**这不是重启能解决的**：没点信任，重启客户端多少次都不会加载。

正确接入步骤（缺一不可）：

1. 左侧栏 **专家·技能·连接器** → 顶部 **连接器** → 右上角 **自定义连接器** → 打开 **MCP 服务管理**。
2. 点 **添加 MCP**，把上面的 `aec` 条目粘进去并保存（该编辑器操作的就是 `~/.workbuddy/mcp.json`；
   即使文件里已手写过 `aec`，也要在这里确认可见）。
3. 在「我的 MCP」列表里找到 `aec`，点 **信任**，状态点由灰变绿（首次信任是一次性安全门禁）。
4. **新建或重启会话**——只有重建会话后，受信任的 MCP 才会注入工具列表。

排障（看不到 AEC 时按顺序查）：

- 会话日志 `~/.workbuddy/logs/<会话>.log`：出现 `scope=user blocked by strict MCP config` 即说明未走信任流程；
  `allServers=[...]` 里出现 `aec:connected` 才算真正加载。
- `~/.workbuddy/logs/daemon.log`：`runtimeMcpCount` 是否包含 aec、`hasTrustedRuntimeMcpEnv` 是否为 `true`。
- 确认已点信任并重建会话；只保存文件、只重启客户端都不够。

启动期 aec-mcp 会做一次连通性自检：默认云端不可达、或自托管时 `AEC_KERNEL_URL`
填了 README 占位样例（如 `*.example`）都会直接拒绝启动；域名合法但不可达也会
退出并给出原因（可用 `AEC_STARTUP_PROBE=0` 显式跳过自检）。

### 4. 开始使用

连接成功后，你**不用敲命令**，只要像平时一样对 AI 助手说话：

- **做成一件事**：明确说"用 AEC 做 X"，把你的需求原原本本说出来。AEC 会匹配经验、给出方案，助手照着执行，最后自动验收。
- **创作一个经验包**：说"用 AEC 创作一个经验包"，跟着助手的提示走完"说需求 → 看方案图 → 起草 → 试用 → 发布"五步。方案会以一张网页图呈现，双击即可打开确认。

就这么简单：说人话，助手干活，AEC 负责"有招可使、做完验货"。

---

## 三、常见问题

**装了之后在助手里看不到 AEC？**
先确认 Node 版本 ≥ 22.5、`aec-mcp` 命令可用，且 `mcp.json` 条目格式正确（使用者 profile 无需填任何地址）。
再按宿主分别处理：
- **WorkBuddy**：多数情况是 strict MCP config 未信任——手写 `mcp.json` 会被 `blocked by strict MCP config` 屏蔽，重启客户端无效。
  必须走「自定义连接器 → 添加 MCP → 信任 → 重建会话」，详见上文「WorkBuddy 必读」。
- **其他宿主**：改完配置后重连/重启助手即可。

更详细的排障记录见 AEC 主仓库的 `aec/docs/MCP_连接排障.md`。

**启动/调用报"无法连接 AEC 内核（connection_refused/dns/timeout…）"？**
这是网络层错误，不是 AEC 的缺陷：默认云端模式下先检查本机网络/DNS/代理是否可达官方云端；自托管场景再核对 `AEC_KERNEL_URL` 是否为管理员给的真实地址（不要照抄 README 样例），修正后重试即可。启动自检失败时进程会退出并给出具体类别，宿主的"连接失败即拒绝激活"语义因此生效。

**密钥从哪里来？丢了/过期了怎么办？**
密钥由你的 AEC 管理员从 AEC 服务器生成（服务器上一条命令：`node aec/scripts/key-admin.mjs create --label <你的名字>`），通过安全渠道发给你，只显示一次。丢了或过期：找管理员撤销旧密钥、生成新密钥，重新给助手提交一次即可（旧密钥撤销后立即失效）。

**助手报"尚未配置密钥 / 密钥无效 / 已撤销"？**
尚未配置：向管理员要一枚 `aec_key_` 密钥发给助手。无效/撤销/过期：确认密钥完整（复制时别带空格换行）、未被撤销、未过期；处理后让助手重新提交。若你在 `mcp.json` 的 `env` 里放了旧版机器令牌（`aec_host_` 开头），v2.0 已不支持——请换成 `aec_key_` 密钥。

**npm install -g 某个本地目录后启动报 ERR_MODULE_NOT_FOUND？**
npm 对本地目录的 `-g` 安装是软链，不会复制依赖。见上文"从源码安装"：先 `npm install` 再 `npm link`，或用 `npm install -g git+https://github.com/fysunlabs/aec-mcp.git`。

**本机会产生哪些文件？**
默认目录为 `~/.config/aec`（Windows 为 `%APPDATA%\aec`；可用 `AEC_IDENTITY_DIR` 或 `XDG_CONFIG_HOME` 覆盖）：`credentials.json`（你的 AEC 密钥，0600，首次 `aec_setup` 校验成功后写入）、`roles.sqlite`（本地角色/资料库）、`sessions-index.json`（会话现场指针）。`roles.sqlite` 由 aec-mcp 自动创建与迁移，你不需要手动管理；排障时可以检查它，或整目录删除后重新提交密钥。旧版 `identity.json`（机器绑定令牌）v2.0 起不再读取，可删。

**启动时打印 ExperimentalWarning: SQLite 是坏事吗？**
不是。Node 22.x 的内置 `node:sqlite` 仍标记为实验性，启动可能打印 ExperimentalWarning，不影响功能；更稳的体验可用 Node 23.4+ 或更高 LTS。

**我的资料会上传到哪里？**
你的密钥和用户资料保存在**本机**（凭证文件 0600 + 一个 SQLite 文件）；服务端只存密钥的哈希，数据库泄露也无法还原密钥原文。每次调用只传密钥本身用于校验。公网连接强制 HTTPS。

**必须联网吗？**
是的，需要一个可访问的 AEC 服务地址。本机只负责收发和展示，匹配、验收等都在服务端完成。

**我能改地址或密钥吗？**
可以。地址改 `mcp.json` 的 `AEC_KERNEL_URL`；密钥找管理员换发后重新给助手提交一次即可（云端校验不通过时助手会告诉你）。

---

## 四、命令与配置速查

日常几乎用不到命令，只有查看本机资料时会用到：

```bash
aec-mcp roles                      # 查看本机设备、令牌数量、用户资料
aec-mcp roles profile <subject>    # 查看某个用户的资料
```

常用环境变量：

| 变量 | 用途 |
|------|------|
| `AEC_KERNEL_URL` | AEC 服务地址（**可选**；使用者 profile 默认连官方云端，自托管/私有部署时填写。占位样例值会被启动自检拒绝） |
| `AEC_API_KEY` | AEC 密钥（`aec_key_` 开头，可选；不经对话注入的部署方式，优先级高于本机凭证文件） |
| `AEC_IDENTITY_DIR` | 本机凭证/资料存放目录 |
| `AEC_KERNEL_ALLOWLIST` | 限制可连接的服务地址 |
| `AEC_TRIAL_ROOT` | 创作试用时的沙箱目录 |
| `AEC_STARTUP_PROBE` | 设为 `0` 跳过启动期连通性自检（默认开启） |

---

## 五、想了解更多？

- **能力是怎么匹配和验收的、经验包是什么**：见主仓 `aec/README.md` 与 `docs/implementation.md`。
- **安装配置、环境变量、工具与操作名等完整技术说明**：见主仓 `aec/docs/MCP_客户端介绍.md`。
- **工作原理与模块划分**：见 [ARCHITECTURE.md](./ARCHITECTURE.md)。
- **链路与身份安全设计**：见 [SECURITY.md](./SECURITY.md)。

如发现安全问题，请勿公开提交 issue，按 [SECURITY.md](./SECURITY.md) 中的方式私下报告。

## 许可

MIT © fysunlabs
