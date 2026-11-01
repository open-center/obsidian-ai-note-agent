# AI Note Agent

> An AI agent for your Obsidian vault.

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

- **Safe by default**: every write shows a diff for you to approve (configurable), every change has an **Undo** button in the chat, and deletes always ask for confirmation.
- The active note and selected text are passed as context (toggle with one click).
- Right-click selected text → **Send to AI Agent**.
- Shows the model name actually returned by the API and token usage under each reply.
- Panel can sit in the right sidebar (split with the outline), the left sidebar, or the editor area.

> The current UI is in Simplified Chinese.

## Requirements and disclosures

- **Account / payment**: you need your own API key from at least one model provider (for example OpenAI, Anthropic or DeepSeek). Most providers charge per token. A local Ollama server works without any key or payment.
- **Network use**: the plugin sends requests **only** to the API endpoint(s) you configure, using Obsidian's `requestUrl`. Depending on your configuration this can be `api.openai.com`, `api.anthropic.com`, `api.deepseek.com`, `generativelanguage.googleapis.com`, `api.moonshot.cn`, `dashscope.aliyuncs.com`, `open.bigmodel.cn`, `api.siliconflow.cn`, `openrouter.ai`, a local Ollama server (`localhost:11434`), or any custom URL you enter. It is needed to send your messages to the model and receive its replies.
- **What is sent**: your chat messages, the path of the active note and the selected text, and the content of any notes the model chooses to read through the tools above. Nothing is sent until you press Send.
- **No telemetry, no ads, no third-party servers.** The plugin has no backend of its own.
- **Storage**: API keys are stored in plain text in the plugin's `data.json` inside your vault's config folder. If you sync or publish your vault, exclude that file.
- The plugin only accesses files inside your vault.

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
- **安全**：默认每次修改都弹出差异对比由你确认；聊天里每次修改都有「撤销」按钮；删除始终需要确认。
- 自动把当前笔记和选中文本作为上下文；右键选中文本可「发送给 AI Agent」。
- 每条回复下方显示 API 返回的实际模型名和 token 用量。
- 面板可以放在右侧边栏（与大纲上下分屏）、左侧边栏或编辑区。

### 使用前须知

- **需要你自己的 API Key**（OpenAI、Anthropic、DeepSeek 等），大多数服务按 token 收费。本地 Ollama 无需 Key。
- **网络访问**：插件只会访问你在设置里配置的 API 地址，用于把消息发给模型并取回回复；没有遥测、没有广告、没有自己的服务器。
- **发送的内容**：你的消息、当前笔记路径与选中文本，以及模型通过工具主动读取的笔记内容。
- **API Key 明文保存**在仓库配置目录下本插件的 `data.json` 中，同步或公开仓库时请排除该文件。

### 开发

```bash
npm install
npm run dev
npm run build
npm run lint
```

作者：zhang33（zyb@zhang33.net），OpenCenter 开源项目。

代码结构：`src/main.ts` 插件入口；`src/view.ts` 聊天面板；`src/agent.ts` Agent 循环；`src/llm.ts` 各家接口封装；`src/tools.ts` 笔记工具、确认与撤销；`src/diff.ts` 差异对比；`src/settings.ts` 设置页。
