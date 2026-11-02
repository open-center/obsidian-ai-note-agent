import { ItemView, MarkdownRenderer, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import type AIAgentPlugin from "./main";
import { Agent, DELEGATE_TOOL, QueuedMessage, SubAgentEvent } from "./agent";
import type { ImageData } from "./attachments";
import type { CompactResult } from "./compact";
import type { ProviderConfig, ToolCall } from "./llm";
import { ToolResult, WRITE_TOOLS } from "./tools";
import { diffStats, lineDiff, renderDiff } from "./diff";
import { withApiKey } from "./secrets";
import { Attachment, extOf, isDocumentExt, isImageExt, parseAttachment } from "./attachments";
import { ConfirmMode, MODE_LABELS, PERMISSION_LABELS } from "./permissions";

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
  list_commands: "列出 Obsidian 命令",
  run_command: "执行 Obsidian 命令",
  list_plugins: "列出插件",
  set_plugin_enabled: "启用 / 停用插件",
  get_settings: "读取设置",
  update_settings: "修改设置",
  open_settings: "打开设置",
  [DELEGATE_TOOL]: "派出子 Agent",
};

/** 同时保留的对话标签数上限 */
const MAX_SESSIONS = 10;

const QUICK_PROMPTS = [
  { label: "总结当前笔记", text: "请总结当前笔记的要点，并把总结以“## 摘要”章节插入到笔记开头（frontmatter 之后）。" },
  { label: "润色选中内容", text: "请润色我选中的文本，让表达更清晰流畅，直接在笔记中替换。" },
  { label: "整理格式", text: "请整理当前笔记的 Markdown 格式（标题层级、列表、空行），不要改变内容含义。" },
  { label: "添加标签", text: "请阅读当前笔记，在 frontmatter 的 tags 中添加 3-5 个合适的标签。" },
];

type SessionState = "idle" | "running" | "done" | "error" | "stopped";

/** 一个对话标签：独立的 Agent 和消息区，可以在后台继续运行 */
export interface ChatSession {
  id: number;
  title: string;
  /** 用户手动改过标题，之后不再自动命名 */
  renamed: boolean;
  agent: Agent;
  el: HTMLElement;
  tabEl: HTMLElement | null;
  /** 运行时显示在消息末尾的动画提示 */
  thinkingEl: HTMLElement | null;
  state: SessionState;
  status: string;
  startedAt: number;
  endedAt: number;
  toolCount: number;
  /** 在后台完成、用户还没看过 */
  unread: boolean;
  /** 运行中排队、尚未送达模型的消息：原始输入和对应的消息气泡 */
  queued: Map<string, { text: string; el: HTMLElement }>;
  /** 用户在排队列表里点了“发送”的那条：当前任务停下后立即作为新需求执行 */
  sendNowId: string | null;
}

const STATE_TEXT: Record<SessionState, string> = {
  idle: "",
  running: "运行中",
  done: "已完成",
  error: "出错了",
  stopped: "已停止",
};

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}

export class AgentView extends ItemView {
  plugin: AIAgentPlugin;
  private sessions: ChatSession[] = [];
  private active!: ChatSession;
  private nextId = 1;
  private sessionsEl!: HTMLElement;
  private tabsEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private queueEl!: HTMLElement;
  private runbarEl!: HTMLElement;
  private ctxEl!: HTMLElement;
  private providerSelect!: HTMLSelectElement;
  private modeSelect!: HTMLSelectElement;
  private includeContext = true;
  private attachEl!: HTMLElement;
  /** 待随下一条消息发送的附件 */
  private attachments: Attachment[] = [];
  /** 子 Agent 行里各工具卡片，按 tool_call id 索引 */
  private subToolEls = new WeakMap<HTMLElement, Map<string, HTMLElement>>();

  constructor(leaf: WorkspaceLeaf, plugin: AIAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "AI 助手"; }
  getIcon() { return "bot"; }

  /** 当前标签的 Agent */
  get agent(): Agent { return this.active.agent; }

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
    this.iconButton(actions, "plus", "新对话（新标签，可与其他对话同时运行）", () => this.newChat());
    this.iconButton(actions, "settings", "设置", () => {
      // 打开本插件的设置页（Obsidian 未公开的 API，做好不存在时的兼容）
      const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
      setting?.open();
      setting?.openTabById(this.plugin.manifest.id);
    });

    this.tabsEl = root.createDiv({ cls: "aiac-tabs" });
    this.sessionsEl = root.createDiv({ cls: "aiac-sessions" });
    this.switchTo(this.createSession());

    // 输入区
    const footer = root.createDiv({ cls: "aiac-footer" });
    this.runbarEl = footer.createDiv({ cls: "aiac-runbar" });
    this.ctxEl = footer.createDiv({ cls: "aiac-context" });
    this.queueEl = footer.createDiv({ cls: "aiac-queue" });
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
    this.modeSelect = tools.createEl("select", { cls: "dropdown aiac-mode-select" });
    for (const [k, label] of Object.entries(MODE_LABELS)) this.modeSelect.createEl("option", { value: k, text: label });
    this.modeSelect.onchange = async () => {
      this.plugin.settings.confirmMode = this.modeSelect.value as ConfirmMode;
      await this.plugin.saveSettings();
    };
    this.refreshPermissionMode();
    const btns = bar.createDiv({ cls: "aiac-send-buttons" });
    this.stopBtn = btns.createEl("button", { cls: "mod-warning", text: "停止" });
    this.stopBtn.onclick = () => this.active.agent.stop();
    this.sendBtn = btns.createEl("button", { cls: "mod-cta", text: "发送" });
    this.sendBtn.onclick = () => void this.onSend();

    this.refreshProviders();
    this.refreshContext();
    this.refreshRunState();
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshContext()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshContext()));
    // 每秒刷新运行中任务的计时
    this.registerInterval(window.setInterval(() => {
      if (this.sessions.some((s) => s.state === "running")) this.refreshRunState();
    }, 1000));
  }

  onClose(): Promise<void> {
    for (const s of this.sessions) s.agent.stop();
    return Promise.resolve();
  }

  private iconButton(parent: HTMLElement, icon: string, tip: string, onClick: () => void) {
    const b = parent.createDiv({ cls: "clickable-icon", attr: { "aria-label": tip } });
    setIcon(b, icon);
    b.onclick = onClick;
    return b;
  }

  /** 三个跳动的点，表示正在运行 */
  private renderDots(el: HTMLElement) {
    el.addClass("aiac-dots");
    for (let i = 0; i < 3; i++) el.createSpan();
  }

  // ---------- 多对话标签 ----------

  private createSession(agent?: Agent, el?: HTMLElement): ChatSession {
    const s: ChatSession = {
      id: this.nextId++,
      title: "新对话",
      renamed: false,
      agent: agent ?? new Agent(this.plugin.tools, () => this.plugin.settings.allowSubAgents, () => this.plugin.settings.contextBudget),
      el: el ?? createDiv({ cls: "aiac-messages" }),
      tabEl: null,
      thinkingEl: null,
      state: "idle",
      status: "",
      startedAt: 0,
      endedAt: 0,
      toolCount: 0,
      unread: false,
      queued: new Map(),
      sendNowId: null,
    };
    this.sessionsEl.appendChild(s.el);
    if (!el) this.renderWelcome(s);
    this.sessions.push(s);
    return s;
  }

  private switchTo(s: ChatSession) {
    this.active = s;
    s.unread = false;
    for (const x of this.sessions) x.el.toggle(x === s);
    this.renderTabs();
    if (this.runbarEl) this.refreshRunState();
    this.scroll(s);
  }

  private closeSession(s: ChatSession) {
    if (s.agent.running) s.agent.stop();
    s.el.remove();
    const idx = this.sessions.indexOf(s);
    this.sessions.splice(idx, 1);
    if (!this.sessions.length) this.createSession();
    if (this.active === s) this.switchTo(this.sessions[Math.min(idx, this.sessions.length - 1)]);
    else this.renderTabs();
  }

  /** 标签栏：每个对话一个标签，末尾是“新对话”按钮 */
  private renderTabs() {
    this.tabsEl.empty();
    const list = this.tabsEl.createDiv({ cls: "aiac-tabs-list" });
    for (const s of this.sessions) {
      const tab = list.createDiv({ cls: `aiac-tab is-${s.state}` + (s === this.active ? " is-active" : "") + (s.unread ? " is-unread" : "") });
      tab.createSpan({ cls: "aiac-tab-dot" });
      const title = tab.createSpan({ cls: "aiac-tab-title", text: s.title });
      tab.setAttr("aria-label", `${s.title}${s.state === "idle" ? "" : " · " + STATE_TEXT[s.state]}（双击重命名）`);
      tab.onclick = () => this.switchTo(s);
      tab.ondblclick = (e) => { e.stopPropagation(); this.renameSession(s, title); };
      const x = tab.createSpan({ cls: "aiac-tab-close", attr: { "aria-label": s.agent.running ? "停止并关闭" : "关闭" } });
      setIcon(x, "x");
      x.onclick = (e) => { e.stopPropagation(); this.closeSession(s); };
      s.tabEl = tab;
    }
    // 当前标签滚动到可见位置；“新对话”按钮固定在最右侧，不随标签滚动
    this.active.tabEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const add = this.tabsEl.createDiv({ cls: "aiac-tab aiac-tab-new", attr: { "aria-label": "新开一个对话，可与其他正在运行的对话同时执行" } });
    setIcon(add.createSpan({ cls: "aiac-tab-new-icon" }), "plus");
    add.createSpan({ text: "新对话" });
    add.onclick = () => this.newChat();
  }

  /** 在标签上就地重命名：回车或失焦保存，Esc 取消 */
  private renameSession(s: ChatSession, titleEl: HTMLElement) {
    const input = createEl("input", { type: "text", cls: "aiac-tab-rename", value: s.title });
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v) { s.title = v; s.renamed = true; }
      this.renderTabs();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.isComposing) finish(true);
      else if (e.key === "Escape") finish(false);
    };
    input.onblur = () => finish(true);
    input.onclick = (e) => e.stopPropagation();
  }

  /** 输入框上方的运行状态条和发送按钮，跟随当前标签 */
  private refreshRunState() {
    const s = this.active;
    const bar = this.runbarEl;
    bar.empty();
    bar.className = `aiac-runbar is-${s.state}`;
    const elapsed = formatElapsed((s.state === "running" ? Date.now() : s.endedAt) - s.startedAt);
    if (s.state !== "idle") {
      const icon = bar.createSpan({ cls: "aiac-runbar-icon" });
      if (s.state === "running") this.renderDots(icon);
      else setIcon(icon, s.state === "done" ? "check-circle" : s.state === "error" ? "x-circle" : "pause-circle");
      bar.createSpan({ cls: "aiac-runbar-text", text: s.state === "running" ? s.status || "运行中…" : STATE_TEXT[s.state] });
      const parts = [elapsed];
      if (s.toolCount) parts.push(`调用 ${s.toolCount} 次工具`);
      if (s.state === "done" && s.status) parts.push(s.status);
      bar.createSpan({ cls: "aiac-runbar-meta", text: parts.join(" · ") });
    }
    const others = this.sessions.filter((x) => x !== s && x.state === "running").length;
    if (others) bar.createSpan({ cls: "aiac-runbar-others", text: `另有 ${others} 个对话在后台运行` });
    bar.toggle(s.state !== "idle" || others > 0);

    // 输入只发给当前选中的对话；它在运行时，消息先排队，当前这一步完成后送达
    const r = s.agent.running;
    this.stopBtn.toggle(r);
    this.sendBtn.setText(r ? "排队" : "发送");
    this.sendBtn.setAttr("aria-label", r ? "加入这个对话的排队：当前这一步完成后送达" : "发送（Enter）");
    this.inputEl.setAttr("placeholder", r
      ? "任务运行中…输入补充说明，会排队并在当前步骤完成后送达这个对话"
      : "告诉 Agent 你想对笔记做什么…（Enter 发送，Shift+Enter 换行）");
    this.renderQueue();
    // 刷新标签上的计时提示
    if (s.tabEl && s.state === "running") s.tabEl.setAttr("aria-label", `${s.title} · 运行中 ${elapsed}`);
  }

  private setSessionState(s: ChatSession, state: SessionState) {
    s.state = state;
    if (state === "running") { s.startedAt = Date.now(); s.toolCount = 0; s.status = ""; }
    else s.endedAt = Date.now();
    if (state !== "running" && s !== this.active) {
      s.unread = true;
      new Notice(`对话「${s.title}」${STATE_TEXT[state]}`);
    }
    this.updateThinking(s);
    this.renderTabs();
    // 后台对话的状态变化也会影响“另有 N 个对话在后台运行”的提示
    this.refreshRunState();
  }

  private setStatus(s: ChatSession, text: string) {
    s.status = text;
    this.updateThinking(s);
    if (s === this.active) this.refreshRunState();
  }

  /** 消息末尾的“正在思考”动画，运行结束后移除 */
  private updateThinking(s: ChatSession) {
    if (s.state !== "running") {
      s.thinkingEl?.remove();
      s.thinkingEl = null;
      return;
    }
    if (!s.thinkingEl) {
      s.thinkingEl = createDiv({ cls: "aiac-thinking" });
      this.renderDots(s.thinkingEl.createSpan());
      s.thinkingEl.createSpan({ cls: "aiac-thinking-text" });
    }
    (s.thinkingEl.querySelector(".aiac-thinking-text") as HTMLElement).setText(s.status || "思考中…");
    s.el.appendChild(s.thinkingEl);
    this.scroll(s);
  }

  /** 用于挪动面板位置时保留对话：交出所有空闲的标签 */
  takeSessions(): { agent: Agent; el: HTMLElement; title: string }[] {
    return this.sessions
      .filter((s) => s.agent.messages.length && !s.agent.running)
      .map((s) => { s.el.detach(); return { agent: s.agent, el: s.el, title: s.title }; });
  }

  restoreSessions(list: { agent: Agent; el: HTMLElement; title: string }[]) {
    if (!list.length) return;
    for (const s of this.sessions) s.el.remove();
    this.sessions = [];
    for (const x of list) {
      const s = this.createSession(x.agent, x.el);
      s.title = x.title;
      s.state = "done";
    }
    this.switchTo(this.sessions[this.sessions.length - 1]);
  }

  // ---------- 设置同步 ----------

  /** 同步底部的权限模式下拉框，并在提示中列出已授权的操作 */
  refreshPermissionMode() {
    if (!this.modeSelect) return;
    const s = this.plugin.settings;
    this.modeSelect.value = s.confirmMode;
    const granted = s.grantedPermissions.map((k) => PERMISSION_LABELS[k]);
    const tips: Record<ConfirmMode, string> = {
      manual: "手动确认：每次操作都弹窗询问",
      grant: `按授权执行：${granted.length ? "以下操作直接执行——" + granted.join("、") : "尚未授权任何操作"}；其余仍弹窗询问。可在设置中调整`,
      auto: "自动执行：所有操作直接执行，不再询问（仍可撤销）",
    };
    this.modeSelect.setAttr("aria-label", tips[s.confirmMode]);
    this.modeSelect.toggleClass("is-auto", s.confirmMode === "auto");
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

  // ---------- 附件 ----------

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
    const notice = new Notice(`正在读取 ${list.length} 个文件…`, 0);
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
    notice.hide();
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

  setInput(text: string) {
    this.inputEl.value = text;
    this.inputEl.focus();
  }

  /** 新建对话：当前对话还是空的就直接用它，否则开一个新标签 */
  newChat() {
    const s = this.active;
    if (!s.agent.messages.length && !s.agent.running) { this.inputEl?.focus(); return; }
    if (this.sessions.length >= MAX_SESSIONS) {
      const idle = this.sessions.find((x) => !x.agent.running && x !== s);
      if (!idle) { new Notice(`最多同时保留 ${MAX_SESSIONS} 个对话，请先关闭一些`); return; }
      this.closeSession(idle);
    }
    this.switchTo(this.createSession());
    this.inputEl?.focus();
  }

  private renderWelcome(s: ChatSession) {
    const w = s.el.createDiv({ cls: "aiac-welcome" });
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

  /** 当前模型提供商（带 API key）；没配置好时提示并返回 null */
  private provider(): ProviderConfig | null {
    const configured = this.plugin.activeProvider();
    const provider = configured ? withApiKey(this.app, configured) : undefined;
    if (!provider) { new Notice("请先在设置中添加模型提供商"); return null; }
    if (!provider.apiKey && !/localhost|127\.0\.0\.1/.test(provider.baseUrl)) { new Notice(`「${provider.name}」还没有填写 API Key`); return null; }
    return provider;
  }

  /** 输入只归属当前选中的对话：它在运行时排队，否则直接开始 */
  private async onSend() {
    const text = this.inputEl.value.trim();
    if (!text && !this.attachments.length) return;
    const s = this.active;
    if (s.agent.running) { this.enqueue(s, text); return; }
    if (!this.provider()) return;

    s.el.querySelector(".aiac-welcome")?.remove();
    const attachments = this.attachments;
    this.attachments = [];
    this.renderAttachments();
    this.inputEl.value = "";
    // 用第一条消息作为标题（标签上放不下时由 CSS 截断，悬停显示完整标题）
    if (!s.renamed && !s.agent.messages.length) {
      const t = (text || attachments[0]?.name || "").replace(/\s+/g, " ");
      s.title = (t.length > 40 ? t.slice(0, 40) + "…" : t) || "新对话";
    }
    this.renderUser(s, text, attachments);
    await this.runAgent(s, this.buildUserMessage(text, attachments), attachments.flatMap((a) => (a.image ? [a.image] : [])));
  }

  /** 在对话 s 中运行一轮 Agent */
  private async runAgent(s: ChatSession, content: string, images: ImageData[]) {
    const provider = this.provider();
    if (!provider) return;
    this.setSessionState(s, "running");
    const toolEls = new Map<string, HTMLElement>();
    let state: SessionState = "done";
    try {
      await s.agent.run(provider, this.systemPrompt(), content, this.plugin.settings.maxSteps, {
        onAssistant: (t, meta) => void this.renderAssistant(s, t, meta),
        onToolStart: (c) => { s.toolCount++; toolEls.set(c.id, this.renderToolStart(s, s.el, c)); },
        onToolEnd: (c, r) => this.renderToolEnd(s, toolEls.get(c.id), c, r),
        onStatus: (t) => this.setStatus(s, t),
        onSubAgent: (c, i, e) => this.renderSubAgent(s, toolEls.get(c.id), i, e),
        onQueueDelivered: (ids) => this.markDelivered(s, ids),
        onCompacted: (r) => this.renderCompacted(s, r),
      }, images);
      if (/已停止/.test(s.status)) state = "stopped";
      else if (!/最大步骤/.test(s.status)) s.status = "";
    } catch (e) {
      this.renderError(s, (e as Error).message);
      s.status = "";
      state = "error";
    } finally {
      const next = this.takeSendNow(s);
      if (!next) this.returnQueue(s);
      this.setSessionState(s, state);
      // 用户点了排队消息的“发送”：当前任务已停下，立即把它作为新需求执行
      if (next) void this.runAgent(s, next.content, next.images ?? []);
    }
  }

  /** 对话里的一条分隔提示：较早的历史已压缩 */
  private renderCompacted(s: ChatSession, r: CompactResult) {
    const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
    const el = s.el.createDiv({ cls: "aiac-compacted" });
    setIcon(el.createSpan({ cls: "aiac-compacted-icon" }), "fold-vertical");
    el.createSpan({
      text: r.mode === "summary"
        ? `较早的对话已压缩成摘要（约 ${k(r.before)} → ${k(r.after)} token）`
        : `已精简较早的工具结果和附件（约 ${k(r.before)} → ${k(r.after)} token）`,
    });
    el.setAttr("aria-label", "对话过长时自动压缩，以减少每次请求的 token、避免触发限流。可在设置中调整阈值");
    this.scroll(s);
  }

  // ---------- 消息排队 ----------

  /** 当前对话运行中发送的消息：显示在对话里并排队，当前这一步完成后送达模型 */
  private enqueue(s: ChatSession, text: string) {
    const attachments = this.attachments;
    this.attachments = [];
    this.renderAttachments();
    this.inputEl.value = "";
    const id = Math.random().toString(36).slice(2, 10);
    const el = this.renderUser(s, text, attachments);
    el.addClass("is-queued");
    el.createDiv({ cls: "aiac-queued-badge", text: "排队中 · 当前步骤完成后送达" });
    s.queued.set(id, { text, el });
    s.agent.enqueue({ id, content: this.buildUserMessage(text, attachments), images: attachments.flatMap((a) => (a.image ? [a.image] : [])) });
    this.renderQueue();
  }

  private markDelivered(s: ChatSession, ids: string[]) {
    for (const id of ids) {
      const q = s.queued.get(id);
      if (!q) continue;
      q.el.removeClass("is-queued");
      q.el.querySelector(".aiac-queued-badge")?.remove();
      s.queued.delete(id);
    }
    if (s === this.active) this.renderQueue();
  }

  private cancelQueued(s: ChatSession, id: string) {
    if (!s.agent.cancelQueued(id)) return;
    const q = s.queued.get(id);
    q?.el.remove();
    s.queued.delete(id);
    if (q && s === this.active && !this.inputEl.value.trim()) this.inputEl.value = q.text;
    this.renderQueue();
  }

  /** 排队消息的“发送”：停下当前任务，停下后立即把这条作为新需求执行 */
  private sendNow(s: ChatSession, id: string) {
    if (!s.agent.running || !s.queued.has(id)) return;
    s.sendNowId = id;
    s.agent.stop();
    this.setStatus(s, "正在停止当前任务，停下后立即发送新需求…");
    this.renderQueue();
  }

  /** 取出要立即发送的那条；其余排队消息继续排在新任务后面 */
  private takeSendNow(s: ChatSession): QueuedMessage | null {
    const id = s.sendNowId;
    s.sendNowId = null;
    if (!id) return null;
    const left = s.agent.takeQueue();
    const next = left.find((m) => m.id === id) ?? null;
    for (const m of left) if (m !== next) s.agent.enqueue(m);
    if (!next) return null;
    const el = s.queued.get(id)?.el;
    this.markDelivered(s, [id]);
    // 把这条消息挪到对话末尾，保持阅读顺序
    if (el) s.el.appendChild(el);
    return next;
  }

  /** 任务结束（停止、出错或达到步骤上限）时还没送达的消息退回输入框 */
  private returnQueue(s: ChatSession) {
    const left = s.agent.takeQueue();
    if (!left.length) return;
    const texts = left.map((m) => s.queued.get(m.id)?.text ?? "").filter(Boolean);
    for (const m of left) { s.queued.get(m.id)?.el.remove(); s.queued.delete(m.id); }
    if (s === this.active && !this.inputEl.value.trim()) {
      this.inputEl.value = texts.join("\n\n");
      new Notice("任务已结束，排队中的消息已退回输入框");
    } else if (texts.length) {
      new Notice(`对话「${s.title}」结束时有 ${texts.length} 条排队消息未送达：\n${texts.join("\n").slice(0, 200)}`, 10000);
    }
  }

  /** 输入框上方的排队列表，可逐条撤回 */
  private renderQueue() {
    const s = this.active;
    this.queueEl.empty();
    this.queueEl.toggle(s.queued.size > 0);
    if (!s.queued.size) return;
    this.queueEl.createDiv({ cls: "aiac-queue-head", text: `排队中 ${s.queued.size} 条 · 当前步骤完成后依次送达；点「发送」则停下当前任务，立即作为新需求执行` });
    for (const [id, q] of s.queued) {
      const row = this.queueEl.createDiv({ cls: "aiac-queue-item" });
      setIcon(row.createSpan({ cls: "aiac-queue-icon" }), "clock");
      row.createSpan({ cls: "aiac-queue-text", text: q.text || "（附件）" });
      const now = row.createEl("button", { cls: "aiac-queue-send", text: s.sendNowId === id ? "发送中…" : "发送" });
      now.setAttr("aria-label", "停下当前任务，立即把这条作为新需求发送");
      now.disabled = s.sendNowId !== null;
      now.onclick = () => this.sendNow(s, id);
      const x = row.createSpan({ cls: "aiac-chip-remove", attr: { "aria-label": "撤回这条消息" } });
      setIcon(x, "x");
      x.onclick = () => this.cancelQueued(s, id);
    }
  }

  // ---------- 消息渲染 ----------

  private scroll(s: ChatSession) {
    if (s.thinkingEl && s.el.lastElementChild !== s.thinkingEl) s.el.appendChild(s.thinkingEl);
    s.el.scrollTop = s.el.scrollHeight;
  }

  private renderUser(s: ChatSession, text: string, attachments: Attachment[] = []): HTMLElement {
    const el = s.el.createDiv({ cls: "aiac-msg aiac-user" });
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
    this.scroll(s);
    return el;
  }

  private async renderAssistant(s: ChatSession, text: string, meta?: { model?: string; usage?: { input?: number; output?: number } }) {
    const el = s.el.createDiv({ cls: "aiac-msg aiac-assistant" });
    this.scroll(s);
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
    this.scroll(s);
  }

  private renderError(s: ChatSession, msg: string) {
    const el = s.el.createDiv({ cls: "aiac-msg aiac-error" });
    el.setText("⚠️ " + msg);
    this.scroll(s);
  }

  private summarizeArgs(call: ToolCall): string {
    try {
      const a = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      const s = (k: string): string => { const v = a[k]; return typeof v === "string" ? v : ""; };
      if (Array.isArray(a.tasks)) return `${a.tasks.length} 个子任务并行`;
      if (s("path") && s("new_path")) return `${s("path")} → ${s("new_path")}`;
      if (s("app")) return s("target") ? `${s("app")} · ${s("target")}` : s("app");
      if (s("id") && typeof a.enabled === "boolean") return `${s("id")} → ${a.enabled ? "启用" : "停用"}`;
      return s("path") || s("query") || s("folder") || s("command") || s("target") || s("id") || s("tab");
    } catch { return ""; }
  }

  private renderToolStart(s: ChatSession, parent: HTMLElement, call: ToolCall): HTMLElement {
    const delegate = call.name === DELEGATE_TOOL;
    const el = parent.createDiv({ cls: "aiac-tool" + (WRITE_TOOLS.has(call.name) ? " is-write" : "") + (delegate ? " is-delegate" : "") });
    const head = el.createDiv({ cls: "aiac-tool-head" });
    const icon = head.createSpan({ cls: "aiac-tool-icon" });
    setIcon(icon, delegate ? "users" : "loader");
    head.createSpan({ cls: "aiac-tool-name", text: TOOL_LABELS[call.name] ?? call.name });
    head.createSpan({ cls: "aiac-tool-arg", text: delegate ? "" : this.summarizeArgs(call) });
    if (delegate) this.renderDelegateCard(el, head, call);
    this.scroll(s);
    return el;
  }

  /** “派出子 Agent”卡片：标题行显示总进度，可折叠；每个子任务一行，先按参数列出全部标题 */
  private renderDelegateCard(el: HTMLElement, head: HTMLElement, call: ToolCall) {
    let tasks: { title?: unknown; instructions?: unknown }[] = [];
    try {
      const a = JSON.parse(call.arguments || "{}") as { tasks?: unknown };
      if (Array.isArray(a.tasks)) tasks = a.tasks as typeof tasks;
    } catch { /* 参数错误时由 Agent 返回错误 */ }
    tasks = tasks.filter((t) => t && typeof t.instructions === "string" && t.instructions.trim());
    head.createSpan({ cls: "aiac-delegate-progress", text: `0 / ${tasks.length} 完成` });
    const chevron = head.createSpan({ cls: "aiac-chevron" });
    setIcon(chevron, "chevron-down");
    const box = el.createDiv({ cls: "aiac-subagents" });
    head.addClass("is-clickable");
    head.setAttr("aria-label", "点击折叠 / 展开子任务");
    head.onclick = () => el.toggleClass("is-collapsed", !el.hasClass("is-collapsed"));
    tasks.forEach((t, i) => {
      const title = typeof t.title === "string" && t.title.trim() ? t.title.trim() : `子任务 ${i + 1}`;
      this.createSubRow(box, i, title, String(t.instructions));
    });
  }

  /** 一个子 Agent 的行：标题行常驻（序号、标题、实时状态、用时），点击展开指令、工具调用和报告 */
  private createSubRow(box: HTMLElement, index: number, title: string, instructions: string): HTMLElement {
    const row = box.createDiv({ cls: "aiac-sub is-waiting is-collapsed", attr: { "data-index": String(index) } });
    const head = row.createDiv({ cls: "aiac-sub-head" });
    const chevron = head.createSpan({ cls: "aiac-chevron" });
    setIcon(chevron, "chevron-right");
    const icon = head.createSpan({ cls: "aiac-sub-icon" });
    setIcon(icon, "circle");
    head.createSpan({ cls: "aiac-sub-index", text: `#${index + 1}` });
    head.createSpan({ cls: "aiac-sub-title", text: title, attr: { "aria-label": title } });
    head.createSpan({ cls: "aiac-sub-status", text: "等待中" });
    head.createSpan({ cls: "aiac-sub-time" });
    head.onclick = () => row.toggleClass("is-collapsed", !row.hasClass("is-collapsed"));
    const body = row.createDiv({ cls: "aiac-sub-body" });
    const ins = body.createDiv({ cls: "aiac-sub-instructions" });
    ins.createSpan({ cls: "aiac-sub-label", text: "指令" });
    ins.createDiv({ text: instructions });
    body.createDiv({ cls: "aiac-sub-tools" });
    this.subToolEls.set(row, new Map());
    return row;
  }

  /** 在“派出子 Agent”卡片里实时更新每个子 Agent 的进度 */
  private renderSubAgent(s: ChatSession, card: HTMLElement | undefined, index: number, e: SubAgentEvent) {
    const box = card?.querySelector<HTMLElement>(".aiac-subagents");
    if (!card || !box) return;
    const row = box.querySelector<HTMLElement>(`[data-index="${index}"]`) ?? this.createSubRow(box, index, `子任务 ${index + 1}`, "");
    const tools = this.subToolEls.get(row) ?? new Map<string, HTMLElement>();
    const status = row.querySelector(".aiac-sub-status") as HTMLElement;
    const icon = row.querySelector(".aiac-sub-icon") as HTMLElement;
    switch (e.type) {
      case "start":
        row.removeClass("is-waiting");
        row.addClass("is-running");
        row.dataset.start = String(Date.now());
        (row.querySelector(".aiac-sub-title") as HTMLElement).setText(e.title);
        icon.empty();
        this.renderDots(icon);
        status.setText("开始…");
        break;
      case "status":
        status.setText(e.text);
        break;
      case "tool-start":
        s.toolCount++;
        status.setText(`${TOOL_LABELS[e.call.name] ?? e.call.name}：${this.summarizeArgs(e.call)}`);
        tools.set(e.call.id, this.renderToolStart(s, row.querySelector(".aiac-sub-tools") as HTMLElement, e.call));
        break;
      case "tool-end":
        this.renderToolEnd(s, tools.get(e.call.id), e.call, e.result);
        break;
      case "end": {
        row.removeClass("is-running");
        row.addClass(e.ok ? "is-ok" : "is-error");
        icon.empty();
        icon.removeClass("aiac-dots");
        setIcon(icon, e.ok ? "check-circle" : "x-circle");
        const n = tools.size;
        status.setText(e.ok ? `已完成${n ? ` · ${n} 次工具调用` : ""}` : e.text.slice(0, 80));
        (row.querySelector(".aiac-sub-time") as HTMLElement).setText(formatElapsed(Date.now() - Number(row.dataset.start ?? Date.now())));
        if (e.ok && e.text) {
          const report = row.querySelector(".aiac-sub-body")?.createDiv({ cls: "aiac-sub-report" });
          if (report) {
            report.createSpan({ cls: "aiac-sub-label", text: "报告" });
            void MarkdownRenderer.render(this.app, e.text, report.createDiv(), "", this);
          }
        }
        // 出错的子任务自动展开，方便查看原因
        if (!e.ok) row.removeClass("is-collapsed");
        break;
      }
    }
    this.updateDelegateProgress(card);
    if (s === this.active) this.refreshRunState();
    this.scroll(s);
  }

  private updateDelegateProgress(card: HTMLElement) {
    const rows = card.querySelectorAll(".aiac-sub");
    const done = card.querySelectorAll(".aiac-sub.is-ok").length;
    const failed = card.querySelectorAll(".aiac-sub.is-error").length;
    const running = card.querySelectorAll(".aiac-sub.is-running").length;
    const parts = [`${done} / ${rows.length} 完成`];
    if (running) parts.push(`${running} 个运行中`);
    if (failed) parts.push(`${failed} 个失败`);
    card.querySelector(".aiac-delegate-progress")?.setText(parts.join(" · "));
  }

  private renderToolEnd(s: ChatSession, el: HTMLElement | undefined, call: ToolCall, result: ToolResult) {
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
          const what = c.kind === "control" ? `你的操作「${c.path}」` : `你对 ${c.path} 的这次修改「${TOOL_LABELS[call.name] ?? call.name}」`;
          s.agent.messages.push({ role: "user", content: `（系统提示：用户撤销了${what}，已恢复原状。）` });
        } catch (e) {
          new Notice("撤销失败：" + (e as Error).message);
        }
      };
      if (c.kind === "write" || c.kind === "move") {
        const open = head.createEl("button", { cls: "aiac-undo", text: "打开" });
        open.onclick = (ev) => { ev.stopPropagation(); void this.app.workspace.openLinkText(c.path, "", false); };
      }
    }

    // 子 Agent 的进度已经显示在卡片里，不再重复显示汇总结果
    if (this.plugin.settings.showToolDetails && call.name !== DELEGATE_TOOL) {
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
    this.scroll(s);
  }
}
