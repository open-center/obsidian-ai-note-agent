import { App, MarkdownView, normalizePath, TFile, TFolder, TAbstractFile } from "obsidian";
import type { ImagePart, ToolSpec } from "./llm";
import { confirmChange } from "./diff";
import type { AgentSettings } from "./settings";
import { Attachment, extractText, formatSize, KIND_LABELS, kindOf, mimeOf, pdfPageCount, pdfPageImage, toImagePart } from "./attachments";
import { CONFIG_TARGETS, maskSecrets, ObsidianControl, stringify } from "./control";

/** 一次可撤销的改动 */
export interface ChangeRecord {
  kind: "write" | "move" | "delete" | "custom";
  path: string;
  /** 修改前内容；null 表示原本不存在 */
  before: string | null;
  after: string | null;
  fromPath?: string;
  /** kind 为 custom 时的撤销函数（插件开关、设置修改、保存的附件等） */
  revert?: () => Promise<string>;
}

export interface ToolResult {
  /** 返回给模型的文本 */
  output: string;
  /** 产生的改动（用于撤销） */
  change?: ChangeRecord;
  isError?: boolean;
  /** 需要让模型“看到”的图片（图片文件、PDF 页面） */
  images?: ImagePart[];
}

/** 一次对话的会话状态（用户添加的附件） */
export interface ToolSession {
  attachments: Attachment[];
}

/** 编辑器上下文：在用户切到聊天面板前记录的最后一个 Markdown 编辑器 */
export interface EditorContext {
  file: TFile | null;
  selection: string;
}

type ToolArgs = Record<string, unknown>;
interface EditOp { old_text?: unknown; new_text?: unknown }

const str = (description: string) => ({ type: "string", description });

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "get_current_note",
    description: "获取用户当前打开的笔记的路径、完整内容，以及用户在编辑器里选中的文本。",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_note",
    description:
      "读取仓库中的文件或用户添加的附件的文字内容。path 可以是仓库路径（如 'Projects/计划.md'，可省略 .md 或只给文件名），也可以是附件编号（如 'att1'）。支持 Markdown/文本、PDF（可用 start_page/end_page 分段读取）、Word(.docx)、PowerPoint(.pptx)、Excel(.xlsx)。图片请用 view_image。",
    parameters: {
      type: "object",
      properties: {
        path: str("仓库中的文件路径，或附件编号如 att1"),
        start_page: { type: "number", description: "仅 PDF：起始页（从 1 开始）" },
        end_page: { type: "number", description: "仅 PDF：结束页（含）" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "列出某个文件夹下的文件和子文件夹。folder 为空表示仓库根目录。",
    parameters: {
      type: "object",
      properties: {
        folder: str("文件夹路径，留空为根目录"),
        recursive: { type: "boolean", description: "是否递归列出子文件夹，默认 false" },
      },
      required: [],
    },
  },
  {
    name: "search_notes",
    description: "在所有 Markdown 笔记的文件名和正文中搜索关键词（不区分大小写），返回匹配的路径和片段。多个关键词用空格分隔，需全部命中。",
    parameters: {
      type: "object",
      properties: { query: str("搜索关键词"), limit: { type: "number", description: "最多返回条数，默认 20" } },
      required: ["query"],
    },
  },
  {
    name: "edit_note",
    description:
      "对笔记做局部修改：按顺序把每个 old_text 精确替换为 new_text。old_text 必须与原文逐字一致（含空格、换行）且在笔记中只出现一次；不唯一时请多带一些上下文。这是修改已有笔记的首选方式。",
    parameters: {
      type: "object",
      properties: {
        path: str("笔记路径"),
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: { old_text: str("要被替换的原文"), new_text: str("替换后的新文本") },
            required: ["old_text", "new_text"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
  {
    name: "write_note",
    description: "用新内容完整覆盖一篇笔记（不存在则创建）。仅在需要整体重写时使用；局部修改请用 edit_note。",
    parameters: { type: "object", properties: { path: str("笔记路径"), content: str("完整的新内容") }, required: ["path", "content"] },
  },
  {
    name: "create_note",
    description: "新建笔记。如果文件已存在会报错。会自动创建缺失的父文件夹。",
    parameters: { type: "object", properties: { path: str("新笔记路径，如 'Inbox/新想法.md'"), content: str("笔记内容") }, required: ["path", "content"] },
  },
  {
    name: "append_to_note",
    description: "在笔记末尾追加内容；若提供 heading，则追加到该标题所在章节的末尾。",
    parameters: {
      type: "object",
      properties: { path: str("笔记路径"), content: str("要追加的内容"), heading: str("可选：标题文字（不含 #），追加到该章节末尾") },
      required: ["path", "content"],
    },
  },
  {
    name: "move_note",
    description: "重命名或移动笔记，Obsidian 会自动更新指向它的双链。",
    parameters: { type: "object", properties: { path: str("原路径"), new_path: str("新路径") }, required: ["path", "new_path"] },
  },
  {
    name: "delete_note",
    description: "把笔记移到回收站（始终需要用户确认）。",
    parameters: { type: "object", properties: { path: str("笔记路径") }, required: ["path"] },
  },
  {
    name: "create_folder",
    description: "创建文件夹（含父文件夹）。",
    parameters: { type: "object", properties: { path: str("文件夹路径") }, required: ["path"] },
  },
];

/** 附件与图片相关工具 */
const FILE_SPECS: ToolSpec[] = [
  {
    name: "list_attachments",
    description: "列出用户在本次对话中添加的附件（来自电脑的文件、文件夹、粘贴或拖入的图片），包括编号、名称、类型、大小、PDF 页数。",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "view_image",
    description:
      "查看图片，让你直接看到画面：可以是附件编号或仓库中的图片路径；对 PDF（附件或仓库文件）则把指定页渲染成图片，适用于扫描件、图表、手写内容。一次最多 4 页。",
    parameters: {
      type: "object",
      properties: {
        path: str("附件编号（如 att2）或仓库中的图片 / PDF 路径"),
        page: { type: "number", description: "仅 PDF：要查看的起始页，默认 1" },
        page_count: { type: "number", description: "仅 PDF：从起始页开始连续查看的页数，默认 1，最多 4" },
      },
      required: ["path"],
    },
  },
  {
    name: "save_attachment",
    description:
      "把附件原文件（PDF、图片、文档等）保存到仓库中，返回仓库路径，之后可以在笔记里用 ![[路径]] 嵌入或 [[路径]] 链接。path 留空时按用户的附件存放设置自动选择位置。",
    parameters: {
      type: "object",
      properties: { id: str("附件编号，如 att1"), path: str("可选：保存到仓库中的路径（含文件名）") },
      required: ["id"],
    },
  },
];

/** 控制 Obsidian 的工具（需在设置中允许） */
const CONTROL_SPECS: ToolSpec[] = [
  {
    name: "list_commands",
    description: "搜索 Obsidian 的命令（命令面板里的所有命令，包括核心功能和各插件的命令），返回命令 ID 和名称。",
    parameters: { type: "object", properties: { query: str("关键词，可中英文，留空列出前 100 条") }, required: [] },
  },
  {
    name: "run_command",
    description: "执行一条 Obsidian 命令（需要用户确认）。命令作用于当前活动的编辑器/视图，执行前可先打开相应笔记。",
    parameters: { type: "object", properties: { id: str("命令 ID，来自 list_commands") }, required: ["id"] },
  },
  {
    name: "list_plugins",
    description: "列出已安装的社区插件和核心插件，以及它们是否启用。",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "set_plugin_enabled",
    description: "启用或停用一个已安装的社区插件或核心插件（需要用户确认，可撤销）。",
    parameters: {
      type: "object",
      properties: { id: str("插件 ID"), enabled: { type: "boolean", description: "true 启用，false 停用" } },
      required: ["id", "enabled"],
    },
  },
  {
    name: "get_settings",
    description: `读取设置（JSON）。target 可以是：${Object.entries(CONFIG_TARGETS).map(([k, v]) => `'${k}' = ${v}`).join("；")}；或者插件 ID（社区插件读取其 data.json，核心插件如 'daily-notes'、'templates' 读取其设置）。密钥类字段会显示为 ***。`,
    parameters: { type: "object", properties: { target: str("app / appearance / hotkeys / core-plugins / 插件 ID") }, required: ["target"] },
  },
  {
    name: "update_settings",
    description:
      "修改设置（需要用户确认，可撤销）：把 changes 深度合并到 target 的设置中，值为 null 表示删除该项。修改前请先用 get_settings 查看现有结构。修改社区插件设置后会自动重新加载该插件使其生效。",
    parameters: {
      type: "object",
      properties: {
        target: str("app / appearance / 插件 ID"),
        changes: { type: "object", description: "要修改的字段，例如 {\"readableLineLength\": false}" },
      },
      required: ["target", "changes"],
    },
  },
  {
    name: "open_plugin_page",
    description: "在 Obsidian 中打开某个社区插件的详情页，用户可以在页面上点击安装。用于用户想安装新插件的情况（出于安全考虑，你不能直接下载安装插件）。",
    parameters: { type: "object", properties: { id: str("社区插件 ID，例如 'dataview'") }, required: ["id"] },
  },
  {
    name: "open_settings",
    description: "打开 Obsidian 设置窗口，可指定标签页（如 'editor'、'appearance'、'hotkeys'、'community-plugins' 或某个插件 ID）。",
    parameters: { type: "object", properties: { tab: str("可选：设置标签页 ID") }, required: [] },
  },
];

/** 当前可用的工具定义 */
export function toolSpecs(allowControl: boolean): ToolSpec[] {
  return allowControl ? [...TOOL_SPECS, ...FILE_SPECS, ...CONTROL_SPECS] : [...TOOL_SPECS, ...FILE_SPECS];
}

export const WRITE_TOOLS = new Set([
  "edit_note", "write_note", "create_note", "append_to_note", "move_note", "delete_note", "create_folder",
  "save_attachment", "run_command", "set_plugin_enabled", "update_settings",
]);

export class VaultTools {
  readonly control: ObsidianControl;

  constructor(private app: App, private getSettings: () => AgentSettings, private getEditorCtx: () => EditorContext, pluginId = "notewright") {
    this.control = new ObsidianControl(app, pluginId);
  }

  // ---------- 路径辅助 ----------

  private clean(p: string): string {
    let s = (p ?? "").trim().replace(/^\/+/, "").replace(/^\[\[|\]\]$/g, "");
    if (s.includes("..")) throw new Error("路径不能包含 ..");
    return s === "" ? "" : normalizePath(s);
  }

  private withMd(p: string): string {
    return /\.[a-z0-9]+$/i.test(p) ? p : p + ".md";
  }

  /** 找到已存在的文件：精确路径 → 补 .md → 按文件名/链接解析 */
  private findFile(raw: string): TFile {
    const p = this.clean(raw);
    const direct = this.app.vault.getAbstractFileByPath(p) ?? this.app.vault.getAbstractFileByPath(this.withMd(p));
    if (direct instanceof TFile) return direct;
    const linked = this.app.metadataCache.getFirstLinkpathDest(p.replace(/\.md$/, ""), "");
    if (linked) return linked;
    throw new Error(`找不到笔记：${raw}。可先用 search_notes 或 list_files 查找正确路径。`);
  }

  private async ensureParent(path: string) {
    const idx = path.lastIndexOf("/");
    if (idx <= 0) return;
    const folder = path.slice(0, idx);
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
  }

  private truncate(text: string): string {
    const max = this.getSettings().maxReadChars;
    return text.length > max ? text.slice(0, max) + `\n\n…[内容过长，已截断，共 ${text.length} 字符]` : text;
  }

  private confirm(title: string, desc: string, before: string | null, after: string | null, force = false): Promise<boolean> {
    if (!force && this.getSettings().confirmMode === "never") return Promise.resolve(true);
    return confirmChange(this.app, title, desc, before, after);
  }

  // ---------- 执行 ----------

  async run(name: string, argsJson: string, session: ToolSession = { attachments: [] }): Promise<ToolResult> {
    let args: ToolArgs;
    try {
      const parsed: unknown = argsJson ? JSON.parse(argsJson) : {};
      args = parsed && typeof parsed === "object" ? (parsed as ToolArgs) : {};
    } catch {
      return { output: `参数不是合法 JSON：${argsJson.slice(0, 200)}`, isError: true };
    }
    const text = (k: string): string => {
      const v = args[k];
      return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
    };
    const num = (k: string): number | undefined => {
      const v = Number(args[k]);
      return args[k] == null || args[k] === "" || !Number.isFinite(v) ? undefined : v;
    };
    if (CONTROL_SPECS.some((t) => t.name === name) && !this.getSettings().allowControl) {
      return { output: "用户没有允许 Agent 控制 Obsidian（可在插件设置中开启）。", isError: true };
    }
    try {
      switch (name) {
        case "get_current_note": return await this.getCurrentNote();
        case "read_note": return await this.readNote(text("path"), num("start_page"), num("end_page"), session);
        case "list_files": return this.listFiles(text("folder"), args.recursive === true);
        case "search_notes": return await this.searchNotes(text("query"), Number(args.limit) || 20);
        case "edit_note": return await this.editNote(text("path"), Array.isArray(args.edits) ? (args.edits as EditOp[]) : []);
        case "write_note": return await this.writeNote(text("path"), text("content"));
        case "create_note": return await this.createNote(text("path"), text("content"));
        case "append_to_note": return await this.appendToNote(text("path"), text("content"), text("heading") || undefined);
        case "move_note": return await this.moveNote(text("path"), text("new_path"));
        case "delete_note": return await this.deleteNote(text("path"));
        case "create_folder": return await this.createFolder(text("path"));
        case "list_attachments": return this.listAttachments(session);
        case "view_image": return await this.viewImage(text("path"), num("page") ?? 1, num("page_count") ?? 1, session);
        case "save_attachment": return await this.saveAttachment(text("id"), text("path"), session);
        case "list_commands": return this.listCommands(text("query"));
        case "run_command": return await this.runCommand(text("id"));
        case "list_plugins": return this.listPlugins();
        case "set_plugin_enabled": return await this.setPluginEnabled(text("id"), args.enabled === true || args.enabled === "true");
        case "get_settings": return await this.getSettingsTool(text("target"));
        case "update_settings": return await this.updateSettings(text("target"), args.changes);
        case "open_plugin_page": return this.openPluginPage(text("id"));
        case "open_settings": return this.openSettings(text("tab"));
        default: return { output: `未知工具：${name}`, isError: true };
      }
    } catch (e) {
      return { output: `错误：${(e as Error).message}`, isError: true };
    }
  }

  private async getCurrentNote(): Promise<ToolResult> {
    const ctx = this.getEditorCtx();
    if (!ctx.file) return { output: "用户当前没有打开任何笔记。" };
    const content = await this.app.vault.read(ctx.file);
    let out = `路径：${ctx.file.path}\n\n<content>\n${this.truncate(content)}\n</content>`;
    if (ctx.selection) out += `\n\n用户选中的文本：\n<selection>\n${ctx.selection}\n</selection>`;
    return { output: out };
  }

  private async readNote(path: string, startPage: number | undefined, endPage: number | undefined, session: ToolSession): Promise<ToolResult> {
    const src = this.resolveSource(path, session);
    if (src.kind === "text" && src.file && /^(md|markdown|txt|canvas|base)$/i.test(src.file.extension)) {
      const content = await this.app.vault.read(src.file);
      return { output: `路径：${src.file.path}\n\n<content>\n${this.truncate(content)}\n</content>` };
    }
    if (src.kind === "image") {
      return { output: `${src.label} 是图片（${src.mime}）。图片已附上供你查看。`, images: [await toImagePart(await src.data(), src.mime, src.name)] };
    }
    const r = await extractText(await src.data(), src.name, src.mime, startPage, endPage);
    let head = src.label;
    if (r.pages) head += `（PDF，共 ${r.pages} 页，本次第 ${r.range?.[0]}–${r.range?.[1]} 页）`;
    const body = r.text.trim();
    let hint = "";
    if (r.pages && r.range) {
      const n = r.range[1] - r.range[0] + 1;
      if (body.replace(/--- 第 \d+ 页 ---/g, "").trim().length < 20 * n) hint = "\n\n提示：几乎没有提取到文字，可能是扫描件或图片型 PDF，可以用 view_image 按页查看。";
      if (r.range[1] < r.pages) hint += `\n\n还有第 ${r.range[1] + 1}–${r.pages} 页未读取，需要时用 start_page 继续读取。`;
    }
    return { output: `${head}\n\n<content>\n${this.truncate(body || "（没有文字内容）")}\n</content>${hint}` };
  }

  // ---------- 附件 / 文件来源 ----------

  /** 把“附件编号或仓库路径”解析成统一的数据源 */
  private resolveSource(path: string, session: ToolSession): {
    label: string; name: string; mime: string; kind: ReturnType<typeof kindOf>; file?: TFile; data: () => Promise<ArrayBuffer>;
  } {
    const key = (path ?? "").trim();
    const att = session.attachments.find((a) => a.id === key || a.id === key.replace(/^#/, "") || a.name === key || a.relPath === key);
    if (att) {
      return { label: `附件 ${att.id}「${att.relPath ?? att.name}」`, name: att.name, mime: att.mime, kind: att.kind, data: () => Promise.resolve(att.data) };
    }
    if (/^att\d+$/i.test(key)) throw new Error(`没有编号为 ${key} 的附件，可用 list_attachments 查看。`);
    const f = this.findFile(path);
    const mime = mimeOf(f.name);
    return { label: `文件 ${f.path}`, name: f.name, mime, kind: kindOf(f.name, mime), file: f, data: () => this.app.vault.readBinary(f) };
  }

  private listAttachments(session: ToolSession): ToolResult {
    if (!session.attachments.length) return { output: "本次对话中用户还没有添加附件。" };
    const lines = session.attachments.map((a) => `- ${a.id}：${a.relPath ?? a.name}（${KIND_LABELS[a.kind]}，${formatSize(a.size)}）`);
    return { output: lines.join("\n") };
  }

  private async viewImage(path: string, page: number, count: number, session: ToolSession): Promise<ToolResult> {
    const src = this.resolveSource(path, session);
    const data = await src.data();
    if (src.kind === "image") return { output: `${src.label} 已附上供你查看。`, images: [await toImagePart(data, src.mime, src.name)] };
    if (src.kind !== "pdf") throw new Error(`${src.label} 不是图片或 PDF，请用 read_note 读取文字内容。`);
    const n = Math.min(4, Math.max(1, Math.floor(count)));
    const images: ImagePart[] = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const pageNo = Math.max(1, Math.floor(page)) + i;
      if (total && pageNo > total) break;
      const r = await pdfPageImage(data, pageNo, src.name);
      total = r.pages;
      images.push(r.image);
    }
    const first = Math.max(1, Math.floor(page));
    return { output: `${src.label} 第 ${first}${images.length > 1 ? `–${first + images.length - 1}` : ""} 页（共 ${total} 页）已渲染为图片附上。`, images };
  }

  private async saveAttachment(id: string, path: string, session: ToolSession): Promise<ToolResult> {
    const att = session.attachments.find((a) => a.id === id.trim().replace(/^#/, ""));
    if (!att) throw new Error(`没有编号为 ${id} 的附件，可用 list_attachments 查看。`);
    let target: string;
    if (path.trim()) {
      target = this.clean(path);
      if (!/\.[a-z0-9]+$/i.test(target)) target = `${target.replace(/\/$/, "")}/${att.name}`;
      if (this.app.vault.getAbstractFileByPath(target)) throw new Error(`目标已存在：${target}`);
    } else {
      target = await this.app.fileManager.getAvailablePathForAttachment(att.name, this.getEditorCtx().file?.path ?? "");
    }
    if (!(await this.confirm("保存附件到仓库", `${att.relPath ?? att.name}（${formatSize(att.size)}）  →  ${target}`, null, null))) {
      return { output: "用户拒绝了保存。" };
    }
    await this.ensureParent(target);
    const file = await this.app.vault.createBinary(target, att.data.slice(0));
    const app = this.app;
    return {
      output: `已保存到 ${file.path}。在笔记中嵌入：![[${file.path}]]，或链接：[[${file.path}]]`,
      change: {
        kind: "custom", path: file.path, before: null, after: null,
        revert: async () => {
          const f = app.vault.getAbstractFileByPath(file.path);
          if (f instanceof TFile) await app.fileManager.trashFile(f);
          return `已删除保存的附件 ${file.path}`;
        },
      },
    };
  }

  // ---------- 控制 Obsidian ----------

  private listCommands(query: string): ToolResult {
    const list = this.control.listCommands(query);
    if (!list.length) return { output: `没有找到包含“${query}”的命令。` };
    return { output: list.map((c) => `- ${c.id}：${c.name}`).join("\n") + (list.length >= 100 ? "\n…（只显示前 100 条，可换更具体的关键词）" : "") };
  }

  private async runCommand(id: string): Promise<ToolResult> {
    const cmd = this.control.findCommand(id);
    if (!cmd) throw new Error(`找不到命令：${id}。请先用 list_commands 搜索。`);
    if (!(await confirmChange(this.app, "执行 Obsidian 命令", `${cmd.name}\n（${cmd.id}）`, null, null, "执行"))) return { output: "用户拒绝了执行这条命令。" };
    const ok = this.control.runCommand(cmd.id);
    return { output: ok ? `已执行命令：${cmd.name}` : `命令「${cmd.name}」当前不可用（可能需要先打开或聚焦某个笔记/视图）。`, isError: !ok };
  }

  private listPlugins(): ToolResult {
    const { community, core } = this.control.listPlugins();
    const c = community.map((p) => `- ${p.enabled ? "✅" : "⬜"} ${p.id}：${p.name}${p.version ? ` ${p.version}` : ""}${p.description ? ` — ${p.description}` : ""}`);
    const k = core.map((p) => `- ${p.enabled ? "✅" : "⬜"} ${p.id}：${p.name}`);
    return { output: `社区插件（${community.length}）：\n${c.join("\n") || "（无）"}\n\n核心插件（${core.length}）：\n${k.join("\n") || "（无）"}` };
  }

  private async setPluginEnabled(id: string, enabled: boolean): Promise<ToolResult> {
    const st = this.control.pluginState(id);
    if (st.enabled === enabled) return { output: `${st.name}（${id}）已经是${enabled ? "启用" : "停用"}状态。` };
    const kindLabel = st.type === "core" ? "核心插件" : "社区插件";
    if (!(await confirmChange(this.app, `${enabled ? "启用" : "停用"}${kindLabel}`, `${st.name}（${id}）`, null, null, enabled ? "启用" : "停用"))) {
      return { output: "用户拒绝了这次操作。" };
    }
    await this.control.setPluginEnabled(id, enabled);
    const control = this.control;
    return {
      output: `已${enabled ? "启用" : "停用"}${kindLabel}：${st.name}（${id}）`,
      change: {
        kind: "custom", path: id, before: null, after: null,
        revert: async () => {
          await control.setPluginEnabled(id, !enabled);
          return `已${enabled ? "停用" : "重新启用"} ${st.name}`;
        },
      },
    };
  }

  private async getSettingsTool(target: string): Promise<ToolResult> {
    if (!target) throw new Error("target 不能为空");
    const { path, value } = await this.control.readSettings(target);
    return { output: `${path}：\n${this.truncate(stringify(maskSecrets(value)))}` };
  }

  private async updateSettings(target: string, changes: unknown): Promise<ToolResult> {
    if (!target) throw new Error("target 不能为空");
    const pv = await this.control.previewSettings(target, changes);
    const beforeText = stringify(maskSecrets(pv.before));
    const afterText = stringify(maskSecrets(pv.after));
    if (beforeText === afterText) return { output: "设置没有变化。" };
    if (!(await confirmChange(this.app, "修改设置", pv.path, beforeText, afterText))) return { output: "用户拒绝了这次设置修改。" };
    await this.control.writeSettings(target, pv.kind, pv.path, pv.before, pv.after);
    const control = this.control;
    return {
      output: `已更新 ${pv.path}${pv.kind === "plugin" ? "，并重新加载了该插件" : ""}。`,
      change: {
        kind: "custom", path: pv.path, before: null, after: null,
        revert: async () => {
          await control.writeSettings(target, pv.kind, pv.path, pv.after, pv.before);
          return `已恢复 ${pv.path} 修改前的设置`;
        },
      },
    };
  }

  private openPluginPage(id: string): ToolResult {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error("插件 ID 只能包含字母、数字、点、下划线和连字符");
    this.control.openPluginPage(id);
    return { output: `已打开社区插件「${id}」的详情页，请用户在页面上点击“安装”，安装后再“启用”。如果页面提示找不到，说明插件 ID 不正确。` };
  }

  private openSettings(tab: string): ToolResult {
    this.control.openSettings(tab || undefined);
    return { output: tab ? `已打开设置：${tab}` : "已打开设置窗口。" };
  }

  /** PDF 附件的页数（用于在消息中提示模型） */
  static async describe(att: Attachment): Promise<string> {
    let extra = "";
    if (att.kind === "pdf") {
      try { extra = `，${await pdfPageCount(att.data)} 页`; } catch { extra = "，无法解析页数"; }
    }
    return `${att.id}：${att.relPath ?? att.name}（${KIND_LABELS[att.kind]}，${formatSize(att.size)}${extra}）`;
  }

  private listFiles(folder: string, recursive: boolean): ToolResult {
    const p = this.clean(folder);
    const root = p ? this.app.vault.getAbstractFileByPath(p) : this.app.vault.getRoot();
    if (!(root instanceof TFolder)) throw new Error(`文件夹不存在：${folder}`);
    const lines: string[] = [];
    const walk = (f: TFolder, depth: number) => {
      const children = [...f.children].sort((a, b) => a.name.localeCompare(b.name));
      for (const c of children) {
        if (lines.length >= 500) return;
        if (c.name.startsWith(".")) continue;
        if (c instanceof TFolder) {
          lines.push(`${"  ".repeat(depth)}📁 ${c.path}/`);
          if (recursive) walk(c, depth + 1);
        } else {
          lines.push(`${"  ".repeat(depth)}${c.path}`);
        }
      }
    };
    walk(root, 0);
    if (!lines.length) return { output: "（空文件夹）" };
    return { output: lines.join("\n") + (lines.length >= 500 ? "\n…（结果过多，已截断到 500 条）" : "") };
  }

  private async searchNotes(query: string, limit: number): Promise<ToolResult> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) throw new Error("query 不能为空");
    const results: string[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (results.length >= limit) break;
      const text = await this.app.vault.cachedRead(f);
      const hay = (f.path + "\n" + text).toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
      const idx = text.toLowerCase().indexOf(terms[0]);
      const snippet = idx >= 0 ? text.slice(Math.max(0, idx - 60), idx + 120).replace(/\s+/g, " ") : text.slice(0, 120).replace(/\s+/g, " ");
      results.push(`- ${f.path}\n  …${snippet}…`);
    }
    return { output: results.length ? results.join("\n") : `没有找到包含“${query}”的笔记。` };
  }

  private async editNote(path: string, edits: EditOp[]): Promise<ToolResult> {
    const f = this.findFile(path);
    const before = await this.app.vault.read(f);
    if (!Array.isArray(edits) || !edits.length) throw new Error("edits 不能为空");
    let after = before;
    edits.forEach((e, i) => {
      const oldT = typeof e.old_text === "string" ? e.old_text : "";
      const newT = typeof e.new_text === "string" ? e.new_text : "";
      if (!oldT) throw new Error(`第 ${i + 1} 处修改的 old_text 为空`);
      const first = after.indexOf(oldT);
      if (first < 0) throw new Error(`第 ${i + 1} 处修改：在笔记中找不到 old_text，请先重新 read_note 获取最新原文。`);
      if (after.indexOf(oldT, first + 1) >= 0) throw new Error(`第 ${i + 1} 处修改：old_text 出现了多次，请包含更多上下文使其唯一。`);
      after = after.slice(0, first) + newT + after.slice(first + oldT.length);
    });
    return this.applyWrite(f.path, before, after, `修改 ${f.path}`);
  }

  private async writeNote(path: string, content: string): Promise<ToolResult> {
    const p = this.withMd(this.clean(path));
    const existing = this.app.vault.getAbstractFileByPath(p);
    const before = existing instanceof TFile ? await this.app.vault.read(existing) : null;
    return this.applyWrite(p, before, content, before === null ? `新建 ${p}` : `覆盖 ${p}`);
  }

  private async createNote(path: string, content: string): Promise<ToolResult> {
    const p = this.withMd(this.clean(path));
    if (!p) throw new Error("path 不能为空");
    if (this.app.vault.getAbstractFileByPath(p)) throw new Error(`文件已存在：${p}。如需修改请用 edit_note 或 write_note。`);
    return await this.applyWrite(p, null, content, `新建 ${p}`);
  }

  private async appendToNote(path: string, content: string, heading?: string): Promise<ToolResult> {
    const f = this.findFile(path);
    const before = await this.app.vault.read(f);
    let after: string;
    if (heading) {
      const lines = before.split("\n");
      const target = heading.replace(/^#+\s*/, "").trim();
      const hIdx = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim() === target);
      if (hIdx < 0) throw new Error(`找不到标题：${heading}`);
      const level = (lines[hIdx].match(/^#+/) as RegExpMatchArray)[0].length;
      let end = lines.length;
      for (let i = hIdx + 1; i < lines.length; i++) {
        const m = lines[i].match(/^(#{1,6})\s/);
        if (m && m[1].length <= level) { end = i; break; }
      }
      // 去掉章节尾部空行后插入
      let ins = end;
      while (ins > hIdx + 1 && lines[ins - 1].trim() === "") ins--;
      lines.splice(ins, 0, content);
      after = lines.join("\n");
    } else {
      after = before.replace(/\s*$/, "") + (before.trim() ? "\n\n" : "") + content + "\n";
    }
    return this.applyWrite(f.path, before, after, `追加内容到 ${f.path}`);
  }

  private async moveNote(path: string, newPath: string): Promise<ToolResult> {
    const f = this.findFile(path);
    const np = this.withMd(this.clean(newPath));
    if (this.app.vault.getAbstractFileByPath(np)) throw new Error(`目标已存在：${np}`);
    if (!(await this.confirm("移动 / 重命名笔记", `${f.path}  →  ${np}`, null, null))) return { output: "用户拒绝了这次移动。" };
    const from = f.path;
    await this.ensureParent(np);
    await this.app.fileManager.renameFile(f, np);
    return { output: `已移动：${from} → ${np}`, change: { kind: "move", path: np, fromPath: from, before: null, after: null } };
  }

  private async deleteNote(path: string): Promise<ToolResult> {
    const f = this.findFile(path);
    const before = await this.app.vault.read(f);
    if (!(await this.confirm("删除笔记（移到回收站）", f.path, before, "", true))) return { output: "用户拒绝了删除。" };
    await this.trash(f);
    return { output: `已将 ${f.path} 移到回收站。`, change: { kind: "delete", path: f.path, before, after: null } };
  }

  private async createFolder(path: string): Promise<ToolResult> {
    const p = this.clean(path);
    if (!p) throw new Error("path 不能为空");
    if (this.app.vault.getAbstractFileByPath(p)) return { output: `文件夹已存在：${p}` };
    await this.app.vault.createFolder(p);
    return { output: `已创建文件夹：${p}` };
  }

  private async applyWrite(path: string, before: string | null, after: string, title: string): Promise<ToolResult> {
    if (before === after) return { output: "内容没有变化，未写入。" };
    if (!(await this.confirm(title, "以下是 Agent 计划进行的修改：", before, after))) {
      return { output: "用户拒绝了这次修改，文件未改动。请询问用户希望如何调整。" };
    }
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.process(existing, () => after);
    else {
      await this.ensureParent(path);
      await this.app.vault.create(path, after);
    }
    return { output: `已写入 ${path}（${after.length} 字符）。`, change: { kind: "write", path, before, after } };
  }

  /** 按用户在 Obsidian 中设置的删除方式（系统回收站 / .trash / 永久删除）处理 */
  private async trash(f: TFile) {
    await this.app.fileManager.trashFile(f);
  }

  // ---------- 撤销 ----------

  async undo(c: ChangeRecord): Promise<string> {
    if (c.revert) return c.revert();
    const vault = this.app.vault;
    const get = (p: string): TAbstractFile | null => vault.getAbstractFileByPath(p);
    if (c.kind === "move") {
      const f = get(c.path);
      if (!(f instanceof TFile) || !c.fromPath) throw new Error("文件已不在原位置，无法撤销");
      await this.app.fileManager.renameFile(f, c.fromPath);
      return `已移回 ${c.fromPath}`;
    }
    if (c.kind === "delete") {
      if (get(c.path)) throw new Error("同名文件已存在，无法恢复");
      await this.ensureParent(c.path);
      await vault.create(c.path, c.before ?? "");
      return `已恢复 ${c.path}`;
    }
    const f = get(c.path);
    if (c.before === null) {
      if (f instanceof TFile) await this.trash(f);
      return `已删除新建的 ${c.path}（移到回收站）`;
    }
    if (f instanceof TFile) { const before = c.before; await vault.process(f, () => before); }
    else { await this.ensureParent(c.path); await vault.create(c.path, c.before); }
    return `已恢复 ${c.path} 修改前的内容`;
  }
}

/** 获取当前活动的 Markdown 编辑器（排除聊天面板本身） */
export function activeMarkdownView(app: App): MarkdownView | null {
  return app.workspace.getActiveViewOfType(MarkdownView);
}
