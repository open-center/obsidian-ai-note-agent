import { chat, ChatMessage, ProviderConfig, RetryOptions, ToolSpec } from "./llm";

/**
 * 对话历史压缩：对话越长，每次请求发给模型的 token 越多，既慢又容易触发限流。
 * 超过阈值的一半时先“精简”——截短较早的工具结果和附件、去掉较早的图片和推理数据；
 * 仍超过阈值时再“摘要”——让模型把较早的对话总结成一段摘要，只保留最近的消息原文。
 */

/** 最近几条工具结果保留原文 */
const KEEP_RECENT_TOOL_RESULTS = 6;
/** 较早的工具结果 / 附件超过这个长度就截短 */
const TRIM_OVER_CHARS = 2000;
const TRIM_KEEP_CHARS = 800;
/** 摘要后保留的最近消息约占阈值的比例 */
const TAIL_RATIO = 0.3;
/** 较早部分至少占阈值的这个比例才值得做摘要 */
const MIN_SUMMARY_RATIO = 0.2;
/** 交给摘要模型的历史最多这么多字符（保留最新的部分） */
const MAX_TRANSCRIPT_CHARS = 120_000;
const IMAGE_TOKENS = 1500;

export interface CompactResult {
  mode: "trim" | "summary";
  before: number;
  after: number;
}

/** 粗略估算 token：中日韩字符约 1 字 1 token，其他约 4 个字符 1 token */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if ((ch.codePointAt(0) ?? 0) >= 0x2e80) cjk++;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

function messageTokens(m: ChatMessage): number {
  if (m.role === "user") return estimateTokens(m.content) + (m.images?.length ?? 0) * IMAGE_TOKENS;
  if (m.role === "tool") return estimateTokens(m.content) + 10;
  let n = estimateTokens(m.content) + estimateTokens(m.reasoning ?? "");
  for (const c of m.toolCalls ?? []) n += estimateTokens(c.name + c.arguments);
  // 加密推理内容不可读，按长度粗算
  if (m.rawOutput?.length) n += Math.ceil(JSON.stringify(m.rawOutput).length / 4);
  return n;
}

export function conversationTokens(system: string, tools: ToolSpec[], messages: ChatMessage[]): number {
  return estimateTokens(system) + estimateTokens(JSON.stringify(tools)) + messages.reduce((n, m) => n + messageTokens(m), 0);
}

function clip(text: string, note: string): string {
  return `${text.slice(0, TRIM_KEEP_CHARS)}\n…[${note}，已省略 ${text.length - TRIM_KEEP_CHARS} 字。需要原文时请重新读取]`;
}

/** 精简：只改较早的消息，最新的用户请求和最近几条工具结果保持原样。返回是否有改动 */
function trim(messages: ChatMessage[]): boolean {
  let changed = false;
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  let toolSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool") {
      toolSeen++;
      if (toolSeen > KEEP_RECENT_TOOL_RESULTS && m.content.length > TRIM_OVER_CHARS) {
        messages[i] = { ...m, content: clip(m.content, "较早的工具结果") };
        changed = true;
      }
    } else if (m.role === "user" && i < lastUser) {
      let content = m.content.replace(/(<attachment name="[^"]*">\n)([\s\S]*?)(\n<\/attachment>)/g, (all, open: string, body: string, close: string) => {
        if (body.length <= TRIM_OVER_CHARS) return all;
        changed = true;
        return open + clip(body, "较早的附件内容") + close;
      });
      if (m.images?.length) {
        content += `\n[较早消息中的 ${m.images.length} 张图片已省略]`;
        changed = true;
      }
      if (content !== m.content || m.images?.length) messages[i] = { role: "user", content };
    } else if (m.role === "assistant" && i < lastUser && (m.rawOutput?.length || m.reasoning)) {
      // 较早轮次的推理过程不再需要
      messages[i] = { role: "assistant", content: m.content, toolCalls: m.toolCalls };
      changed = true;
    }
  }
  return changed;
}

/** 选一个切分点：之后的消息约占 tailBudget，且不能从工具结果开始（否则工具结果找不到对应的调用） */
function cutIndex(messages: ChatMessage[], tailBudget: number): number {
  let n = 0;
  let i = messages.length;
  while (i > 0 && n + messageTokens(messages[i - 1]) <= tailBudget) n += messageTokens(messages[--i]);
  // 至少保留最后一条消息，以及最近一次工具调用和它的结果（模型正要用到）
  if (i === messages.length) i = messages.length - 1;
  for (let k = messages.length - 1; k >= 0; k--) {
    const m = messages[k];
    if (m.role === "assistant" && m.toolCalls?.length) { i = Math.min(i, k); break; }
  }
  while (i < messages.length && messages[i].role === "tool") i++;
  return i;
}

function transcript(messages: ChatMessage[]): string {
  const lines = messages.map((m) => {
    const c = (t: string) => (t.length > 3000 ? t.slice(0, 3000) + "…" : t);
    if (m.role === "user") return `【用户】${c(m.content)}`;
    if (m.role === "tool") return `【工具结果 ${m.name}】${c(m.content)}`;
    const calls = (m.toolCalls ?? []).map((t) => `调用 ${t.name}(${c(t.arguments)})`).join("；");
    return `【助手】${c(m.content)}${calls ? `\n${calls}` : ""}`;
  });
  const all = lines.join("\n\n");
  return all.length > MAX_TRANSCRIPT_CHARS ? "…（更早的内容已省略）\n" + all.slice(-MAX_TRANSCRIPT_CHARS) : all;
}

const SUMMARY_SYSTEM = `你负责压缩一段 AI 笔记助手与用户的对话历史，供助手继续工作时参考。请用中文写一份简洁但完整的摘要，包括：
1. 用户的目标和所有要求、偏好（用户最新的请求请尽量保留原话）；
2. 已经完成的操作：读取、创建、修改、移动、删除了哪些笔记（写出路径）以及改了什么；
3. 已经得到的关键信息和结论；
4. 还没完成的事项和下一步。
不要编造对话里没有的内容；不要寒暄，直接输出摘要。`;

/**
 * 按需压缩对话历史（直接修改 messages）。没有超过阈值时返回 null。
 * budget 为 0 表示关闭压缩。
 */
export async function compactConversation(
  provider: ProviderConfig,
  system: string,
  tools: ToolSpec[],
  messages: ChatMessage[],
  budget: number,
  retry: RetryOptions,
  onStart: () => void,
): Promise<CompactResult | null> {
  if (budget <= 0) return null;
  const before = conversationTokens(system, tools, messages);
  if (before <= budget / 2) return null;

  trim(messages);
  let after = conversationTokens(system, tools, messages);
  if (after <= budget) return after < before ? { mode: "trim", before, after } : null;

  const cut = cutIndex(messages, budget * TAIL_RATIO);
  // 可压缩的较早部分太少时不做摘要，避免每一步都重复摘要
  const olderTokens = messages.slice(0, cut).reduce((n, m) => n + messageTokens(m), 0);
  if (cut <= 0 || olderTokens < budget * MIN_SUMMARY_RATIO) return after < before ? { mode: "trim", before, after } : null;
  onStart();
  const older = messages.slice(0, cut);
  let summary: string;
  try {
    const res = await chat(provider, SUMMARY_SYSTEM, [{ role: "user", content: `以下是需要压缩的对话历史：\n\n${transcript(older)}` }], [], retry);
    summary = res.content.trim();
  } catch {
    summary = "";
  }
  // 摘要失败时退而只保留最近的消息，保证请求还能发出去
  const head: ChatMessage[] = [{
    role: "user",
    content: summary
      ? `（以下是之前对话的压缩摘要，原始内容已省略）\n${summary}`
      : "（之前的对话过长，已省略较早的内容。如需之前读过的笔记，请重新读取。）",
  }];
  const tail = messages.slice(cut);
  if (tail[0]?.role === "user") head.push({ role: "assistant", content: "好的，我已了解之前的进展。" });
  messages.splice(0, messages.length, ...head, ...tail);
  after = conversationTokens(system, tools, messages);
  return { mode: "summary", before, after };
}
