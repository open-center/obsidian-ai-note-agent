import { ItemView, MarkdownRenderer, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import type AIAgentPlugin from "./main";
import { Agent } from "./agent";
import type { ToolCall } from "./llm";
import { ToolResult, WRITE_TOOLS } from "./tools";
import { diffStats, lineDiff, renderDiff } from "./diff";
import { withApiKey } from "./secrets";
import { Attachment, extOf, isDocumentExt, isImageExt, parseAttachment } from "./attachments";

export const VIEW_TYPE = "ai-note-agent-view";

/** 添加文件夹时最多读取的文件数 */
const MAX_FOLDER_FILES = 100;

const TOOL_LABELS: Record<string, string> = {
  get_current_note: "读取当前笔记",
  read_note: "读取笔记",
  list_files: "列出文件",
  search_notes: "搜索笔记",
  edit_note: "修改笔记",
  write_note: "重写笔记",
  create_note: "新建笔记",
  append_to_note: "追加内容",
  move_note: "移动笔记",
  delete_note: "删除笔记",
  create_folder: "新建文件夹",
  get_system_info: "查看系统信息",
  open_app: "启动应用",
  open_with_default_app: "打开文件 / 网址",
  run_shell_command: "执行命令",
};

const QUICK_PROMPTS = [
  { label: "总结当前笔记", text: "请总结当前笔记的要点，并把总结以“## 摘要”章节插入到笔记开头（frontmatter 之后）。" },
  { label: "润色选中内容", text: "请润色我选中的文本，让表达更清晰流畅，直接在笔记中替换。" },
  { label: "整理格式", text: "请整理当前笔记的 Markdown 格式（标题层级、列表、空行），不要改变内容含义。" },
  { label: "添加标签", text: "请阅读当前笔记，在 frontmatter 的 tags 中添加 3-5 个合适的标签。" },
];

export class AgentView extends ItemView {
  plugin: AIAgentPlugin;
  agent: Agent;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private ctxEl!: HTMLElement;
  private providerSelect!: HTMLSelectElement;
  private includeContext = true;
  private attachEl!: HTMLElement;
  /** 待随下一条消息发送的附件 */
  private attachments: Attachment[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: AIAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.agent = new Agent(plugin.tools);
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "AI 助手"; }
  getIcon() { return "bot"; }

  async onOpen() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("aiac-root");

    // 顶栏
    const header = root.createDiv({ cls: "aiac-header" });
    this.providerSelect = header.createEl("select", { cls: "dropdown aiac-provider-select" });
    this.providerSelect.onchange = async () => {
      this.plugin.settings.activeProviderId = this.providerSelect.value;
      await this.plugin.saveSettings();
    };
    const actions = header.createDiv({ cls: "aiac-header-actions" });
    this.iconButton(actions, "plus", "新对话", () => this.newChat());
    this.iconButton(actions, "settings", "设置", () => {
      // 打开本插件的设置页（Obsidian 未公开的 API，做好不存在时的兼容）
      const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
      setting?.open();
      setting?.openTabById(this.plugin.manifest.id);
    });

    this.messagesEl = root.createDiv({ cls: "aiac-messages" });
    this.renderWelcome();

    // 输入区
    const footer = root.createDiv({ cls: "aiac-footer" });
    this.statusEl = footer.createDiv({ cls: "aiac-status" });
    this.ctxEl = footer.createDiv({ cls: "aiac-context" });
    this.attachEl = footer.createDiv({ cls: "aiac-attachments" });
    this.inputEl = footer.createEl("textarea", {
      cls: "aiac-input",
      attr: { placeholder: "告诉 Agent 你想对笔记做什么…（Enter 发送，Shift+Enter 换行）", rows: "3" },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      // isComposing：中文输入法选词时按回车不应发送
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.onSend();
      }
    });
    this.inputEl.addEventListener("paste", (e) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      void this.addFiles(files);
    });
    footer.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      footer.addClass("is-dragover");
    });
    footer.addEventListener("dragleave", () => footer.removeClass("is-dragover"));
    footer.addEventListener("drop", (e) => {
      footer.removeClass("is-dragover");
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      void this.addFiles(files);
    });

    const bar = footer.createDiv({ cls: "aiac-input-bar" });
    const tools = bar.createDiv({ cls: "aiac-hint" });
    const fileInput = tools.createEl("input", { type: "file", attr: { multiple: "" } });
    const folderInput = tools.createEl("input", { type: "file" });
    folderInput.webkitdirectory = true;
    for (const input of [fileInput, folderInput]) {
      input.hide();
      input.onchange = () => {
        const files = Array.from(input.files ?? []);
        input.value = "";
        void this.addFiles(files, input === folderInput);
      };
    }
    this.iconButton(tools, "paperclip", "添加附件（图片、PDF、Word、PowerPoint、Excel、文本）", () => fileInput.click());
    this.iconButton(tools, "folder-open", "添加文件夹", () => folderInput.click());
    this.sendBtn = bar.createEl("button", { cls: "mod-cta", text: "发送" });
    this.sendBtn.onclick = () => (this.agent.running ? this.agent.stop() : this.onSend());

    this.refreshProviders();
    this.refreshContext();
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshContext()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshContext()));
  }

  onClose(): Promise<void> {
    this.agent.stop();
    return Promise.resolve();
  }

  private iconButton(parent: HTMLElement, icon: string, tip: string, onClick: () => void) {
    const b = parent.createDiv({ cls: "clickable-icon", attr: { "aria-label": tip } });
    setIcon(b, icon);
    b.onclick = onClick;
    return b;
  }

  refreshProviders() {
    if (!this.providerSelect) return;
    this.providerSelect.empty();
    const s = this.plugin.settings;
    for (const p of s.providers) this.providerSelect.createEl("option", { value: p.id, text: `${p.name} · ${p.model || "?"}` });
    const active = this.plugin.activeProvider();
    if (active) this.providerSelect.value = active.id;
    if (!s.providers.length) this.providerSelect.createEl("option", { text: "请先在设置中添加提供商", value: "" });
  }

  refreshContext() {
    if (!this.ctxEl) return;
    this.ctxEl.empty();
    const ctx = this.plugin.editorContext();
    const chip = this.ctxEl.createDiv({ cls: "aiac-chip" + (this.includeContext ? "" : " is-off") });
    setIcon(chip.createSpan(), "file-text");
    chip.createSpan({ text: ctx.file ? ctx.file.basename : "未打开笔记" });
    if (ctx.selection) chip.createSpan({ cls: "aiac-chip-sel", text: ` · 选中 ${ctx.selection.length} 字` });
    chip.setAttr("aria-label", this.includeContext ? "点击：不把当前笔记作为上下文" : "点击：把当前笔记作为上下文");
    chip.onclick = () => { this.includeContext = !this.includeContext; this.refreshContext(); };
  }

  /** 读取并解析用户选择的文件；不支持的文件给出提示后跳过 */
  private async addFiles(files: File[], fromFolder = false) {
    let list = files;
    if (fromFolder) {
      // 文件夹里只取能解析的文件，跳过隐藏文件和其他二进制文件
      list = files.filter((f) => {
        const path = f.webkitRelativePath || f.name;
        if (path.split("/").some((seg) => seg.startsWith("."))) return false;
        const ext = extOf(f.name);
        return isImageExt(ext) || isDocumentExt(ext) || !/^(zip|gz|tar|7z|rar|exe|dmg|bin|dll|so|mp3|mp4|mov|wav|woff2?|ttf|otf|ico|doc|ppt|xls)$/.test(ext);
      });
      if (!list.length) { new Notice("文件夹里没有可以读取的文件"); return; }
      if (list.length > MAX_FOLDER_FILES) {
        new Notice(`文件夹中文件过多，只读取前 ${MAX_FOLDER_FILES} 个`);
        list = list.slice(0, MAX_FOLDER_FILES);
      }
    }
    this.statusEl.setText(`正在读取 ${list.length} 个文件…`);
    const failed: string[] = [];
    for (const f of list) {
      try {
        const name = (fromFolder && f.webkitRelativePath) || f.name || "粘贴的图片.png";
        this.attachments.push(await parseAttachment(name, await f.arrayBuffer()));
      } catch (e) {
        failed.push((e as Error).message);
      }
      this.renderAttachments();
    }
    this.statusEl.setText("");
    if (failed.length) new Notice(failed.slice(0, 5).join("\n") + (failed.length > 5 ? `\n…等 ${failed.length} 个文件无法读取` : ""), 8000);
  }

  private renderAttachments() {
    this.attachEl.empty();
    for (const a of this.attachments) {
      const chip = this.attachEl.createDiv({ cls: "aiac-chip aiac-attachment" });
      if (a.image) chip.createEl("img", { attr: { src: `data:${a.image.mediaType};base64,${a.image.data}` } });
      else setIcon(chip.createSpan(), extOf(a.name) === "pdf" ? "file-text" : "file");
      chip.createSpan({ text: a.name, attr: { "aria-label": `${a.name} · ${(a.size / 1024).toFixed(0)} KB` } });
      const x = chip.createSpan({ cls: "aiac-chip-remove", attr: { "aria-label": "移除" } });
      setIcon(x, "x");
      x.onclick = () => {
        this.attachments = this.attachments.filter((b) => b !== a);
        this.renderAttachments();
      };
    }
  }

  /** 用于挪动面板位置时保留对话：取出消息节点（连同事件一起搬走） */
  takeMessages(): Node[] | null {
    if (!this.agent.messages.length) return null;
    return Array.from(this.messagesEl.childNodes);
  }

  restore(agent: Agent, nodes: Node[] | null) {
    if (!nodes?.length) return;
    this.agent = agent;
    this.messagesEl.empty();
    for (const n of nodes) this.messagesEl.appendChild(n);
    this.scroll();
  }

  setInput(text: string) {
    this.inputEl.value = text;
    this.inputEl.focus();
  }

  newChat() {
    if (this.agent.running) { new Notice("请先停止当前任务"); return; }
    this.agent.reset();
    this.messagesEl.empty();
    this.renderWelcome();
    this.statusEl.setText("");
  }

  private renderWelcome() {
    const w = this.messagesEl.createDiv({ cls: "aiac-welcome" });
    w.createEl("h4", { text: "👋 我是你的笔记助手" });
    w.createEl("p", { text: "我可以读取、搜索、新建和修改仓库里的笔记。试试：" });
    const list = w.createDiv({ cls: "aiac-quick" });
    for (const q of QUICK_PROMPTS) {
      const b = list.createEl("button", { text: q.label });
      b.onclick = () => this.setInput(q.text);
    }
  }

  private buildUserMessage(text: string, attachments: Attachment[]): string {
    const max = this.plugin.settings.maxReadChars;
    const docs = attachments.filter((a) => a.kind === "text").map((a) => {
      const t = a.text ?? "";
      const body = t.length > max ? t.slice(0, max) + `\n\n…[内容过长，已截断，共 ${t.length} 字符]` : t;
      return `<attachment name="${a.name}">\n${body}\n</attachment>`;
    });
    const images = attachments.filter((a) => a.kind === "image").map((a) => a.name);
    if (docs.length || images.length) {
      const head = images.length ? `（用户附带了 ${images.length} 张图片：${images.join("、")}）\n` : "";
      text = `${text || "请查看我添加的附件。"}\n\n${head}${docs.join("\n\n")}`.trimEnd();
    }
    if (!this.includeContext) return text;
    const ctx = this.plugin.editorContext();
    const parts: string[] = [];
    if (ctx.file) parts.push(`当前打开的笔记：${ctx.file.path}`);
    if (ctx.selection) parts.push(`用户选中的文本：\n<selection>\n${ctx.selection}\n</selection>`);
    if (!parts.length) return text;
    return `${text}\n\n<context>\n${parts.join("\n")}\n</context>`;
  }

  private systemPrompt(): string {
    const now = new Date();
    const p = this.plugin.activeProvider();
    return `${this.plugin.settings.systemPrompt}\n\n环境信息：仓库名「${this.app.vault.getName()}」；当前时间 ${now.toLocaleString()}；你是通过 ${p?.name ?? "?"} 的 API 调用的模型「${p?.model ?? "?"}」（用户问起你是什么模型时，据此回答）。`;
  }

  private async onSend() {
    const text = this.inputEl.value.trim();
    if ((!text && !this.attachments.length) || this.agent.running) return;
    const configured = this.plugin.activeProvider();
    const provider = configured ? withApiKey(this.app, configured) : undefined;
    if (!provider) { new Notice("请先在设置中添加模型提供商"); return; }
    if (!provider.apiKey && !/localhost|127\.0\.0\.1/.test(provider.baseUrl)) { new Notice(`「${provider.name}」还没有填写 API Key`); return; }

    this.messagesEl.querySelector(".aiac-welcome")?.remove();
    const attachments = this.attachments;
    this.attachments = [];
    this.renderAttachments();
    this.inputEl.value = "";
    this.renderUser(text, attachments);
    this.setRunning(true);

    const toolEls = new Map<string, HTMLElement>();
    try {
      await this.agent.run(provider, this.systemPrompt(), this.buildUserMessage(text, attachments), this.plugin.settings.maxSteps, {
        onAssistant: (t, meta) => void this.renderAssistant(t, meta),
        onToolStart: (c) => toolEls.set(c.id, this.renderToolStart(c)),
        onToolEnd: (c, r) => this.renderToolEnd(toolEls.get(c.id), c, r),
        onStatus: (s) => this.statusEl.setText(s),
      }, attachments.flatMap((a) => (a.image ? [a.image] : [])));
      if (!/最大步骤|已停止/.test(this.statusEl.getText())) this.statusEl.setText("");
    } catch (e) {
      this.renderError((e as Error).message);
      this.statusEl.setText("");
    } finally {
      this.setRunning(false);
    }
  }

  private setRunning(r: boolean) {
    this.sendBtn.setText(r ? "停止" : "发送");
    this.sendBtn.toggleClass("mod-warning", r);
    this.sendBtn.toggleClass("mod-cta", !r);
  }

  private scroll() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderUser(text: string, attachments: Attachment[] = []) {
    const el = this.messagesEl.createDiv({ cls: "aiac-msg aiac-user" });
    if (text) el.createDiv({ text });
    if (attachments.length) {
      const box = el.createDiv({ cls: "aiac-attachments" });
      for (const a of attachments) {
        if (a.image) box.createEl("img", { cls: "aiac-user-image", attr: { src: `data:${a.image.mediaType};base64,${a.image.data}`, alt: a.name } });
        else {
          const chip = box.createDiv({ cls: "aiac-chip" });
          setIcon(chip.createSpan(), "paperclip");
          chip.createSpan({ text: a.name });
        }
      }
    }
    this.scroll();
  }

  private async renderAssistant(text: string, meta?: { model?: string; usage?: { input?: number; output?: number } }) {
    const el = this.messagesEl.createDiv({ cls: "aiac-msg aiac-assistant" });
    await MarkdownRenderer.render(this.app, text, el, this.plugin.editorContext().file?.path ?? "", this);
    if (meta?.model || meta?.usage?.input) {
      const parts: string[] = [];
      if (meta.model) parts.push(meta.model);
      if (meta.usage?.input != null) parts.push(`输入 ${meta.usage.input} / 输出 ${meta.usage.output ?? "?"} tokens`);
      el.createDiv({ cls: "aiac-meta", text: parts.join(" · "), attr: { "aria-label": "由 API 返回的实际模型名与用量" } });
    }
    const copy = el.createDiv({ cls: "aiac-copy clickable-icon", attr: { "aria-label": "复制" } });
    setIcon(copy, "copy");
    copy.onclick = () => { void navigator.clipboard.writeText(text).then(() => new Notice("已复制")); };
    this.scroll();
  }

  private renderError(msg: string) {
    const el = this.messagesEl.createDiv({ cls: "aiac-msg aiac-error" });
    el.setText("⚠️ " + msg);
    this.scroll();
  }

  private summarizeArgs(call: ToolCall): string {
    try {
      const a = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      const s = (k: string): string => { const v = a[k]; return typeof v === "string" ? v : ""; };
      if (s("path") && s("new_path")) return `${s("path")} → ${s("new_path")}`;
      if (s("app")) return s("target") ? `${s("app")} · ${s("target")}` : s("app");
      return s("path") || s("query") || s("folder") || s("command") || s("target");
    } catch { return ""; }
  }

  private renderToolStart(call: ToolCall): HTMLElement {
    const el = this.messagesEl.createDiv({ cls: "aiac-tool" + (WRITE_TOOLS.has(call.name) ? " is-write" : "") });
    const head = el.createDiv({ cls: "aiac-tool-head" });
    const icon = head.createSpan({ cls: "aiac-tool-icon" });
    setIcon(icon, "loader");
    head.createSpan({ cls: "aiac-tool-name", text: TOOL_LABELS[call.name] ?? call.name });
    head.createSpan({ cls: "aiac-tool-arg", text: this.summarizeArgs(call) });
    this.scroll();
    return el;
  }

  private renderToolEnd(el: HTMLElement | undefined, call: ToolCall, result: ToolResult) {
    if (!el) return;
    const icon = el.querySelector(".aiac-tool-icon") as HTMLElement;
    icon.empty();
    const rejected = /用户拒绝/.test(result.output);
    setIcon(icon, result.isError ? "x-circle" : rejected ? "ban" : "check-circle");
    el.addClass(result.isError ? "is-error" : rejected ? "is-rejected" : "is-ok");

    const head = el.querySelector(".aiac-tool-head") as HTMLElement;
    const c = result.change;
    if (c && c.kind === "write") {
      const st = diffStats(lineDiff(c.before ?? "", c.after ?? ""));
      head.createSpan({ cls: "aiac-tool-stat", text: `+${st.add} −${st.del}` });
    }
    if (c) {
      const undo = head.createEl("button", { cls: "aiac-undo", text: "撤销" });
      undo.onclick = async (ev) => {
        ev.stopPropagation();
        try {
          new Notice(await this.plugin.tools.undo(c));
          undo.setText("已撤销");
          undo.disabled = true;
          el.addClass("is-undone");
          this.agent.messages.push({ role: "user", content: `（系统提示：用户撤销了你对 ${c.path} 的这次修改「${TOOL_LABELS[call.name] ?? call.name}」，文件已恢复原状。）` });
        } catch (e) {
          new Notice("撤销失败：" + (e as Error).message);
        }
      };
      if (c.kind !== "delete") {
        const open = head.createEl("button", { cls: "aiac-undo", text: "打开" });
        open.onclick = (ev) => { ev.stopPropagation(); void this.app.workspace.openLinkText(c.path, "", false); };
      }
    }

    if (this.plugin.settings.showToolDetails) {
      const details = el.createDiv({ cls: "aiac-tool-details" });
      details.hide();
      head.addClass("is-clickable");
      head.onclick = () => details.toggle(!details.isShown());
      if (c && c.kind === "write") renderDiff(details, lineDiff(c.before ?? "", c.after ?? ""));
      else {
        details.createEl("pre", { text: `参数：${call.arguments}` });
        details.createEl("pre", { text: result.output.length > 3000 ? result.output.slice(0, 3000) + "\n…" : result.output });
      }
    }
    this.scroll();
  }
}
