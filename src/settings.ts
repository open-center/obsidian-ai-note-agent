import { App, FuzzySuggestModal, Notice, PluginSettingTab, Setting } from "obsidian";
import type AIAgentPlugin from "./main";
import { chat, listModels, ProviderConfig, ProviderKind, ReasoningEffort } from "./llm";

export type ConfirmMode = "always" | "never";
export type PanelPosition = "right-split" | "right-tab" | "left-split" | "main-split";

export interface AgentSettings {
  providers: ProviderConfig[];
  activeProviderId: string;
  systemPrompt: string;
  confirmMode: ConfirmMode;
  maxSteps: number;
  maxReadChars: number;
  showToolDetails: boolean;
  panelPosition: PanelPosition;
  /** 上一次实际应用的面板位置，用于在设置变化或升级后把面板挪到新位置 */
  appliedPanelPosition: string;
  /** 是否已把 OpenAI 官方地址迁移到 Responses 接口 */
  migratedResponses?: boolean;
}

export interface Preset {
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
}

/** 常见提供商预设。模型名可以在设置页随时修改或点击“选择模型”拉取。 */
export const PRESETS: Preset[] = [
  { label: "OpenAI", kind: "openai-responses", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
  { label: "Anthropic (Claude)", kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" },
  { label: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { label: "Google Gemini (OpenAI 兼容)", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash" },
  { label: "Moonshot / Kimi", kind: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2-0905-preview" },
  { label: "阿里通义千问 (DashScope)", kind: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { label: "智谱 GLM", kind: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6" },
  { label: "硅基流动 SiliconFlow", kind: "openai", baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3" },
  { label: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o" },
  { label: "Ollama（本地）", kind: "openai", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
  { label: "自定义 OpenAI 兼容", kind: "openai", baseUrl: "https://", model: "" },
];

export const DEFAULT_SYSTEM_PROMPT = `你是嵌入在 Obsidian 中的笔记助手（Agent）。你可以通过工具读取、搜索、创建和修改用户仓库（vault）里的 Markdown 笔记。

工作原则：
1. 修改笔记前，先用 read_note 或 get_current_note 读取最新内容，不要凭记忆改写。
2. 局部修改优先使用 edit_note（精确的 old_text → new_text 替换），只有在需要整体重写时才用 write_note。
3. 保留用户原有的格式：YAML frontmatter、[[双链]]、#标签、callout、代码块等。
4. 用户说“这篇笔记/当前笔记/这段”时，指的是上下文中给出的当前笔记或选中文本。
5. 不确定用户意图、或操作会大量删除内容时，先说明计划再执行。
6. 完成后用简短的中文说明你做了哪些修改。`;

export function newProviderFromPreset(p: Preset): ProviderConfig {
  return {
    id: Math.random().toString(36).slice(2, 10),
    name: p.label,
    kind: p.kind,
    baseUrl: p.baseUrl,
    apiKey: "",
    model: p.model,
    temperature: -1,
    maxTokens: 0,
  };
}

export const DEFAULT_SETTINGS: AgentSettings = {
  providers: [newProviderFromPreset(PRESETS[0])],
  activeProviderId: "",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  confirmMode: "always",
  maxSteps: 20,
  maxReadChars: 40000,
  showToolDetails: true,
  panelPosition: "right-split",
  appliedPanelPosition: "",
};

export class AgentSettingTab extends PluginSettingTab {
  plugin: AIAgentPlugin;
  private presetIndex = 0;
  private activeSelect: HTMLSelectElement | null = null;

  /** 名称/模型改动后，立即刷新“当前使用”下拉框（聊天面板由 saveSettings 刷新） */
  private refreshActiveSelect() {
    const sel = this.activeSelect;
    if (!sel) return;
    const s = this.plugin.settings;
    sel.empty();
    for (const p of s.providers) sel.createEl("option", { value: p.id, text: `${p.name} · ${p.model || "未设置模型"}` });
    sel.value = this.plugin.activeProvider()?.id ?? "";
  }

  constructor(app: App, plugin: AIAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();


    // ---------- 模型提供商 ----------
    new Setting(containerEl).setName("模型提供商").setHeading();

    new Setting(containerEl)
      .setName("当前使用")
      .setDesc("聊天面板顶部也可以切换")
      .addDropdown((d) => {
        for (const p of s.providers) d.addOption(p.id, `${p.name} · ${p.model || "未设置模型"}`);
        d.setValue(this.plugin.activeProvider()?.id ?? "");
        this.activeSelect = d.selectEl;
        d.onChange(async (v) => {
          s.activeProviderId = v;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("添加提供商")
      .setDesc("从预设创建，之后可修改地址和模型")
      .addDropdown((d) => {
        PRESETS.forEach((p, i) => d.addOption(String(i), p.label));
        d.setValue(String(this.presetIndex));
        d.onChange((v) => (this.presetIndex = Number(v)));
      })
      .addButton((b) =>
        b.setButtonText("添加").setCta().onClick(async () => {
          const p = newProviderFromPreset(PRESETS[this.presetIndex]);
          s.providers.push(p);
          if (!s.activeProviderId) s.activeProviderId = p.id;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    for (const p of s.providers) this.renderProvider(containerEl, p);

    // ---------- 界面 ----------
    new Setting(containerEl).setName("界面").setHeading();
    new Setting(containerEl)
      .setName("面板位置")
      .setDesc("“右侧边栏（上下分屏）”会让 Agent 和大纲等面板同时显示，不再互相遮挡。也可以直接拖动面板的标签到任意位置。")
      .addDropdown((d) =>
        d
          .addOption("right-split", "右侧边栏 · 上下分屏（推荐）")
          .addOption("right-tab", "右侧边栏 · 作为标签页")
          .addOption("left-split", "左侧边栏 · 文件列表下方")
          .addOption("main-split", "编辑区 · 左右分屏")
          .setValue(s.panelPosition)
          .onChange(async (v) => {
            s.panelPosition = v as PanelPosition;
            await this.plugin.saveSettings();
            await this.plugin.relocateView();
          }),
      );

    // ---------- Agent 行为 ----------
    new Setting(containerEl).setName("Agent 行为").setHeading();

    new Setting(containerEl)
      .setName("修改笔记前确认")
      .setDesc("“每次确认”会弹出差异对比，由你决定是否应用；“自动应用”直接写入（每次修改仍可在聊天面板中撤销）。删除操作始终需要确认。")
      .addDropdown((d) =>
        d
          .addOption("always", "每次确认（推荐）")
          .addOption("never", "自动应用")
          .setValue(s.confirmMode)
          .onChange(async (v) => {
            s.confirmMode = v as ConfirmMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("单次最多步骤数")
      .setDesc("一次请求中 Agent 最多调用多少轮工具，防止死循环")
      .addText((t) =>
        t.setValue(String(s.maxSteps)).onChange(async (v) => {
          const n = parseInt(v);
          if (n > 0) { s.maxSteps = n; await this.plugin.saveSettings(); }
        }),
      );

    new Setting(containerEl)
      .setName("单篇笔记最多读取字符数")
      .setDesc("超长笔记会被截断后再发给模型，节省 token")
      .addText((t) =>
        t.setValue(String(s.maxReadChars)).onChange(async (v) => {
          const n = parseInt(v);
          if (n > 0) { s.maxReadChars = n; await this.plugin.saveSettings(); }
        }),
      );

    new Setting(containerEl)
      .setName("显示工具调用详情")
      .addToggle((t) =>
        t.setValue(s.showToolDetails).onChange(async (v) => {
          s.showToolDetails = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("系统提示词")
      .setDesc("定义 Agent 的角色和规则")
      .addExtraButton((b) =>
        b.setIcon("rotate-ccw").setTooltip("恢复默认").onClick(async () => {
          s.systemPrompt = DEFAULT_SYSTEM_PROMPT;
          await this.plugin.saveSettings();
          this.display();
        }),
      );
    const ta = containerEl.createEl("textarea", { cls: "aiac-system-prompt" });
    ta.value = s.systemPrompt;
    ta.addEventListener("change", async () => {
      s.systemPrompt = ta.value;
      await this.plugin.saveSettings();
    });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: `提示：API Key 以明文保存在 ${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}/data.json 中。如果你同步或公开仓库，请注意不要泄露该文件。`,
    });
  }

  private renderProvider(containerEl: HTMLElement, p: ProviderConfig) {
    const s = this.plugin.settings;
    const box = containerEl.createDiv({ cls: "aiac-provider-box" });
    const isActive = this.plugin.activeProvider()?.id === p.id;

    new Setting(box)
      .setName(`${p.name}${isActive ? "（当前）" : ""}`)
      .setHeading()
      .addButton((b) =>
        b.setButtonText("测试连接").onClick(async () => {
          b.setDisabled(true).setButtonText("测试中…");
          try {
            const r = await chat(p, "You are a helpful assistant.", [{ role: "user", content: "Reply with: OK" }], []);
            new Notice(`✅ ${p.name} 连接成功：${r.content.slice(0, 60)}`);
          } catch (e) {
            new Notice(`❌ ${p.name} 连接失败：${(e as Error).message}`, 10000);
          } finally {
            b.setDisabled(false).setButtonText("测试连接");
          }
        }),
      )
      .addExtraButton((b) =>
        b.setIcon("trash").setTooltip("删除该提供商").onClick(async () => {
          s.providers = s.providers.filter((x) => x.id !== p.id);
          if (s.activeProviderId === p.id) s.activeProviderId = s.providers[0]?.id ?? "";
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    new Setting(box).setName("名称").addText((t) =>
      t.setValue(p.name).onChange(async (v) => { p.name = v; await this.plugin.saveSettings(); this.refreshActiveSelect(); }),
    );

    new Setting(box)
      .setName("接口协议")
      .setDesc("OpenAI 官方（尤其是推理模型）选 Responses；DeepSeek、Kimi、通义等第三方选 OpenAI 兼容；Claude 官方选 Anthropic")
      .addDropdown((d) =>
        d
          .addOption("openai-responses", "OpenAI Responses（OpenAI 官方，推荐）")
          .addOption("openai", "OpenAI 兼容 Chat Completions")
          .addOption("anthropic", "Anthropic")
          .setValue(p.kind).onChange(async (v) => {
          p.kind = v as ProviderKind;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    new Setting(box)
      .setName("Base URL")
      .setDesc(p.kind === "anthropic" ? "例如 https://api.anthropic.com" : "例如 https://api.openai.com/v1（不要带 /chat/completions）")
      .addText((t) => t.setValue(p.baseUrl).onChange(async (v) => { p.baseUrl = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(box).setName("API key").addText((t) => {
      t.inputEl.type = "password";
      t.setPlaceholder("sk-...").setValue(p.apiKey).onChange(async (v) => { p.apiKey = v.trim(); await this.plugin.saveSettings(); });
    });

    const modelSetting = new Setting(box).setName("模型").setDesc("需要支持工具调用（function calling）的模型");
    let modelInput: HTMLInputElement;
    modelSetting.addText((t) => {
      modelInput = t.inputEl;
      t.setValue(p.model).onChange(async (v) => { p.model = v.trim(); await this.plugin.saveSettings(); this.refreshActiveSelect(); });
    });
    modelSetting.addButton((b) =>
      b.setButtonText("应用").setCta().onClick(async () => {
        p.model = modelInput.value.trim();
        s.activeProviderId = p.id;
        await this.plugin.saveSettings();
        new Notice(`✅ 已切换为 ${p.name} · ${p.model || "未设置模型"}`);
        this.display();
      }),
    );
    modelSetting.addButton((b) =>
      b.setButtonText("选择模型").onClick(async () => {
        b.setDisabled(true).setButtonText("获取中…");
        try {
          const models = await listModels(p);
          new ModelPickerModal(this.app, models, async (m) => {
            p.model = m;
            modelInput.value = m;
            await this.plugin.saveSettings();
            this.refreshActiveSelect();
            new Notice(`已选择模型：${m}`);
          }).open();
        } catch (e) {
          new Notice(`获取模型失败：${(e as Error).message}`, 8000);
        } finally {
          b.setDisabled(false).setButtonText("选择模型");
        }
      }),
    );

    new Setting(box)
      .setName("推理强度")
      .setDesc("仅对推理模型（如 GPT-5 / o 系列）有效。越高越聪明但越慢越贵；改笔记这类任务通常 low 或 medium 就够。")
      .addDropdown((d) =>
        d
          .addOption("", "模型默认")
          .addOption("none", "none（关闭推理）")
          .addOption("minimal", "minimal")
          .addOption("low", "low")
          .addOption("medium", "medium")
          .addOption("high", "high")
          .setValue(p.reasoningEffort ?? "")
          .onChange(async (v) => {
            p.reasoningEffort = v as ReasoningEffort;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(box)
      .setName("温度 / 最大输出 token")
      .setDesc("温度填 -1 表示使用模型默认值；最大 token 填 0 表示默认")
      .addText((t) =>
        t.setValue(String(p.temperature)).onChange(async (v) => {
          const n = parseFloat(v);
          if (!isNaN(n)) { p.temperature = n; await this.plugin.saveSettings(); }
        }),
      )
      .addText((t) =>
        t.setValue(String(p.maxTokens)).onChange(async (v) => {
          const n = parseInt(v);
          if (!isNaN(n)) { p.maxTokens = n; await this.plugin.saveSettings(); }
        }),
      );
  }
}

/** 不适合对话/工具调用的模型（语音、绘图、向量等），排到列表末尾 */
const NON_CHAT = /(tts|transcribe|whisper|embedding|embed|dall-e|image|moderation|realtime|audio|search-preview|davinci|babbage)/i;

class ModelPickerModal extends FuzzySuggestModal<string> {
  private models: string[];
  constructor(app: App, models: string[], private onPick: (m: string) => void) {
    super(app);
    // 对话模型在前，同组内按名称倒序（新版本号通常排在前面）
    this.models = [...models].sort((a, b) => {
      const na = NON_CHAT.test(a) ? 1 : 0, nb = NON_CHAT.test(b) ? 1 : 0;
      return na - nb || b.localeCompare(a, undefined, { numeric: true });
    });
    this.setPlaceholder(`共 ${models.length} 个模型，输入关键词搜索（如 sol、6.1、mini）`);
  }
  getItems() { return this.models; }
  getItemText(m: string) { return m; }
  onChooseItem(m: string) { this.onPick(m); }
}
