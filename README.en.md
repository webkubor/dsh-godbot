<p align="center">
  <img src="https://raw.githubusercontent.com/webkubor/nativecrew/nativecrew-v0.2.0-rc.28/icon.svg" alt="NativeCrew logo" width="72" height="72">
</p>

<h1 align="center">NativeCrew</h1>

<p align="center"><strong>Give your native agents a team in DeepSeek Harness. Assign work, hand it off, and review the results.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dsh-plugins/nativecrew"><img alt="npm version" src="https://img.shields.io/npm/v/%40dsh-plugins%2Fnativecrew?style=for-the-badge&amp;logo=npm&amp;color=B54425"></a>
  <a href="https://github.com/webkubor/nativecrew/actions/workflows/verification.yml"><img alt="Build verification" src="https://img.shields.io/github/actions/workflow/status/webkubor/nativecrew/verification.yml?branch=main&amp;style=for-the-badge"></a>
  <a href="https://github.com/webkubor/nativecrew/blob/main/LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-555?style=for-the-badge"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness plugin" src="https://img.shields.io/badge/DSH-Plugin-91462D?style=for-the-badge"></a>
</p>

<p align="center"><a href="https://github.com/webkubor/nativecrew">中文</a> · <a href="#install">Install</a> · <a href="#see-it-in-dsh">See it in DSH</a></p>

## Why NativeCrew

| What you need | Coordinating CLI sessions by hand | With NativeCrew |
| --- | --- | --- |
| Hand off work automatically | ❌ Copy requirements and results between terminals | ✅ Assign workflow steps by owner and condition |
| Review a delivery in one place | ❌ Find the output and conversation in separate terminals | ✅ Open the owner's conversation and report from the task board |
| Isolate accounts and project files per member | Maintain separate environments yourself | ✅ Bind a Bot to a configured sandbox account and allowed directories |

- 🔌 **Native sessions.** Codex uses app-server, Claude Code uses stream-json, and Antigravity uses ACP. Each CLI handles its own sign-in and model requests.
- 📋 **Delegation with review.** Assign owners and acceptance criteria. Agents run in their own conversations and report back. Review the evidence on the task board and accept or return the work.
- 🔒 **Isolation per Bot.** Bind members to their own configured sandbox account, session, and approved project directories. Provider terms apply to each account and authentication method.

## Install

Open **Plugins → Add plugin** in DSH, paste the package name below, and install and enable it. Open **NativeCrew** from the sidebar.

```text
@dsh-plugins/nativecrew
```

Verified on **macOS with DSH Web `0.2.2-rc.5`**. To connect a native agent, install and sign in to its CLI. For other DSH versions, check compatibility in the plugin manager.

## See it in DSH

For a page delivery, have Codex implement it and Claude Code review it. Open the assigned agent's conversation in DSH to check the evidence.

![The NativeCrew task board shows the owner, acceptance criteria, submitted evidence, and review controls](https://raw.githubusercontent.com/webkubor/nativecrew/main/assets/task-board-terracotta.png)

This screenshot shows the current NativeCrew development build with the terracotta theme in DSH Web. The interface language is Chinese. A local test model submitted the sample report through the actual task flow.

**Try one assignment.** Open **Settings → Task board → Assign task**, pick a configured Bot, and add acceptance criteria. When the Bot reports back, review its evidence on the board. Save repeated assignments as a workflow.

## Documentation and feedback

- [Workbench reference (Chinese)](https://github.com/webkubor/nativecrew/blob/main/docs/workbench-reference.md) covers sandboxes, workflows, automation, CLI commands, and migration.
- See the [verification notes](https://github.com/webkubor/nativecrew/blob/main/VERIFICATION.md) for test coverage. Include your DSH and plugin versions when you [report an issue](https://github.com/webkubor/nativecrew/issues).
- [MIT License](https://github.com/webkubor/nativecrew/blob/main/LICENSE) · [Upstream and third-party notices](https://github.com/webkubor/nativecrew/blob/main/THIRD_PARTY_NOTICES)
