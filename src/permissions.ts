import { App, Notice } from "obsidian";
import { ConfirmOptions, askPermission } from "./diff";

/**
 * 权限模式：
 * - manual 手动：每次操作都弹窗确认
 * - grant  授权：已授权的操作类型直接执行，其余仍弹窗确认
 * - auto   自动：所有操作直接执行（仍可在聊天中撤销）
 */
export type ConfirmMode = "manual" | "grant" | "auto";

/** 需要确认的操作类型 */
export type PermissionKey =
  | "note-edit"
  | "note-move"
  | "note-delete"
  | "obsidian-command"
  | "obsidian-plugin"
  | "obsidian-settings"
  | "system-open"
  | "system-shell";

export const MODE_LABELS: Record<ConfirmMode, string> = {
  manual: "手动确认",
  grant: "按授权执行",
  auto: "自动执行",
};

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  "note-edit": "创建和修改笔记",
  "note-move": "移动 / 重命名笔记",
  "note-delete": "删除笔记（移到回收站）",
  "obsidian-command": "执行 Obsidian 命令",
  "obsidian-plugin": "启用 / 停用插件",
  "obsidian-settings": "修改 Obsidian 和插件设置",
  "system-open": "启动应用、打开文件或网址",
  "system-shell": "执行本地 shell 命令",
};

export const PERMISSION_KEYS = Object.keys(PERMISSION_LABELS) as PermissionKey[];

export interface PermissionSettings {
  confirmMode: ConfirmMode;
  grantedPermissions: PermissionKey[];
}

/** 把旧版设置（always / never）迁移到新的权限模式，并清理无效的授权项 */
export function normalizePermissions(s: PermissionSettings) {
  const mode = s.confirmMode as string;
  if (mode === "always") s.confirmMode = "manual";
  else if (mode === "never") s.confirmMode = "auto";
  else if (!(mode in MODE_LABELS)) s.confirmMode = "manual";
  s.grantedPermissions = Array.isArray(s.grantedPermissions)
    ? s.grantedPermissions.filter((k) => PERMISSION_KEYS.includes(k))
    : [];
}

/** 所有需要用户确认的操作都经过这里，根据权限模式决定是否弹窗 */
export class PermissionGate {
  constructor(
    private app: App,
    private getSettings: () => PermissionSettings,
    private save: () => Promise<void>,
  ) {}

  isAllowed(key: PermissionKey): boolean {
    const s = this.getSettings();
    return s.confirmMode === "auto" || (s.confirmMode === "grant" && s.grantedPermissions.includes(key));
  }

  async confirm(key: PermissionKey, title: string, desc: string, before: string | null, after: string | null, options: ConfirmOptions = {}): Promise<boolean> {
    if (this.isAllowed(key)) return true;
    const decision = await askPermission(this.app, title, desc, before, after, { ...options, grantLabel: PERMISSION_LABELS[key] });
    if (decision === "always") await this.grant(key);
    return decision !== "deny";
  }

  /** 授权某类操作，并切换到“按授权执行”模式 */
  async grant(key: PermissionKey) {
    const s = this.getSettings();
    if (!s.grantedPermissions.includes(key)) s.grantedPermissions.push(key);
    if (s.confirmMode === "manual") s.confirmMode = "grant";
    await this.save();
    new Notice(`已授权：${PERMISSION_LABELS[key]}。之后这类操作将直接执行，可在聊天面板或设置中收回。`);
  }
}
