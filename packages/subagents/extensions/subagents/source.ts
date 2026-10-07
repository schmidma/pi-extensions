import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  AgentSession, ExtensionAPI, ExtensionContext, MessageStartEvent, MessageUpdateEvent, MessageEndEvent,
  ToolExecutionStartEvent, ToolExecutionUpdateEvent, ToolExecutionEndEvent, ToolRenderers, MessageRenderer,
} from "@earendil-works/pi-coding-agent";

export interface TranscriptMessage {
  id: string;
  message: AgentMessage;
  streaming?: boolean;
}
export interface TranscriptTool {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  argsComplete?: boolean;
  started?: boolean;
  result?: Pick<ToolResultMessage, "content" | "details" | "isError">;
  partial?: boolean;
}
export interface TranscriptSnapshot {
  messages: TranscriptMessage[];
  tools: TranscriptTool[];
}
export type TranscriptUpdate =
  | { type: "message"; value: TranscriptMessage }
  | { type: "tool"; value: TranscriptTool }
  | { type: "reset"; value: TranscriptSnapshot };

/** Snapshot and subscribe must be synchronous: no await between them at the consumer. */
export interface TranscriptSource {
  snapshot(): TranscriptSnapshot;
  subscribe(listener: (update: TranscriptUpdate) => void): () => void;
  /** Resolve the owning child session's renderers when it is live. */
  resolveToolRenderers?(name: string): ToolRenderers | undefined;
  resolveMessageRenderer?(type: string): MessageRenderer | undefined;
}

type NativeEvent = MessageStartEvent | MessageUpdateEvent | MessageEndEvent |
  ToolExecutionStartEvent | ToolExecutionUpdateEvent | ToolExecutionEndEvent;
const clone = <T>(value: T): T => structuredClone(value);

/** Retains in-flight values and the brief message_end-to-persistence gap only. */
export class CurrentSessionSource implements TranscriptSource {
  private listeners = new Set<(update: TranscriptUpdate) => void>();
  private pending = new Map<string, TranscriptMessage>();
  private tools = new Map<string, TranscriptTool>();
  private pendingLeaf = new Map<string, string | null>();
  private reconciledEntries = new Set<string>();
  private activeAssistant?: string;
  private serial = 0;
  private unsubscribe: (() => void)[] = [];
  private disposed = false;

  constructor(private context: () => Pick<ExtensionContext, "sessionManager">) {}

  private prunePersisted(): void {
    if (![...this.pending.values()].some(value => !value.streaming)) return;
    const branch = this.context().sessionManager.getBranch();
    for (const [id, value] of this.pending) {
      if (value.streaming) continue;
      const leaf = this.pendingLeaf.get(id);
      const start = leaf ? branch.findIndex(entry => entry.id === leaf) + 1 : 0;
      // Pi persists finalized events in order, but transformers can replace the
      // observer's object (and all of its content). Match a new persistence slot,
      // not object/content equality, and consume each slot only once.
      const saved = branch.slice(start).find(entry => !this.reconciledEntries.has(entry.id) &&
        (value.message.role === "custom" ? entry.type === "custom_message" :
          entry.type === "message" && entry.message.role === value.message.role));
      if (!saved) continue;
      this.reconciledEntries.add(saved.id);
      this.pending.delete(id);
      this.pendingLeaf.delete(id);
      if (value.message.role === "toolResult") this.tools.delete(value.message.toolCallId);
    }
    if (![...this.pending.values()].some(value => !value.streaming)) this.reconciledEntries.clear();
  }

  snapshot(): TranscriptSnapshot {
    this.prunePersisted();
    const messages = this.context().sessionManager.buildSessionProjection().entries.flatMap(entry =>
      entry.messages.map((message, i) => ({ id: `${entry.sourceEntry.id}:${i}`, message: clone(message) })),
    );
    return { messages: [...messages, ...clone([...this.pending.values()])], tools: clone([...this.tools.values()]) };
  }

  subscribe(listener: (update: TranscriptUpdate) => void): () => void {
    if (this.disposed) throw new Error("Transcript source is disposed");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(update: TranscriptUpdate): void {
    for (const listener of this.listeners) listener(clone(update));
  }

  accept(event: NativeEvent): void {
    if (this.disposed) return;
    this.prunePersisted();
    if (event.type.startsWith("message_")) {
      const e = event as MessageStartEvent | MessageUpdateEvent | MessageEndEvent;
      // A single native assistant message streams at a time; tool results may interleave.
      let id: string;
      if (e.message.role === "assistant") {
        // turn_end drafts commit after its handlers. Refresh the canonical
        // projection now, before inserting the next streaming message.
        if (e.type === "message_start") this.emit({ type: "reset", value: this.snapshot() });
        if (e.type === "message_start" || !this.activeAssistant) this.activeAssistant = `live:${++this.serial}`;
        id = this.activeAssistant;
      } else {
        id = `live:${++this.serial}`;
      }
      const value = { id, message: clone(e.message), streaming: e.type !== "message_end" && e.message.role === "assistant" };
      if (value.streaming) this.pending.set(id, value);
      if (e.type === "message_start" && e.message.role !== "assistant") return;
      if (e.type === "message_end") {
        // Persistence follows all handlers. Keep the observed value for openings
        // in that gap; the final replacement is authoritative only in history.
        this.pending.set(id, { ...value, message: e.message });
        this.pendingLeaf.set(id, this.context().sessionManager.getLeafId());
        if (e.message.role === "assistant") this.activeAssistant = undefined;
      }
      this.emit({ type: "message", value });
      return;
    }
    const e = event as ToolExecutionStartEvent | ToolExecutionUpdateEvent | ToolExecutionEndEvent;
    // Nested executions are not native transcript messages. Their parent renderer owns them.
    if (e.parentToolCallId) return;
    const value: TranscriptTool = { ...this.tools.get(e.toolCallId), id: e.toolCallId, name: e.toolName };
    if (e.type !== "tool_execution_end") value.args = clone(e.args);
    value.argsComplete = true;
    value.started = true;
    if (e.type === "tool_execution_update") {
      value.result = { ...clone(e.partialResult), isError: false };
      value.partial = true;
    } else if (e.type === "tool_execution_end") {
      value.result = { ...clone(e.result), isError: e.isError };
      value.partial = false;
    }
    this.tools.set(value.id, value);
    this.emit({ type: "tool", value });
  }

  protected reconcileBoundary(): void {
    // turn_end/agent_end/settled run after finalized message persistence. Do not
    // carry stale observer replacements across turns, including projected omissions.
    for (const [id, value] of this.pending) {
      if (value.streaming) continue;
      this.pending.delete(id);
      this.pendingLeaf.delete(id);
      if (value.message.role === "toolResult") this.tools.delete(value.message.toolCallId);
    }
    this.reconciledEntries.clear();
    this.emit({ type: "reset", value: this.snapshot() });
  }

  reset(): void {
    this.pendingLeaf.clear();
    this.reconciledEntries.clear();
    this.pending.clear();
    this.tools.clear();
    this.activeAssistant = undefined;
    this.emit({ type: "reset", value: this.snapshot() });
  }

  bind(pi: ExtensionAPI): void {
    // Collect while closed as well: the extension context exposes finalized history only.
    // This bounded in-flight cache is needed to reopen in the middle of args/output streaming.
    this.unsubscribe = [
      pi.on("message_start", event => this.accept(event)),
      pi.on("message_update", event => this.accept(event)),
      pi.on("message_end", event => this.accept(event)),
      pi.on("tool_execution_start", event => this.accept(event)),
      pi.on("tool_execution_update", event => this.accept(event)),
      pi.on("tool_execution_end", event => this.accept(event)),
      // Reconcile final transforms and boundary messages from canonical persisted data.
      pi.on("turn_end", () => this.reconcileBoundary()),
      pi.on("agent_end", () => this.reconcileBoundary()),
      pi.on("agent_settled", () => this.reconcileBoundary()),
    ];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe = [];
    this.listeners.clear();
    this.pendingLeaf.clear();
    this.reconciledEntries.clear();
    this.pending.clear();
    this.tools.clear();
  }
}

/** Native SDK events and projection; no model run or context mutation is needed to inspect. */
export class AgentSessionSource extends CurrentSessionSource {
  private unbind: () => void;
  constructor(private session: AgentSession) {
    super(() => ({ sessionManager: session.sessionManager }));
    this.unbind = session.subscribe(event => {
      switch (event.type) {
        case "message_start": case "message_update": case "message_end":
        case "tool_execution_start": case "tool_execution_update": case "tool_execution_end":
          this.accept(event); break;
        case "turn_end": case "agent_end": case "agent_settled":
          this.reconcileBoundary(); break;
      }
    });
  }
  resolveToolRenderers(name: string): ToolRenderers | undefined {
    return this.session.extensionRunner.resolveToolRenderers(name, () => this.session.getToolDefinition(name));
  }
  resolveMessageRenderer(type: string): MessageRenderer | undefined {
    return this.session.extensionRunner.getMessageRenderer(type);
  }
  override dispose(): void { this.unbind(); super.dispose(); }
}
