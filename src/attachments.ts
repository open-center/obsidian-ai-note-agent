import { arrayBufferToBase64, loadPdfJs } from "obsidian";
import type { ImagePart } from "./llm";

/**
 * 附件与文件内容提取：
 * - 图片：缩放到适合模型的尺寸后直接发给模型
 * - PDF：用 Obsidian 内置的 pdf.js 提取文字，或把某一页渲染成图片（扫描件）
 * - Word / PowerPoint / Excel：解压后从 XML 中提取文字（不依赖第三方库）
 * - 文本类文件：按 UTF-8 解码
 *
 * 所有数据只在本地内存中处理；只有模型通过工具读取的内容才会随请求发给模型提供商。
 */

export type AttachmentKind = "image" | "pdf" | "office" | "text" | "other";

export interface Attachment {
  /** 对话内唯一的编号，例如 att1 */
  id: string;
  name: string;
  /** 通过“添加文件夹”选择时的相对路径 */
  relPath?: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  data: ArrayBuffer;
}

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** 模型能直接识别的图片格式 */
const MODEL_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** 图片长边上限（像素）与直接发送的大小上限 */
const MAX_IMAGE_EDGE = 1568;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

const IMAGE_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", avif: "image/avif", heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff",
};
const OFFICE_EXT = new Set(["docx", "pptx", "xlsx"]);
const TEXT_EXT = new Set([
  "md", "markdown", "txt", "text", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "html", "htm", "svg", "log", "ini", "toml", "conf",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "java", "kt", "go", "rs", "c", "h", "cpp", "hpp", "cs", "rb", "php", "swift", "sh", "bash", "zsh",
  "sql", "css", "scss", "less", "tex", "bib", "rst", "org", "srt", "vtt", "canvas", "base",
]);

export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

export function kindOf(name: string, mime = ""): AttachmentKind {
  const ext = extOf(name);
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (OFFICE_EXT.has(ext)) return "office";
  if (ext === "svg") return "text";
  if (IMAGE_EXT[ext] || mime.startsWith("image/")) return "image";
  if (TEXT_EXT.has(ext) || mime.startsWith("text/") || mime === "application/json") return "text";
  return "other";
}

export function mimeOf(name: string, fallback = ""): string {
  const ext = extOf(name);
  if (IMAGE_EXT[ext]) return IMAGE_EXT[ext];
  if (ext === "pdf") return "application/pdf";
  return fallback || "application/octet-stream";
}

export const KIND_LABELS: Record<AttachmentKind, string> = {
  image: "图片",
  pdf: "PDF",
  office: "Office 文档",
  text: "文本",
  other: "其他文件",
};

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------- 图片 ----------------

/** 把图片转换成模型可接受的格式和尺寸 */
export async function toImagePart(data: ArrayBuffer, mime: string, name?: string): Promise<ImagePart> {
  if (MODEL_IMAGE_MIMES.has(mime) && data.byteLength <= MAX_IMAGE_BYTES) {
    const size = await imageSize(data, mime).catch(() => null);
    if (size && Math.max(size.width, size.height) <= MAX_IMAGE_EDGE) return { mime, data: arrayBufferToBase64(data), name };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([data], { type: mime }));
  } catch {
    throw new Error(`无法解码图片 ${name ?? ""}（格式 ${mime}）。请转换为 PNG 或 JPEG 后再试。`);
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = createEl("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  // JPEG 没有透明通道，先铺白底
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvasToPart(canvas, name);
}

function canvasToPart(canvas: HTMLCanvasElement, name?: string): ImagePart {
  const url = canvas.toDataURL("image/jpeg", 0.85);
  return { mime: "image/jpeg", data: url.slice(url.indexOf(",") + 1), name };
}

async function imageSize(data: ArrayBuffer, mime: string): Promise<{ width: number; height: number }> {
  const bmp = await createImageBitmap(new Blob([data], { type: mime }));
  const size = { width: bmp.width, height: bmp.height };
  bmp.close();
  return size;
}

// ---------------- PDF ----------------

interface PdfTextItem { str?: string; hasEOL?: boolean }
interface PdfViewport { width: number; height: number }
interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  getViewport(o: { scale: number }): PdfViewport;
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): { promise: Promise<void> };
  cleanup(): void;
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy?(): Promise<void>;
}
interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy?(): Promise<void>;
}
interface PdfJs {
  getDocument(src: { data: Uint8Array }): PdfLoadingTask;
}

/** 打开 PDF；用完后必须调用 close() 释放 pdf.js 的资源 */
async function openPdf(data: ArrayBuffer): Promise<{ doc: PdfDocument; close: () => Promise<void> }> {
  const pdfjs = (await loadPdfJs()) as PdfJs;
  // pdf.js 会转移（detach）传入的缓冲区，所以传一份拷贝
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
  const doc = await task.promise;
  return {
    doc,
    close: async () => {
      // 不同版本的 pdf.js 把 destroy 放在不同对象上
      if (task.destroy) await task.destroy();
      else if (doc.destroy) await doc.destroy();
    },
  };
}

export async function pdfPageCount(data: ArrayBuffer): Promise<number> {
  const { doc, close } = await openPdf(data);
  try { return doc.numPages; } finally { await close(); }
}

export interface ExtractedText {
  text: string;
  /** PDF 总页数 */
  pages?: number;
  /** 本次提取的页码范围 */
  range?: [number, number];
}

export async function pdfText(data: ArrayBuffer, startPage?: number, endPage?: number): Promise<ExtractedText> {
  const { doc, close } = await openPdf(data);
  try {
    const n = doc.numPages;
    const start = Math.min(Math.max(1, Math.floor(startPage ?? 1)), n);
    const end = Math.min(Math.max(start, Math.floor(endPage ?? n)), n);
    const parts: string[] = [];
    for (let i = start; i <= end; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = "";
      for (const it of content.items) {
        text += it.str ?? "";
        if (it.hasEOL) text += "\n";
      }
      page.cleanup();
      parts.push(`--- 第 ${i} 页 ---\n${text.replace(/[ \t]+\n/g, "\n").trim()}`);
    }
    return { text: parts.join("\n\n"), pages: n, range: [start, end] };
  } finally {
    await close();
  }
}

/** 把 PDF 的某一页渲染成图片（用于扫描件、图表等） */
export async function pdfPageImage(data: ArrayBuffer, pageNo: number, name?: string): Promise<{ image: ImagePart; pages: number }> {
  const { doc, close } = await openPdf(data);
  try {
    const n = doc.numPages;
    if (pageNo < 1 || pageNo > n) throw new Error(`页码超出范围：共 ${n} 页`);
    const page = await doc.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(3, MAX_IMAGE_EDGE / Math.max(base.width, base.height)) });
    const canvas = createEl("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup();
    return { image: canvasToPart(canvas, `${name ?? "PDF"} 第 ${pageNo} 页`), pages: n };
  } finally {
    await close();
  }
}

// ---------------- Office（docx / pptx / xlsx） ----------------

/** 极简 ZIP 读取：只解析中央目录，支持 store 与 deflate 两种压缩方式 */
async function unzip(data: ArrayBuffer, want: (name: string) => boolean): Promise<Map<string, string>> {
  const view = new DataView(data);
  const bytes = new Uint8Array(data);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 Office 文件（无法解压）");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder("utf-8");
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = data.slice(start, start + compSize);
    let content: Uint8Array;
    if (method === 0) content = new Uint8Array(raw);
    else if (method === 8) content = await inflateRaw(raw);
    else continue;
    out.set(name, decoder.decode(content));
  }
  return out;
}

async function inflateRaw(raw: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

const stripTags = (xml: string) => decodeXml(xml.replace(/<[^>]+>/g, ""));
const byNumber = (a: string, b: string) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);

function docxText(xml: string): string {
  return stripTags(
    xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n"),
  ).replace(/\n{3,}/g, "\n\n").trim();
}

function pptxText(slides: [string, string][]): string {
  return slides
    .map(([name, xml], i) => {
      const paras = xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).join("")).filter((t) => t.trim());
      return `--- 第 ${i + 1} 页（${name.split("/").pop() ?? ""}）---\n${paras.join("\n")}`;
    })
    .join("\n\n");
}

function xlsxText(files: Map<string, string>): string {
  const shared: string[] = [];
  const sst = files.get("xl/sharedStrings.xml");
  if (sst) for (const si of sst.split("</si>")) if (si.includes("<si")) shared.push(stripTags(si.slice(si.indexOf("<si"))));
  const names: string[] = [];
  const wb = files.get("xl/workbook.xml");
  if (wb) for (const m of wb.matchAll(/<sheet [^>]*name="([^"]*)"/g)) names.push(decodeXml(m[1]));
  const sheets = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort(byNumber);
  return sheets
    .map((key, i) => {
      const xml = files.get(key) ?? "";
      const rows: string[] = [];
      for (const row of xml.split("</row>")) {
        const cells: string[] = [];
        for (const c of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1];
          const body = c[2] ?? "";
          const col = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          let val = "";
          if (/t="s"/.test(attrs) && v !== undefined) val = shared[Number(v)] ?? "";
          else if (/t="inlineStr"/.test(attrs)) val = stripTags(body);
          else if (v !== undefined) val = decodeXml(v);
          if (col) {
            const idx = col.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
            while (cells.length < idx) cells.push("");
          }
          cells.push(val.includes(",") || val.includes("\n") ? `"${val.replace(/"/g, '""')}"` : val);
        }
        if (cells.some((x) => x !== "")) rows.push(cells.join(","));
      }
      return `--- 工作表：${names[i] ?? key} ---\n${rows.join("\n")}`;
    })
    .join("\n\n");
}

export async function officeText(data: ArrayBuffer, name: string): Promise<string> {
  const ext = extOf(name);
  if (ext === "docx") {
    const files = await unzip(data, (n) => n === "word/document.xml");
    return docxText(files.get("word/document.xml") ?? "");
  }
  if (ext === "pptx") {
    const files = await unzip(data, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    return pptxText([...files.entries()].sort((a, b) => byNumber(a[0], b[0])));
  }
  if (ext === "xlsx") {
    const files = await unzip(data, (n) => n === "xl/sharedStrings.xml" || n === "xl/workbook.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    return xlsxText(files);
  }
  throw new Error(`不支持的 Office 格式：.${ext}（支持 .docx / .pptx / .xlsx；旧版 .doc/.ppt/.xls 请先另存为新格式）`);
}

// ---------------- 统一入口 ----------------

/** 提取任意文件的文字内容 */
export async function extractText(data: ArrayBuffer, name: string, mime = "", startPage?: number, endPage?: number): Promise<ExtractedText> {
  const kind = kindOf(name, mime);
  if (kind === "pdf") return pdfText(data, startPage, endPage);
  if (kind === "office") return { text: await officeText(data, name) };
  if (kind === "text") {
    let text = new TextDecoder("utf-8").decode(data);
    const ext = extOf(name);
    if (ext === "html" || ext === "htm") {
      text = stripTags(text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<\/(p|div|h\d|li|tr|br)>/gi, "\n")).replace(/\n{3,}/g, "\n\n");
    }
    return { text };
  }
  if (kind === "image") throw new Error("这是图片，请用 view_image 查看。");
  throw new Error(`无法读取这种文件的文字内容（${name}）。`);
}

/** 从浏览器 File 对象创建附件 */
export async function attachmentFromFile(file: File, id: string, relPath?: string): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} 超过 ${formatSize(MAX_ATTACHMENT_BYTES)}，已跳过`);
  const data = await file.arrayBuffer();
  const mime = mimeOf(file.name, file.type);
  return { id, name: file.name, relPath, mime, size: file.size, kind: kindOf(file.name, mime), data };
}
