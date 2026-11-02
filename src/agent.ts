import { chat, ChatMessage, LLMResponse, ProviderConfig, ToolCall, ToolSpec } from "./llm";
import type { ImageData } from "./attachments";
import { ToolResult, VaultTools } from "./tools";
import { compactConversation, CompactResult } from "./compact";

/** 子 Agent 进度事件，用于在父任务的工具卡片里实时显示 */
export type SubAgentEvent =
  | { type: "start"; title: string }
  | { type: "status"; text: string }
  | { type: "tool-start"; call: ToolCall }
  | { type: "tool-end"; call: ToolCall; result: ToolResult }
  | { type: "end"; ok: boolean; text: string };

/** 运行中用户追加的消息，在下一步开始前送达模型 */
export interface QueuedMessage {
  id: string;
  content: string;
  images?: ImageData[];
}

export interface AgentCallbacks {
  onAssistant(text: string, meta: Pick<LLMResponse, "model" | "usage">): void;
  onToolStart(call: ToolCall): void;
  onToolEnd(call: ToolCall, result: ToolResult): void;
  onStatus(text: string): void;
  /** delegate_tasks 派出的第 index 个子 Agent 的进度 */
  onSubAgent?(parent: ToolCall, index: number, event: SubAgentEvent): void;
  /** 排队的消息已送达模型 */
  onQueueDelivered?(ids: string[]): void;
  /** 对话历史被压缩 */
  onCompacted?(result: CompactResult): void;
}

export const DELEGATE_TOOL = "delegate_tasks";
/** 一次最多派出的子 Agent 数 */
export const MAX_SUB_AGENTS = 6;

const DELEGATE_SPEC: ToolSpec = {
  name: DELEGATE_TOOL,
  description:
    `把一个大任务拆成多个互相独立的子任务，同时派给多个子 Agent 并行执行，全部完成后返回每个子任务的结果。` +
    `适合：批量处理多篇笔记、分别调研多个主题、同时整理多个文件夹等。子 Agent 拥有和你相同的工具，但看不到当前对话，` +
    `所以 instructions 必须写清楚完整背景、涉及的笔记路径和期望的产出。不同子任务不要修改同一篇笔记。一次最多 ${MAX_SUB_AGENTS} 个。` +
    `简单任务直接自己做，不要委派。`,
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        maxItems: MAX_SUB_AGENTS,
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "子任务的简短标题（10 字以内）" },
            instructions: { type: "string", description: "交给子 Agent 的完整指令" },
          },
          required: ["title", "instructions"],
        },
      },
    },
    required: ["tasks"],
  },
};

const SUB_AGENT_PROMPT = `\n\n你现在是一个子 Agent，由主 Agent 派来完成下面的单个子任务。只做这个子任务，不要做额外的事。完成后用简洁的中文报告结果（做了什么、改了哪些笔记、发现了什么），这份报告会交回给主 Agent。`;

/** 一个对话 = 一组消息 + 工具循环 */
export class Agent {
  messages: ChatMessage[] = [];
  private aborted = false;
  running = false;
  /** 正在运行的子 Agent，停止时一并停止 */
  private children = new Set<Agent>();
  /** 运行中用户追加、还没送达模型的消息 */
  private queue: QueuedMessage[] = [];

  constructor(
    private tools: VaultTools,
    /** 是否允许派出子 Agent（子 Agent 自身不能再委派） */
    private canDelegate: () => boolean = () => false,
    /** 对话超过多少 token 时自动压缩，0 表示不压缩 */
    private getContextBudget: () => number = () => 0,
  ) {}

  reset() {
    this.messages = [];
  }

  stop() {
    this.aborted = true;
    for (const c of this.children) c.stop();
  }

  /** 运行中追加一条消息：当前这一步结束后送达模型，不打断正在执行的工具 */
  enqueue(msg: QueuedMessage) {
    this.queue.push(msg);
  }

  /** 撤回一条还没送达的消息，成功返回 true */
  cancelQueued(id: string): boolean {
    const n = this.queue.length;
    this.queue = this.queue.filter((m) => m.id !== id);
    return this.queue.length < n;
  }

  /** 取出全部未送达的消息（例如停止任务时退回输入框） */
  takeQueue(): QueuedMessage[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  get queued(): readonly QueuedMessage[] {
    return this.queue;
  }

  /** 把排队的消息作为用户消息加入对话，返回是否有新消息 */
  private deliverQueue(cb: AgentCallbacks): boolean {
    if (!this.queue.length) return false;
    const q = this.takeQueue();
    for (const m of q) {
      this.messages.push({
        role: "user",
        content: `（用户在你执行任务的过程中补充了以下内容，请结合它继续：）\n${m.content}`,
        ...(m.images?.length ? { images: m.images } : {}),
      });
    }
    cb.onQueueDelivered?.(q.map((m) => m.id));
    return true;
  }

  async run(provider: ProviderConfig, system: string, userText: string, maxSteps: number, cb: AgentCallbacks, images: ImageData[] = []): Promise<void> {
    this.aborted = false;
    this.running = true;
    const userMsg: ChatMessage = { role: "user", content: userText, ...(images.length ? { images } : {}) };
    this.messages.push(userMsg);
    try {
      for (let step = 0; step < maxSteps; step++) {
        if (this.aborted) { cb.onStatus("已停止"); return; }
        this.deliverQueue(cb);
        cb.onStatus(step === 0 ? "思考中…" : `第 ${step + 1} 步：思考中…`);
        const specs = this.canDelegate() ? [...this.tools.specs(), DELEGATE_SPEC] : this.tools.specs();
        const retry = {
          isAborted: () => this.aborted,
          onRetry: (n: number, ms: number, reason: string) => cb.onStatus(`${reason}，${Math.ceil(ms / 1000)} 秒后自动重试（第 ${n} 次）…`),
        };
        let res;
        try {
          const compacted = await compactConversation(provider, system, specs, this.messages, this.getContextBudget(), retry,
            () => cb.onStatus("对话较长，正在压缩较早的历史…"));
          if (compacted) cb.onCompacted?.(compacted);
          if (this.aborted) { cb.onStatus("已停止"); this.closeDanglingToolCalls(); return; }
          res = await chat(provider, system, this.messages, specs, retry);
        } catch (e) {
          // 等待重试时用户点了停止：按停止处理，不算出错
          if (this.aborted) { cb.onStatus("已停止"); this.closeDanglingToolCalls(); return; }
          throw e;
        }
        if (this.aborted) { cb.onStatus("已停止"); this.closeDanglingToolCalls(); return; }

        this.messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls, reasoning: res.reasoning, rawOutput: res.rawOutput });
        if (res.content.trim()) cb.onAssistant(res.content, { model: res.model, usage: res.usage });
        // 模型已经答完，但用户在这期间又补充了消息：接着处理，不结束任务
        if (!res.toolCalls.length) {
          if (this.queue.length && !this.aborted) continue;
          return;
        }

        for (const call of res.toolCalls) {
          if (this.aborted) {
            this.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: "用户中止了操作。" });
            continue;
          }
          cb.onToolStart(call);
          cb.onStatus(`第 ${step + 1} 步：执行工具…`);
          const result = call.name === DELEGATE_TOOL && this.canDelegate()
            ? await this.delegate(call, provider, system, maxSteps, cb)
            : await this.tools.run(call.name, call.arguments);
          this.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result.output });
          cb.onToolEnd(call, result);
        }
      }
      cb.onStatus(`已达到最大步骤数（${maxSteps}），可以发送“继续”让它接着做。`);
    } catch (e) {
      // 请求失败：补齐没有结果的 tool_call；若本轮没有任何进展则撤回这条用户消息
      this.closeDanglingToolCalls();
      if (this.messages[this.messages.length - 1] === userMsg) this.messages.pop();
      throw e;
    } finally {
      this.running = false;
    }
  }

  /** 并行运行多个子 Agent，汇总各自的最终回复 */
  private async delegate(call: ToolCall, provider: ProviderConfig, system: string, maxSteps: number, cb: AgentCallbacks): Promise<ToolResult> {
    let tasks: { title?: unknown; instructions?: unknown }[];
    try {
      const args = JSON.parse(call.arguments || "{}") as { tasks?: unknown };
      tasks = Array.isArray(args.tasks) ? (args.tasks as typeof tasks) : [];
    } catch {
      return { output: "参数不是合法的 JSON。", isError: true };
    }
    tasks = tasks.filter((t) => t && typeof t.instructions === "string" && t.instructions.trim());
    if (!tasks.length) return { output: "tasks 不能为空。", isError: true };
    if (tasks.length > MAX_SUB_AGENTS) return { output: `一次最多派出 ${MAX_SUB_AGENTS} 个子 Agent。`, isError: true };

    const results = await Promise.all(tasks.map(async (t, i) => {
      const title = typeof t.title === "string" && t.title.trim() ? t.title.trim() : `子任务 ${i + 1}`;
      const emit = (e: SubAgentEvent) => cb.onSubAgent?.(call, i, e);
      const child = new Agent(this.tools, () => false, this.getContextBudget);
      this.children.add(child);
      emit({ type: "start", title });
      let last = "";
      try {
        await child.run(provider, system + SUB_AGENT_PROMPT, String(t.instructions), maxSteps, {
          onAssistant: (text) => { last = text; },
          onToolStart: (c) => emit({ type: "tool-start", call: c }),
          onToolEnd: (c, r) => emit({ type: "tool-end", call: c, result: r }),
          onStatus: (s) => emit({ type: "status", text: s }),
        });
        const ok = !this.aborted;
        emit({ type: "end", ok, text: ok ? last : "已停止" });
        return `## ${title}\n${ok ? last || "（子 Agent 没有给出文字报告）" : "已被用户停止。"}`;
      } catch (e) {
        const msg = (e as Error).message;
        emit({ type: "end", ok: false, text: msg });
        return `## ${title}\n失败：${msg}`;
      } finally {
        this.children.delete(child);
      }
    }));
    return { output: results.join("\n\n") };
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
