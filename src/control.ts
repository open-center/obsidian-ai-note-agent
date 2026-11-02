import { App, normalizePath } from "obsidian";

/**
 * 控制 Obsidian 本身：命令、插件、设置。
 *
 * Obsidian 没有为这些功能提供公开 API，这里通过运行时特性检测访问应用内部对象；
 * 任何一项不可用时都会给出明确的错误，而不会影响插件其他功能。
 * 所有会改变状态的操作都需要用户在弹窗中确认，并提供撤销。
 */

interface CommandInfo { id: string; name: string }
interface CommandsApi {
  listCommands?: () => CommandInfo[];
  commands?: Record<string, CommandInfo>;
  executeCommandById(id: string): boolean;
}
interface PluginManifestLite { id: string; name: string; version?: string; description?: string; author?: string }
interface CommunityPluginsApi {
  manifests: Record<string, PluginManifestLite>;
  enabledPlugins: Set<string>;
  enablePluginAndSave(id: string): Promise<boolean>;
  disablePluginAndSave(id: string): Promise<void>;
  enablePlugin?(id: string): Promise<boolean>;
  disablePlugin?(id: string): Promise<void>;
}
interface CorePlugin {
  enabled: boolean;
  instance?: { id?: string; name?: string; description?: string };
  enable(save: boolean): Promise<void> | void;
  disable(save: boolean): Promise<void> | void;
}
interface CorePluginsApi {
  plugins: Record<string, CorePlugin>;
  getPluginById?(id: string): CorePlugin | null;
}
interface VaultConfigApi {
  getConfig(key: string): unknown;
  setConfig(key: string, value: unknown): void;
}
interface SettingApi { open(): void; openTabById(id: string): void }

interface AppInternals {
  commands?: CommandsApi;
  plugins?: CommunityPluginsApi;
  internalPlugins?: CorePluginsApi;
  setting?: SettingApi;
}

/** 可以读写的 Obsidian 全局设置文件 */
export const CONFIG_TARGETS: Record<string, string> = {
  app: "app.json（编辑器、文件与链接等）",
  appearance: "appearance.json（外观、主题、字体）",
  hotkeys: "hotkeys.json（快捷键，只读）",
  "core-plugins": "core-plugins.json（核心插件开关，只读，修改请用 set_plugin_enabled）",
};

const SECRET_KEY = /(api[-_]?key|token|secret|password|passwd|cookie|auth)/i;

/** 把设置中疑似密钥的值替换成 ***，避免发给模型 */
export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && typeof v === "string" && v ? "***" : maskSecrets(v);
    }
    return out;
  }
  return value;
}

/** 深度合并：对象逐层合并，其他类型直接覆盖；值为 null 表示删除该项 */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !base || typeof base !== "object" || Array.isArray(base)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete out[k];
    else out[k] = deepMerge(out[k], v);
  }
  return out;
}

/** 合并时保留被打码的原值：模型传回 *** 时不覆盖真实密钥 */
function keepMasked(patch: unknown, original: unknown): unknown {
  if (patch === "***") return original;
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    const orig = original && typeof original === "object" ? (original as Record<string, unknown>) : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = keepMasked(v, orig[k]);
    return out;
  }
  return patch;
}

export function stringify(v: unknown): string {
  return JSON.stringify(v, null, 2) ?? "null";
}

export class ObsidianControl {
  constructor(private app: App, private selfId: string) {}

  private get internals(): AppInternals {
    return this.app as unknown as AppInternals;
  }

  private need<T>(value: T | undefined, what: string): T {
    if (!value) throw new Error(`当前 Obsidian 版本不支持${what}`);
    return value;
  }

  // ---------- 命令 ----------

  listCommands(query: string, limit = 100): CommandInfo[] {
    const api = this.need(this.internals.commands, "列出命令");
    const all = api.listCommands ? api.listCommands() : Object.values(api.commands ?? {});
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return all
      .filter((c) => terms.every((t) => `${c.id} ${c.name}`.toLowerCase().includes(t)))
      .slice(0, limit)
      .map((c) => ({ id: c.id, name: c.name }));
  }

  findCommand(id: string): CommandInfo | undefined {
    const api = this.need(this.internals.commands, "执行命令");
    const all = api.listCommands ? api.listCommands() : Object.values(api.commands ?? {});
    return all.find((c) => c.id === id);
  }

  runCommand(id: string): boolean {
    if (id.startsWith(`${this.selfId}:`)) throw new Error("不能通过 Agent 执行本插件自己的命令");
    return this.need(this.internals.commands, "执行命令").executeCommandById(id);
  }

  // ---------- 插件 ----------

  listPlugins(): { community: (PluginManifestLite & { enabled: boolean })[]; core: { id: string; name: string; enabled: boolean }[] } {
    const community = this.internals.plugins;
    const core = this.internals.internalPlugins;
    return {
      community: community
        ? Object.values(community.manifests)
            .map((m) => ({ id: m.id, name: m.name, version: m.version, description: m.description, author: m.author, enabled: community.enabledPlugins.has(m.id) }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
      core: core
        ? Object.entries(core.plugins)
            .map(([id, p]) => ({ id, name: p.instance?.name ?? id, enabled: p.enabled }))
            .sort((a, b) => a.id.localeCompare(b.id))
        : [],
    };
  }

  /** 返回插件类型与当前状态；找不到时抛错 */
  pluginState(id: string): { type: "community" | "core"; name: string; enabled: boolean } {
    const community = this.internals.plugins;
    if (community?.manifests[id]) return { type: "community", name: community.manifests[id].name, enabled: community.enabledPlugins.has(id) };
    const core = this.internals.internalPlugins?.plugins[id];
    if (core) return { type: "core", name: core.instance?.name ?? id, enabled: core.enabled };
    throw new Error(`没有安装插件：${id}。可以先用 list_plugins 查看已安装的插件，或用 open_plugin_page 打开社区插件安装页。`);
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    if (id === this.selfId && !enabled) throw new Error("不能停用 AI Note Agent 自身");
    const st = this.pluginState(id);
    if (st.type === "community") {
      const api = this.need(this.internals.plugins, "管理社区插件");
      if (enabled) {
        const ok = await api.enablePluginAndSave(id);
        if (ok === false) throw new Error(`插件 ${id} 启用失败（可能与当前 Obsidian 版本不兼容），详情见开发者控制台`);
      } else await api.disablePluginAndSave(id);
    } else {
      const p = this.need(this.internals.internalPlugins?.plugins[id], "管理核心插件");
      if (enabled) await p.enable(true);
      else await p.disable(true);
    }
  }

  /** 重新加载社区插件，让它读取新的设置 */
  async reloadPlugin(id: string): Promise<void> {
    const api = this.internals.plugins;
    if (!api?.enabledPlugins.has(id) || !api.disablePlugin || !api.enablePlugin) return;
    await api.disablePlugin(id);
    await api.enablePlugin(id);
  }

  /** 在 Obsidian 中打开社区插件的详情 / 安装页 */
  openPluginPage(id: string): void {
    window.open(`obsidian://show-plugin?id=${encodeURIComponent(id)}`);
  }

  openSettings(tabId?: string): void {
    const setting = this.need(this.internals.setting, "打开设置页");
    setting.open();
    if (tabId) setting.openTabById(tabId);
  }

  // ---------- 设置 ----------

  /** 设置文件路径：全局设置或某个插件的 data.json */
  settingsPath(target: string): { path: string; kind: "global" | "plugin" | "core" } {
    const dir = this.app.vault.configDir;
    if (CONFIG_TARGETS[target]) return { path: normalizePath(`${dir}/${target}.json`), kind: "global" };
    const st = this.pluginState(target);
    if (st.type === "core") return { path: normalizePath(`${dir}/${target}.json`), kind: "core" };
    return { path: normalizePath(`${dir}/plugins/${target}/data.json`), kind: "plugin" };
  }

  async readSettings(target: string): Promise<{ path: string; value: unknown }> {
    if (target === this.selfId) throw new Error("本插件的设置（含 API key）不对 Agent 开放，请在设置页中修改");
    const { path } = this.settingsPath(target);
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path))) return { path, value: {} };
    const raw = await adapter.read(path);
    try {
      return { path, value: JSON.parse(raw) as unknown };
    } catch {
      throw new Error(`${path} 不是有效的 JSON`);
    }
  }

  /** 计算修改后的设置（不写入），用于确认弹窗 */
  async previewSettings(target: string, changes: unknown): Promise<{ path: string; kind: "global" | "plugin" | "core"; before: unknown; after: unknown }> {
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("changes 必须是 JSON 对象");
    if (target === "hotkeys" || target === "core-plugins") throw new Error(`${target} 只读：${CONFIG_TARGETS[target]}`);
    const { path, kind } = this.settingsPath(target);
    const { value: before } = await this.readSettings(target);
    const after = deepMerge(before, keepMasked(changes, before));
    return { path, kind, before, after };
  }

  /** 写入设置并让它生效；返回用于撤销的旧值 */
  async writeSettings(target: string, kind: "global" | "plugin" | "core", path: string, before: unknown, after: unknown): Promise<void> {
    if (kind === "global") {
      const api = this.app.vault as unknown as Partial<VaultConfigApi>;
      if (typeof api.setConfig !== "function") throw new Error("当前 Obsidian 版本不支持修改全局设置");
      const b = (before ?? {}) as Record<string, unknown>;
      const a = (after ?? {}) as Record<string, unknown>;
      // 通过 setConfig 写入，Obsidian 会立即应用并保存到对应的设置文件
      for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
        if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) api.setConfig(key, a[key] === undefined ? null : a[key]);
      }
      this.app.workspace.trigger("css-change");
      return;
    }
    await this.app.vault.adapter.write(path, stringify(after));
    if (kind === "plugin") await this.reloadPlugin(target);
    else {
      // 核心插件：关闭再打开，让它重新读取设置
      const p = this.internals.internalPlugins?.plugins[target];
      if (p?.enabled) {
        await p.disable(false);
        await p.enable(false);
      }
    }
  }
}
