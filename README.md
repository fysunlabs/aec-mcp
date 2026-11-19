# AEC · 让 AI 助手按成熟经验把事做成

> 你有没有遇到过：同一类任务，这次做成了，下次换个窗口又要从头教 AI？AEC 就是把"做成过的方法"沉淀下来，下次你说一句话，它把验证过的步骤、提示词和所需资源交给你的 AI 助手，助手照着做就行。

`aec-mcp` 是你电脑上安装的一个小工具，它把 AEC 接入你正在用的 AI 助手（如 WorkBuddy、Claude Desktop 等）。**你不需要懂 MCP、不需要装 AEC 服务端、也不需要手动管理任何数据库**（本机会自动维护一个小型本地状态库，见常见问题）——装好、在助手里登记一项、完成一次机器码校验，就能用。

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

不填 `AEC_KERNEL_URL` 时默认连接 AEC 官方云端。第一次连接时会**自动上传本机机器码完成校验（设备绑定）**，通过后即可使用；整个过程无需找管理员要地址、无需手动注册。完整带注释的配置样例见 [`config/mcp.example.json`](./config/mcp.example.json)。

> **自托管 / 私有部署**：在 `env` 里加 `"AEC_KERNEL_URL": "<你的内核服务地址>"` 即可覆盖默认云端；占位样例值（如 `*.example`）会被启动自检拒绝。

如果你是**创作者**，再加一个创作入口（创作端点仅内网可用，需要运维提供的地址与密钥）：

```json
{
  "mcpServers": {
    "aec-author": {
      "type": "stdio",
      "command": "aec-mcp",
      "args": ["--profile", "author"],
      "env": {
        "AEC_KERNEL_URL": "<创作端点地址，仅内网可用，由运维提供>",
        "AEC_AUTHOR_SECRET": "<由 AEC 运维下发>"
      }
    }
  }
}
```

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
- **Claude Desktop / Cline / WorkBuddy**：均为标准 `mcpServers` JSON；WorkBuddy
  也可在连接器管理页添加自定义 stdio 连接器，字段同上。

启动期 aec-mcp 会做一次连通性自检：默认云端不可达、或自托管时 `AEC_KERNEL_URL`
填了 README 占位样例（如 `*.example`）都会直接拒绝启动；域名合法但不可达也会
退出并给出原因（可用 `AEC_STARTUP_PROBE=0` 显式跳过自检）。

### 3. 开始使用

连接成功后，你**不用敲命令**，只要像平时一样对 AI 助手说话：

- **做成一件事**：明确说"用 AEC 做 X"，把你的需求原原本本说出来。AEC 会匹配经验、给出方案，助手照着执行，最后自动验收。
- **创作一个经验包**：说"用 AEC 创作一个经验包"，跟着助手的提示走完"说需求 → 看方案图 → 起草 → 试用 → 发布"五步。方案会以一张网页图呈现，双击即可打开确认。

就这么简单：说人话，助手干活，AEC 负责"有招可使、做完验货"。

---

## 三、常见问题

**装了之后在助手里看不到 AEC？**
确认 Node 版本 ≥ 22.5、`aec-mcp` 命令可用，且 `mcp.json` 条目格式正确（使用者 profile 无需填任何地址）；改完配置后重连助手。更详细的排障记录见 AEC 主仓库的 `aec/docs/MCP_连接排障.md`。

**启动/调用报"无法连接 AEC 内核（connection_refused/dns/timeout…）"？**
这是网络层错误，不是 AEC 的缺陷：默认云端模式下先检查本机网络/DNS/代理是否可达官方云端；自托管场景再核对 `AEC_KERNEL_URL` 是否为管理员给的真实地址（不要照抄 README 样例），修正后重试即可。启动自检失败时进程会退出并给出具体类别，宿主的"连接失败即拒绝激活"语义因此生效。

**机器码校验失败（machine_code_required）？**
极少数主机暴露不出任何稳定硬件标识（Windows 上 MachineGuid、macOS 上 IOPlatformUUID、Linux 上 machine-id 都读不到）时会出现。Windows 上 reg.exe 被安全软件禁用时 aec-mcp 会自动改用 PowerShell 读取同一注册表值，通常无需干预；仍失败说明主机真的没有稳定标识，请换设备或联系管理员。

**npm install -g 某个本地目录后启动报 ERR_MODULE_NOT_FOUND？**
npm 对本地目录的 `-g` 安装是软链，不会复制依赖。见上文"从源码安装"：先 `npm install` 再 `npm link`，或用 `npm install -g github:fysunlabs/aec-mcp`。

**本机会产生哪些文件？**
默认目录为 `~/.config/aec`（Windows 为 `%APPDATA%\aec`；可用 `AEC_IDENTITY_DIR` 或 `XDG_CONFIG_HOME` 覆盖）：`identity.json`（设备绑定令牌）、`roles.sqlite`（本地角色/资料库）、`sessions-index.json`（会话现场指针）、`author.key`（创作者密钥，0600）。`roles.sqlite` 由 aec-mcp 自动创建与迁移，你不需要手动管理；但排障时可以检查它，或整目录删除后重连（会重新完成设备绑定）。

**启动时打印 ExperimentalWarning: SQLite 是坏事吗？**
不是。Node 22.x 的内置 `node:sqlite` 仍标记为实验性，启动可能打印 ExperimentalWarning，不影响功能；更稳的体验可用 Node 23.4+ 或更高 LTS。

**我的资料会上传到哪里？**
你的设备标识、令牌和你填写的用户资料保存在**本机**的一个 SQLite 文件里，不会上传给服务；令牌原文只留在本机内存和本地库，服务端只存哈希。公网连接强制 HTTPS。

**必须联网吗？**
是的，需要一个可访问的 AEC 服务地址。本机只负责收发和展示，匹配、验收等都在服务端完成。

**我能改地址或密钥吗？**
可以，改配置里的环境变量后重连即可。令牌失效（换服务、轮换、过期）时会自动重新绑定。

**设备多了会乱吗？**
不会。令牌和设备绑定，复制到别的机器上无效；可用 `aec-mcp roles` 查看本机设备、令牌与资料。

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
| `AEC_AUTHOR_SECRET` | 创作密钥（仅创作者；此时 `AEC_KERNEL_URL` 为创作端点，必填） |
| `AEC_IDENTITY_DIR` | 本机身份/资料存放目录 |
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
