import { App, MarkdownView, normalizePath, TFile, TFolder, TAbstractFile } from "obsidian";
import type { ToolSpec } from "./llm";
import { confirmChange } from "./diff";
import type { AgentSettings } from "./settings";

/** 一次可撤销的改动 */
export interface ChangeRecord {
  kind: "write" | "move" | "delete";
  path: string;
  /** 修改前内容；null 表示原本不存在 */
  before: string | null;
  after: string | null;
  fromPath?: string;
}

export interface ToolResult {
  /** 返回给模型的文本 */
  output: string;
  /** 产生的改动（用于撤销） */
  change?: ChangeRecord;
  isError?: boolean;
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
    description: "读取指定路径的笔记全文。路径相对于仓库根目录，例如 'Projects/计划.md'。可省略 .md 后缀，也可只给文件名。",
    parameters: { type: "object", properties: { path: str("笔记路径") }, required: ["path"] },
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

export const WRITE_TOOLS = new Set(["edit_note", "write_note", "create_note", "append_to_note", "move_note", "delete_note", "create_folder"]);

export class VaultTools {
  constructor(private app: App, private getSettings: () => AgentSettings, private getEditorCtx: () => EditorContext) {}

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

  async run(name: string, argsJson: string): Promise<ToolResult> {
    let args: ToolArgs;
    try {
      const parsed: unknown = argsJson ? JSON.parse(argsJson) : {};
      args = parsed && typeof parsed === "object" ? (parsed as ToolArgs) : {};
    } catch {
      return { output: `参数不是合法 JSON：${argsJson.slice(0, 200)}`, isError: true };
    }
    const text = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : args[k] == null ? "" : JSON.stringify(args[k]));
    try {
      switch (name) {
        case "get_current_note": return await this.getCurrentNote();
        case "read_note": return await this.readNote(text("path"));
        case "list_files": return this.listFiles(text("folder"), args.recursive === true);
        case "search_notes": return await this.searchNotes(text("query"), Number(args.limit) || 20);
        case "edit_note": return await this.editNote(text("path"), Array.isArray(args.edits) ? (args.edits as EditOp[]) : []);
        case "write_note": return await this.writeNote(text("path"), text("content"));
        case "create_note": return await this.createNote(text("path"), text("content"));
        case "append_to_note": return await this.appendToNote(text("path"), text("content"), text("heading") || undefined);
        case "move_note": return await this.moveNote(text("path"), text("new_path"));
        case "delete_note": return await this.deleteNote(text("path"));
        case "create_folder": return await this.createFolder(text("path"));
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

  private async readNote(path: string): Promise<ToolResult> {
    const f = this.findFile(path);
    const content = await this.app.vault.read(f);
    return { output: `路径：${f.path}\n\n<content>\n${this.truncate(content)}\n</content>` };
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
