import { ItemView, MarkdownRenderer, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import type AIAgentPlugin from "./main";
import { Agent } from "./agent";
import type { ToolCall } from "./llm";
import { ToolResult, WRITE_TOOLS } from "./tools";
import { diffStats, lineDiff, renderDiff } from "./diff";

export const VIEW_TYPE = "notewright-view";

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

  constructor(leaf: WorkspaceLeaf, plugin: AIAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.agent = new Agent(plugin.tools);
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "AI Agent"; }
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
    this.inputEl = footer.createEl("textarea", {
      cls: "aiac-input",
      attr: { placeholder: "告诉 Agent 你想对笔记做什么…（Enter 发送，Shift+Enter 换行）", rows: "3" },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      // isComposing：中文输入法选词时按回车不应发送
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        void this.onSend();
      }
    });
    const bar = footer.createDiv({ cls: "aiac-input-bar" });
    bar.createDiv({ cls: "aiac-hint", text: "" });
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
    this.messagesEl.empty();
    this.renderWelcome();
    this.statusEl.setText("");
  }

  private renderWelcome() {
    const w = this.messagesEl.createDiv({ cls: "aiac-welcome" });
    w.createEl("h4", { text: "👋 我是你的笔记 Agent" });
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
    return `${this.plugin.settings.systemPrompt}\n\n环境信息：仓库名「${this.app.vault.getName()}」；当前时间 ${now.toLocaleString()}；你是通过 ${p?.name ?? "?"} 的 API 调用的模型「${p?.model ?? "?"}」（用户问起你是什么模型时，据此回答）。`;
  }

  private async onSend() {
    const text = this.inputEl.value.trim();
    if (!text || this.agent.running) return;
    const provider = this.plugin.activeProvider();
    if (!provider) { new Notice("请先在设置中添加模型提供商"); return; }
    if (!provider.apiKey && !/localhost|127\.0\.0\.1/.test(provider.baseUrl)) { new Notice(`「${provider.name}」还没有填写 API Key`); return; }

    this.messagesEl.querySelector(".aiac-welcome")?.remove();
    this.inputEl.value = "";
    this.renderUser(text);
    this.setRunning(true);

    const toolEls = new Map<string, HTMLElement>();
    try {
      await this.agent.run(provider, this.systemPrompt(), this.buildUserMessage(text), this.plugin.settings.maxSteps, {
        onAssistant: (t, meta) => this.renderAssistant(t, meta),
        onToolStart: (c) => toolEls.set(c.id, this.renderToolStart(c)),
        onToolEnd: (c, r) => this.renderToolEnd(toolEls.get(c.id), c, r),
        onStatus: (s) => this.statusEl.setText(s),
      });
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

  private renderUser(text: string) {
    const el = this.messagesEl.createDiv({ cls: "aiac-msg aiac-user" });
    el.setText(text);
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
      const a = JSON.parse(call.arguments || "{}");
      if (a.path && a.new_path) return `${a.path} → ${a.new_path}`;
      return a.path ?? a.query ?? a.folder ?? "";
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
