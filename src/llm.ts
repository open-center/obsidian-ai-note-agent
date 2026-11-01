import { requestUrl } from "obsidian";

/**
 * 提供商协议：
 * - openai-responses：OpenAI 官方 Responses 接口（/v1/responses），支持推理模型 + 工具调用
 * - openai：Chat Completions 兼容接口（DeepSeek、Kimi、通义、智谱、OpenRouter、Ollama、Gemini 兼容端点…）
 * - anthropic：Claude 原生接口
 */
export type ProviderKind = "openai-responses" | "openai" | "anthropic";
export type ReasoningEffort = "" | "none" | "minimal" | "low" | "medium" | "high";

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /** 推理强度，仅对推理模型生效；空表示使用模型默认 */
  reasoningEffort?: ReasoningEffort;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON 字符串 */
  arguments: string;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      reasoning?: string;
      /** Responses 接口原始输出项（含加密推理内容），下一轮原样回传以保持推理连续 */
      rawOutput?: ResponsesOutputItem[];
    }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  reasoning?: string;
  rawOutput?: ResponsesOutputItem[];
  /** 服务端实际使用的模型名（来自响应） */
  model?: string;
  usage?: { input?: number; output?: number };
}

// ---------------- 各家接口的响应结构（只声明用到的字段） ----------------

type JsonObject = Record<string, unknown>;

interface ApiErrorBody {
  error?: { message?: string } | string;
  message?: string;
}

interface OpenAIChatResponse {
  model?: string;
  choices?: {
    message?: {
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string | JsonObject } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface ResponsesOutputItem {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  summary?: unknown[];
  encrypted_content?: string;
  content?: { type?: string; text?: string }[];
}

interface ResponsesResponse {
  model?: string;
  status?: string;
  output?: ResponsesOutputItem[];
  error?: unknown;
  incomplete_details?: { reason?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface AnthropicResponse {
  model?: string;
  content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface ModelListResponse {
  data?: { id?: string; name?: string }[];
  models?: { id?: string; name?: string }[];
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

function parseError(status: number, text: string): string {
  try {
    const j = JSON.parse(text) as ApiErrorBody;
    const err = j.error;
    const msg = (typeof err === "object" ? err?.message : undefined) ?? j.message ?? err ?? text;
    return `HTTP ${status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`;
  } catch {
    return `HTTP ${status}: ${text.slice(0, 500)}`;
  }
}

async function postJson<T>(url: string, headers: Record<string, string>, body: unknown): Promise<T> {
  // requestUrl 走 Obsidian 的原生网络层，可绕过浏览器 CORS 限制
  const res = await requestUrl({
    url,
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    throw: false,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(parseError(res.status, res.text));
  return res.json as T;
}

function argsToString(a: unknown): string {
  return typeof a === "string" ? a : JSON.stringify(a ?? {});
}

// ---------------- OpenAI 兼容 ----------------

function toOpenAIMessages(system: string, messages: ChatMessage[]): JsonObject[] {
  const out: JsonObject[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const msg: JsonObject = { role: "assistant", content: m.content || null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments || "{}" },
        }));
      }
      // DeepSeek 思考模式在工具调用轮次中要求回传 reasoning_content
      if (m.reasoning) msg.reasoning_content = m.reasoning;
      out.push(msg);
    } else {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

async function chatOpenAI(p: ProviderConfig, system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<LLMResponse> {
  const body: JsonObject = {
    model: p.model,
    messages: toOpenAIMessages(system, messages),
  };
  if (tools.length) {
    body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = "auto";
  }
  if (p.temperature >= 0) body.temperature = p.temperature;
  if (p.maxTokens > 0) body.max_tokens = p.maxTokens;
  if (p.reasoningEffort) body.reasoning_effort = p.reasoningEffort;

  const headers: Record<string, string> = {};
  if (p.apiKey) headers["Authorization"] = `Bearer ${p.apiKey}`;
  const json = await postJson<OpenAIChatResponse>(joinUrl(p.baseUrl, "/chat/completions"), headers, body);
  const msg = json?.choices?.[0]?.message;
  if (!msg) throw new Error("模型返回为空：" + JSON.stringify(json).slice(0, 300));
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c, i) => ({
    id: c.id || `call_${Date.now()}_${i}`,
    name: c.function?.name ?? "",
    arguments: argsToString(c.function?.arguments),
  }));
  return {
    content: typeof msg.content === "string" ? msg.content : "",
    toolCalls,
    reasoning: msg.reasoning_content || undefined,
    model: json.model,
    usage: { input: json.usage?.prompt_tokens, output: json.usage?.completion_tokens },
  };
}

// ---------------- OpenAI Responses ----------------

/** 回传历史输出项：去掉 message / function_call 的 id（store=false 时服务端不保存这些项），保留带加密内容的 reasoning 项 */
function sanitizeOutputItem(item: ResponsesOutputItem): JsonObject | null {
  if (item.type === "reasoning") {
    if (!item.encrypted_content) return null;
    return { type: "reasoning", id: item.id, summary: item.summary ?? [], encrypted_content: item.encrypted_content };
  }
  if (item.type === "function_call") return { type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments ?? "{}" };
  if (item.type === "message") {
    const text = (item.content ?? []).map((c) => c.text ?? "").join("");
    return text ? { role: "assistant", content: text } : null;
  }
  return null;
}

function toResponsesInput(messages: ChatMessage[]): JsonObject[] {
  const out: JsonObject[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      if (m.rawOutput?.length) {
        for (const it of m.rawOutput) {
          const x = sanitizeOutputItem(it);
          if (x) out.push(x);
        }
      } else {
        if (m.content) out.push({ role: "assistant", content: m.content });
        for (const c of m.toolCalls ?? []) out.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments || "{}" });
      }
    } else {
      out.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
    }
  }
  return out;
}

async function chatResponses(p: ProviderConfig, system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<LLMResponse> {
  const body: JsonObject = {
    model: p.model,
    instructions: system,
    input: toResponsesInput(messages),
    store: false,
    include: ["reasoning.encrypted_content"],
  };
  if (tools.length) body.tools = tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
  if (p.temperature >= 0) body.temperature = p.temperature;
  if (p.maxTokens > 0) body.max_output_tokens = p.maxTokens;
  if (p.reasoningEffort) body.reasoning = { effort: p.reasoningEffort };

  const headers: Record<string, string> = {};
  if (p.apiKey) headers["Authorization"] = `Bearer ${p.apiKey}`;
  const url = joinUrl(p.baseUrl, "/responses");
  let json: ResponsesResponse;
  try {
    json = await postJson<ResponsesResponse>(url, headers, body);
  } catch (e) {
    // 非推理模型可能不接受 include 参数：去掉后重试一次
    if (/include|encrypted/i.test((e as Error).message)) {
      delete body.include;
      json = await postJson<ResponsesResponse>(url, headers, body);
    } else throw e;
  }
  const output = json?.output ?? [];
  let content = "";
  const toolCalls: ToolCall[] = [];
  for (const it of output) {
    if (it.type === "message") {
      for (const c of it.content ?? []) if (c.type === "output_text" || c.type === "text") content += c.text ?? "";
    } else if (it.type === "function_call") {
      toolCalls.push({ id: it.call_id || it.id || `call_${Date.now()}`, name: it.name ?? "", arguments: argsToString(it.arguments) });
    }
  }
  if (!output.length && json?.error) throw new Error(JSON.stringify(json.error));
  if (json?.status === "incomplete" && !content && !toolCalls.length) {
    throw new Error(`模型输出不完整（${json.incomplete_details?.reason ?? "unknown"}），可以在设置里调大最大输出 token 或降低推理强度`);
  }
  return { content, toolCalls, rawOutput: output, model: json.model, usage: { input: json.usage?.input_tokens, output: json.usage?.output_tokens } };
}

// ---------------- Anthropic ----------------

interface AnthropicMessage {
  role: "user" | "assistant";
  content: JsonObject[];
}

function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const last = out[out.length - 1];
      // Anthropic 要求 user/assistant 交替，连续的 user 消息合并
      if (last && last.role === "user") last.content.push({ type: "text", text: m.content });
      else out.push({ role: "user", content: [{ type: "text", text: m.content }] });
    } else if (m.role === "assistant") {
      const blocks: JsonObject[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        let input: unknown = {};
        try { input = JSON.parse(c.arguments || "{}"); } catch { /* ignore */ }
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input });
      }
      if (!blocks.length) blocks.push({ type: "text", text: "(empty)" });
      out.push({ role: "assistant", content: blocks });
    } else {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      // 连续的工具结果需要合并到同一条 user 消息里
      if (last && last.role === "user" && last.content.every((b) => b.type === "tool_result")) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

async function chatAnthropic(p: ProviderConfig, system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<LLMResponse> {
  const body: JsonObject = {
    model: p.model,
    system,
    messages: toAnthropicMessages(messages),
    max_tokens: p.maxTokens > 0 ? p.maxTokens : 8192,
  };
  if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  if (p.temperature >= 0) body.temperature = p.temperature;

  const json = await postJson<AnthropicResponse>(
    joinUrl(p.baseUrl, "/v1/messages"),
    { "x-api-key": p.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body,
  );
  let content = "";
  const toolCalls: ToolCall[] = [];
  for (const b of json?.content ?? []) {
    if (b.type === "text") content += b.text ?? "";
    else if (b.type === "tool_use") toolCalls.push({ id: b.id ?? `call_${Date.now()}`, name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) });
  }
  return { content, toolCalls, model: json.model, usage: { input: json.usage?.input_tokens, output: json.usage?.output_tokens } };
}

export async function chat(p: ProviderConfig, system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<LLMResponse> {
  if (!p.model) throw new Error(`提供商「${p.name}」还没有填写模型名称`);
  if (p.kind === "anthropic") return chatAnthropic(p, system, messages, tools);
  if (p.kind === "openai-responses") return chatResponses(p, system, messages, tools);
  return chatOpenAI(p, system, messages, tools);
}

/** 拉取模型列表（用于设置页的“选择模型”按钮） */
export async function listModels(p: ProviderConfig): Promise<string[]> {
  const headers: Record<string, string> =
    p.kind === "anthropic"
      ? { "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" }
      : p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {};
  const url = joinUrl(p.baseUrl, p.kind === "anthropic" ? "/v1/models?limit=100" : "/models");
  const res = await requestUrl({ url, method: "GET", headers, throw: false });
  if (res.status < 200 || res.status >= 300) throw new Error(parseError(res.status, res.text));
  const json = res.json as ModelListResponse;
  const data = json?.data ?? json?.models ?? [];
  return data.map((m) => m.id ?? m.name ?? "").filter(Boolean).sort();
}
