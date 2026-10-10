import type { ExtensionAPI, ExtensionContext, ToolRenderers } from "@earendil-works/pi-coding-agent";

type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
export type Phase = "composing" | "ready" | "running" | "success" | "failure" | "cancelled";
const terminal = (phase: Phase) => ["success", "failure", "cancelled"].includes(phase);
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Pi persists error text, but no structured cancellation flag. Match only core's known outcomes. */
export function resultPhase(result: { content?: readonly { type: string; text?: string }[] }, isError: boolean, toolName?: string): Phase {
  if (!isError) return "success";
  const text = result?.content?.filter(block => block.type === "text").map(block => block.text).join("\n");
  return text === "Operation aborted" || text === "Tool execution was blocked" ||
    ((toolName === "bash" || toolName === "powershell") && /(?:^|\n\n)Command aborted$/.test(text ?? "")) ||
    /^Tool call ".+" was not executed: the response hit the output token limit,/.test(text ?? "")
    ? "cancelled" : "failure";
}

export class Lifecycle {
  private phases = new Map<string, Phase>();
  private redraw = new Map<string, () => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private enabled = false;

  start(entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>, enabled: boolean) {
    this.stop();
    this.enabled = enabled;
    // Seed every historical call as not executed, then apply its actual result.
    // executionStarted in a render context is also true for historical/export rows.
    for (const entry of entries) {
      const message = entry.type === "message" ? entry.message : undefined;
      if (message?.role === "assistant") for (const block of message.content) {
        if (block.type === "toolCall") this.phases.set(block.id, "cancelled");
      }
      if (message?.role === "toolResult") this.phases.set(message.toolCallId, resultPhase(message, message.isError, message.toolName));
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.phases.clear();
    this.redraw.clear();
    this.enabled = false;
    this.frame = 0;
  }

  set(id: string, phase: Phase) {
    this.phases.set(id, phase);
    this.redraw.get(id)?.();
    if (terminal(phase)) this.redraw.delete(id);
    this.syncTimer();
  }

  settle() {
    for (const [id, phase] of this.phases) if (!terminal(phase)) this.set(id, "cancelled");
  }

  marker(context: RenderContext, theme: Parameters<NonNullable<ToolRenderers["renderCall"]>>[1]): string {
    let phase = this.phases.get(context.toolCallId);
    if (!phase) phase = context.isPartial ? "cancelled" : context.isError ? "failure" : "success";
    // Result rendering can precede lifecycle dispatch (or happen in a static export).
    if (!context.isPartial && !terminal(phase)) phase = context.isError ? "failure" : "success";
    if (this.enabled && !terminal(phase)) this.redraw.set(context.toolCallId, context.invalidate);
    this.syncTimer();
    const mark = phase === "running" ? frames[this.frame % frames.length] :
      ({ composing: "✎", ready: "○", success: "✓", failure: "×", cancelled: "-" } as const)[phase];
    return theme.fg(phase === "failure" ? "error" : "muted", mark);
  }

  private syncTimer() {
    const needed = this.enabled && [...this.redraw.keys()].some(id => this.phases.get(id) === "running");
    if (!needed && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (needed && !this.timer) {
      this.timer = setInterval(() => {
        this.frame++;
        for (const [id, redraw] of [...this.redraw]) if (this.phases.get(id) === "running") redraw();
      }, 100);
      this.timer.unref?.();
    }
  }
}

export function watchLifecycle(pi: ExtensionAPI, lifecycle: Lifecycle) {
  const start = (_event: unknown, ctx: ExtensionContext) => lifecycle.start(ctx.sessionManager.getBranch(), ctx.mode === "tui");
  pi.on("session_start", start);
  pi.on("session_tree", start);
  pi.on("session_shutdown", () => lifecycle.stop());
  pi.on("message_update", event => {
    const stream = event.assistantMessageEvent;
    if (stream.type !== "toolcall_start" && stream.type !== "toolcall_delta" && stream.type !== "toolcall_end") return;
    const block = stream.partial.content[stream.contentIndex];
    if (block?.type === "toolCall") lifecycle.set(block.id, stream.type === "toolcall_end" ? "ready" : "composing");
  });
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    const skipped = ["aborted", "error", "length"].includes(event.message.stopReason);
    for (const block of event.message.content) if (block.type === "toolCall") lifecycle.set(block.id, skipped ? "cancelled" : "ready");
  });
  // This is Pi's execution lifecycle, which includes validation and approval, not a body-entry hook.
  pi.on("tool_execution_start", event => { if (!event.parentToolCallId) lifecycle.set(event.toolCallId, "running"); });
  pi.on("tool_execution_end", (event, ctx) => {
    if (!event.parentToolCallId) lifecycle.set(event.toolCallId, event.isError && ctx.signal?.aborted
      ? "cancelled" : resultPhase(event.result, event.isError, event.toolName));
  });
  // UI prompt events have no call identity; they must not reclassify concurrent tools.
  pi.on("agent_end", () => lifecycle.settle());
}
