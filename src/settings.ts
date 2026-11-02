import { App, FuzzySuggestModal, Notice, PluginSettingTab, requireApiVersion, Setting } from "obsidian";
import type { SettingDefinitionItem, SettingDefinitionPage } from "obsidian";
import type AIAgentPlugin from "./main";
import { chat, listModels, ProviderConfig, ProviderKind, ReasoningEffort } from "./llm";
import { clearApiKey, keyStorageDescription, readApiKey, withApiKey, writeApiKey } from "./secrets";
import { ConfirmMode, PERMISSION_KEYS, PERMISSION_LABELS, PermissionKey } from "./permissions";

export type PanelPosition = "right-split" | "right-tab" | "left-split" | "main-split";

export interface AgentSettings {
  providers: ProviderConfig[];
  activeProviderId: string;
  systemPrompt: string;
  /** 权限模式：手动确认 / 按授权执行 / 自动执行 */
  confirmMode: ConfirmMode;
  /** “按授权执行”模式下无需确认的操作类型 */
  grantedPermissions: PermissionKey[];
  maxSteps: number;
  maxReadChars: number;
  showToolDetails: boolean;
  /** 是否允许 Agent 控制本地软件（启动应用、打开文件、执行命令），仅桌面端 */
  allowSystemControl: boolean;
  /** 是否允许 Agent 控制 Obsidian 本身（执行命令、启用/停用插件、修改设置） */
  allowObsidianControl: boolean;
  /** 是否允许主 Agent 把任务拆分给多个子 Agent 并行执行 */
  allowSubAgents: boolean;
  /** 对话超过多少 token 时自动压缩较早的历史，0 表示不压缩 */
  contextBudget: number;
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
  confirmMode: "manual",
  grantedPermissions: [],
  maxSteps: 20,
  maxReadChars: 40000,
  showToolDetails: true,
  allowSystemControl: false,
  allowObsidianControl: true,
  allowSubAgents: true,
  contextBudget: 80000,
  panelPosition: "right-split",
  appliedPanelPosition: "",
};

// ---------- 共享的文案与选项（新旧两套设置页共用，避免两处不一致） ----------

const KIND_LABELS: Record<ProviderKind, string> = {
  "openai-responses": "官方 OpenAI 接口（推荐）",
  openai: "OpenAI 兼容接口（第三方）",
  anthropic: "Anthropic",
};

const PANEL_OPTIONS: Record<PanelPosition, string> = {
  "right-split": "右侧边栏 · 上下分屏（推荐）",
  "right-tab": "右侧边栏 · 作为标签页",
  "left-split": "左侧边栏 · 文件列表下方",
  "main-split": "编辑区 · 左右分屏",
};

const CONFIRM_OPTIONS: Record<ConfirmMode, string> = {
  manual: "手动确认（推荐）",
  grant: "按授权执行",
  auto: "自动执行",
};

/** 声明式设置页中授权开关的 key 前缀 */
const GRANT_PREFIX = "grant:";

const REASONING_OPTIONS: Record<string, string> = {
  "": "模型默认",
  none: "None（关闭推理）",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
};

const TEXT = {
  activeDesc: "聊天面板顶部也可以切换",
  panelDesc: "“右侧边栏（上下分屏）”会让对话面板和大纲等面板同时显示，不再互相遮挡。也可以直接拖动面板的标签到任意位置。",
  confirmDesc: "“手动确认”每次操作都弹窗，由你决定是否执行；“按授权执行”对下方勾选的操作直接执行，其余仍弹窗；“自动执行”所有操作都直接执行，不再询问。修改仍可在聊天面板中撤销。聊天面板底部也可以切换。",
  grantDesc: "在“按授权执行”模式下，勾选的操作直接执行。确认弹窗中点击“始终允许此类操作”也会勾选对应项。",
  maxStepsDesc: "一次请求中助手最多调用多少轮工具，防止死循环",
  contextDesc: "对话越长，每次请求发给模型的 token 越多，越慢也越容易触发限流。估算超过这个数的一半时，先截短较早的工具结果和附件；超过这个数时，把较早的对话交给模型总结成摘要，只保留最近的消息原文。填 0 关闭压缩。",
  maxReadDesc: "超长笔记会被截断后再发给模型，节省 token",
  promptDesc: "定义助手的角色和规则",
  obsidianControlDesc: "允许 Agent 执行 Obsidian 命令、启用或停用核心插件和第三方插件、读取和修改应用及插件设置。每次改动都会先弹窗确认，并可在聊天中撤销；疑似密钥的设置项会打码后再给模型；不能控制本插件自身。",
  subAgentsDesc: "允许 Agent 把大任务拆成多个子任务，同时派给多个子 Agent 并行执行（例如批量整理多篇笔记），完成后汇总结果。子 Agent 使用同一个模型和同样的权限设置，会消耗更多 token。",
  systemControlDesc: "允许 Agent 启动本地应用、用默认程序打开文件或网址、执行 shell 命令（macOS 上还可通过 AppleScript 控制其他应用）。每次操作都会先弹窗显示具体命令，由你确认后才执行。命令以你的用户权限运行，请只在信任所用模型时开启。仅桌面版可用。",
  kindDesc: "OpenAI 官方（尤其是推理模型）选第一项；其他第三方服务选兼容接口；Claude 官方选 Anthropic",
  modelDesc: "需要支持工具调用（function calling）的模型",
  reasoningDesc: "仅对推理模型（如 GPT-5 / o 系列）有效。越高越聪明但越慢越贵；改笔记这类任务通常 low 或 medium 就够。",
  tempDesc: "温度填 -1 表示使用模型默认值；最大 token 填 0 表示默认",
};

/** 一行设置：名称、说明、搜索别名，以及填充这一行的渲染函数 */
interface SettingRow {
  name: string;
  desc?: string;
  aliases?: string[];
  render: (setting: Setting) => void;
}

function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)/.test(url);
}

export class AgentSettingTab extends PluginSettingTab {
  plugin: AIAgentPlugin;
  private presetIndex = 0;
  private activeSelect: HTMLSelectElement | null = null;

  constructor(app: App, plugin: AIAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // =====================================================================
  // Obsidian 1.13+：声明式设置。设置项会出现在 Obsidian 的设置搜索里。
  // =====================================================================

  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    return [
      {
        type: "group",
        heading: "模型提供商",
        items: [
          {
            name: "当前使用",
            desc: TEXT.activeDesc,
            aliases: ["provider", "model", "AI", "提供商", "模型"],
            control: { type: "dropdown", key: "activeProviderId", options: this.providerOptions() },
          },
        ],
      },
      {
        type: "list",
        heading: "已配置的提供商",
        emptyState: "还没有提供商，点击右上角的 ＋ 添加",
        addItem: {
          name: "添加提供商",
          action: () => new PresetPickerModal(this.app, (preset) => void this.addProvider(preset)).open(),
        },
        onDelete: (index) => void this.deleteProvider(index),
        items: s.providers.map((p): SettingDefinitionPage => ({
          type: "page",
          name: p.name || "未命名提供商",
          desc: KIND_LABELS[p.kind],
          displayValue: () => p.model || "未设置模型",
          status: () => (!readApiKey(this.app, p) && !isLocalUrl(p.baseUrl) ? "warning" : null),
          items: [
            {
              type: "group",
              items: this.providerRows(p).map((row) => ({
                name: row.name,
                desc: row.desc,
                aliases: row.aliases,
                render: (setting: Setting) => row.render(setting),
              })),
            },
          ],
        })),
      },
      {
        type: "group",
        heading: "界面",
        items: [
          {
            name: "面板位置",
            desc: TEXT.panelDesc,
            aliases: ["panel", "sidebar", "侧边栏", "布局"],
            control: { type: "dropdown", key: "panelPosition", options: PANEL_OPTIONS },
          },
        ],
      },
      {
        type: "group",
        heading: "Agent 行为",
        extraButtons: [
          (b) =>
            b.setIcon("rotate-ccw").setTooltip("恢复默认系统提示词").onClick(async () => {
              s.systemPrompt = DEFAULT_SYSTEM_PROMPT;
              await this.plugin.saveSettings();
              this.rerender();
            }),
        ],
        items: [
          {
            name: "权限模式",
            desc: TEXT.confirmDesc,
            aliases: ["confirm", "permission", "auto", "确认", "权限", "授权", "自动"],
            control: { type: "dropdown", key: "confirmMode", options: CONFIRM_OPTIONS },
          },
          {
            name: "单次最多步骤数",
            desc: TEXT.maxStepsDesc,
            control: {
              type: "number",
              key: "maxSteps",
              min: 1,
              max: 200,
              step: 1,
              defaultValue: DEFAULT_SETTINGS.maxSteps,
              validate: (v) => (Number.isInteger(v) && v > 0 ? undefined : "请输入大于 0 的整数"),
            },
          },
          {
            name: "自动压缩上下文的阈值（token）",
            desc: TEXT.contextDesc,
            aliases: ["context", "compact", "token", "rate limit", "上下文", "压缩", "限流"],
            control: {
              type: "number",
              key: "contextBudget",
              min: 0,
              step: 10000,
              defaultValue: DEFAULT_SETTINGS.contextBudget,
              validate: (v) => (Number.isInteger(v) && (v === 0 || v >= 10000) ? undefined : "请输入 0 或不小于 10000 的整数"),
            },
          },
          {
            name: "单篇笔记最多读取字符数",
            desc: TEXT.maxReadDesc,
            control: {
              type: "number",
              key: "maxReadChars",
              min: 1000,
              step: 1000,
              defaultValue: DEFAULT_SETTINGS.maxReadChars,
              validate: (v) => (Number.isInteger(v) && v >= 1000 ? undefined : "请输入不小于 1000 的整数"),
            },
          },
          {
            name: "显示工具调用详情",
            control: { type: "toggle", key: "showToolDetails" },
          },
          {
            name: "允许控制 Obsidian",
            desc: TEXT.obsidianControlDesc,
            aliases: ["command", "plugin", "settings", "命令", "插件", "设置"],
            control: { type: "toggle", key: "allowObsidianControl" },
          },
          {
            name: "允许派出子代理",
            desc: TEXT.subAgentsDesc,
            aliases: ["multi agent", "sub agent", "多 agent", "子 agent", "并行"],
            control: { type: "toggle", key: "allowSubAgents" },
          },
          {
            name: "允许控制本地软件",
            desc: TEXT.systemControlDesc,
            aliases: ["shell", "command", "terminal", "app", "本地", "命令", "终端", "应用"],
            control: { type: "toggle", key: "allowSystemControl" },
          },
          {
            name: "系统提示词",
            desc: TEXT.promptDesc,
            aliases: ["system prompt", "prompt", "提示词"],
            control: { type: "textarea", key: "systemPrompt", rows: 12 },
          },
        ],
      },
      {
        type: "group",
        heading: "授权的操作",
        items: PERMISSION_KEYS.map((k) => ({
          name: PERMISSION_LABELS[k],
          aliases: ["permission", "授权", "权限"],
          control: { type: "toggle" as const, key: GRANT_PREFIX + k },
        })),
      },
      {
        name: "API key 的存储位置",
        desc: this.keyStorageNote(),
        aliases: ["api key", "密钥", "安全"],
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (key.startsWith(GRANT_PREFIX)) return this.plugin.settings.grantedPermissions.includes(key.slice(GRANT_PREFIX.length) as PermissionKey);
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key.startsWith(GRANT_PREFIX)) {
      await this.setGranted(key.slice(GRANT_PREFIX.length) as PermissionKey, value === true);
      return;
    }
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    await this.plugin.saveSettings();
    if (key === "panelPosition") await this.plugin.relocateView();
  }

  private async setGranted(key: PermissionKey, on: boolean) {
    const s = this.plugin.settings;
    s.grantedPermissions = s.grantedPermissions.filter((k) => k !== key);
    if (on) s.grantedPermissions.push(key);
    await this.plugin.saveSettings();
  }

  /**
   * 结构性变化（增删提供商等）后重新渲染。
   * Obsidian 1.13+ 提供 update()（重新读取 getSettingDefinitions 并渲染）；更早的版本没有该方法，退回 display()。
   * 用运行时特性检测而不是直接调用，保证在 minAppVersion（1.7.2）以上的所有版本都能正常工作。
   */
  private rerender() {
    const tab = this as unknown as { update?: () => void; display: () => void };
    if (typeof tab.update === "function" && requireApiVersion("1.13.0")) tab.update();
    else tab.display();
  }

  private providerOptions(): Record<string, string> {
    const options: Record<string, string> = {};
    for (const p of this.plugin.settings.providers) options[p.id] = `${p.name} · ${p.model || "未设置模型"}`;
    return options;
  }

  private keyStorageNote(): string {
    return keyStorageDescription(this.app, this.plugin.manifest.id);
  }

  private async addProvider(preset: Preset) {
    const s = this.plugin.settings;
    const p = newProviderFromPreset(preset);
    s.providers.push(p);
    if (!s.activeProviderId) s.activeProviderId = p.id;
    await this.plugin.saveSettings();
    this.rerender();
  }

  private async deleteProvider(index: number) {
    const s = this.plugin.settings;
    const [removed] = s.providers.splice(index, 1);
    if (removed) clearApiKey(this.app, removed);
    if (removed && s.activeProviderId === removed.id) s.activeProviderId = s.providers[0]?.id ?? "";
    await this.plugin.saveSettings();
    this.rerender();
  }

  /** 名称/模型改动后，立即刷新旧版设置页里的“当前使用”下拉框（聊天面板由 saveSettings 刷新） */
  private refreshActiveSelect() {
    const sel = this.activeSelect;
    if (!sel) return;
    sel.empty();
    for (const [id, label] of Object.entries(this.providerOptions())) sel.createEl("option", { value: id, text: label });
    sel.value = this.plugin.activeProvider()?.id ?? "";
  }

  /** 单个提供商的所有设置行。新旧两套设置页共用这一份定义。 */
  private providerRows(p: ProviderConfig): SettingRow[] {
    const save = () => this.plugin.saveSettings();
    let modelInput: HTMLInputElement | null = null;
    return [
      {
        name: "名称",
        render: (setting) => {
          setting.addText((t) =>
            t.setValue(p.name).onChange(async (v) => {
              p.name = v;
              await save();
              this.refreshActiveSelect();
            }),
          );
        },
      },
      {
        name: "接口协议",
        desc: TEXT.kindDesc,
        render: (setting) => {
          setting.addDropdown((d) => {
            for (const [k, label] of Object.entries(KIND_LABELS)) d.addOption(k, label);
            d.setValue(p.kind).onChange(async (v) => {
              p.kind = v as ProviderKind;
              await save();
              this.rerender();
            });
          });
        },
      },
      {
        name: "Base URL",
        desc: p.kind === "anthropic" ? "例如 https://api.anthropic.com" : "例如 https://api.openai.com/v1（不要带 /chat/completions）",
        aliases: ["endpoint", "url", "接口地址"],
        render: (setting) => {
          setting.addText((t) => t.setValue(p.baseUrl).onChange(async (v) => { p.baseUrl = v.trim(); await save(); }));
        },
      },
      {
        name: "API key",
        aliases: ["key", "token", "密钥"],
        render: (setting) => {
          setting.addText((t) => {
            t.inputEl.type = "password";
            t.setValue(readApiKey(this.app, p)).onChange(async (v) => {
              try {
                writeApiKey(this.app, p, v.trim());
              } catch (e) {
                new Notice(`API key 保存失败：${(e as Error).message}`, 8000);
                return;
              }
              await save();
            });
          });
        },
      },
      {
        name: "模型",
        desc: TEXT.modelDesc,
        aliases: ["model"],
        render: (setting) => {
          setting.addText((t) => {
            modelInput = t.inputEl;
            t.setValue(p.model).onChange(async (v) => {
              p.model = v.trim();
              await save();
              this.refreshActiveSelect();
            });
          });
          setting.addButton((b) =>
            b.setButtonText("应用").setCta().onClick(async () => {
              if (modelInput) p.model = modelInput.value.trim();
              this.plugin.settings.activeProviderId = p.id;
              await save();
              new Notice(`✅ 已切换为 ${p.name} · ${p.model || "未设置模型"}`);
              this.rerender();
            }),
          );
          setting.addButton((b) =>
            b.setButtonText("选择模型").onClick(async () => {
              b.setDisabled(true).setButtonText("获取中…");
              try {
                const models = await listModels(withApiKey(this.app, p));
                new ModelPickerModal(this.app, models, async (m) => {
                  p.model = m;
                  if (modelInput) modelInput.value = m;
                  await save();
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
        },
      },
      {
        name: "推理强度",
        desc: TEXT.reasoningDesc,
        aliases: ["reasoning effort", "reasoning"],
        render: (setting) => {
          setting.addDropdown((d) => {
            for (const [k, label] of Object.entries(REASONING_OPTIONS)) d.addOption(k, label);
            d.setValue(p.reasoningEffort ?? "").onChange(async (v) => {
              p.reasoningEffort = v as ReasoningEffort;
              await save();
            });
          });
        },
      },
      {
        name: "温度 / 最大输出 token",
        desc: TEXT.tempDesc,
        aliases: ["temperature", "max tokens"],
        render: (setting) => {
          setting
            .addText((t) =>
              t.setValue(String(p.temperature)).onChange(async (v) => {
                const n = parseFloat(v);
                if (!isNaN(n)) { p.temperature = n; await save(); }
              }),
            )
            .addText((t) =>
              t.setValue(String(p.maxTokens)).onChange(async (v) => {
                const n = parseInt(v);
                if (!isNaN(n)) { p.maxTokens = n; await save(); }
              }),
            );
        },
      },
      {
        name: "测试连接",
        desc: "发送一条简短请求，检查地址、API key 和模型是否可用",
        render: (setting) => {
          setting.addButton((b) =>
            b.setButtonText("测试连接").onClick(async () => {
              b.setDisabled(true).setButtonText("测试中…");
              try {
                const r = await chat(withApiKey(this.app, p), "You are a helpful assistant.", [{ role: "user", content: "Reply with: OK" }], []);
                new Notice(`✅ ${p.name} 连接成功：${r.content.slice(0, 60)}`);
              } catch (e) {
                new Notice(`❌ ${p.name} 连接失败：${(e as Error).message}`, 10000);
              } finally {
                b.setDisabled(false).setButtonText("测试连接");
              }
            }),
          );
        },
      },
    ];
  }

  // =====================================================================
  // Obsidian < 1.13：传统的命令式设置页（1.13+ 不会调用）
  // =====================================================================

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    // ---------- 模型提供商 ----------
    new Setting(containerEl).setName("模型提供商").setHeading();

    new Setting(containerEl)
      .setName("当前使用")
      .setDesc(TEXT.activeDesc)
      .addDropdown((d) => {
        for (const [id, label] of Object.entries(this.providerOptions())) d.addOption(id, label);
        d.setValue(this.plugin.activeProvider()?.id ?? "");
        this.activeSelect = d.selectEl;
        d.onChange(async (v) => {
          s.activeProviderId = v;
          await this.plugin.saveSettings();
          this.rerender();
        });
      });

    new Setting(containerEl)
      .setName("添加提供商")
      .setDesc("从预设创建，之后可修改地址和模型")
      .addDropdown((d) => {
        for (const [i, p] of PRESETS.entries()) d.addOption(String(i), p.label);
        d.setValue(String(this.presetIndex));
        d.onChange((v) => (this.presetIndex = Number(v)));
      })
      .addButton((b) =>
        b.setButtonText("添加").setCta().onClick(async () => {
          await this.addProvider(PRESETS[this.presetIndex]);
        }),
      );

    s.providers.forEach((p, index) => {
      const box = containerEl.createDiv({ cls: "aiac-provider-box" });
      const isActive = this.plugin.activeProvider()?.id === p.id;
      new Setting(box)
        .setName(`${p.name}${isActive ? "（当前）" : ""}`)
        .setHeading()
        .addExtraButton((b) =>
          b.setIcon("trash").setTooltip("删除该提供商").onClick(async () => {
            await this.deleteProvider(index);
          }),
        );
      for (const row of this.providerRows(p)) {
        const setting = new Setting(box).setName(row.name);
        if (row.desc) setting.setDesc(row.desc);
        row.render(setting);
      }
    });

    // ---------- 界面 ----------
    new Setting(containerEl).setName("界面").setHeading();
    new Setting(containerEl)
      .setName("面板位置")
      .setDesc(TEXT.panelDesc)
      .addDropdown((d) => {
        for (const [k, label] of Object.entries(PANEL_OPTIONS)) d.addOption(k, label);
        d.setValue(s.panelPosition).onChange(async (v) => {
          await this.setControlValue("panelPosition", v);
        });
      });

    // ---------- Agent 行为 ----------
    new Setting(containerEl).setName("Agent 行为").setHeading();

    new Setting(containerEl)
      .setName("权限模式")
      .setDesc(TEXT.confirmDesc)
      .addDropdown((d) => {
        for (const [k, label] of Object.entries(CONFIRM_OPTIONS)) d.addOption(k, label);
        d.setValue(s.confirmMode).onChange(async (v) => {
          s.confirmMode = v as ConfirmMode;
          await this.plugin.saveSettings();
        });
      });

    for (const k of PERMISSION_KEYS) {
      new Setting(containerEl)
        .setName(`授权：${PERMISSION_LABELS[k]}`)
        .setDesc(k === PERMISSION_KEYS[0] ? TEXT.grantDesc : "")
        .addToggle((t) => t.setValue(s.grantedPermissions.includes(k)).onChange((v) => this.setGranted(k, v)));
    }

    new Setting(containerEl)
      .setName("单次最多步骤数")
      .setDesc(TEXT.maxStepsDesc)
      .addText((t) =>
        t.setValue(String(s.maxSteps)).onChange(async (v) => {
          const n = parseInt(v);
          if (n > 0) { s.maxSteps = n; await this.plugin.saveSettings(); }
        }),
      );

    new Setting(containerEl)
      .setName("自动压缩上下文的阈值（token）")
      .setDesc(TEXT.contextDesc)
      .addText((t) =>
        t.setValue(String(s.contextBudget)).onChange(async (v) => {
          const n = parseInt(v);
          if (n === 0 || n >= 10000) { s.contextBudget = n; await this.plugin.saveSettings(); }
        }),
      );

    new Setting(containerEl)
      .setName("单篇笔记最多读取字符数")
      .setDesc(TEXT.maxReadDesc)
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
      .setName("允许控制 Obsidian")
      .setDesc(TEXT.obsidianControlDesc)
      .addToggle((t) =>
        t.setValue(s.allowObsidianControl).onChange(async (v) => {
          s.allowObsidianControl = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("允许派出子代理")
      .setDesc(TEXT.subAgentsDesc)
      .addToggle((t) =>
        t.setValue(s.allowSubAgents).onChange(async (v) => {
          s.allowSubAgents = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("允许控制本地软件")
      .setDesc(TEXT.systemControlDesc)
      .addToggle((t) =>
        t.setValue(s.allowSystemControl).onChange(async (v) => {
          s.allowSystemControl = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("系统提示词")
      .setDesc(TEXT.promptDesc)
      .addExtraButton((b) =>
        b.setIcon("rotate-ccw").setTooltip("恢复默认").onClick(async () => {
          s.systemPrompt = DEFAULT_SYSTEM_PROMPT;
          await this.plugin.saveSettings();
          this.rerender();
        }),
      );
    const ta = containerEl.createEl("textarea", { cls: "aiac-system-prompt" });
    ta.value = s.systemPrompt;
    ta.addEventListener("change", () => {
      s.systemPrompt = ta.value;
      void this.plugin.saveSettings();
    });

    containerEl.createEl("p", { cls: "setting-item-description", text: `提示：${this.keyStorageNote()}` });
  }
}

/** 1.13+ 设置页“添加提供商”时的预设选择器 */
class PresetPickerModal extends FuzzySuggestModal<Preset> {
  constructor(app: App, private onPick: (preset: Preset) => void) {
    super(app);
    this.setPlaceholder("选择要添加的模型提供商");
  }
  getItems() { return PRESETS; }
  getItemText(p: Preset) { return p.label; }
  onChooseItem(p: Preset) { this.onPick(p); }
}

/** 不适合对话/工具调用的模型（语音、绘图、向量等），排到列表末尾 */
const NON_CHAT = /(tts|transcribe|whisper|embedding|embed|dall-e|image|moderation|realtime|audio|search-preview|davinci|babbage)/i;

class ModelPickerModal extends FuzzySuggestModal<string> {
  private models: string[];
  constructor(app: App, models: string[], private onPick: (m: string) => Promise<void>) {
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
  onChooseItem(m: string) { void this.onPick(m); }
}
