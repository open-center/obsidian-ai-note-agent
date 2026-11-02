import { loadPdfJs } from "obsidian";

/**
 * 附件解析：图片转 base64 直接发给模型；PDF、Word、PowerPoint、Excel 和文本文件在本地提取文字。
 * 不依赖第三方库：PDF 使用 Obsidian 内置的 pdf.js，Office 文件（zip + XML）用浏览器自带的 DecompressionStream 解压。
 */

export interface ImageData {
  /** 如 image/png */
  mediaType: string;
  /** base64，不含 data: 前缀 */
  data: string;
}

export interface Attachment {
  id: string;
  name: string;
  size: number;
  kind: "image" | "text";
  image?: ImageData;
  text?: string;
}

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const TEXT_EXTS = new Set([
  "md", "markdown", "txt", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "xml", "html", "htm", "css", "svg",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "java", "kt", "go", "rs", "c", "h", "cpp", "hpp", "cs", "rb", "php", "swift",
  "sh", "bash", "zsh", "ps1", "bat", "sql", "log", "tex", "bib", "org", "rst", "canvas", "env", "gitignore",
]);

/** 单个文件大小上限 */
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
/** 图片超过此大小或尺寸时先压缩（各家接口对单张图片都有 5MB 左右的限制） */
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const MAX_IMAGE_DIM = 2048;

export function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

/** 能否解析为文字（用于 read_note 读取仓库内的非 Markdown 文件） */
export function isDocumentExt(ext: string): boolean {
  return ext === "pdf" || ext === "docx" || ext === "pptx" || ext === "xlsx";
}

export function isImageExt(ext: string): boolean {
  return ext in IMAGE_TYPES;
}

export async function parseAttachment(name: string, bytes: ArrayBuffer): Promise<Attachment> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`${name} 超过 ${MAX_FILE_BYTES / 1024 / 1024}MB，无法添加`);
  const id = Math.random().toString(36).slice(2, 10);
  const ext = extOf(name);
  const base = { id, name, size: bytes.byteLength };
  if (isImageExt(ext)) return { ...base, kind: "image", image: await prepareImage(bytes, IMAGE_TYPES[ext]) };
  return { ...base, kind: "text", text: await extractText(name, bytes) };
}

/** 把文件内容提取为纯文本；不支持的格式抛出错误 */
export async function extractText(name: string, bytes: ArrayBuffer): Promise<string> {
  const ext = extOf(name);
  switch (ext) {
    case "pdf": return pdfText(bytes);
    case "docx": return docxText(bytes);
    case "pptx": return pptxText(bytes);
    case "xlsx": return xlsxText(bytes);
    case "doc": case "ppt": case "xls":
      throw new Error(`不支持旧版 Office 格式 .${ext}，请另存为 .${ext}x 后再添加`);
  }
  if (TEXT_EXTS.has(ext) || looksLikeText(bytes)) return new TextDecoder("utf-8").decode(bytes);
  throw new Error(`不支持的文件类型：${name}`);
}

function looksLikeText(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 8192));
  return !head.includes(0);
}

// ---------- 图片 ----------

function toBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

async function prepareImage(bytes: ArrayBuffer, mediaType: string): Promise<ImageData> {
  // GIF 可能是动图，压缩会丢帧，原样发送
  if (mediaType === "image/gif") return { mediaType, data: toBase64(bytes) };
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mediaType }));
  const { width, height } = bitmap;
  if (bytes.byteLength <= MAX_IMAGE_BYTES && Math.max(width, height) <= MAX_IMAGE_DIM) {
    bitmap.close();
    return { mediaType, data: toBase64(bytes) };
  }
  const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(width, height));
  const canvas = createEl("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法压缩图片");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { mediaType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}

// ---------- PDF ----------

interface PdfTextItem { str?: string; hasEOL?: boolean }
interface PdfPage { getTextContent(): Promise<{ items: PdfTextItem[] }> }
interface PdfDoc { numPages: number; getPage(n: number): Promise<PdfPage>; destroy(): Promise<void> }
interface PdfJs { getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDoc> } }

async function pdfText(bytes: ArrayBuffer): Promise<string> {
  const pdfjs = (await loadPdfJs()) as PdfJs;
  // pdf.js 会转移（detach）传入的缓冲区，先复制一份
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const { items } = await page.getTextContent();
      // 不少 PDF 把常用汉字编码成外形相同的康熙部首（如“⼀”U+2F00），还原为普通汉字
      const text = items.map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : "")).join("").replace(/[⺀-⿟]/g, (c) => c.normalize("NFKC")).trim();
      pages.push(`--- 第 ${i} 页 ---\n${text}`);
    }
    const all = pages.join("\n\n");
    if (!all.replace(/--- 第 \d+ 页 ---/g, "").trim()) return all + "\n\n（这份 PDF 没有可提取的文字，可能是扫描件；可以把页面截图作为图片添加）";
    return all;
  } finally {
    await doc.destroy();
  }
}

// ---------- ZIP（Office 文件） ----------

/** 读取 zip 中的所有文件（只支持 stored 和 deflate，Office 文件足够） */
async function unzip(bytes: ArrayBuffer, want: (name: string) => boolean): Promise<Map<string, string>> {
  const view = new DataView(bytes);
  // 从末尾找 End of Central Directory 记录
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("文件已损坏或不是 Office 文档");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder("utf-8");
  const out = new Map<string, string>();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(bytes, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = new Uint8Array(bytes, dataStart, compSize);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    else continue;
    out.set(name, decoder.decode(data));
  }
  return out;
}

function xml(text: string): Document {
  return new DOMParser().parseFromString(text, "application/xml");
}

/** 按文档顺序收集段落文字：段落之间换行，制表符和换行符保留 */
function paragraphs(doc: Document, ns: "w" | "a"): string[] {
  const out: string[] = [];
  for (const p of Array.from(doc.getElementsByTagName(`${ns}:p`))) {
    let line = "";
    const walk = (el: Element) => {
      for (const c of Array.from(el.children)) {
        if (c.tagName === `${ns}:t`) line += c.textContent ?? "";
        else if (c.tagName === `${ns}:tab`) line += "\t";
        else if (c.tagName === `${ns}:br`) line += "\n";
        else if (c.tagName !== `${ns}:p`) walk(c);
      }
    };
    walk(p);
    out.push(line);
  }
  return out;
}

async function docxText(bytes: ArrayBuffer): Promise<string> {
  const files = await unzip(bytes, (n) => n === "word/document.xml");
  const body = files.get("word/document.xml");
  if (!body) throw new Error("不是有效的 Word 文档");
  return paragraphs(xml(body), "w").join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const numOf = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);

async function pptxText(bytes: ArrayBuffer): Promise<string> {
  const files = await unzip(bytes, (n) => /^ppt\/(slides|notesSlides)\/\w+?\d+\.xml$/.test(n));
  const slides = [...files.keys()].filter((n) => n.startsWith("ppt/slides/")).sort((a, b) => numOf(a) - numOf(b));
  if (!slides.length) throw new Error("不是有效的 PowerPoint 文档");
  return slides
    .map((n) => {
      const i = numOf(n);
      let s = `--- 幻灯片 ${i} ---\n` + paragraphs(xml(files.get(n) ?? ""), "a").filter((l) => l.trim()).join("\n");
      const notes = files.get(`ppt/notesSlides/notesSlide${i}.xml`);
      if (notes) {
        // 备注页里会重复幻灯片编号等占位符，只保留有实际内容的行
        const lines = paragraphs(xml(notes), "a").filter((l) => l.trim() && !/^\d+$/.test(l.trim()));
        if (lines.length) s += `\n备注：${lines.join("\n")}`;
      }
      return s;
    })
    .join("\n\n");
}

/** 列号（A、B…AA）转为从 0 开始的下标 */
function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

async function xlsxText(bytes: ArrayBuffer): Promise<string> {
  const files = await unzip(bytes, (n) => n === "xl/sharedStrings.xml" || n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || /^xl\/worksheets\/[^/]+\.xml$/.test(n));
  const shared = Array.from(xml(files.get("xl/sharedStrings.xml") ?? "<sst/>").getElementsByTagName("si")).map((si) =>
    Array.from(si.getElementsByTagName("t")).map((t) => t.textContent ?? "").join(""),
  );
  // 工作表名称 → 文件路径（通过 workbook.xml.rels 关联）
  const rels = new Map<string, string>();
  for (const r of Array.from(xml(files.get("xl/_rels/workbook.xml.rels") ?? "<Relationships/>").getElementsByTagName("Relationship"))) {
    const target = (r.getAttribute("Target") ?? "").replace(/^\/?xl\//, "");
    rels.set(r.getAttribute("Id") ?? "", "xl/" + target);
  }
  const sheets = Array.from(xml(files.get("xl/workbook.xml") ?? "<workbook/>").getElementsByTagName("sheet")).map((s, i) => ({
    name: s.getAttribute("name") ?? `Sheet${i + 1}`,
    path: rels.get(s.getAttribute("r:id") ?? "") ?? `xl/worksheets/sheet${i + 1}.xml`,
  }));
  if (!sheets.length) throw new Error("不是有效的 Excel 文档");
  const out: string[] = [];
  for (const sheet of sheets) {
    const doc = xml(files.get(sheet.path) ?? "<worksheet/>");
    const rows: string[] = [];
    for (const row of Array.from(doc.getElementsByTagName("row"))) {
      const cells: string[] = [];
      for (const c of Array.from(row.getElementsByTagName("c"))) {
        const t = c.getAttribute("t");
        const v = c.getElementsByTagName("v")[0]?.textContent ?? "";
        let value: string;
        if (t === "s") value = shared[Number(v)] ?? "";
        else if (t === "inlineStr") value = Array.from(c.getElementsByTagName("t")).map((x) => x.textContent ?? "").join("");
        else if (t === "b") value = v === "1" ? "TRUE" : "FALSE";
        else value = v;
        const idx = colIndex(c.getAttribute("r") ?? "");
        while (cells.length < idx) cells.push("");
        cells[idx] = value.replace(/[\t\n]/g, " ");
      }
      if (cells.some((x) => x)) rows.push(cells.join("\t"));
    }
    out.push(`--- 工作表：${sheet.name} ---\n${rows.join("\n") || "（空）"}`);
  }
  return out.join("\n\n");
}
