import { MarkdownView, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { AgentSettings, AgentSettingTab, DEFAULT_SETTINGS } from "./settings";
import type { ProviderConfig } from "./llm";
import { EditorContext, VaultTools } from "./tools";
import { AgentView, VIEW_TYPE } from "./view";
import { migrateApiKeys } from "./secrets";
import { normalizePermissions, PermissionGate } from "./permissions";

export default class AIAgentPlugin extends Plugin {
  settings!: AgentSettings;
  tools!: VaultTools;
  permissions!: PermissionGate;
  /** 用户切换到聊天面板前，最后一次聚焦的 Markdown 编辑器 */
  private lastMarkdownView: MarkdownView | null = null;

  async onload() {
    await this.loadSettings();
    this.permissions = new PermissionGate(this.app, () => this.settings, () => this.saveSettings());
    this.tools = new VaultTools(this.app, () => this.settings, () => this.editorContext(), this.permissions, this.manifest.id, () => this.markdownView());

    this.registerView(VIEW_TYPE, (leaf) => new AgentView(leaf, this));
    this.addRibbonIcon("bot", "打开 AI 对话面板", () => void this.activateView());
    this.addSettingTab(new AgentSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) this.lastMarkdownView = leaf.view;
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      const v = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (v) this.lastMarkdownView = v;
      // 升级或修改设置后，把已有的面板挪到设定的位置
      if (this.settings.appliedPanelPosition !== this.settings.panelPosition && this.app.workspace.getLeavesOfType(VIEW_TYPE).length) {
        void this.relocateView();
      }
    });

    this.addCommand({ id: "open-agent", name: "打开对话面板", callback: () => this.activateView() });
    this.addCommand({
      id: "new-chat",
      name: "新建对话",
      callback: async () => (await this.activateView())?.newChat(),
    });
    this.addCommand({
      id: "ask-about-selection",
      name: "对选中文本提问 / 下指令",
      editorCallback: async (editor) => {
        const view = await this.activateView();
        view?.refreshContext();
        view?.setInput(editor.getSelection() ? "请处理我选中的文本：" : "");
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        if (!editor.getSelection()) return;
        menu.addItem((item) =>
          item.setTitle("发送给 AI 助手").setIcon("bot").onClick(async () => {
            const view = await this.activateView();
            view?.refreshContext();
            view?.setInput("请处理我选中的文本：");
          }),
        );
      }),
    );
  }

  onunload() {}

  /** 用户最后打开的 Markdown 编辑器（已关闭则为 null） */
  markdownView(): MarkdownView | null {
    const view = this.lastMarkdownView;
    return view && view.file ? view : null;
  }

  editorContext(): EditorContext {
    const view = this.markdownView();
    const file: TFile | null = view?.file ?? this.app.workspace.getActiveFile();
    let selection = "";
    try { selection = view?.editor?.getSelection() ?? ""; } catch { /* ignore */ }
    return { file, selection };
  }

  activeProvider(): ProviderConfig | undefined {
    const s = this.settings;
    return s.providers.find((p) => p.id === s.activeProviderId) ?? s.providers[0];
  }

  /** 按设置的位置创建一个新的叶子 */
  private createLeafForPosition(): WorkspaceLeaf | null {
    const ws = this.app.workspace;
    switch (this.settings.panelPosition) {
      case "right-tab": return ws.getRightLeaf(false);
      case "left-split": return ws.getLeftLeaf(true);
      case "main-split": return ws.getLeaf("split", "vertical");
      case "right-split":
      default: return ws.getRightLeaf(true);
    }
  }

  async activateView(): Promise<AgentView | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = this.createLeafForPosition();
      if (!leaf) return null;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      if (this.settings.appliedPanelPosition !== this.settings.panelPosition) {
        this.settings.appliedPanelPosition = this.settings.panelPosition;
        await this.saveData(this.settings);
      }
    }
    await workspace.revealLeaf(leaf);
    return leaf.view instanceof AgentView ? leaf.view : null;
  }

  /** 关闭现有面板并在新位置重新打开（对话内容会保留） */
  async relocateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const oldView = leaves[0]?.view instanceof AgentView ? leaves[0].view : null;
    const sessions = oldView ? oldView.takeSessions() : [];
    for (const l of leaves) l.detach();
    this.settings.appliedPanelPosition = "";
    const view = await this.activateView();
    view?.restoreSessions(sessions);
  }

  async loadSettings() {
    const data = ((await this.loadData()) ?? {}) as Partial<AgentSettings>;
    this.settings = { ...DEFAULT_SETTINGS, ...data };
    if (!Array.isArray(this.settings.providers)) this.settings.providers = DEFAULT_SETTINGS.providers;
    normalizePermissions(this.settings);
    if (!this.settings.activeProviderId && this.settings.providers[0]) this.settings.activeProviderId = this.settings.providers[0].id;
    // 迁移：OpenAI 官方地址默认改用 Responses 接口（推理模型 + 工具调用必须走这个接口）
    if (!this.settings.migratedResponses) {
      for (const p of this.settings.providers) {
        if (p.kind === "openai" && /^https:\/\/api\.openai\.com/.test(p.baseUrl)) p.kind = "openai-responses";
      }
      this.settings.migratedResponses = true;
      await this.saveData(this.settings);
    }
    // 迁移：把 data.json 里的明文 API key 移到 Obsidian 的系统密钥存储（Obsidian 1.11.4+）
    if (migrateApiKeys(this.app, this.settings.providers)) await this.saveData(this.settings);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof AgentView) { leaf.view.refreshProviders(); leaf.view.refreshPermissionMode(); }
    }
  }
}
