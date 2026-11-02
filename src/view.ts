import { ItemView, MarkdownRenderer, Notice, Platform, setIcon, WorkspaceLeaf } from "obsidian";
import type AIAgentPlugin from "./main";
import { Agent } from "./agent";
import type { ImagePart, ToolCall } from "./llm";
import { ToolResult, VaultTools, WRITE_TOOLS } from "./tools";
import { Attachment, attachmentFromFile, extractText, formatSize, KIND_LABELS, toImagePart } from "./attachments";
import { diffStats, lineDiff, renderDiff } from "./diff";
import { withApiKey } from "./secrets";

export const VIEW_TYPE = "ai-note-agent-view";

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
  list_attachments: "查看附件",
  view_image: "查看图片",
  save_attachment: "保存附件",
  list_commands: "搜索命令",
  run_command: "执行命令",
  list_plugins: "查看插件",
  set_plugin_enabled: "切换插件",
  get_settings: "读取设置",
  update_settings: "修改设置",
  open_plugin_page: "打开插件页",
  open_settings: "打开设置",
};

/** 一次最多直接发给模型的图片数量；更多的图片由模型用 view_image 按需查看 */
const MAX_INLINE_IMAGES = 6;
/** 添加文件夹时最多读取的文件数 */
const MAX_FOLDER_FILES = 200;
/** 待发送附件的总大小上限 */
const MAX_PENDING_BYTES = 300 * 1024 * 1024;

const CAPABILITIES = `能力补充说明：
- 用户可以在对话中添加附件（电脑上的文件、整个文件夹、粘贴或拖入的图片），每个附件有编号（att1、att2…）。用 list_attachments 查看，read_note 读取文字（PDF 支持分页），view_image 查看图片或 PDF 页面，save_attachment 把原文件存进仓库后可在笔记中用 ![[路径]] 嵌入。
- read_note 和 view_image 同样适用于仓库中的 PDF、图片、Word/PPT/Excel 文件。
- 根据资料整理笔记时：先通读资料，再规划笔记结构，然后创建或修改笔记；需要引用原文件时先 save_attachment 再嵌入链接。`;

const CONTROL_CAPABILITIES = `- 你可以控制 Obsidian：list_commands / run_command 执行命令面板中的任意命令；list_plugins / set_plugin_enabled 管理插件；get_settings / update_settings 读写 Obsidian 与插件的设置；open_plugin_page 打开社区插件安装页（安装需用户点击）；open_settings 打开设置。修改设置前先读取现有设置，只改需要改的字段。这些操作都会请用户确认。`;

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
  private attachEl!: HTMLElement;
  private includeContext = true;
  /** 已添加但还没有发送的附件 */
  private pending: Attachment[] = [];

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
      void this.addFiles(files.map((f) => ({ file: f })));
    });
    root.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); root.addClass("is-dragover"); }
    });
    root.addEventListener("dragleave", (e) => {
      if (e.target === root) root.removeClass("is-dragover");
    });
    root.addEventListener("drop", (e) => {
      root.removeClass("is-dragover");
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      void this.addFiles(files.map((f) => ({ file: f })));
    });

    const bar = footer.createDiv({ cls: "aiac-input-bar" });
    const tools = bar.createDiv({ cls: "aiac-input-tools" });
    const fileInput = tools.createEl("input", { cls: "aiac-hidden", attr: { type: "file", multiple: "" } });
    fileInput.onchange = () => {
      const files = Array.from(fileInput.files ?? []);
      fileInput.value = "";
      void this.addFiles(files.map((f) => ({ file: f })));
    };
    this.iconButton(tools, "paperclip", "添加文件（图片、PDF、Word、PPT、Excel、文本…）", () => fileInput.click());
    if (!Platform.isMobile) {
      const folderInput = tools.createEl("input", { cls: "aiac-hidden", attr: { type: "file", webkitdirectory: "", multiple: "" } });
      folderInput.onchange = () => {
        const files = Array.from(folderInput.files ?? []);
        folderInput.value = "";
        void this.addFolder(files);
      };
      this.iconButton(tools, "folder-plus", "添加文件夹（读取其中的文档和图片）", () => folderInput.click());
    }
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
    this.pending = [];
    this.renderPending();
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

  private buildUserMessage(text: string): string {
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
    const caps = CAPABILITIES + (this.plugin.settings.allowControl ? "\n" + CONTROL_CAPABILITIES : "");
    return `${this.plugin.settings.systemPrompt}\n\n${caps}\n\n环境信息：仓库名「${this.app.vault.getName()}」；当前时间 ${now.toLocaleString()}；你是通过 ${p?.name ?? "?"} 的 API 调用的模型「${p?.model ?? "?"}」（用户问起你是什么模型时，据此回答）。`;
  }

  private async onSend() {
    let text = this.inputEl.value.trim();
    if ((!text && !this.pending.length) || this.agent.running) return;
    if (!text) text = "请阅读我添加的附件。";
    const configured = this.plugin.activeProvider();
    const provider = configured ? withApiKey(this.app, configured) : undefined;
    if (!provider) { new Notice("请先在设置中添加模型提供商"); return; }
    if (!provider.apiKey && !/localhost|127\.0\.0\.1/.test(provider.baseUrl)) { new Notice(`「${provider.name}」还没有填写 API Key`); return; }

    this.messagesEl.querySelector(".aiac-welcome")?.remove();
    this.inputEl.value = "";
    const atts = this.pending;
    this.pending = [];
    this.renderPending();
    this.renderUser(text, atts);
    this.setRunning(true);

    const toolEls = new Map<string, HTMLElement>();
    try {
      let message = this.buildUserMessage(text);
      let images: ImagePart[] = [];
      if (atts.length) {
        this.statusEl.setText("正在处理附件…");
        this.agent.attachments.push(...atts);
        const prepared = await this.prepareAttachments(atts);
        message += prepared.text;
        images = prepared.images;
      }
      await this.agent.run(provider, this.systemPrompt(), message, this.plugin.settings.maxSteps, {
        onAssistant: (t, meta) => void this.renderAssistant(t, meta),
        onToolStart: (c) => toolEls.set(c.id, this.renderToolStart(c)),
        onToolEnd: (c, r) => this.renderToolEnd(toolEls.get(c.id), c, r),
        onStatus: (s) => this.statusEl.setText(s),
      }, { images, allowControl: this.plugin.settings.allowControl });
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

  private renderUser(text: string, atts: Attachment[] = []) {
    const el = this.messagesEl.createDiv({ cls: "aiac-msg aiac-user" });
    el.createDiv({ text });
    if (atts.length) {
      const list = el.createDiv({ cls: "aiac-user-atts" });
      for (const a of atts.slice(0, 20)) list.createSpan({ cls: "aiac-user-att", text: `${a.id} · ${a.relPath ?? a.name}` });
      if (atts.length > 20) list.createSpan({ cls: "aiac-user-att", text: `…共 ${atts.length} 个附件` });
    }
    this.scroll();
  }

  // ---------- 附件 ----------

  /** 添加文件到待发送列表 */
  async addFiles(items: { file: File; relPath?: string }[]) {
    let added = 0;
    const skipped: string[] = [];
    for (const { file, relPath } of items) {
      const total = this.pending.reduce((n, a) => n + a.size, 0);
      if (total + file.size > MAX_PENDING_BYTES) { skipped.push(`${file.name}（超出总大小上限 ${formatSize(MAX_PENDING_BYTES)}）`); continue; }
      try {
        const name = file.name || `粘贴的图片-${Date.now()}.png`;
        const f = file.name ? file : new File([file], name, { type: file.type });
        this.pending.push(await attachmentFromFile(f, this.agent.newAttachmentId(), relPath));
        added++;
      } catch (e) {
        skipped.push((e as Error).message);
      }
    }
    this.renderPending();
    if (skipped.length) new Notice(`有 ${skipped.length} 个文件未添加：\n${skipped.slice(0, 5).join("\n")}`);
    if (added) this.inputEl.focus();
  }

  /** 添加整个文件夹：只保留能读取的文件（文档、图片、文本），跳过隐藏文件 */
  private async addFolder(files: File[]) {
    const usable = files.filter((f) => {
      const rel = f.webkitRelativePath || f.name;
      if (rel.split("/").some((seg) => seg.startsWith("."))) return false;
      return attachmentKindReadable(f.name, f.type);
    });
    if (!usable.length) { new Notice("这个文件夹里没有可以读取的文件"); return; }
    if (usable.length > MAX_FOLDER_FILES) new Notice(`文件夹中有 ${usable.length} 个可读文件，只添加前 ${MAX_FOLDER_FILES} 个`);
    await this.addFiles(usable.slice(0, MAX_FOLDER_FILES).map((f) => ({ file: f, relPath: f.webkitRelativePath || undefined })));
  }

  private renderPending() {
    if (!this.attachEl) return;
    this.attachEl.empty();
    for (const a of this.pending) {
      const chip = this.attachEl.createDiv({ cls: "aiac-chip aiac-att-chip", attr: { "aria-label": `${KIND_LABELS[a.kind]} · ${formatSize(a.size)}` } });
      setIcon(chip.createSpan(), a.kind === "image" ? "image" : a.kind === "pdf" ? "file-text" : "file");
      chip.createSpan({ cls: "aiac-att-name", text: a.relPath ?? a.name });
      const x = chip.createSpan({ cls: "aiac-att-remove", attr: { "aria-label": "移除" } });
      setIcon(x, "x");
      x.onclick = () => {
        this.pending = this.pending.filter((p) => p !== a);
        this.renderPending();
      };
    }
    if (this.pending.length > 1) {
      const clear = this.attachEl.createDiv({ cls: "aiac-chip", text: `全部移除（${this.pending.length}）` });
      clear.onclick = () => { this.pending = []; this.renderPending(); };
    }
  }

  /** 生成随消息发送的附件说明；图片直接附上，少量文档直接附上文字内容 */
  private async prepareAttachments(atts: Attachment[]): Promise<{ text: string; images: ImagePart[] }> {
    const lines: string[] = [];
    for (const a of atts) lines.push("- " + (await VaultTools.describe(a)));
    const images: ImagePart[] = [];
    for (const a of atts.filter((x) => x.kind === "image").slice(0, MAX_INLINE_IMAGES)) {
      try { images.push(await toImagePart(a.data, a.mime, `${a.id} ${a.name}`)); } catch (e) { lines.push(`  （${a.id} 无法预览：${(e as Error).message}）`); }
    }
    let inline = "";
    const docs = atts.filter((x) => x.kind !== "image" && x.kind !== "other");
    if (docs.length && docs.length <= 3) {
      const budget = Math.floor(this.plugin.settings.maxReadChars / 2);
      const parts: string[] = [];
      let used = 0;
      for (const d of docs) {
        try {
          const r = await extractText(d.data, d.name, d.mime);
          if (used + r.text.length > budget) { parts.length = 0; break; }
          used += r.text.length;
          parts.push(`<file id="${d.id}" name="${d.relPath ?? d.name}">\n${r.text}\n</file>`);
        } catch { parts.length = 0; break; }
      }
      if (parts.length) inline = `\n\n附件内容：\n${parts.join("\n\n")}`;
    }
    const imageNote = images.length ? `\n其中 ${images.length} 张图片已直接附上。` : "";
    const readNote = inline ? "" : "\n用 read_note（传附件编号）读取文档内容，用 view_image 查看图片或 PDF 页面。";
    return { text: `\n\n<attachments>\n用户添加了以下附件：\n${lines.join("\n")}${imageNote}${readNote}${inline}\n</attachments>`, images };
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
      if (typeof a.enabled === "boolean") return `${s("id")} → ${a.enabled ? "启用" : "停用"}`;
      return s("path") || s("query") || s("folder") || s("id") || s("target") || s("tab");
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
          this.agent.messages.push({ role: "user", content: `（系统提示：用户撤销了你的这次操作「${TOOL_LABELS[call.name] ?? call.name}」（${c.path}），已恢复原状。）` });
        } catch (e) {
          new Notice("撤销失败：" + (e as Error).message);
        }
      };
      if (c.kind !== "delete" && c.kind !== "custom") {
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

function attachmentKindReadable(name: string, mime: string): boolean {
  return /\.(pdf|docx|pptx|xlsx|png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?|md|markdown|txt|csv|tsv|json|ya?ml|xml|html?|svg|log|tex|rst|org|srt|vtt)$/i.test(name) || mime.startsWith("image/") || mime.startsWith("text/");
}
