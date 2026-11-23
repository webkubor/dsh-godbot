<p align="center">
  <img src="https://raw.githubusercontent.com/webkubor/nativecrew/nativecrew-v0.2.0-rc.28/icon.svg" alt="NativeCrew 标志" width="72" height="72">
</p>

<h1 align="center">NativeCrew（原生协作）</h1>

<p align="center"><strong>在 DeepSeek Harness 里，让你的原生 Agent 自己分工、交接任务、提交结果。</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dsh-plugins/nativecrew"><img alt="npm 版本" src="https://img.shields.io/npm/v/%40dsh-plugins%2Fnativecrew?style=for-the-badge&amp;logo=npm&amp;color=B54425"></a>
  <a href="https://github.com/webkubor/nativecrew/actions/workflows/verification.yml"><img alt="构建验证" src="https://img.shields.io/github/actions/workflow/status/webkubor/nativecrew/verification.yml?branch=main&amp;style=for-the-badge"></a>
  <a href="https://github.com/webkubor/nativecrew/blob/main/LICENSE"><img alt="MIT 许可" src="https://img.shields.io/badge/license-MIT-555?style=for-the-badge"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness 插件" src="https://img.shields.io/badge/DSH-Plugin-91462D?style=for-the-badge"></a>
</p>

<p align="center"><a href="https://github.com/webkubor/nativecrew/blob/main/README.en.md">English</a> · <a href="#安装">安装</a> · <a href="#实机演示">实机演示</a></p>

## 为什么用 NativeCrew

| 你要做什么 | 手动协调多个 CLI | 用 NativeCrew |
| --- | --- | --- |
| 自动把任务交给下一个 Agent | ❌ 手动复制要求和结果 | ✅ 工作流按负责人和条件派工 |
| 从同一处追溯交付 | ❌ 回不同终端找对话和输出 | ✅ 从任务板打开负责人的会话和报告 |
| 给各成员配置隔离环境 | 手动维护不同运行环境 | ✅ 为 Bot 绑定已配置的沙箱账号和授权目录 |

- 🔌 **原生会话。** Codex 走 app-server，Claude Code 走 stream-json，Antigravity 走 ACP。各 CLI 负责自己的登录与模型请求。
- 📋 **可验收的自动派工。** 节点带负责人和验收条件。成员在各自会话中执行并回报，任务板支持验收和退回。
- 🔒 **按成员隔离。** 给需要隔离的成员绑定独立账号、会话和允许挂载的项目目录。使用范围遵循厂商对所选账号和认证方式的授权。

## 安装

在 DSH 打开 **插件 → 添加插件**，粘贴下面的包名，安装并启用。然后点侧栏的 **NativeCrew**。

```text
@dsh-plugins/nativecrew
```

已在 **macOS · DSH Web `0.2.2-rc.5`** 验证。需要接入原生 Agent 时，再安装对应 CLI 并完成厂商登录。其他 DSH 版本以插件管理器的兼容性提示为准。

## 实机演示

比如要交付一个页面，可以让 Codex 实现、Claude Code 审查，再在 DSH 里打开负责人的会话核对证据。

![NativeCrew 的任务板显示负责人、验收条件、回报证据和验收按钮](https://raw.githubusercontent.com/webkubor/nativecrew/main/assets/task-board-terracotta.png)

截图取自 DSH Web 中运行的 NativeCrew 开发构建，展示仓库当前的陶橙主题。示例任务由本地测试模型回报，同一界面可打开负责人的会话并验收结果。

**试一项任务。** 打开 **设置 → 任务板 → 分配任务**，选一个已配置的 Bot，写清交付内容与验收条件。收到回报后，在任务板查看证据并点验收。相同任务需要反复执行时，可保存为工作流。

## 文档与反馈

- [工作台参考](https://github.com/webkubor/nativecrew/blob/main/docs/workbench-reference.md)涵盖沙箱、工作流、自动化、命令行和备份迁移。
- [验证记录](https://github.com/webkubor/nativecrew/blob/main/VERIFICATION.md)说明测试范围。[报告问题](https://github.com/webkubor/nativecrew/issues)时，请带上 DSH 和插件版本。
- [MIT License](https://github.com/webkubor/nativecrew/blob/main/LICENSE) · [上游项目与第三方许可](https://github.com/webkubor/nativecrew/blob/main/THIRD_PARTY_NOTICES)
