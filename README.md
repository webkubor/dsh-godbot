# dsh-godbot

**Godbot 是 dsh 的多 Agent 团队工作台。** 把 Claude Code、Codex、Antigravity 和原生 dsh 成员放进同一个团队：你可以直接接管某个成员的原生会话，也可以让成员互发消息、分派任务、提交证据并由你验收。

*A multi-agent team workbench plugin for dsh — run Claude Code, Codex, Antigravity and native dsh members as one team, with native session hand-off, workflows, schedules, CI hooks and audit trails.*

外部成员通过本机 CLI 的原生接口执行，沿用各 CLI 自己的登录和配额，订阅凭据由各 CLI 自行管理。工作台通过当前 dsh profile 的 owner 身份授权。

## 功能概览

| 能力 | 说明 |
| --- | --- |
| 原生 Agent 接管 | 在 Bot 私聊中切到「原生对话」或「原生终端」，与 Bot 共用同一个会话、工作目录和进程，随时交还聊天。 |
| 团队协作 | GodBot 组建团队和群聊，成员之间 `@` 点名、派工、提交证据；群组有独立的任务板、待办和阶段目标。 |
| 多 Bot 工作流 | 用节点和条件连线编排可重复运行的流程，支持汇合、分支、版本锁定，并可从 CI 触发。 |
| 自动化任务 | 一次性、固定间隔、每天、每周、五字段 Cron 或 iCalendar RRULE，由本机 Host 调度。 |
| 沙箱多账号 | 同一提供商可登记多个隔离账号，每个账号运行在独立的 Lima 虚拟机中，按目录授权挂载项目。 |
| 浏览器与桌面 | 每个 Bot 拥有独立 Chromium 或完整 Linux 桌面容器，你可以随时接管网页再交还给 Bot。 |
| CI、Webhook 与 MCP | `godbot` 命令行、stdio MCP、HMAC 签名的 Webhook 和 GitHub 公开仓库事件订阅。 |
| 用量控制 | 按 profile 或单个 Bot 设置 UTC 日、月 token 与美元上限，额度拒绝时切换备用模型。 |
| 共享与审计 | 个人邀请、按资源授权（查看、聊天、管理与审批），所有操作均有审计记录。 |
| 加密备份与换机 | scrypt + AES-256-GCM 加密的工作台备份，可映射项目路径恢复，并支持中断恢复与回滚。 |

功能与上游实现的对照、验证范围见 [FEATURE_PARITY.md](FEATURE_PARITY.md)。

## 目录

- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [使用指南](#使用指南)
- [本地 Agent 与沙箱多账号](#本地-agent-与沙箱多账号)
- [CI、Webhook 与用量控制](#ciwebhook-与用量控制)
- [与同事共享工作区](#与同事共享工作区)
- [加密备份和换机](#加密备份和换机)
- [命令行速查](#命令行速查)
- [故障排查](#故障排查)
- [开发与验证](#开发与验证)
- [相关文档与第三方声明](#相关文档与第三方声明)
- [许可证](#许可证)

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | macOS（首版支持范围） |
| Node.js | 24.9 或以上，并准备好 npm 和 pnpm |
| DSH | DSH Web `0.2.2-rc.5`（本版本验证过的宿主）。宿主只向前走：**不要为了装插件把 DSH 降级**，宿主比这新时插件停用即可，等验证过新宿主的 Godbot 发布 |
| Agent CLI | 需要使用的 Claude Code、Codex 或 Antigravity，并已在**同一系统用户**的终端中完成正常登录 |
| 原生 dsh 成员 | 目标 profile 中至少配置一条可用的模型路由 |

## 快速开始

```sh
# 首次使用 DSH 时安装
npm install -g @deepseek-ai/dsh

git clone https://github.com/renjiegod/dsh-godbot.git
cd dsh-godbot
dsh --version
npm ci
node scripts/install-local.mjs web
dsh web
```

安装脚本会：

1. 构建浏览器插件，把带内容摘要的 `.tgz` 写到 `~/.local/share/dsh-godbot/packages/`；
2. 安装到指定 profile（上例为 `web`）；
3. 把插件的 DSH 依赖链接到当前运行的 dsh 安装。工具权限依赖同一份作用域注册表，升级或移动 dsh 后重新运行脚本即可重建链接。

运行 `dsh web` 后，使用 DSH 提供的登录入口打开网页，在侧栏选择 **Godbot**，或直接打开 `/#/godbot`。

新建 profile 的团队数据保存在 Godbot 数据目录的 `team-workspace/` 下。已有 profile 继续使用原团队目录，保留会话和工作文件的绝对路径。

### 更新

Godbot 会自己检查新版本。Host 启动后以及之后每 6 小时，它查询本仓库的 [GitHub Releases](https://github.com/renjiegod/dsh-godbot/releases)；发现更新的版本后，把安装包下载到 `~/.local/share/dsh-godbot/packages/`，并按 GitHub 为该文件记录的 SHA-256 校验。安装包内的 `package.json` 还要满足两点才会安装：

- `engines.dsh` 与当前运行的 DSH 版本一致；
- 新版本声明的 DSH 依赖已链接在当前 profile 中。

不满足时，**设置 → 关于 Godbot** 只显示原因（例如需要的 DSH 版本），不会安装。在同一页面的 **自动更新** 中选择行为：

| 模式 | 行为 |
| --- | --- |
| **自动安装**（默认） | 下载并校验后，等 Godbot 连续空闲 2 分钟（没有 Bot 正在运行回合，也没有被接管的原生终端），通过 DSH 插件管理器安装。 |
| **下载后询问** | 下载并校验后，侧栏顶部的云朵按钮和关于页提供 **更新**，由你决定何时安装。 |
| **手动检查** | 只在点击 **检查更新** 时查询；点 **更新** 时再下载并安装。 |

安装后，DSH 能就地重载插件时新版本立即生效；否则（包括 rc.1 返回 `restart-required / package-moved`）页面提示「重启 DSH 后开始使用」，等该 profile 的会话空闲后重启 dsh 即可。只读 Host 不会自动安装，由持有团队写锁的 Host 负责。

- 自动更新只针对 `.tgz` 安装包（`scripts/install-local.mjs` 的安装结果，以及之后的每次更新）。以 `link:` 或文件夹方式安装的开发副本，请在源码目录中更新。
- 预发布版（版本号带 `-`）跟随更新的预发布版，正式版只跟随正式版。
- 管理员可以在该 profile 的 `cordis.patch.yml` 中调整（`updateMode` 只决定尚未选择过模式的 profile）：

```yaml
- id: godbot
  config:
    teamWorkspace:
      updateCheck: false        # 关闭全部检查；也可设置环境变量 GODBOT_UPDATE_CHECK=0
      updateMode: notify        # auto | notify | off
      updateChannel: stable     # stable | prerelease
```

**手动更新。** 让活跃任务收尾，重新运行 `node scripts/install-local.mjs web`，然后在 **插件管理** 中停用并重新启用 `dsh-godbot`，随后刷新浏览器。

## 使用指南

### 团队工作台

从 dsh 侧栏选择 **Godbot**，或打开 `/#/godbot`。团队工作台在当前 dsh 窗口打开，每个 profile 保存自己的成员、群聊和工作目录。在 **设置 → 任务板** 查看任务和工作流，在 **设置 → 定时派工** 管理派工计划。Godbot 侧栏的 ← 按钮返回进入 Godbot 前的 dsh 页面。

- **搭建团队。** 首次进入时选择 GodBot 使用的模型。可以让 GodBot 创建其他 Bot、组建群聊、指派管理员，也可以在侧栏手动创建。每个 Bot 的详情中可设置身份、职责、工作文件夹、权限、模型与推理档位。
- **协作与追踪。** 成员可直接聊天、在群聊中使用 `@成员` 或由管理员调度。群组有独立历史、任务板、待办和阶段目标。运行中可补充消息、处理审批或提问，`/side` 可就当前上下文开旁聊。工作台还提供聊天检索、分段历史、文件与图片、交互卡片和用量统计。
- **记忆与隐私。** 在 Bot 或群聊详情中管理记忆条目、主题、固定、变更历史与撤销，也可以在对话中让 Bot 记住或回忆。私密 Bot 需要独立目录，并受群成员身份和对外分享审批约束；删除后私密目录保护仍有效。CLI 的 shell 和网络访问服从各自运行环境的权限。
- **定时任务与集成。** 设置中可管理计划、共享 MCP、技能、连接器和通讯渠道。计划使用当前 dsh 的调度服务，真实账号连接沿用各服务的授权流程。设备能力以宿主为准：浏览器接管依赖桌面桥，电脑操控需要可用的执行器和系统授权。
- **手机配对。** 在团队设置的「手机」页面填入 WebSocket 中继地址（godbot-server，例如 `wss://relay.example.org/v1/link`），开启访问后，用 Godbot Android App 扫描一次性配对码。管理员也可以通过 `teamWorkspace.phoneRelay` 为新 profile 指定中继，已有配对继续使用之前的中继。中继支持推送时，「推送通知」开着的情况下，手机没连接时也会收到需要你处理的审批、提问和 Bot 回复；通知内容在电脑上加密，中继和 FCM 看不到。同一页面有从中继下载 App 的二维码。

每个 DSH profile 使用自己的 Bot 名单和任务板。首次运行这个版本会清理该 profile 原独立团队的成员、任务、工作流和关联历史；已有的 Bot、群聊、私聊历史和账号配置继续由 Bot 工作区保存。

### 接手 Bot 的原生 Agent

打开 Claude Code、Codex 或 Antigravity 的 Bot 私聊，先在聊天中完成一个回合，然后点击右上角的终端图标（**原生 Agent**）：

| 模式 | 适用场景 |
| --- | --- |
| **原生对话** | 消息输入框，可发送文本或 `/` 命令、查看 CLI 实时输出，也可以展开当前 Bot 已绑定的会话记录。 |
| **原生终端** | 完整的 CLI 界面，可直接使用原生菜单、快捷键和交互工具。 |

两种模式共用这个 Bot 的原生会话 ID、工作目录、运行账号和同一个终端进程，可在面板内随时切换。

- **收起原生 Agent** 保留进程，再次打开时可接回。
- **输出高亮**（终端头部的星形按钮）为 CLI 未着色的输出补充颜色：路径、链接、数字、行内代码、错误与警告、diff 和代码片段。CLI 自己设置的颜色保持不变；开关状态保存在当前浏览器。
- 终端中的网址悬停时显示下划线，按住 ⌘（macOS）或 Ctrl 点击在新标签页打开。
- **交还聊天** 结束该进程，让 Bot 在原会话中继续。若在 CLI 内用 `/new`、`/clear` 或 `/resume` 切换了会话，交还后 Bot 会接回最初绑定的会话。

> [!NOTE]
> 选择任一模式前，请先处理正在运行的回合和待审批项。受宿主强制只读保护的工作区继续在 Bot 聊天中操作。选择 Claude Code 的原生模式时，Godbot 会核对并确认 CLI 提示中的 Bot 工作目录，后续工具调用沿用 Claude Code 的权限设置。

### 输入原生命令

在 Claude Code、Codex 或 Antigravity 的 Bot 私聊中，在输入框开头键入 `/`。继续输入可按命令名筛选，方向键选择，选中后可补参数并发送。命令目录随成员及工作目录切换：

- Claude Code 的项目命令来自本机 CLI；
- Antigravity 使用 ACP 公布的命令；
- Codex 技能按原生 `$技能名` 传入当前线程。

模型选择等交互会打开对应的 Godbot 控件，需要完整终端界面的项目会标注「原生终端」。群聊使用群自身的命令和 `@成员`。

在 Claude Code 私聊中：

- `/usage` 直接显示会话与周额度、重置时间、过去 24 小时和 7 天的使用构成，也可以展开 CLI 原文。**Session** 显示执行该命令时的耗时、代码改动、模型 token 和 API 等价费用。旧消息优先使用保存的命令回执，缺少明细时仅在原生会话中匹配同一条记录。
- `/cost` 查看同一用量报告。
- `/stats` 默认打开 **Stats**，按页面标出的截止日展示本机 Claude Code 缓存的活动统计。

### 给 Bot 分配任务

打开 **设置 → 任务板 → 分配任务**，选择当前 Bot 团队中的负责人，填写任务和验收条件。派工会送入该 Bot 的实际私聊。点击任务上的 Bot 名称可打开对应会话；Bot 回复后，在任务板查看证据、验收或退回。Bot 的名称、模型、账号和工作目录统一在 Bot 设置中维护。

### 可重复运行的多 Bot 工作流

1. 打开 **设置 → 任务板 → 新建工作流**，为每个节点选择负责人，填写任务名称和验收标准。
2. 点选起点后选 **从此节点连线**，再点终点、选择连线条件并添加；也可以用起点和终点下拉框。
3. 保存后点 **运行工作流**。每次运行都有独立的任务、证据和运行 ID，运行记录可以打开原始任务验收。

**示例：** 让调研和分析分别提交证据，将两条线连到审核节点，汇合条件选「全部条件满足」。审核 Bot 的报告经人工验收后，证据包含 `SHIP-OK` 时走发布分支，不包含时走修改分支。把两条分支连到交付节点并选「任一条件满足」，即可收集本次实际执行分支的证据。

- 文本匹配区分大小写。
- 汇合会等所有直接前置节点通过验收或被跳过；前置任务失败时会阻塞下游，可以在任务板重试。
- **导出工作流模板** 保存节点、连线、条件和负责人引用。单独导入工作流时，将引用指向当前 Bot。导出 Bot 团队模板也会包含负责人都在导出范围内的工作流，导入时一起建立对应关系。
- **设置 → 定时派工 → 新建自动化任务** 可以选择已保存的工作流，按固定版本定时执行。编辑工作流后，已有计划继续执行所绑定的版本，可在计划设置中选择新版本。

从外部脚本运行时，展开任务板的 **从 CI 运行** 取得当前工作流的 ID 和版本，使用工作区 CI 凭据执行（凭据签发见 [CI、Webhook 与用量控制](#ciwebhook-与用量控制)）。多次提交同一请求时，沿用同一个请求 ID：

```sh
godbot run --workflow "$WORKFLOW_ID" --revision "$REVISION" --request-id "$CI_JOB_ID" --wait
godbot export "$RUN_ID" --output workflow-evidence.json
```

stdio MCP 的 `run_workflow` 接收 `workflowId`、`revision` 和 `requestId`，沿用 `wait`、`inspect` 和 `export` 查询同一次运行。导出的记录包含当时的流程图、报告和验收回执。

### 自动化任务

Godbot 提供两类自动化入口：

| 入口 | 用途 |
| --- | --- |
| **设置 → 会话定时消息 → 新建任务** | 定时把指令发给一个 Bot 或群聊。使用 DSH 的「自动化任务」插件。 |
| **设置 → 定时派工 → 新建自动化任务** | 定时派工给负责人，要求提交证据并由你验收。每次运行在团队任务板创建独立任务。 |

**定时发送指令。** 选择 Bot 或群聊，填写指令，可指定一次性时间、固定间隔、每天或每周的本地时间，也可以用五字段 Cron 或 iCalendar RRULE。例如选择 `Asia/Shanghai` 和 `0 9 * * 1-5`，就能在工作日上午九点把指令发到该会话。已有计划可以编辑、暂停、恢复或删除。**立即运行** 用于测试指令，原计划继续按自己的时间运行。**投递记录** 可打开对应会话查看回复。

**定时派工与验收。** 选择成员，填写执行要求与验收条件，按一次、间隔、每天或每周派工。展开 **运行记录 → 查看任务** 可追踪进展、补交证据或验收。计划保存最近 50 条运行记录，删除计划后已派发的任务仍可在任务板查看。

调度由本机 Host 执行，浏览器可以关闭。任务板的周期任务在 Host 重启后，会把停机期间错过的时段合并为一次派工，随后回到原周期。手动暂停计划后，恢复时从下一个有效时间开始。

### 工作台收件箱和团队模板

- 左栏的 **工作台收件箱** 汇总当前 Bot 私聊和群聊中可处理的审批与提问。
- 展开 **群聊自动分派** 可让管理员优先的群使用 DSH 模型选择执行者。显式点名优先，判断不明确或模型超时由管理员接手。
- 收件箱里的 **团队模板** 支持导出全部公开成员和群，或只导出所选群。JSON 包含角色、指令、群成员关系、技能名称与计划定义。导入页面先展示预览，确认后生成新 ID。技能清单供目标 owner 核对配置，计划要逐项点击 **启用计划** 才会执行。模板不携带原会话、记忆或连接器授权。

### 查看成员实际使用的连接器

在完整团队中打开一个 Bot 私聊，点聊天标题，在详情中展开 **连接器工具**。这里显示当前模型后端、连接器状态、最近一次工具目录和调用回执。

DSH、Claude Code 和 Codex 成员可从当前会话调用已授权的应用工具，实际操作沿用宿主审批和连接器只读设置。撤销成员授权会对已打开的会话生效。CLI 不能表示某个工具的参数约束时，详情会说明原因。任务使用负责 Bot 的工具和权限配置。

### Bot 的浏览器和桌面

在标准 DSH Web 的完整团队中打开一个 Bot 私聊，选择标题旁的 **浏览器 → 打开执行环境**。默认在 DSH 服务器上按 Bot 启动独立的 Chromium 配置目录。宿主需要有 Chrome 或 Playwright Chromium，也可以通过下方配置的 `executablePath` 指定浏览器绝对路径。

- 面板显示实时画面。点 **接管网页** 后可以点击画面、输入文字、滚动或打开网址。
- **交还给 Bot** 让成员继续操作同一页面。
- 断开面板连接且 20 秒无心跳时，接管权自动释放。

**独立 Linux 桌面。** 要给每个 Bot 分配独立桌面，先在目标 Docker 引擎上构建镜像（在仓库根目录执行；使用云端 Docker context 时，在该 context 上构建或预置同一镜像）：

```sh
docker build -t dsh-godbot-browser:1 src/host/team-runtime/browser-container
```

然后在该 web profile 的 `cordis.patch.yml` 合并 Godbot 配置并重启 Host。`cloudContext` 填写管理员已配置的远程 Docker context，仅使用本机容器时可省略；可按需补充 `containerContext`、`cloudImage` 或 `dockerCommand`。

```yaml
- id: godbot
  config:
    teamWorkspace:
      serverBrowser:
        containerImage: dsh-godbot-browser:1
        cloudContext: my-dedicated-cloud
```

从面板选择 **独立容器** 或 **云端容器**，运行后可在 **网页 / 完整桌面** 之间切换。完整桌面包含 X11、Openbox、Chromium 和终端，每个 Bot 的工作目录 `/profile/work` 随其专属数据卷保留。

Bot 可用 `godbot_desktop_view` 读取当前画面与窗口标识，再用 `godbot_desktop_input` 申请对该窗口进行一次输入，owner 的批准只对该次请求生效。关闭执行环境会结束该 Bot 的进程，其他 Bot 可继续工作。桌面图像、输入和控制权通过 Host 的 owner 接口传输；Docker 通过容器内连接访问 Chromium。

### 网页搜索

Godbot 提供 `auto` 网页搜索，可在 DSH profile 中启用。DSH 按当前 profile 的选择运行 `web_search`：启用 `auto` 后，搜索先尝试当前会话模型线路支持的原生搜索；该线路缺少 API key 或无法搜索时，改用 Bing、DuckDuckGo 的公开结果页。每次结果的 `Search backend` 字段说明实际来源。

DSH Web 0.2.2-rc.1 的网页搜索设置页提供内置 DeepSeek 选项。要选择 `auto`，在该 profile 的 `cordis.patch.yml`（默认 web profile 位于 `~/.dsh/profiles/web/cordis.patch.yml`）合并以下配置并重启 DSH。若已有 `web` 配置，保留原有字段及所选 `fetchProvider`，仅修改 `searchProvider`。该选择适用于该 profile 内使用 DSH `web_search` 的会话。

```yaml
- id: web
  config:
    searchProvider: auto
    fetchProvider: http
```

## 本地 Agent 与沙箱多账号

打开 **设置 → 本地 Agent**。列表按提供商显示本机检测到的 CLI、自定义 ACP 以及已有隔离环境支持的 Agent。点开 Antigravity、Claude Code 或 Codex，即可管理该提供商的本机账号和隔离账号。

- **单账号** 使用本机 CLI。需要多账号时，在此页开启 **启用沙箱多账号**，开关按 DSH profile 保存。
- **添加账号** 时选择已登记的隔离环境，可以填写便于识别的名称。点 **登录** 完成厂商授权，再点 **核验身份** 获取 CLI 返回的登录状态及可用的账号标识。打开列表时读取上次核验结果；主动核验隔离账号时才启动相应虚拟机。
- **设为默认** 后，为新 Bot 选择该提供商时会使用首选账号。也可以给不同 Bot 显式选择不同账号和允许挂载的工作目录，既有会话继续使用已绑定的账号。
- **更多操作** 可以编辑名称、查看目录和登录命令，或将账号从该提供商的列表移出。已登记的环境可以再次添加，账号盘上的厂商登录仍可使用。

### 在沙箱中登录 CLI

在运行 Godbot Host 的机器上查看账号，并在交互终端给需要的 CLI 登录，登录可以在创建第一个聊天前完成。下例使用已登记的账号 ID `sandbox-agy-a`。用本地安装脚本安装时，可通过 `~/.dsh/profiles/web/node_modules/.bin/godbot` 调用该命令。

```sh
godbot sandbox list
godbot sandbox login sandbox-agy-a antigravity
godbot sandbox login sandbox-agy-a claude
godbot sandbox login sandbox-agy-a codex
```

登录与聊天使用同一个 Linux 用户、HOME 和钥匙环。Codex 走原生设备码登录，个人账号或组织须允许该方式。账号沙箱按需启动，聊天使用的 Agent 协议经 SSH stdio 传递，模型请求由 guest 内的官方 CLI 发出。切换账号应新建会话；已绑定的会话在相同账号和工作目录恢复。参考：[Codex 官方登录说明](https://developers.openai.com/codex/auth) · [Claude Code 登录说明](https://code.claude.com/docs/en/authentication)

### 宿主账号清单

Host 按需读取 `~/.local/share/dsh-godbot/sandbox-accounts/<id>.json`，也可以给 Host 和本机 `godbot` 命令设置相同的 `GODBOT_SANDBOX_ACCOUNTS_DIR`。账号目录和 JSON 清单由 Host 用户持有，可分别设为 `0700`、`0600`。公开给 Bot 选择器的只有账号显示名、CLI 类型和授权目录；真实凭据始终交给 guest 内的 CLI 管理。

以下示例描述一台已配置好的 Lima VZ Ubuntu 虚拟机。把示例值换成实际的绝对路径、`/etc/machine-id`、非 root 用户 UID 和挂载源标签。管理脚本由宿主部署提供：

- `start` 启动或复用对应 guest，并使账号钥匙环就绪；
- `ssh` 以该账号用户执行命令，支持 `-T` 或 `-tt`、仅限回环的 `-R`，以及 `--` 后的逐个参数。

Guest 需要 `/usr/bin/python3` 和该用户的 systemd user manager，用于验证挂载与回收 Agent 进程树。

```json
{
  "id": "sandbox-agy-a",
  "name": "沙箱 A",
  "machineId": "0123456789abcdef0123456789abcdef",
  "uid": 1000,
  "start": ["/Users/owner/.local/lib/godbot/vmctl", "start", "a"],
  "ssh": ["/Users/owner/.local/lib/godbot/slot-ssh", "a"],
  "programs": {
    "antigravity": "/usr/local/bin/agy",
    "claude": "/usr/local/bin/claude",
    "codex": "/usr/local/bin/codex"
  },
  "workspaces": [
    {
      "hostPath": "/Users/owner/code/project-a",
      "guestPath": "/mnt/godbot-shared/project-a",
      "filesystem": "virtiofs",
      "source": "lima-0123456789abcdef",
      "readOnly": false
    }
  ]
}
```

### 给现有沙箱增加本机项目

设置里的目录选择器列出清单中的挂载根目录，原生运行接口也接受这些目录下的真实子目录。增加一个项目需要同时配置虚拟机挂载和账号清单。准备好要导出的项目目录，先结束该 VM 中活动的任务和终端，再按以下顺序操作。命令示例使用实例 `a`，`LIMA_HOME` 指向该部署的实例目录，`vmctl` 和 `slot-ssh` 指向上面清单使用的管理脚本。

```sh
vmctl stop a
limactl edit -y --set '.mounts += [{"location":"/Users/owner/code/project-b","mountPoint":"/mnt/godbot-shared/project-b","writable":true}]' a
vmctl start a
slot-ssh a -- findmnt --mountpoint /mnt/godbot-shared/project-b -n -o TARGET,FSTYPE,SOURCE,OPTIONS
```

1. 在该账号的 `workspaces` 追加一项。宿主路径填写真实绝对路径；guest 路径、`filesystem` 和 `source` 填写 `findmnt` 在**精确挂载点**读回的值。只读项目在 Lima 设置 `writable: false`，确认 guest 显示 `ro` 后将清单设为 `readOnly: true`。
2. 运行 `godbot sandbox list` 核对，然后在 Bot 设置中选择该目录。Host 每次启动都会核对 guest 机器身份、用户、挂载点、文件系统、来源和读写属性；路径未登记、挂载缺失或身份变化会在启动时报错。
3. 多个账号协作时，可以导出同一宿主项目供读取。并行修改代码时，为各账号分别导出独立 checkout。普通 Git linked worktree 的 `.git` 文件可能引用宿主的公共 Git 目录，guest 需要独立执行 Git 命令时请使用独立 clone。宿主项目之外的目录始终按单独授权处理。参考：[Lima 文件系统挂载](https://lima-vm.io/docs/config/mount/#virtiofs)

设计与验收细节见 [MULTI_ACCOUNT_DESIGN.md](MULTI_ACCOUNT_DESIGN.md) 和 [MULTI_ACCOUNT_ACCEPTANCE.md](MULTI_ACCOUNT_ACCEPTANCE.md)。

## CI、Webhook 与用量控制

### 签发凭据并从 CI 派工

1. 在「设置 → 任务板 → CI 与 Webhook」给当前团队签发凭据，按用途勾选派工、查看与等待、导出证据。凭据可覆盖当前 Bot 工作区，也可以限定到单个 Bot 或群聊；每个团队可单独撤销。
2. 将只显示一次的凭据写入 CI 的 secret 文件，设置 `GODBOT_URL` 为面板显示的地址，`GODBOT_TOKEN_FILE` 指向该文件。
3. 插件的 npm 包自带 `godbot` 命令，客户端可通过 `npm install <插件包.tgz>` 安装，再用 `npx --no-install godbot` 运行。Host 只在同机回环地址监听，远程 CI 可以通过受控隧道连接。

```sh
godbot run --bot "$BOT_ID" --title "复核本次变更" --criteria "提交测试结果和结论" --request-id "$CI_JOB_ID"
godbot wait "$RUN_ID" --timeout 120
godbot inspect "$RUN_ID"
godbot export "$RUN_ID" --output evidence.json
```

- 工作区凭据可用 `--bot` 指定 Bot 名称或 ID，省略时由团队负责人接单；`--member` 是同一参数的别名。绑定单个 Bot 或群聊的凭据直接使用已授权目标，运行时省略这两个参数。
- `run` 的 JSON 输出给出 `runId`。同一身份重复发送相同的请求 ID 和内容，会收到原运行 ID。
- `wait` 追踪负责人和下游任务，可用原 ID 继续等待。`export` 导出证据文本、版本及验收回执。
- 使用外部 MCP 客户端时，配置 stdio 命令 `godbot mcp` 和同一组环境变量。CLI 和 stdio MCP 可按同一个运行 ID 查看状态和证据。
- 在「CI 与 Webhook」面板可以验收指定目标的回报或要求返工。Bot 转为私密后，相关外部访问会关闭。

`godbot wait` 的退出码：

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部已验收 |
| `1` | 失败或已停止 |
| `2` | 输入或授权错误 |
| `3` | 需要审批、补证据或人工验收 |
| `4` | 等待超时 |
| `5` | 需要核对原生执行结果 |

### Webhook

在任务板选择成员，填写固定任务和验收标准，将生成的 URL 和密钥交给事件发送方。发送 JSON 时：

- `X-Godbot-Delivery`：稳定的投递 ID；
- `X-Godbot-Signature`：`HMAC-SHA256(secret, deliveryId + "\n" + 原始请求体)` 的小写十六进制值。

有效请求返回 HTTP 202 和运行 ID。暂停触发器后停止接收新事件。

**GitHub 事件。** GitHub 公开仓库也可在此订阅仓库和事件类型，由 Host 轮询官方事件列表。默认从订阅时的游标开始；勾选「创建时处理最近一条匹配事件」可取回一个已有事件来核对执行结果。

### 用量上限与备用模型

打开「设置 → 用量 → 用量上限与备用模型」，选择整个 profile 或单个 Bot，可设置 UTC 日、月 token 与估算美元门槛。美元值使用配置的每百万 token 费率，界面单列未定价调用和未报告用量。

- 达到上限后，新工作延迟派发，已经启动的任务可以结束；手动任务是否也受限制由「达到上限时暂停」决定。
- 使用 DSH 模型路由时，可给成员指定一个已配置的 API 备用模型。只有 Host 收到明确的额度拒绝、且本次请求尚无输出时，才会切到备用模型；到供应商给定的时间再试原路由，未给时间时一分钟后重试。

## 与同事共享工作区

在「设置 → 任务板」展开 **多人共享与审计**，为每位同事创建个人邀请，再为该身份选择资源及权限并保存。对方从个人邀请进入单独的共享页面。邀请只能兑换一次，有效期 15 分钟；登录会话有效期 7 天。可以给该人生成新的设备邀请，或立即撤销此人的所有登录。

| 权限 | 范围 |
| --- | --- |
| **查看** | 读取获准成员或群聊的历史、搜索、下载附件和导出会话证据。 |
| **聊天** | 另可发送消息或上传附件（每个最多 2 MiB）。 |
| **管理与审批** | 处理对应资源的工具审批和该 Bot 已报告的任务。 |

- 每种资源单独授权，可选择普通 Bot 或群聊。Bot 转私密后，其私聊及仍包含它的群从共享入口撤下。共享会话时，历史消息和曾经在该会话分享的材料也对获准人可见。
- 共享导出的内容包括该对话的历史消息和证据。邀请及登录凭据由身份服务保管。完整团队中由 Bot 交付的本机文件，须仍在获准资源的公开工作目录中才能下载；修改工作目录、文件指向或撤权后，旧下载地址会重新检查。
- 共享用户通过自己的配对身份操作，服务端记录授权变化、聊天、上传、导出、验收和审批，owner 可在同一面板查看审计。授权成员聊天会使用该成员已配置的模型、工具与执行权限。
- 默认邀请使用本机回环地址。同事从其他设备访问时，可由运维配置 HTTPS 反向代理，把共享站点的 `/share/` 转发到界面显示的本机监听端口，并将 Godbot 插件配置的 `automation.publicUrl` 设为该 HTTPS 站点的来源地址，保留对应 Host 头。

## 加密备份和换机

先结束活动任务，关闭使用源或目标 DSH 数据目录的 Host。目标 profile 需先安装并启动一次 Godbot。

备份包含 Bot 任务与工作流数据库、完整团队状态和记忆、所属的 DSH v4 JSONL 会话、引用的附件，以及工作台创建的工作目录。文件使用 scrypt 派生密钥和 AES-256-GCM 加密，命令会输出归档的 SHA-256。密码文件应只允许本人读取。

```sh
godbot workspace backup  --home /old/dsh --profile web --file team.godbot --password-file /private/backup-key
godbot workspace restore --home /new/dsh --profile web --file team.godbot --password-file /private/backup-key --map /old/project=/new/project
```

- 每个外部项目可指定一次 `--map`。备份格式为 v2，覆盖 Bot 团队和任务板。项目目录在目标机器上准备好后，可以用路径映射恢复会话。
- **需要在目标机重新配置：** 注册的自定义 CLI、CLI 登录、MCP 授权、浏览器登录态、CI 令牌和真人会话。
- 恢复会保留共享附件和审计记录，并清空真人权限，暂停计划与 GitHub 订阅。Claude、Codex、Antigravity 和自定义 ACP 的原生会话还依赖各工具在目标机可访问的会话存储。
- **中断恢复：** 关闭目标 Host，运行 `godbot workspace recover --home /new/dsh --profile web`。
- **回滚：** 完成恢复后可用 `godbot workspace rollback --home /new/dsh --profile web` 回到该次恢复前的工作台，回退会撤销恢复后在目标工作台产生的修改。
- 自定义了 Godbot `stateDir` 的 profile，需给每条命令加 `--state-dir`。

## 命令行速查

| 命令 | 用途 |
| --- | --- |
| `godbot sandbox list` | 列出已登记的沙箱账号 |
| `godbot sandbox login <账号ID> <antigravity\|claude\|codex>` | 在沙箱账号内登录对应 CLI |
| `godbot run --bot <Bot> --title … --criteria …` | 给 Bot 派工 |
| `godbot run --workflow <ID> --revision <版本>` | 运行指定版本的工作流 |
| `godbot wait <runId>` | 等待运行结束，退出码见上表 |
| `godbot inspect <runId>` | 查看运行状态 |
| `godbot export <runId> --output <文件>` | 导出证据、版本和验收回执 |
| `godbot mcp` | 以 stdio MCP 服务运行 |
| `godbot workspace backup\|restore\|recover\|rollback` | 加密备份、恢复、中断恢复与回滚 |

常用环境变量：

| 变量 | 用途 |
| --- | --- |
| `GODBOT_URL` | CI 访问的 Godbot 地址 |
| `GODBOT_TOKEN_FILE` | 保存 CI 凭据的 secret 文件路径 |
| `GODBOT_SANDBOX_ACCOUNTS_DIR` | 自定义沙箱账号清单目录 |
| `GODBOT_UPDATE_CHECK` | 设为 `0` 时 Host 不检查、不下载、不安装更新 |
| `GODBOT_UPDATE_API` | 从另一个与 GitHub API 同形的服务读取发布列表（测试用）；安装包仍按其声明的 SHA-256 校验 |
| `GODBOT_E2E_CLAUDE_CONFIG_DIR` / `GODBOT_E2E_CODEX_HOME` | 真实 E2E 测试使用的账号目录 |

## 故障排查

| 现象 | 处理 |
| --- | --- |
| **CLI 启动失败** | 以运行 DSH 的系统用户检查 `codex --version`、`claude --version` 或 `agy --version` 及登录状态，然后在该 Bot 的私聊重试。登录和授权交给原生 CLI，无需把订阅凭据填入团队聊天。 |
| **会话中断或投递状态待核对** | 先用原生会话 ID 检查历史与工作区，再决定是否重发。原会话无法恢复时，用交接摘要新开会话，保留新旧会话的关联。刷新浏览器会从 Host 重新读取状态。 |
| **终端仍控制会话** | 在该 Bot 的原生面板点击「交还聊天」。终端确认退出后，等待中的 Bot 消息才会继续。 |
| **DSH 模型报错** | 查看成员实际使用的 provider、model、HTTP 状态和错误信息，也可在普通 dsh 会话中用同一路由对照。确认另一条路由可用后，可在空闲成员面板显式切换。 |
| **侧栏缺失或连接失败** | 核对当前 profile 的插件状态、DSH 版本与 owner 登录。默认状态目录为 `$DSH_HOME/godbot/<profile>`，使用默认 home 时位于 `~/.dsh/godbot/<profile>`。 |
| **`GODBOT_STATE_IN_USE`** | 每个状态目录只允许一个 Host 持有。核对已有 Host；两个独立实例应使用不同的状态目录。 |
| **自动更新失败** | 原因显示在「设置 → 关于 Godbot」，Host 诊断日志也有记录。下载失败会在 30 分钟后自动重试；安装由 DSH 插件管理器执行，`spawn pnpm ENOENT` 表示运行 dsh 的环境里找不到 pnpm，需把 pnpm 加入该环境的 `PATH`（或为插件管理器配置 `pnpmCommand`）后点「重试」。自动安装失败的版本不会再自动重试。 |

## 开发与验证

```sh
npm ci
npm run build
npm test
npm pack --dry-run
```

构建会生成手机链路（`src/link` → `src/host/team-runtime/mobile-link.js`）、浏览器入口和 Host 构建标识，三者都要和源码一起提交；`npm run typecheck` 检查 `src/link` 的类型。常规测试使用本地夹具，覆盖协议回执、迟到事件、工作区、审批和任务依赖。

| 命令 | 说明 |
| --- | --- |
| `npm test` | 单元与集成测试 |
| `npm run test:e2e` | 浏览器端到端测试，默认 `release` 套件；可加 `--artifact <tgz>` 测试指定安装包 |
| `npm run test:e2e -- --case E12 --previous <tgz>` | 升级测试：从指定的旧版安装包升级到当前构建。未传 `--previous` 且仓库中没有 0.1.0 基线提交时，E12 记为 `skipped` |
| `npm run test:e2e -- --case UPDATE` | 自动更新：从本机模拟的发布列表下载、校验新版本，经 DSH 插件管理器安装，重启后运行新版本 |
| `GODBOT_RELAY_BIN=<godbot-relay> npm run test:e2e -- --case PHONE` | 手机链路：经 godbot-server 中继配对、调用团队接口、交换推送密钥，离线时经（模拟的）FCM 收到加密推送，移除后无法再连。未设置 `GODBOT_RELAY_BIN` 时记为 `skipped` |
| `GODBOT_RELAY_BIN=<godbot-relay> npm run test:e2e -- --case PHONE-PAGES` | 手机 App 的每个页面经加密链路各做一次读和一次写（Bot、群、记忆、日程、工作文件夹、用量、Bot 浏览器、密钥、模型服务商、连接器、能力、更新、诊断、侧聊），写入都在电脑上核对 |
| `GODBOT_RELAY_BIN=<godbot-relay> node test/e2e/phone-host.mjs` | 常驻的测试宿主：隔离的 Godbot、中继和一个本地控制接口，给手机 App 的 UI 测试用（打印配对链接） |
| `GODBOT_RELAY_BIN=<godbot-relay> GODBOT_ANDROID_E2E=<godbot-app> npm run test:e2e -- --case PHONE-ANDROID` | 真机流程：模拟器上的 Godbot Android App 扫码配对、加载团队、给主 Bot 发消息并显示回复。需要已构建的 App 和一台运行中的模拟器 |
| `npm run test:e2e -- --case E1` | 验证跨后端读取连接器工具 |
| `npm run test:e2e -- --case E2` | 验证写入审批、撤权、重启和终端交还 |
| `npm run test:e2e -- --suite live-connectors` | 通过本机已登录的 Claude Code、Codex 调用测试工单服务 |
| `npm run test:e2e -- --suite live-routines` | 在临时 DSH 工作区中验证定时任务：群聊双成员回复、Bot 会话定时投递、重启后的运行记录 |
| `node test/external/live-control.mjs codex` | 对新 CLI 版本做真实插话验证，参数可换成 `claude` 或 `antigravity` |

> [!WARNING]
> `live-*` 套件和 `test/external/live-control.mjs` 使用本机已登录的账号，会消耗对应订阅或模型额度。测试用的 DSH profile 和工单数据均为临时创建。`L-BOT-WORKFLOW` 可通过 `GODBOT_E2E_CLAUDE_CONFIG_DIR` 和 `GODBOT_E2E_CODEX_HOME` 指定测试账号目录。

仓库的 GitHub Actions（`.github/workflows/verification.yml`）在每次 push 和 Pull Request 时于 macOS 上运行单元测试、构建和 `npm pack --dry-run`。对打包产物执行 `release` E2E 套件耗时较长，需在 Actions 页面选择 **Verify Godbot package → Run workflow** 手动触发。

### 发布新版本

1. 修改 `package.json` 的 `version`，运行 `npm run build` 并提交。
2. 推送同名 tag，例如 `git tag v0.2.0 && git push origin v0.2.0`。
3. `.github/workflows/release.yml` 核对 tag 与 `package.json` 版本一致，运行测试和构建，再创建 GitHub Release 并上传 `dsh-godbot-<version>.tgz` 及其 `.sha256`。版本号带 `-`（如 `0.2.0-rc.4`）时标记为预发布。

已安装的 Godbot 会在下一次检查时发现这个版本（见 [更新](#更新)）。

## 相关文档与第三方声明

| 文档 | 内容 |
| --- | --- |
| [FEATURE_PARITY.md](FEATURE_PARITY.md) | 功能对照与验证范围 |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | 架构与实现计划 |
| [MULTI_ACCOUNT_DESIGN.md](MULTI_ACCOUNT_DESIGN.md) | 沙箱多账号设计 |
| [MULTI_ACCOUNT_ACCEPTANCE.md](MULTI_ACCOUNT_ACCEPTANCE.md) | 沙箱多账号验收记录 |
| [VERIFICATION.md](VERIFICATION.md) | 发布候选版本验证记录 |

复用组件、原始版权和修改范围见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)，相关许可证全文位于 [`licenses/`](licenses/)。

## 许可证

本项目以 [MIT 许可证](LICENSE) 发布。其中来自第三方的部分（例如源自 DS-Bot 的代码，使用 Apache-2.0）继续沿用各自的许可证，详见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。
