import { App, MarkdownView } from "obsidian";
import type { ToolSpec } from "./llm";
import type { PermissionGate, PermissionKey } from "./permissions";
import type { ChangeRecord, ToolResult } from "./tools";

/**
 * 控制 Obsidian 本身：命令、核心插件、第三方插件、设置。
 * Obsidian 没有为这些功能提供公开 API，这里通过运行时检测访问应用内部对象，任何一项不可用时给出明确错误。
 * 所有会改变状态的操作都按权限模式确认，并可在聊天中撤销；疑似密钥的设置项会打码后再给模型；不能控制本插件自身。
 */

type ToolArgs = Record<string, unknown>;
type Json = Record<string, unknown>;

interface CommandInfo { id: string; name: string; editorCallback?: unknown; editorCheckCallback?: unknown }
interface CommandsApi {
  commands: Record<string, CommandInfo>;
  executeCommandById(id: string): boolean;
}
interface CorePlugin {
  enabled: boolean;
  instance?: { id?: string; name?: string; options?: Json };
  enable(save?: boolean): Promise<void>;
  disable(save?: boolean): void;
  loadData(): Promise<Json | null>;
  saveData(data: Json): Promise<void>;
}
interface CorePluginsApi {
  plugins: Record<string, CorePlugin>;
  saveConfig?: () => Promise<void> | void;
}
interface CommunityPlugin { loadData(): Promise<unknown>; saveData(data: unknown): Promise<void> }
interface CommunityPluginsApi {
  manifests: Record<string, { id: string; name: string; version?: string; description?: string }>;
  enabledPlugins: Set<string>;
  plugins: Record<string, CommunityPlugin | undefined>;
  enablePluginAndSave(id: string): Promise<boolean>;
  disablePluginAndSave(id: string): Promise<void>;
  enablePlugin(id: string): Promise<boolean>;
  disablePlugin(id: string): Promise<void>;
}
interface SettingApi {
  open(): void;
  openTabById(id: string): unknown;
  settingTabs?: { id: string; name?: string }[];
  pluginTabs?: { id: string; name?: string }[];
}
interface VaultConfigApi {
  config?: Json;
  getConfig(key: string): unknown;
  setConfig(key: string, value: unknown): void;
}

/** 撤销设置类改动所需的信息，存放在 ChangeRecord.control 中 */
export type ControlUndo =
  | { type: "app-config"; before: Json }
  | { type: "plugin-data"; id: string; core: boolean; before: Json | null }
  | { type: "plugin-enabled"; id: string; core: boolean; before: boolean };

const str = (description: string) => ({ type: "string", description });

/** 疑似密钥的字段名：读取时打码，写入时若仍为打码值则保留原值 */
const SECRET_KEY = /(api[-_]?key|apikey|token|secret|password|passwd|credential|cookie|auth|private[-_]?key)/i;
const MASK = "[已隐藏]";

/** 常用的 Obsidian 应用设置项。getConfig 对未修改过的项返回默认值，这里列出以便模型了解有哪些可改 */
const COMMON_APP_KEYS = [
  "theme", "cssTheme", "accentColor", "baseFontSize", "interfaceFontFamily", "textFontFamily", "monospaceFontFamily", "enabledCssSnippets",
  "translucency", "nativeMenus", "showViewHeader", "showRibbon", "showInlineTitle",
  "livePreview", "defaultViewMode", "readableLineLength", "showLineNumber", "spellcheck", "vimMode", "strictLineBreaks", "showFrontmatter",
  "foldHeading", "foldIndent", "autoPairBrackets", "autoPairMarkdown", "smartIndentList", "useTab", "tabSize", "rightToLeft",
  "newFileLocation", "newFileFolderPath", "attachmentFolderPath", "alwaysUpdateLinks", "useMarkdownLinks", "newLinkFormat",
  "promptDelete", "trashOption", "showUnsupportedFiles", "userIgnoreFilters",
];

export const CONTROL_TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_commands",
    description: "列出 Obsidian 中可执行的命令（核心功能和插件提供的命令），返回命令 ID 和名称。可用 query 按名称或 ID 过滤。",
    parameters: {
      type: "object",
      properties: { query: str("可选：过滤关键词，多个词用空格分隔，需全部命中"), limit: { type: "number", description: "最多返回条数，默认 100" } },
      required: [],
    },
  },
  {
    name: "run_command",
    description: "执行一条 Obsidian 命令（需用户确认）。先用 list_commands 找到准确的命令 ID。编辑器类命令会作用于用户最后打开的笔记。",
    parameters: { type: "object", properties: { id: str("命令 ID，例如 'editor:toggle-bold'") }, required: ["id"] },
  },
  {
    name: "list_plugins",
    description: "列出所有核心插件和已安装的第三方插件，以及它们是否启用。",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "set_plugin_enabled",
    description: "启用或停用一个核心插件或第三方插件（需用户确认）。不能停用本插件自身。",
    parameters: {
      type: "object",
      properties: { id: str("插件 ID（来自 list_plugins）"), enabled: { type: "boolean", description: "true 启用，false 停用" } },
      required: ["id", "enabled"],
    },
  },
  {
    name: "get_settings",
    description:
      "读取设置。target 为 'app' 时返回 Obsidian 应用设置（外观、编辑器、文件与链接等）；为插件 ID 时返回该核心插件或第三方插件的设置。疑似密钥的字段会显示为 [已隐藏]。",
    parameters: { type: "object", properties: { target: str("'app' 或插件 ID") }, required: ["target"] },
  },
  {
    name: "update_settings",
    description:
      "修改设置（需用户确认，可撤销）。values 中的每个顶层键会覆盖原值，未列出的键保持不变；值为 [已隐藏] 的键保留原值。修改前先用 get_settings 读取当前设置。第三方插件的设置会在保存后重新加载该插件以生效。",
    parameters: {
      type: "object",
      properties: {
        target: str("'app' 或插件 ID"),
        values: { type: "object", description: "要修改的设置项，例如 {\"showLineNumber\": true}" },
      },
      required: ["target", "values"],
    },
  },
  {
    name: "open_settings",
    description: "打开 Obsidian 设置窗口，可指定标签页（如 'appearance'、'editor'、'hotkeys'、'community-plugins' 或插件 ID）。",
    parameters: { type: "object", properties: { tab: str("可选：设置标签页 ID") }, required: [] },
  },
];

export const CONTROL_TOOL_NAMES = new Set(CONTROL_TOOL_SPECS.map((t) => t.name));
/** 会改变状态的控制工具（聊天中按“写入”样式显示） */
export const CONTROL_WRITE_TOOLS = ["run_command", "set_plugin_enabled", "update_settings"];

function maskSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskSecrets);
  if (v && typeof v === "object") {
    const out: Json = {};
    for (const [k, x] of Object.entries(v as Json)) out[k] = SECRET_KEY.test(k) && typeof x === "string" && x ? MASK : maskSecrets(x);
    return out;
  }
  return v;
}

/** 把打码值还原为原值，避免模型把 [已隐藏] 写回去 */
function unmask(next: unknown, prev: unknown): unknown {
  if (next === MASK) return prev;
  if (next && typeof next === "object" && !Array.isArray(next) && prev && typeof prev === "object" && !Array.isArray(prev)) {
    const out: Json = {};
    for (const [k, x] of Object.entries(next as Json)) out[k] = unmask(x, (prev as Json)[k]);
    return out;
  }
  return next;
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** 实际发生变化的顶层键 */
const changedKeys = (before: Json, after: Json) => Object.keys(after).filter((k) => pretty(before[k]) !== pretty(after[k]));

export class ObsidianTools {
  constructor(
    private app: App,
    private gate: PermissionGate,
    /** 本插件的 ID，不允许 Agent 控制自身 */
    private selfId: string,
    /** 用户最后打开的 Markdown 编辑器，用于执行编辑器类命令 */
    private getMarkdownView: () => MarkdownView | null,
  ) {}

  // ---------- 内部对象（运行时检测） ----------

  private internals() {
    const a = this.app as unknown as { commands?: CommandsApi; internalPlugins?: CorePluginsApi; plugins?: CommunityPluginsApi; setting?: SettingApi };
    return a;
  }

  private commands(): CommandsApi {
    const c = this.internals().commands;
    if (!c || typeof c.executeCommandById !== "function") throw new Error("当前 Obsidian 版本不支持命令控制");
    return c;
  }

  private core(): CorePluginsApi {
    const c = this.internals().internalPlugins;
    if (!c?.plugins) throw new Error("当前 Obsidian 版本不支持核心插件控制");
    return c;
  }

  private community(): CommunityPluginsApi {
    const c = this.internals().plugins;
    if (!c?.manifests) throw new Error("当前 Obsidian 版本不支持第三方插件控制");
    return c;
  }

  private vault(): VaultConfigApi {
    const v = this.app.vault as unknown as VaultConfigApi;
    if (typeof v.getConfig !== "function" || typeof v.setConfig !== "function") throw new Error("当前 Obsidian 版本不支持修改应用设置");
    return v;
  }

  /** 解析插件 ID：返回核心插件或第三方插件 */
  private findPlugin(id: string): { core: true; plugin: CorePlugin; name: string } | { core: false; name: string } {
    if (!id) throw new Error("插件 ID 不能为空");
    if (id === this.selfId) throw new Error("不能通过 Agent 控制本插件自身，请在设置中手动修改。");
    const corePlugin = this.core().plugins[id];
    if (corePlugin) return { core: true, plugin: corePlugin, name: corePlugin.instance?.name ?? id };
    const m = this.community().manifests[id];
    if (m) return { core: false, name: m.name };
    throw new Error(`找不到插件：${id}。可先用 list_plugins 查看插件 ID。`);
  }

  private confirm(key: PermissionKey, title: string, desc: string, before: string | null, after: string | null, code?: string): Promise<boolean> {
    return this.gate.confirm(key, title, desc, before, after, { code, okText: code ? "允许执行" : "应用修改" });
  }

  // ---------- 执行 ----------

  async run(name: string, argsJson: string): Promise<ToolResult> {
    let args: ToolArgs;
    try {
      const parsed: unknown = argsJson ? JSON.parse(argsJson) : {};
      args = parsed && typeof parsed === "object" ? (parsed as ToolArgs) : {};
    } catch {
      return { output: `参数不是合法 JSON：${argsJson.slice(0, 200)}`, isError: true };
    }
    const text = (k: string): string => {
      const v = args[k];
      return typeof v === "string" ? v.trim() : "";
    };
    try {
      switch (name) {
        case "list_commands": return this.listCommands(text("query"), Number(args.limit) || 100);
        case "run_command": return await this.runCommand(text("id"));
        case "list_plugins": return this.listPlugins();
        case "set_plugin_enabled": return await this.setPluginEnabled(text("id"), args.enabled === true);
        case "get_settings": return await this.getSettings(text("target"));
        case "update_settings": {
          const values = args.values;
          if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("values 必须是对象");
          return await this.updateSettings(text("target"), values as Json);
        }
        case "open_settings": return this.openSettings(text("tab"));
        default: return { output: `未知工具：${name}`, isError: true };
      }
    } catch (e) {
      return { output: `错误：${(e as Error).message}`, isError: true };
    }
  }

  private listCommands(query: string, limit: number): ToolResult {
    const api = this.commands();
    // 不用 listCommands()：它会隐藏当前不可用的编辑器命令，而聊天时焦点在面板上，编辑器命令总是“不可用”
    const all = Object.values(api.commands).sort((a, b) => a.id.localeCompare(b.id));
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = all.filter((c) => terms.every((t) => `${c.id} ${c.name}`.toLowerCase().includes(t)));
    if (!hits.length) return { output: query ? `没有名称或 ID 包含“${query}”的命令。` : "没有可用的命令。" };
    const lines = hits.slice(0, limit).map((c) => `- ${c.id} · ${c.name}`);
    return { output: lines.join("\n") + (hits.length > limit ? `\n…共 ${hits.length} 条，已显示前 ${limit} 条，可用 query 缩小范围` : "") };
  }

  private async runCommand(id: string): Promise<ToolResult> {
    const api = this.commands();
    const cmd = api.commands[id];
    if (!cmd) throw new Error(`找不到命令：${id}。可先用 list_commands 查找。`);
    if (id.startsWith(this.selfId + ":")) throw new Error("不能通过 Agent 执行本插件自身的命令。");
    if (!(await this.confirm("obsidian-command", "执行 Obsidian 命令", `Agent 想要执行命令「${cmd.name}」`, null, null, id))) {
      return { output: "用户拒绝了执行该命令。" };
    }
    // 编辑器类命令需要编辑器处于激活状态：先切回用户最后打开的笔记
    if (cmd.editorCallback || cmd.editorCheckCallback) {
      // 没有记录到最后使用的编辑器时，退而使用任意一个已打开的笔记
      const fallback = this.app.workspace.getLeavesOfType("markdown").map((l) => l.view).find((v) => v instanceof MarkdownView);
      const view = this.getMarkdownView() ?? (fallback instanceof MarkdownView ? fallback : null);
      if (!view) throw new Error("这是编辑器命令，但用户当前没有打开任何笔记。");
      this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
    }
    const ok = api.executeCommandById(id);
    return ok ? { output: `已执行命令「${cmd.name}」。` } : { output: `命令「${cmd.name}」当前不可用（可能需要先打开笔记或满足其他条件）。`, isError: true };
  }

  private listPlugins(): ToolResult {
    const core = Object.entries(this.core().plugins)
      .map(([id, p]) => `- ${id} · ${p.instance?.name ?? id} · ${p.enabled ? "已启用" : "未启用"}`)
      .sort();
    const cp = this.community();
    const community = Object.values(cp.manifests)
      .filter((m) => m.id !== this.selfId)
      .map((m) => `- ${m.id} · ${m.name}${m.version ? " v" + m.version : ""} · ${cp.enabledPlugins.has(m.id) ? "已启用" : "未启用"}`)
      .sort();
    return { output: `核心插件：\n${core.join("\n")}\n\n第三方插件：\n${community.join("\n") || "（无）"}` };
  }

  private async setPluginEnabled(id: string, enabled: boolean): Promise<ToolResult> {
    const found = this.findPlugin(id);
    const before = found.core ? found.plugin.enabled : this.community().enabledPlugins.has(id);
    if (before === enabled) return { output: `插件「${found.name}」已经是${enabled ? "启用" : "停用"}状态。` };
    const kind = found.core ? "核心插件" : "第三方插件";
    if (!(await this.confirm("obsidian-plugin", `${enabled ? "启用" : "停用"}插件`, `Agent 想要${enabled ? "启用" : "停用"}${kind}「${found.name}」（${id}）`, null, null))) {
      return { output: "用户拒绝了这次操作。" };
    }
    await this.applyPluginEnabled(id, found.core, enabled);
    return {
      output: `已${enabled ? "启用" : "停用"}${kind}「${found.name}」。`,
      change: this.record(`${enabled ? "启用" : "停用"}插件 ${found.name}`, { type: "plugin-enabled", id, core: found.core, before }),
    };
  }

  private async applyPluginEnabled(id: string, core: boolean, enabled: boolean) {
    if (core) {
      const api = this.core();
      const p = api.plugins[id];
      if (enabled) await p.enable(true);
      else p.disable(true);
      // enable/disable 只改内存状态，需要显式保存 core-plugins.json
      await api.saveConfig?.();
    } else {
      const cp = this.community();
      if (enabled) {
        if (!(await cp.enablePluginAndSave(id))) throw new Error("插件启用失败，可能与当前 Obsidian 版本不兼容");
      } else await cp.disablePluginAndSave(id);
    }
  }

  // ---------- 设置 ----------

  private appConfig(): Json {
    const v = this.vault();
    const out: Json = {};
    for (const k of COMMON_APP_KEYS) {
      const x = v.getConfig(k);
      if (x !== undefined) out[k] = x;
    }
    // 用户改过的其他设置项也一并列出
    for (const [k, x] of Object.entries(v.config ?? {})) if (!(k in out)) out[k] = x;
    return out;
  }

  /** 读取插件设置：核心插件读 .obsidian/<id>.json，第三方插件读 data.json */
  private async pluginData(id: string): Promise<{ core: boolean; name: string; data: Json | null }> {
    const found = this.findPlugin(id);
    if (found.core) {
      const data = (await found.plugin.loadData()) ?? found.plugin.instance?.options ?? null;
      return { core: true, name: found.name, data };
    }
    const loaded = this.community().plugins[id];
    let data: unknown = null;
    if (loaded) data = await loaded.loadData();
    else {
      const path = `${this.app.vault.configDir}/plugins/${id}/data.json`;
      if (await this.app.vault.adapter.exists(path)) data = JSON.parse(await this.app.vault.adapter.read(path)) as unknown;
    }
    if (data !== null && (typeof data !== "object" || Array.isArray(data))) throw new Error("该插件的设置不是对象格式，无法修改");
    return { core: false, name: found.name, data: data as Json | null };
  }

  private async getSettings(target: string): Promise<ToolResult> {
    if (!target) throw new Error("target 不能为空（'app' 或插件 ID）");
    if (target === "app") return { output: `Obsidian 应用设置：\n${pretty(this.appConfig())}` };
    const { name, data } = await this.pluginData(target);
    if (data === null) return { output: `插件「${name}」还没有保存过任何设置。` };
    return { output: `插件「${name}」的设置：\n${pretty(maskSecrets(data))}` };
  }

  private async updateSettings(target: string, values: Json): Promise<ToolResult> {
    if (!target) throw new Error("target 不能为空（'app' 或插件 ID）");
    if (!Object.keys(values).length) throw new Error("values 不能为空");

    if (target === "app") {
      const v = this.vault();
      const before: Json = {};
      for (const k of Object.keys(values)) before[k] = v.getConfig(k);
      const after = unmask(values, before) as Json;
      if (pretty(before) === pretty(after)) return { output: "设置没有变化。" };
      if (!(await this.confirm("obsidian-settings", "修改 Obsidian 设置", "以下是 Agent 计划修改的应用设置：", pretty(maskSecrets(before)), pretty(maskSecrets(after))))) {
        return { output: "用户拒绝了这次修改。" };
      }
      for (const [k, x] of Object.entries(after)) v.setConfig(k, x);
      return { output: `已修改应用设置：${changedKeys(before, after).join("、")}。`, change: this.record("修改应用设置", { type: "app-config", before }) };
    }

    const { core, name, data } = await this.pluginData(target);
    const before = data ?? {};
    const after = { ...before, ...(unmask(values, before) as Json) };
    if (pretty(before) === pretty(after)) return { output: "设置没有变化。" };
    if (!(await this.confirm("obsidian-settings", `修改插件「${name}」的设置`, "以下是 Agent 计划进行的修改：", pretty(maskSecrets(before)), pretty(maskSecrets(after))))) {
      return { output: "用户拒绝了这次修改。" };
    }
    await this.writePluginData(target, core, after);
    return {
      output: `已修改插件「${name}」的设置：${changedKeys(before, after).join("、")}。`,
      change: this.record(`修改插件 ${name} 的设置`, { type: "plugin-data", id: target, core, before: data }),
    };
  }

  private async writePluginData(id: string, core: boolean, data: Json | null) {
    if (core) {
      const p = this.core().plugins[id];
      const next = data ?? {};
      await p.saveData(next);
      // saveData 只写文件，同步更新内存中的设置使其立即生效
      if (p.instance) p.instance.options = { ...next };
      return;
    }
    const cp = this.community();
    const loaded = cp.plugins[id];
    if (loaded) {
      await loaded.saveData(data ?? {});
      // 重新加载插件，让它读取新设置
      await cp.disablePlugin(id);
      await cp.enablePlugin(id);
    } else {
      const path = `${this.app.vault.configDir}/plugins/${id}/data.json`;
      await this.app.vault.adapter.write(path, pretty(data ?? {}));
    }
  }

  private openSettings(tab: string): ToolResult {
    const s = this.internals().setting;
    if (!s) throw new Error("当前 Obsidian 版本不支持打开设置");
    s.open();
    if (tab) {
      const ids = [...(s.settingTabs ?? []), ...(s.pluginTabs ?? [])].map((t) => t.id);
      if (!ids.includes(tab)) return { output: `已打开设置，但没有 ID 为“${tab}”的标签页。可用的有：${ids.join("、")}`, isError: true };
      s.openTabById(tab);
    }
    return { output: tab ? `已打开设置的「${tab}」页。` : "已打开设置。" };
  }

  // ---------- 撤销 ----------

  private record(label: string, control: ControlUndo): ChangeRecord {
    return { kind: "control", path: label, before: null, after: null, control };
  }

  async undo(u: ControlUndo): Promise<string> {
    switch (u.type) {
      case "app-config": {
        const v = this.vault();
        for (const [k, x] of Object.entries(u.before)) v.setConfig(k, x);
        return "已恢复修改前的应用设置";
      }
      case "plugin-data":
        await this.writePluginData(u.id, u.core, u.before);
        return "已恢复插件修改前的设置";
      case "plugin-enabled":
        await this.applyPluginEnabled(u.id, u.core, u.before);
        return u.before ? "已重新启用插件" : "已重新停用插件";
    }
  }
}
