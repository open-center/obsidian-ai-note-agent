# AI Note Agent Legacy

> Retired community entry (`notewright`). Development continues in [AI Note Agent](https://github.com/open-center/ai-note-agent), using ID `ai-note-agent` and a separate version series starting at `1.0.0`.
>
> Download the [new 1.0.0 release](https://github.com/open-center/ai-note-agent/releases/tag/1.0.0) and follow the [settings migration guide](https://github.com/open-center/ai-note-agent#moving-from-notewright-to-ai-note-agent). Old releases remain available for existing users.
>
> 旧社区条目 `notewright` 已归档，后续开发迁移到上述新仓库。新版使用 `ai-note-agent`，版本从 `1.0.0` 开始；迁移前请备份旧插件设置。

Chat with OpenAI, Claude, DeepSeek or any OpenAI-compatible model in an Obsidian sidebar, and let it act as an agent that reads, searches, creates and edits your notes — with a diff preview and one-click undo for every change.

[中文说明](#中文说明)

## Features

- **Many providers**: OpenAI (Responses API, including reasoning models), Anthropic Claude, DeepSeek, Google Gemini (OpenAI-compatible endpoint), Moonshot/Kimi, Qwen (DashScope), Zhipu GLM, SiliconFlow, OpenRouter, local Ollama, and any OpenAI-compatible endpoint. Configure several and switch from the panel header.
- **Agent tools** the model can call:

  | Tool | What it does |
  |---|---|
  | `get_current_note` | Read the active note and the current selection |
  | `read_note` / `list_files` / `search_notes` | Read, browse and full-text search the vault |
  | `edit_note` | Exact find-and-replace edits (preferred way to change notes) |
  | `write_note` / `create_note` / `append_to_note` | Rewrite, create, or append (optionally under a heading) |
  | `move_note` / `delete_note` / `create_folder` | Move/rename (links are updated), delete (respects your trash setting), create folders |
  | `list_commands` / `run_command` | List and run Obsidian commands |
  | `list_plugins` / `set_plugin_enabled` | List core and community plugins; enable or disable them |
  | `get_settings` / `update_settings` / `open_settings` | Read and change Obsidian and plugin settings; open a settings tab |
  | `get_system_info` / `open_app` / `open_with_default_app` / `run_shell_command` | Desktop only, off by default: launch local apps, open files / URLs with the default app, run shell commands (AppleScript via `osascript` on macOS) |

- **Attachments**: use 📎 (files) or 📁 (folder) under the input box, paste, or drag and drop. Images are sent to the model directly (needs a vision model). PDFs (via Obsidian's built-in pdf.js), Word / PowerPoint / Excel files (`.docx`, `.pptx`, `.xlsx`) and plain-text files are converted to text locally. `read_note` can also read PDFs and Office files that are already in your vault.
- **Control Obsidian** (setting **允许控制 Obsidian**, on by default): the agent can run commands, enable or disable plugins, and read and change Obsidian and plugin settings. Changes follow the permission mode and can be undone from the chat; secret-looking fields are masked before settings are shown to the model; the agent cannot control this plugin itself.
- **Control local software** (setting **允许控制本地软件**, off by default, desktop only): the agent can launch apps, open files and URLs, and run shell commands. In manual mode every action shows the exact command and runs only after you confirm it. Commands run with your user permissions.

- **Multiple conversations**: only **+ 新对话** in the tab bar creates a new conversation; whatever you type always goes to the selected tab. Conversations run in parallel; you can switch away while one is working and it keeps going in the background. Each tab shows its state (running, finished, error, stopped), and you get a notice when a background conversation finishes.
- **Queued follow-ups**: while a conversation is running, messages you send to it are queued (shown above the input, each can be withdrawn) and delivered to the agent as soon as the current step finishes, so you can add instructions without stopping the task. Clicking **发送** on a queued message stops the current task and runs that message right away as a new request. If the task is stopped, undelivered messages go back into the input box.
- **Automatic retry**: rate limits (HTTP 429), overloaded or failing servers (5xx) and network errors are retried automatically, waiting as long as the server asks (up to 10 retries, at most 60 s each). The status bar shows the countdown, and Stop cancels the wait. Quota or billing errors are reported immediately.
- **Context compression** (setting **自动压缩上下文的阈值**, default 80k tokens, 0 turns it off): long conversations are compacted automatically to keep each request small and avoid rate limits. Above half the threshold, older tool results and attachments are shortened and old images and reasoning data are dropped; above the threshold, older messages are summarized by the model while recent messages and the latest tool results stay verbatim. A divider in the chat shows when this happened.
- **Sub-agents** (setting **允许派出子代理**, on by default): the agent can split a large task into independent sub-tasks and hand them to up to 6 sub-agents that run in parallel, then combine their reports. Each sub-agent's progress and tool calls appear live in the chat, with their own Undo buttons.
- **Live status**: while a task runs, a status bar above the input shows the current step, elapsed time and number of tool calls with an animated progress line; when it ends it shows whether it finished, failed or was stopped.
- **Permission modes** (dropdown at the bottom of the chat panel, or in settings): **手动确认** (manual) asks before every action; **按授权执行** (grant) runs the action types you have authorized and asks for the rest; **自动执行** (auto) runs everything without asking. Clicking **始终允许此类操作** in a confirmation dialog authorizes that action type (notes, moves, deletes, Obsidian commands, plugins, settings, opening apps, shell commands) and switches to grant mode. Authorizations can be revoked in settings.
- **Safe by default**: manual mode is the default, every write shows a diff, and every change has an **Undo** button in the chat.
- The active note and selected text are passed as context (toggle with one click).
- Right-click selected text → **Send to AI Agent**.
- Shows the model name actually returned by the API and token usage under each reply.
- Panel can sit in the right sidebar (split with the outline), the left sidebar, or the editor area.
- Settings are searchable from Obsidian's settings search (Obsidian 1.13+). Each provider has its own settings page; providers without an API key are flagged.

> The current UI is in Simplified Chinese.

## Requirements and disclosures

- **Account / payment**: you need your own API key from at least one model provider (for example OpenAI, Anthropic or DeepSeek). Most providers charge per token. A local Ollama server works without any key or payment.
- **Network use**: the plugin sends requests **only** to the API endpoint(s) you configure, using Obsidian's `requestUrl`. Depending on your configuration this can be `api.openai.com`, `api.anthropic.com`, `api.deepseek.com`, `generativelanguage.googleapis.com`, `api.moonshot.cn`, `dashscope.aliyuncs.com`, `open.bigmodel.cn`, `api.siliconflow.cn`, `openrouter.ai`, a local Ollama server (`localhost:11434`), or any custom URL you enter. It is needed to send your messages to the model and receive its replies.
- **What is sent**: your chat messages, the path of the active note and the selected text, the content of any attachments you add, the content of any notes the model chooses to read through the tools above, and the output of local commands you approved. Nothing is sent until you press Send.
- **No telemetry, no ads, no third-party servers.** The plugin has no backend of its own.
- **Storage**: on Obsidian 1.11.4+ API keys are kept in Obsidian's secret storage (the operating system's keychain), not in the plugin's `data.json`, so they are not synced or published with your vault; on another device, enter the key once more. Keys saved by earlier versions are moved there automatically. On older Obsidian versions keys fall back to plain text in `data.json`; exclude that file if you sync or publish your vault.
- **File access**: the plugin reads and writes files inside your vault. It reads files outside your vault only when you add them as attachments yourself, or when you approve a local command that does so. Attachments are kept in memory for the current chat only.

## Installation

From the community directory: **Settings → Community plugins → Browse**, search for **AI Note Agent**, install and enable.

Manual install: download `main.js`, `manifest.json` and `styles.css` from the latest [release](../../releases) into `<vault>/.obsidian/plugins/notewright/`, then enable the plugin.

## Usage

1. Open **Settings → AI Note Agent**, add a provider, paste your API key, click **选择模型** (choose model), then **测试连接** (test connection).
2. Click the robot icon in the ribbon to open the chat panel.
3. Ask things like "Summarize this note and insert the summary at the top" or "Add a todo under ## Tasks".

The model must support tool (function) calling.

## Development

```bash
npm install
npm run dev      # watch mode
npm run build    # type-check + production build
npm run lint     # Obsidian's official ESLint rules
```

Releases are built by GitHub Actions: bump the version with `npm version patch|minor|major`, push the tag, and publish the draft release that the workflow creates.

## Author

zhang33 · [zyb@zhang33.net](mailto:zyb@zhang33.net) · part of [OpenCenter](https://github.com/open-center)

## License

[MIT](LICENSE)

---

## 中文说明

**AI Note Agent**：在 Obsidian 侧边栏里和大模型对话，并让它像 Agent 一样**直接读取、搜索、新建和修改你的笔记**。每次修改都有差异预览和一键撤销。

### 功能

- **多家模型**：OpenAI（Responses 接口，支持推理模型）、Anthropic Claude、DeepSeek、Google Gemini、Kimi、通义千问、智谱 GLM、硅基流动、OpenRouter、本地 Ollama，以及任何 OpenAI 兼容接口。可配置多个，在面板顶部切换。
- **Agent 工具**：读取当前笔记和选中文本、读取/浏览/全文搜索、精确局部修改、重写/新建/追加（可追加到指定标题下）、移动（自动更新双链）、删除（遵循你的回收站设置）、新建文件夹。
- **附件**：输入框下方 📎 添加文件 / 📁 添加文件夹，也可以粘贴或拖拽。图片直接发给模型（需要模型支持识图）；PDF（使用 Obsidian 内置 pdf.js）、Word / PowerPoint / Excel（`.docx`、`.pptx`、`.xlsx`）和文本文件在本地转换为文字。`read_note` 也能读取仓库里的 PDF 和 Office 文件。
- **控制 Obsidian**（设置项「允许控制 Obsidian」，默认开启）：Agent 可以执行 Obsidian 命令、启用或停用核心插件和第三方插件、读取和修改应用及插件设置。改动按权限模式确认，并可在聊天中撤销；疑似密钥的设置项会打码后再给模型；不能控制本插件自身。
- **控制本地软件**（设置项「允许控制本地软件」，默认关闭，仅桌面版）：Agent 可以启动本地应用、用默认程序打开文件或网址、执行 shell 命令（macOS 上可通过 `osascript` 执行 AppleScript）。手动模式下每次操作都会先弹窗显示具体命令，确认后才执行；命令以你的用户权限运行。
- **多对话并行**：只有点标签栏右侧的「+ 新对话」才会新建对话，输入的内容永远发给当前选中的标签。多个对话可以同时运行；切到别的标签后，原来的任务会在后台继续执行。标签上会显示状态（运行中、已完成、出错、已停止），后台任务完成时会弹出提示。
- **消息排队**：对话运行中，往这个对话发送的消息会排队（显示在输入框上方，可逐条撤回），当前步骤一完成就送达 Agent，不用停止任务就能补充说明。在排队列表里点某条的「发送」，会停下当前任务，立即把这条作为新需求执行。任务被停止时，未送达的消息会退回输入框。
- **自动重试**：遇到限流（HTTP 429）、服务繁忙或服务器出错（5xx）、网络异常时自动等待后重试，等待时间优先按服务器的建议（最多重试 10 次，每次最多等 60 秒）。状态条会显示倒计时，点「停止」可随时取消。额度用完、需要充值这类错误会直接提示，不会重试。
- **上下文压缩**（设置项「自动压缩上下文的阈值（token）」，默认 8 万，填 0 关闭）：对话变长后自动压缩，减少每次请求的 token、避免触发限流。超过阈值的一半时，截短较早的工具结果和附件，去掉较早的图片和推理数据；超过阈值时，把较早的对话交给模型总结成摘要，最近的消息和最新的工具结果保留原文。聊天里会出现一条分隔提示。
- **子 Agent**（设置项「允许派出子代理」，默认开启）：Agent 可以把大任务拆成互相独立的子任务，最多同时派给 6 个子 Agent 并行执行，完成后汇总结果。每个子 Agent 的进度和工具调用会实时显示在聊天里，改动同样可以撤销。
- **实时状态**：任务运行时，输入框上方的状态条会显示当前步骤、已用时间和工具调用次数，并带有进度动画；结束后会显示已完成、出错还是已停止。
- **权限模式**（聊天面板底部的下拉框，或设置页）：「手动确认」每次操作都弹窗询问；「按授权执行」对已授权的操作类型直接执行，其余仍询问；「自动执行」所有操作直接执行，不再询问。在确认弹窗中点「始终允许此类操作」，会授权这一类操作（修改笔记、移动、删除、Obsidian 命令、插件开关、设置、打开应用、shell 命令）并切换到「按授权执行」。授权可以在设置中收回。
- **安全**：默认是手动确认，修改会显示差异对比；聊天里每次修改都有「撤销」按钮。
- 自动把当前笔记和选中文本作为上下文；右键选中文本可「发送给 AI Agent」。
- 每条回复下方显示 API 返回的实际模型名和 token 用量。
- 面板可以放在右侧边栏（与大纲上下分屏）、左侧边栏或编辑区。
- 支持 Obsidian 设置搜索（1.13+）：每个提供商有独立的设置子页面，缺少 API Key 的会显示警告。

### 使用前须知

- **需要你自己的 API Key**（OpenAI、Anthropic、DeepSeek 等），大多数服务按 token 收费。本地 Ollama 无需 Key。
- **网络访问**：插件只会访问你在设置里配置的 API 地址，用于把消息发给模型并取回回复；没有遥测、没有广告、没有自己的服务器。
- **发送的内容**：你的消息、当前笔记路径与选中文本、你添加的附件内容、模型通过工具主动读取的笔记内容，以及你批准执行的本地命令的输出。
- **文件访问**：插件读写仓库内的文件；仓库外的文件只有在你主动添加为附件、或你批准的本地命令读取时才会被访问。附件只保存在当前对话的内存中。
- **API Key 存储**：Obsidian 1.11.4 及以上版本，API Key 保存在 Obsidian 的系统密钥存储（操作系统钥匙串）中，不写入 `data.json`，也不会随仓库同步或公开；换设备使用需重新填写一次。旧版本保存的 Key 会自动迁移。更早的 Obsidian 版本仍以明文保存在 `data.json`，同步或公开仓库时请排除该文件。

### 开发

```bash
npm install
npm run dev
npm run build
npm run lint
```

作者：zhang33（zyb@zhang33.net），OpenCenter 开源项目。

代码结构：`src/main.ts` 插件入口；`src/view.ts` 聊天面板；`src/agent.ts` Agent 循环与子 Agent；`src/compact.ts` 上下文压缩；`src/llm.ts` 各家接口封装；`src/tools.ts` 笔记工具与撤销；`src/permissions.ts` 权限模式与授权；`src/diff.ts` 差异对比；`src/settings.ts` 设置页。
