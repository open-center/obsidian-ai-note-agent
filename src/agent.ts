import { chat, ChatMessage, ImagePart, LLMResponse, ProviderConfig, ToolCall } from "./llm";
import { toolSpecs, ToolResult, ToolSession, VaultTools } from "./tools";
import type { Attachment } from "./attachments";

export interface AgentCallbacks {
  onAssistant(text: string, meta: Pick<LLMResponse, "model" | "usage">): void;
  onToolStart(call: ToolCall): void;
  onToolEnd(call: ToolCall, result: ToolResult): void;
  onStatus(text: string): void;
}

export interface RunOptions {
  /** 随本条消息直接发给模型的图片 */
  images?: ImagePart[];
  /** 是否提供控制 Obsidian 的工具 */
  allowControl?: boolean;
}

/** 一个对话 = 一组消息 + 附件 + 工具循环 */
export class Agent {
  messages: ChatMessage[] = [];
  /** 本次对话中用户添加的附件（只保存在内存中） */
  attachments: Attachment[] = [];
  private nextAttachmentNo = 1;
  private aborted = false;
  running = false;

  constructor(private tools: VaultTools) {}

  reset() {
    this.messages = [];
    this.attachments = [];
    this.nextAttachmentNo = 1;
  }

  stop() {
    this.aborted = true;
  }

  newAttachmentId(): string {
    return `att${this.nextAttachmentNo++}`;
  }

  async run(provider: ProviderConfig, system: string, userText: string, maxSteps: number, cb: AgentCallbacks, opts: RunOptions = {}): Promise<void> {
    this.aborted = false;
    this.running = true;
    const startLen = this.messages.length;
    const session: ToolSession = { attachments: this.attachments };
    const specs = toolSpecs(opts.allowControl ?? false);
    this.messages.push(opts.images?.length ? { role: "user", content: userText, images: opts.images } : { role: "user", content: userText });
    try {
      for (let step = 0; step < maxSteps; step++) {
        if (this.aborted) { cb.onStatus("已停止"); return; }
        cb.onStatus(step === 0 ? "思考中…" : `第 ${step + 1} 步…`);
        const res = await chat(provider, system, this.messages, specs);
        if (this.aborted) { cb.onStatus("已停止"); this.closeDanglingToolCalls(); return; }

        this.messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls, reasoning: res.reasoning, rawOutput: res.rawOutput });
        if (res.content.trim()) cb.onAssistant(res.content, { model: res.model, usage: res.usage });
        if (!res.toolCalls.length) return;

        const images: ImagePart[] = [];
        for (const call of res.toolCalls) {
          if (this.aborted) {
            this.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: "用户中止了操作。" });
            continue;
          }
          cb.onToolStart(call);
          const result = await this.tools.run(call.name, call.arguments, session);
          this.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result.output });
          if (result.images?.length) images.push(...result.images);
          cb.onToolEnd(call, result);
        }
        // 工具消息本身只能是文字：把工具返回的图片作为紧随其后的一条用户消息发给模型
        if (images.length) {
          const names = images.map((i) => i.name).filter(Boolean).join("、");
          this.messages.push({ role: "user", content: `（以下是工具返回的图片${names ? `：${names}` : ""}）`, images });
        }
      }
      cb.onStatus(`已达到最大步骤数（${maxSteps}），可以发送“继续”让它接着做。`);
    } catch (e) {
      // 请求失败：补齐没有结果的 tool_call；若本轮没有任何进展则撤回这条用户消息
      this.closeDanglingToolCalls();
      if (this.messages.length === startLen + 1) this.messages.length = startLen;
      throw e;
    } finally {
      this.running = false;
    }
  }

  /** 保证每个 tool_call 都有对应的 tool 结果，否则 API 会拒绝后续请求 */
  private closeDanglingToolCalls() {
    const answered = new Set(this.messages.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])));
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === "assistant" && m.toolCalls?.length) {
        for (const c of m.toolCalls) if (!answered.has(c.id)) this.messages.push({ role: "tool", toolCallId: c.id, name: c.name, content: "已中止。" });
        break;
      }
    }
  }
}
