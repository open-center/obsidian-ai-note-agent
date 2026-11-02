import { App, FileSystemAdapter, Platform } from "obsidian";
import type { ToolSpec } from "./llm";
import type { PermissionGate, PermissionKey } from "./permissions";
import type { ToolResult } from "./tools";

/**
 * 控制本地软件：启动应用、用默认程序打开文件/网址、执行 shell 命令。
 * 仅桌面端可用（依赖 Electron / Node），需要在设置中开启；除 get_system_info 外都按权限模式确认。
 */

type ToolArgs = Record<string, unknown>;
type ChildProcess = typeof import("child_process");
type ElectronShell = { openPath(path: string): Promise<string>; openExternal(url: string): Promise<void> };

/** Obsidian 桌面端渲染进程提供的 Node require；移动端不存在 */
function nodeRequire<T>(id: string): T {
  const req = (window as unknown as { require?: (id: string) => unknown }).require;
  if (!Platform.isDesktopApp || typeof req !== "function") throw new Error("本地控制仅在桌面版 Obsidian 中可用");
  return req(id) as T;
}

/** 环境变量（HOME、SHELL 等） */
function env(name: string): string | undefined {
  return nodeRequire<{ env: Record<string, string | undefined> }>("process").env[name];
}

function nodeProcess(): { platform: string; arch: string } {
  return nodeRequire<{ platform: string; arch: string }>("process");
}

const str = (description: string) => ({ type: "string", description });

/** 命令输出最多返回给模型的字符数 */
const MAX_OUTPUT = 20000;

export const SYSTEM_TOOL_SPECS: ToolSpec[] = [
  {
    name: "get_system_info",
    description: "获取本机操作系统、CPU 架构、默认 shell 和仓库在磁盘上的绝对路径。执行本地命令前先调用它，以选择正确的命令语法。",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "open_app",
    description:
      "启动本地应用程序，可选地让它打开一个文件或网址。macOS 上 app 为应用名（如 'Safari'、'Visual Studio Code'）；Windows 上为可执行文件名或完整路径（如 'notepad'、'C:\\\\Program Files\\\\...\\\\app.exe'）；Linux 上为命令名（如 'firefox'）。",
    parameters: {
      type: "object",
      properties: {
        app: str("应用名或可执行文件路径"),
        target: str("可选：要用该应用打开的文件路径（仓库内相对路径或绝对路径）或网址"),
      },
      required: ["app"],
    },
  },
  {
    name: "open_with_default_app",
    description: "用系统默认程序打开文件、文件夹或网址（如用默认浏览器打开链接、用 Finder/资源管理器打开文件夹）。路径可以是仓库内相对路径或绝对路径。",
    parameters: { type: "object", properties: { target: str("文件/文件夹路径或网址（http、https、mailto 等）") }, required: ["target"] },
  },
  {
    name: "run_shell_command",
    description:
      "在本机执行一条 shell 命令并返回输出（stdout、stderr、退出码）。macOS/Linux 使用用户的默认 shell，Windows 使用 cmd.exe。默认工作目录为仓库根目录。macOS 上可以用 osascript 执行 AppleScript 控制其他应用。不要执行交互式命令（会等待输入直到超时）。",
    parameters: {
      type: "object",
      properties: {
        command: str("要执行的命令"),
        cwd: str("可选：工作目录（仓库内相对路径或绝对路径），默认仓库根目录"),
        timeout_seconds: { type: "number", description: "超时时间（秒），默认 60，最大 600" },
      },
      required: ["command"],
    },
  },
];

export const SYSTEM_TOOL_NAMES = new Set(SYSTEM_TOOL_SPECS.map((t) => t.name));

/** 本插件运行的平台是否支持本地控制（仅桌面端） */
export function systemControlSupported(): boolean {
  return Platform.isDesktopApp;
}

export class SystemTools {
  constructor(private app: App, private gate: PermissionGate) {}

  // Node / Electron 模块只在桌面端按需加载，避免移动端加载插件时报错
  private cp(): ChildProcess {
    return nodeRequire<ChildProcess>("child_process");
  }

  private shell(): ElectronShell {
    return nodeRequire<{ shell: ElectronShell }>("electron").shell;
  }

  private vaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    throw new Error("无法获取仓库在磁盘上的路径");
  }

  /** 把仓库相对路径转换成绝对路径；绝对路径、~ 开头的路径和网址原样返回 */
  private resolve(p: string): string {
    const s = p.trim();
    if (!s || this.isUrl(s)) return s;
    if (s.startsWith("/") || /^[a-z]:[\\/]/i.test(s) || s.startsWith("\\\\")) return s;
    if (s === "~" || s.startsWith("~/")) return (env("HOME") ?? "") + s.slice(1);
    const sep = Platform.isWin ? "\\" : "/";
    return this.vaultPath() + sep + s.replace(/[\\/]/g, sep);
  }

  private isUrl(s: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z]:[\\/]/i.test(s);
  }

  private confirm(key: PermissionKey, title: string, desc: string, detail: string): Promise<boolean> {
    return this.gate.confirm(key, title, desc, null, null, { code: detail, okText: "允许执行" });
  }

  async run(name: string, argsJson: string): Promise<ToolResult> {
    if (!systemControlSupported()) return { output: "本地控制仅在桌面版 Obsidian 中可用。", isError: true };
    let args: ToolArgs;
    try {
      const parsed: unknown = argsJson ? JSON.parse(argsJson) : {};
      args = parsed && typeof parsed === "object" ? (parsed as ToolArgs) : {};
    } catch {
      return { output: `参数不是合法 JSON：${argsJson.slice(0, 200)}`, isError: true };
    }
    const text = (k: string): string => {
      const v = args[k];
      return typeof v === "string" ? v : "";
    };
    try {
      switch (name) {
        case "get_system_info": return this.systemInfo();
        case "open_app": return await this.openApp(text("app"), text("target"));
        case "open_with_default_app": return await this.openDefault(text("target"));
        case "run_shell_command": return await this.runCommand(text("command"), text("cwd"), Number(args.timeout_seconds) || 60);
        default: return { output: `未知工具：${name}`, isError: true };
      }
    } catch (e) {
      return { output: `错误：${(e as Error).message}`, isError: true };
    }
  }

  private systemInfo(): ToolResult {
    const os = Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "未知";
    const shell = Platform.isWin ? (env("ComSpec") ?? "cmd.exe") : (env("SHELL") ?? "/bin/sh");
    return {
      output: [
        `操作系统：${os}（${nodeProcess().platform} ${nodeProcess().arch}）`,
        `默认 shell：${shell}`,
        `仓库路径：${this.vaultPath()}`,
        `用户主目录：${env("HOME") ?? env("USERPROFILE") ?? "?"}`,
      ].join("\n"),
    };
  }

  private async openApp(app: string, target: string): Promise<ToolResult> {
    if (!app.trim()) throw new Error("app 不能为空");
    const t = target.trim() ? (this.isUrl(target.trim()) ? target.trim() : this.resolve(target)) : "";
    let file: string, argv: string[];
    if (Platform.isMacOS) { file = "open"; argv = ["-a", app, ...(t ? [t] : [])]; }
    // Windows 用 start 启动；参数原样传给 cmd，含空格的需自行加引号
    else if (Platform.isWin) { file = "cmd.exe"; argv = ["/c", "start", '""', ...[app, ...(t ? [t] : [])].map((a) => (/\s/.test(a) ? `"${a}"` : a))]; }
    else { file = app; argv = t ? [t] : []; }
    const display = [file, ...argv].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
    if (!(await this.confirm("system-open", "启动本地应用", `Agent 想要启动「${app}」${t ? "并打开：" + t : ""}`, display))) {
      return { output: "用户拒绝了启动该应用。" };
    }
    await new Promise<void>((resolve, reject) => {
      const child = this.cp().spawn(file, argv, { detached: true, stdio: "ignore", windowsVerbatimArguments: Platform.isWin });
      child.once("error", reject);
      // macOS 的 open 会很快退出，可据此判断应用是否存在；其他平台进程常驻，短暂等待后视为成功
      child.once("exit", (code) => (code ? reject(new Error(`启动失败（退出码 ${code}），请检查应用名是否正确`)) : resolve()));
      window.setTimeout(resolve, 1500);
      child.unref();
    });
    return { output: `已启动 ${app}${t ? `，打开 ${t}` : ""}。` };
  }

  private async openDefault(target: string): Promise<ToolResult> {
    const raw = target.trim();
    if (!raw) throw new Error("target 不能为空");
    const url = this.isUrl(raw);
    const t = url ? raw : this.resolve(raw);
    if (!(await this.confirm("system-open", "用默认程序打开", url ? "Agent 想要打开网址：" : "Agent 想要用系统默认程序打开：", t))) {
      return { output: "用户拒绝了打开。" };
    }
    if (url) await this.shell().openExternal(t);
    else {
      const err = await this.shell().openPath(t);
      if (err) throw new Error(err);
    }
    return { output: `已打开 ${t}` };
  }

  private async runCommand(command: string, cwd: string, timeoutSec: number): Promise<ToolResult> {
    if (!command.trim()) throw new Error("command 不能为空");
    const dir = cwd.trim() ? this.resolve(cwd) : this.vaultPath();
    const timeout = Math.min(Math.max(timeoutSec, 1), 600) * 1000;
    if (!(await this.confirm("system-shell", "执行本地命令", `工作目录：${dir}`, command))) {
      return { output: "用户拒绝了执行该命令。" };
    }
    const shell = Platform.isWin ? undefined : (env("SHELL") ?? "/bin/sh");
    const { stdout, stderr, code, killed } = await new Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>((resolve) => {
      this.cp().exec(command, { cwd: dir, timeout, shell, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, so, se) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        resolve({
          stdout: String(so),
          stderr: String(se) || (e && typeof e.code !== "number" ? e.message : ""),
          code: e ? (typeof e.code === "number" ? e.code : -1) : 0,
          killed: !!e?.killed,
        });
      });
    });
    const clip = (s: string) => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n…[输出过长，已截断，共 ${s.length} 字符]` : s);
    let out = killed ? `命令超时（${timeout / 1000} 秒）被终止。\n` : `退出码：${code}\n`;
    if (stdout.trim()) out += `\n<stdout>\n${clip(stdout)}\n</stdout>`;
    if (stderr.trim()) out += `\n<stderr>\n${clip(stderr)}\n</stderr>`;
    if (!stdout.trim() && !stderr.trim()) out += "（没有输出）";
    return { output: out, isError: killed || code !== 0 };
  }
}
