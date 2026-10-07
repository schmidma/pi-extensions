import {
  AssistantMessageComponent, ToolExecutionComponent,
  type KeybindingsManager, type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { builtInRenderers, nativeMessage, nativeTool, safeTextLines } from "./native.ts";
import { delegationRenderers, reportRenderer, type RecordLookup, type RunLookup } from "./cards.ts";
import { REPORT_TYPE } from "./state.ts";
import type { TranscriptMessage, TranscriptSnapshot, TranscriptSource, TranscriptTool, TranscriptUpdate } from "./source.ts";

/** Read-only native rows plus an explicitly clipped text-only viewport. */
export class TranscriptInspector implements Component {
  private messages = new Map<string, TranscriptMessage>();
  private messageComponents = new Map<string, Component>();
  private tools = new Map<string, TranscriptTool>();
  private toolComponents = new Map<string, ToolExecutionComponent>();
  private readonly fallback;
  private unsubscribe: () => void;
  private disposed = false;
  private expanded = false;
  private hideThinking = true;
  private following = true;
  private offset = 0;
  private maxOffset = 0;
  private viewportHeight = 1;

  constructor(
    private source: TranscriptSource,
    private ui: TUI,
    private theme: Theme,
    private keys: KeybindingsManager,
    private cwd: string,
    private done: () => void,
    private height: () => number = () => ui.terminal.rows,
    private title = "Current-session preview - not a subagent manager (images disabled)",
    private lookup: RecordLookup = () => undefined,
    private lookupRun: RunLookup = () => undefined,
  ) {
    this.fallback = builtInRenderers(cwd);
    this.hydrate(source.snapshot());
    this.unsubscribe = source.subscribe(update => this.apply(update));
  }

  private hydrate(snapshot: TranscriptSnapshot): void {
    this.messages.clear();
    this.tools.clear();
    this.messageComponents.clear();
    this.toolComponents.clear();
    for (const message of snapshot.messages) this.updateMessage(message);
    for (const tool of snapshot.tools) this.updateTool(tool);
  }

  private updateMessage(value: TranscriptMessage): void {
    const { message } = value;
    this.messages.set(value.id, value);
    if (message.role === "toolResult") {
      this.updateTool({
        id: message.toolCallId, name: message.toolName, started: true, argsComplete: true,
        result: { content: message.content, details: message.details, isError: message.isError }, partial: false,
      });
      return;
    }
    let component = this.messageComponents.get(value.id);
    if (component instanceof AssistantMessageComponent && message.role === "assistant") {
      component.updateContent(message, value.streaming ?? false);
    } else {
      const renderer = message.role === "custom" ? this.source.resolveMessageRenderer?.(message.customType)
        ?? (message.customType === REPORT_TYPE ? reportRenderer(this.lookup, this.lookupRun) : undefined) : undefined;
      component = nativeMessage(message, this.ui, this.hideThinking, renderer);
      if (component) {
        if (component instanceof AssistantMessageComponent && message.role === "assistant") {
          component.updateContent(message, value.streaming ?? false);
        }
        if ("setExpanded" in component) (component as Component & { setExpanded(value: boolean): void }).setExpanded(this.expanded);
        this.messageComponents.set(value.id, component);
      }
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const failed = message.stopReason === "aborted" || message.stopReason === "error";
        this.updateTool({ id: block.id, name: block.name, args: block.arguments,
          argsComplete: failed ? this.tools.get(block.id)?.argsComplete ?? false : !value.streaming });
      }
      this.finalizeFailedTools(value);
    }
  }

  private finalizeFailedTools({ message, streaming }: TranscriptMessage): void {
    if (streaming || message.role !== "assistant" ||
      (message.stopReason !== "aborted" && message.stopReason !== "error")) return;
    const text = message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error";
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const tool = this.tools.get(block.id);
      // A real terminal execution/result always wins over an assistant failure.
      if (tool?.result && !tool.partial) continue;
      this.updateTool({ id: block.id, name: block.name,
        result: { content: [{ type: "text", text }], isError: true }, partial: false });
    }
  }

  private updateTool(update: TranscriptTool): void {
    const previous = this.tools.get(update.id);
    // A stale partial snapshot must not replace a persisted terminal result
    // (or reopen an already-finalized failure row).
    if (update.result && update.partial && previous?.result && !previous.partial) {
      update = { ...update, result: previous.result, partial: false };
    }
    const value = { ...previous, ...update };
    this.tools.set(value.id, value);
    let component = this.toolComponents.get(value.id);
    if (!component) {
      // Caller-resolved custom renderers take precedence; definitions are fallback only.
      component = nativeTool(value.name, value.id, value.args ?? {},
        this.source.resolveToolRenderers?.(value.name) ?? delegationRenderers(value.name, this.lookup) ?? this.fallback(value.name), this.ui, this.cwd);
      component.setExpanded(this.expanded);
      this.toolComponents.set(value.id, component);
    }
    if (update.args !== undefined) component.updateArgs(update.args);
    if (value.argsComplete) component.setArgsComplete();
    if (value.started) component.markExecutionStarted();
    if (update.result) component.updateResult(update.result, value.partial ?? false);
  }

  private apply(update: TranscriptUpdate): void {
    if (this.disposed) return;
    if (update.type === "reset") this.hydrate(update.value);
    else if (update.type === "message") this.updateMessage(update.value);
    else this.updateTool(update.value);
    this.ui.requestRender();
  }

  private renderRows(width: number): string[] {
    const rows: string[] = [];
    const shown = new Set<string>();
    const addTool = (id: string) => {
      if (shown.has(id)) return;
      const component = this.toolComponents.get(id);
      if (!component) return;
      shown.add(id);
      rows.push(...safeTextLines(component.render(width)));
    };
    for (const [id, { message }] of this.messages) {
      const component = this.messageComponents.get(id);
      if (component) rows.push(...safeTextLines(component.render(width)));
      if (message.role === "assistant") {
        for (const block of message.content) if (block.type === "toolCall") addTool(block.id);
      } else if (message.role === "toolResult") addTool(message.toolCallId);
    }
    // Executions observed before their assistant call, or orphan results after context edits.
    for (const id of this.tools.keys()) addTool(id);
    return rows;
  }

  render(width: number): string[] {
    const height = Math.max(1, Math.floor(this.height()));
    const chrome = height >= 3 ? 2 : 1;
    this.viewportHeight = Math.max(0, height - chrome);
    const content = this.renderRows(Math.max(1, width));
    this.maxOffset = Math.max(0, content.length - this.viewportHeight);
    this.offset = this.following ? this.maxOffset : Math.min(this.offset, this.maxOffset);
    const title = this.theme.fg("accent", this.title);
    const lines = [truncateToWidth(title, width)];
    lines.push(...content.slice(this.offset, this.offset + this.viewportHeight));
    while (lines.length < height - (chrome === 2 ? 1 : 0)) lines.push("");
    if (chrome === 2) {
      const hint = `Left/Esc close · ${this.keys.getKeys("app.tools.expand").join("/")} tools · ${this.keys.getKeys("app.thinking.toggle").join("/")} thinking · Up/Down/PgUp/PgDn · Home/End · ${this.following ? "following" : "paused"}`;
      lines.push(truncateToWidth(this.theme.fg("muted", hint), width));
    }
    // The viewport owns clipping; overlay maxHeight and ScrollView.render do not scroll content.
    return lines.map(line => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, "escape") || matchesKey(data, "left") || this.keys.matches(data, "tui.select.cancel")) {
      this.dispose();
      this.done();
      return;
    }
    if (this.keys.matches(data, "app.tools.expand")) {
      this.expanded = !this.expanded;
      for (const component of this.toolComponents.values()) component.setExpanded(this.expanded);
      for (const component of this.messageComponents.values()) {
        if ("setExpanded" in component) (component as Component & { setExpanded(value: boolean): void }).setExpanded(this.expanded);
      }
    } else if (this.keys.matches(data, "app.thinking.toggle")) {
      this.hideThinking = !this.hideThinking;
      for (const component of this.messageComponents.values()) {
        if (component instanceof AssistantMessageComponent) component.setHideThinkingBlock(this.hideThinking);
      }
    } else if (matchesKey(data, "home")) {
      this.following = false;
      this.offset = 0;
    } else if (matchesKey(data, "end")) {
      this.following = true;
    } else {
      let delta = 0;
      if (this.keys.matches(data, "tui.editor.cursorUp")) delta = -1;
      else if (this.keys.matches(data, "tui.editor.cursorDown")) delta = 1;
      else if (this.keys.matches(data, "tui.editor.pageUp")) delta = -Math.max(1, this.viewportHeight);
      else if (this.keys.matches(data, "tui.editor.pageDown")) delta = Math.max(1, this.viewportHeight);
      if (!delta) return;
      this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + delta));
      this.following = delta > 0 && this.offset === this.maxOffset;
    }
    this.ui.requestRender();
  }

  invalidate(): void {
    for (const component of this.messageComponents.values()) component.invalidate();
    for (const component of this.toolComponents.values()) component.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.messageComponents.clear();
    this.toolComponents.clear();
    this.messages.clear();
    this.tools.clear();
  }
}
