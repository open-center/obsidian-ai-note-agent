import { App, Modal } from "obsidian";

/** 非文件修改类确认（如执行命令）的附加选项 */
export interface ConfirmOptions {
  /** 以等宽代码块显示的内容，例如要执行的命令 */
  code?: string;
  /** 确认按钮文字，默认“应用修改” */
  okText?: string;
  /** 操作类型名称；提供时额外显示“始终允许”按钮 */
  grantLabel?: string;
}

/** 用户在确认弹窗中的选择：拒绝 / 允许这一次 / 始终允许这类操作 */
export type PermissionDecision = "deny" | "once" | "always";

export type DiffLine = { type: "same" | "add" | "del"; text: string };

/** 基于 LCS 的行级 diff；超大文件退化为“整体删除 + 整体新增” */
export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split("\n");
  const B = b.split("\n");
  // 去掉公共前后缀，缩小计算量
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length - 1, endB = B.length - 1;
  while (endA >= start && endB >= start && A[endA] === B[endB]) { endA--; endB--; }
  const midA = A.slice(start, endA + 1);
  const midB = B.slice(start, endB + 1);
  const head: DiffLine[] = A.slice(0, start).map((t) => ({ type: "same", text: t }));
  const tail: DiffLine[] = A.slice(endA + 1).map((t) => ({ type: "same", text: t }));

  const n = midA.length, m = midB.length;
  let mid: DiffLine[] = [];
  if (n * m > 4_000_000) {
    mid = [...midA.map((t) => ({ type: "del" as const, text: t })), ...midB.map((t) => ({ type: "add" as const, text: t }))];
  } else {
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { mid.push({ type: "same", text: midA[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) mid.push({ type: "del", text: midA[i++] });
      else mid.push({ type: "add", text: midB[j++] });
    }
    while (i < n) mid.push({ type: "del", text: midA[i++] });
    while (j < m) mid.push({ type: "add", text: midB[j++] });
  }
  return [...head, ...mid, ...tail];
}

export function diffStats(d: DiffLine[]) {
  return { add: d.filter((l) => l.type === "add").length, del: d.filter((l) => l.type === "del").length };
}

/** 把 diff 渲染进容器，未改动的长段落折叠，只保留上下文 3 行 */
export function renderDiff(el: HTMLElement, d: DiffLine[], context = 3) {
  const box = el.createDiv({ cls: "aiac-diff" });
  const keep = new Array(d.length).fill(false);
  d.forEach((l, i) => {
    if (l.type !== "same") for (let k = Math.max(0, i - context); k <= Math.min(d.length - 1, i + context); k++) keep[k] = true;
  });
  let skipped = 0;
  const flush = () => {
    if (skipped) box.createDiv({ cls: "aiac-diff-skip", text: `… 省略 ${skipped} 行未改动内容 …` });
    skipped = 0;
  };
  d.forEach((l, i) => {
    if (!keep[i]) { skipped++; return; }
    flush();
    const row = box.createDiv({ cls: `aiac-diff-line aiac-diff-${l.type}` });
    row.createSpan({ cls: "aiac-diff-sign", text: l.type === "add" ? "+" : l.type === "del" ? "−" : " " });
    row.createSpan({ text: l.text || " " });
  });
  flush();
}

/** 修改确认弹窗 */
export class ConfirmChangeModal extends Modal {
  private resolved = false;
  constructor(
    app: App,
    private title: string,
    private description: string,
    private before: string | null,
    private after: string | null,
    private resolve: (decision: PermissionDecision) => void,
    private options: ConfirmOptions = {},
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("aiac-confirm-modal");
    contentEl.createEl("h3", { text: this.title });
    if (this.description) contentEl.createEl("p", { text: this.description, cls: "aiac-muted" });
    if (this.before !== null || this.after !== null) {
      const d = lineDiff(this.before ?? "", this.after ?? "");
      const st = diffStats(d);
      contentEl.createEl("p", { cls: "aiac-muted", text: `+${st.add} 行  −${st.del} 行` });
      renderDiff(contentEl, d);
    }
    if (this.options.code) contentEl.createEl("pre", { cls: "aiac-confirm-code", text: this.options.code });
    const btns = contentEl.createDiv({ cls: "aiac-modal-buttons" });
    btns.createEl("button", { text: "拒绝" }).onclick = () => this.finish("deny");
    if (this.options.grantLabel) {
      btns.createEl("button", { text: "始终允许此类操作", attr: { "aria-label": `之后「${this.options.grantLabel}」将直接执行，不再询问` } })
        .onclick = () => this.finish("always");
    }
    const ok = btns.createEl("button", { text: this.options.okText ?? "应用修改", cls: "mod-cta" });
    ok.onclick = () => this.finish("once");
    window.setTimeout(() => ok.focus(), 50);
  }

  private finish(v: PermissionDecision) {
    if (!this.resolved) { this.resolved = true; this.resolve(v); }
    this.close();
  }

  onClose() {
    if (!this.resolved) { this.resolved = true; this.resolve("deny"); }
    this.contentEl.empty();
  }
}

export function askPermission(app: App, title: string, description: string, before: string | null, after: string | null, options?: ConfirmOptions): Promise<PermissionDecision> {
  return new Promise((resolve) => new ConfirmChangeModal(app, title, description, before, after, resolve, options).open());
}
