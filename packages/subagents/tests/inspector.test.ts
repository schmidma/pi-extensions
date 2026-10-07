import { beforeAll, expect, test } from "bun:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { initTheme, SessionManager, AgentSession, ExtensionRunner, SettingsManager, createExtensionRuntime, discoverAndLoadExtensions, type Theme, type KeybindingsManager, type ExtensionAPI, type TurnEndEvent, type TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as TuiKeys, TUI_KEYBINDINGS, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { TranscriptInspector } from "../extensions/subagents/inspector.ts";
import { CurrentSessionSource, type TranscriptSnapshot, type TranscriptSource, type TranscriptUpdate } from "../extensions/subagents/source.ts";
import { builtInRenderers, safeTextLines } from "../extensions/subagents/native.ts";
import preview from "../extensions/subagents/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Chrome uses the injected theme; actual native rows use Pi's initialized active theme.
const theme = { fg: (_token: string, text: string) => text } as Theme;
beforeAll(() => { initTheme("dark", false); });
const keys = new TuiKeys({ ...TUI_KEYBINDINGS,
  "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tools" },
  "app.thinking.toggle": { defaultKeys: "ctrl+t", description: "Show thinking" },
}) as KeybindingsManager;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: any[], timestamp = 2, stopReason = "toolUse") => ({ role: "assistant", content, timestamp, stopReason, api: "test", provider: "test", model: "test", usage }) as any;
const call = (id: string, name: string, args: any) => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, name: string, text: string, details?: any) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 3, details }) as any;
const strip = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

class Fixture implements TranscriptSource {
  listeners = new Set<(value: TranscriptUpdate) => void>();
  resolveToolRenderers?: TranscriptSource["resolveToolRenderers"];
  constructor(public state: TranscriptSnapshot) {}
  snapshot() { return structuredClone(this.state); }
  subscribe(listener: (value: TranscriptUpdate) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(value: TranscriptUpdate) { for (const listener of this.listeners) listener(value); }
}
function inspect(source: TranscriptSource, initialHeight = 80) {
  let rows = initialHeight, renders = 0, closed = 0;
  const ui = { requestRender: () => renders++, terminal: { get rows() { return rows; } } } as TUI;
  const view = new TranscriptInspector(source, ui, theme, keys, "/tmp", () => closed++);
  return { view, text: (width = 100) => strip(view.render(width).join("\n")), resize: (height: number) => rows = height, renders: () => renders, closed: () => closed };
}

test("physical and Kitty Left close once like Escape, while Right does not close", () => {
  for (const close of ["\x1b[D", "\x1b[1;1D", "\x1b[1;1:1D", "\x1b"]) {
    const source = new Fixture({ messages: [], tools: [] });
    const f = inspect(source);
    expect(f.text(180)).toContain("Left/Esc close");
    f.view.handleInput("\x1b[C"); f.view.handleInput("\x1b[1;1C");
    expect(f.closed()).toBe(0); expect(source.listeners.size).toBe(1);
    f.view.handleInput(close); f.view.handleInput(close); f.view.handleInput("\x1b");
    expect(f.closed()).toBe(1); expect(source.listeners.size).toBe(0);
  }
});

test("real native bash/read/edit renderers preserve commands, args, diff and association", () => {
  const source = new Fixture({ messages: [
    { id: "user", message: { role: "user", content: "Please inspect", timestamp: 1 } },
    { id: "a", message: assistant([
      { type: "text", text: "Inspecting now" },
      call("b", "bash", { command: "printf native-bash" }),
      call("r", "read", { path: "/tmp/native-file.ts", offset: 2, limit: 4 }),
      call("e", "edit", { path: "/tmp/native-file.ts", oldText: "old", newText: "new" }),
    ]) },
    // Reverse result order must not reorder the original calls.
    { id: "re", message: result("e", "edit", "edited", { diff: "-1 old\n+1 new", firstChangedLine: 1 }) },
    { id: "rr", message: result("r", "read", "native-read-output") },
    { id: "rb", message: result("b", "bash", "native-bash-output") },
  ], tools: [] });
  const { view, text } = inspect(source);
  view.handleInput("\x0f");
  const output = text();
  expect(output).toContain("printf native-bash");
  expect(output).toContain("native-file.ts:2-5");
  expect(output).toContain("old");
  expect(output).toContain("new");
  expect(output.indexOf("printf native-bash")).toBeLessThan(output.indexOf("native-read-output"));
  expect(output.indexOf("native-read-output")).toBeLessThan(output.indexOf("old"));
  expect(output.match(/native-bash-output/g)).toHaveLength(1);
  expect(output.match(/native-read-output/g)).toHaveLength(1);
  view.dispose();
});

for (const name of ["__proto__", "hasOwnProperty", "constructor", "toString"]) test(`prototype-named tool ${name} uses the native generic fallback`, () => {
  const renderers = builtInRenderers("/tmp");
  expect(renderers(name)).toBeUndefined();
  expect(renderers("read")?.renderCall).toBeFunction();
  expect(renderers("read")).toBe(renderers("read"));
  const source = new Fixture({ messages: [
    { id: "call", message: assistant([call("unknown", name, { value: "generic-argument" })]) },
    { id: "result", message: result("unknown", name, "generic-result") },
  ], tools: [] });
  const { view, text } = inspect(source);
  try {
    view.handleInput("\x0f");
    expect(text()).toContain(name);
    expect(text()).toContain("generic-argument");
    expect(text()).toContain("generic-result");
  } finally { view.dispose(); }
});

test("native direct shell hydration preserves exit status and truncation", () => {
  const source = new Fixture({ messages: [{ id: "shell", message: {
    role: "bashExecution", command: "false shell-command", output: "shell-output", exitCode: 2,
    cancelled: false, truncated: true, fullOutputPath: "/tmp/full-shell-output", timestamp: 4,
  } }], tools: [] });
  const { view, text } = inspect(source);
  expect(text()).toContain("false shell-command");
  expect(text()).toContain("shell-output");
  expect(text()).toContain("2");
  expect(text()).toContain("/tmp/full-shell-output");
  view.dispose();
});

test("streamed partial args and output become final without duplicate rows", () => {
  const source = new Fixture({ messages: [], tools: [] });
  const { view, text } = inspect(source);
  source.emit({ type: "message", value: { id: "live", message: assistant([call("x", "bash", { command: "printf par" })], 2, "pending"), streaming: true } });
  expect(text()).toContain("printf par");
  source.emit({ type: "message", value: { id: "live", message: assistant([{ type: "thinking", thinking: "secret-thought" }, call("x", "bash", { command: "printf final-command" })]), streaming: false } });
  expect(text()).not.toContain("printf par");
  expect(text()).not.toContain("secret-thought");
  view.handleInput("\x14");
  expect(text()).toContain("secret-thought");
  source.emit({ type: "tool", value: { id: "x", name: "bash", started: true, result: { content: [{ type: "text", text: "partial-output" }], isError: false }, partial: true } });
  expect(text()).toContain("partial-output");
  source.emit({ type: "tool", value: { id: "x", name: "bash", result: { content: [{ type: "text", text: "final-output" }], isError: false }, partial: false } });
  source.emit({ type: "message", value: { id: "result", message: result("x", "bash", "final-output") } });
  expect(text()).not.toContain("partial-output");
  expect(text().match(/final-command/g)).toHaveLength(1);
  expect(text().match(/final-output/g)).toHaveLength(1);
  view.dispose();
});

test("real tool expansion, viewport clipping, pause/follow tail, resize and invalidation", () => {
  const output = Array.from({ length: 35 }, (_, i) => `line-${i.toString().padStart(2, "0")}`).join("\n");
  const source = new Fixture({ messages: [
    { id: "a", message: assistant([call("x", "bash", { command: "many-lines" })]) },
    { id: "r", message: result("x", "bash", output) },
  ], tools: [] });
  const { view, text, resize } = inspect(source, 80);
  expect(text()).not.toContain("line-00"); // Native bash's collapsed tail preview.
  view.handleInput("\x0f");
  expect(text()).toContain("line-00");
  resize(8);
  let rendered = view.render(44);
  expect(rendered).toHaveLength(8);
  expect(rendered.every(line => visibleWidth(line) <= 44)).toBe(true);
  expect(text()).toContain("line-34");
  view.handleInput("\x1b[H");
  const top = text();
  expect(top).toContain("many-lines");
  source.emit({ type: "message", value: { id: "new", message: { role: "user", content: "tail-added", timestamp: 10 } } });
  expect(text()).not.toContain("tail-added");
  view.handleInput("\x1b[F");
  expect(text()).toContain("tail-added");
  view.handleInput("\x1b[A");
  expect(text()).toContain("paused");
  view.handleInput("\x1b[6~");
  expect(text()).toContain("following");
  resize(4);
  view.invalidate();
  expect(view.render(12)).toHaveLength(4);
  resize(1);
  expect(view.render(1)).toHaveLength(1);
  expect(view.render(1).every(line => visibleWidth(line) <= 1)).toBe(true);
  view.dispose();
});

test("tool expansion preserves the viewport when changed output is above it", () => {
  const source = new Fixture({ messages: [
    { id: "a", message: assistant([call("x", "bash", { command: "offscreen-command" })]) },
    { id: "r", message: result("x", "bash", Array.from({ length: 30 }, (_, i) => `tool-line-${i}`).join("\n")) },
    { id: "answer", message: assistant([{ type: "text", text: Array.from({ length: 30 }, (_, i) => `answer-line-${i}`).join("\n") }], 4, "stop") },
  ], tools: [] });
  const { view, text } = inspect(source, 8);
  try {
    const collapsed = view.render(100);
    expect(text()).toContain("ctrl+o tools");
    expect(text()).not.toContain("offscreen-command");
    view.handleInput("\x0f");
    expect(view.render(100)).toEqual(collapsed);
    view.handleInput("\x1b[H");
    expect(text()).toContain("tool-line-0");
    view.handleInput("\x0f");
    expect(text()).not.toContain("tool-line-0");
  } finally {
    view.dispose();
  }
});

test("hydration/reopening midstream retains live args and partial outputs; cleanup is idempotent", () => {
  const sessionManager = SessionManager.inMemory("/tmp");
  sessionManager.appendMessage({ role: "user", content: "start", timestamp: 1 });
  const source = new CurrentSessionSource(() => ({ sessionManager }));
  const start = assistant([], 2, "pending");
  source.accept({ type: "message_start", message: start });
  source.accept({ type: "message_update", message: assistant([call("x", "bash", { command: "mid-stream-command" })], 2, "pending"), assistantMessageEvent: {} as any });
  source.accept({ type: "tool_execution_start", toolCallId: "x", toolName: "bash", args: { command: "mid-stream-command" } });
  source.accept({ type: "tool_execution_update", toolCallId: "x", toolName: "bash", args: { command: "mid-stream-command" }, partialResult: { content: [{ type: "text", text: "mid-stream-output" }] } });
  let first = inspect(source);
  expect(first.text()).toContain("mid-stream-command");
  expect(first.text()).toContain("mid-stream-output");
  first.view.handleInput("\x1b");
  expect(first.closed()).toBe(1);
  const renders = first.renders();
  first.view.dispose();
  const second = inspect(source);
  expect(second.text()).toContain("mid-stream-output");
  const final = assistant([call("x", "bash", { command: "mid-stream-command" })]);
  source.accept({ type: "message_end", message: final });
  sessionManager.appendMessage(final);
  source.accept({ type: "tool_execution_end", toolCallId: "x", toolName: "bash", result: { content: [{ type: "text", text: "done-output" }] }, isError: false });
  const toolResult = result("x", "bash", "done-output");
  source.accept({ type: "message_end", message: toolResult });
  sessionManager.appendMessage(toolResult);
  expect(second.text().match(/mid-stream-command/g)).toHaveLength(1);
  expect(second.text().match(/done-output/g)).toHaveLength(1);
  expect(first.renders()).toBe(renders);
  second.view.dispose();
  const third = inspect(source);
  expect(third.text().match(/done-output/g)).toHaveLength(1);
  expect(source.snapshot().tools).toHaveLength(0);
  third.view.dispose();
  source.dispose(); source.dispose();
  expect(() => source.subscribe(() => {})).toThrow("disposed");
});

test("opening in message_end's persistence gap and projected edits do not duplicate content", () => {
  const sessionManager = SessionManager.inMemory("/tmp");
  const source = new CurrentSessionSource(() => ({ sessionManager }));
  const ended = assistant([{ type: "text", text: "not-yet-persisted" }], 20, "stop");
  source.accept({ type: "message_start", message: ended });
  source.accept({ type: "message_end", message: ended });
  const gap = inspect(source);
  expect(gap.text().match(/not-yet-persisted/g)).toHaveLength(1);
  gap.view.dispose();
  const entryId = sessionManager.appendMessage(ended);
  const after = inspect(source);
  expect(after.text().match(/not-yet-persisted/g)).toHaveLength(1);
  after.view.dispose();
  sessionManager.appendContextEdit(entryId, { content: [{ type: "text", text: "projected-replacement" }] });
  const edited = inspect(source);
  expect(edited.text()).toContain("projected-replacement");
  expect(edited.text()).not.toContain("not-yet-persisted");
  edited.view.dispose();
  const custom = { role: "custom", customType: "fixture", content: "custom-output", display: true, timestamp: 21 } as const;
  source.accept({ type: "message_end", message: custom });
  expect(source.snapshot().messages.filter(value => value.message.role === "custom")).toHaveLength(1);
  sessionManager.appendCustomMessageEntry(custom.customType, custom.content, true);
  const savedCustom = inspect(source);
  expect(savedCustom.text().match(/custom-output/g)).toHaveLength(1);
  savedCustom.view.dispose();
  source.dispose();
});

// Exercise the installed dispatcher and AgentSession persistence order, without
// model/runtime construction or any provider/network activity. Private host calls
// are test-only; the extension remains on the public API.
function lifecycle(transformFirst: boolean, gap: (source: CurrentSessionSource) => void,
  turnEnd?: (event: TurnEndEvent) => TurnEndEventResult) {
  const sessionManager = SessionManager.inMemory("/tmp");
  const source = new CurrentSessionSource(() => ({ sessionManager }));
  const handlers = new Map<string, Function[]>();
  source.bind({ on(name: string, handler: Function) {
    const list = handlers.get(name) ?? [];
    list.push(handler); handlers.set(name, list);
    return () => { list.splice(list.indexOf(handler), 1); };
  } } as unknown as ExtensionAPI);
  handlers.get("message_end")!.push(() => gap(source));
  const observer = { path: "observer", handlers };
  const transformer = { path: "transformer", handlers: new Map<string, Function[]>([["message_end", [(event: any) => ({
    message: { ...event.message, content: [{ type: "text", text: "canonical-final" }],
      ...(event.message.role === "custom" ? { customType: "canonical-type" } : {}) },
  })]]]) };
  if (turnEnd) transformer.handlers.set("turn_end", [turnEnd]);
  const runner = new ExtensionRunner((transformFirst ? [transformer, observer] : [observer, transformer]) as any,
    createExtensionRuntime(), "/tmp", sessionManager, {} as any);
  class HostLifecycle extends (AgentSession as any) { _buildRuntime() {} }
  const session = new HostLifecycle({ agent: new Agent(), sessionManager, cwd: "/tmp",
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }), initialActiveToolNames: [] });
  session._extensionRunner = runner;
  return { sessionManager, source, session, runner };
}

for (const first of [true, false]) test(`Pi lifecycle reconciles replacements ${first ? "before" : "after"} observer, equal messages and reopen`, async () => {
  let gaps = 0;
  const { sessionManager, source, session } = lifecycle(first, current => {
    const snapshot = current.snapshot();
    expect(snapshot.messages).toHaveLength(++gaps);
    // Opening while handlers are still running must retain this finalized event.
    const opened = inspect(current);
    expect(opened.text()).toContain(first ? "canonical-final" : "original-content");
    opened.view.dispose();
  });
  for (let i = 1; i <= 4; i++) {
    // Deliberately identical objects by value, including timestamps.
    const message = assistant([{ type: "text", text: "original-content" }], 2, "stop");
    await session._handleAgentEvent({ type: "message_start", message });
    await session._handleAgentEvent({ type: "message_end", message });
    // Test before even reaching a guaranteed boundary.
    expect(source.snapshot().messages).toHaveLength(i);
    expect((source as any).pending.size).toBe(0);
    await session._handleAgentEvent({ type: "turn_end", message, toolResults: [] });
    const reopened = inspect(source);
    expect(reopened.text().match(/canonical-final/g)).toHaveLength(i);
    expect(reopened.text()).not.toContain("original-content");
    reopened.view.dispose();
    expect((source as any).pendingLeaf.size).toBe(0);
    expect((source as any).reconciledEntries.size).toBe(0);
  }
  expect(sessionManager.buildSessionProjection().messages).toHaveLength(4);
  await session._handleAgentEvent({ type: "agent_end", messages: [] });
  await session._emitAgentSettled();
  source.dispose(); session.dispose();
});

for (const first of [true, false]) test(`Pi custom replacements ${first ? "before" : "after"} observer use distinct persistence slots`, async () => {
  let gaps = 0;
  const { source, session } = lifecycle(first, current => expect(current.snapshot().messages).toHaveLength(++gaps));
  for (let i = 1; i <= 3; i++) {
    const message = { role: "custom", customType: "original", content: [{ type: "text", text: "original-content" }], display: true, timestamp: 2 };
    await session._handleAgentEvent({ type: "message_end", message });
    const reopened = inspect(source);
    expect(reopened.text().match(/canonical-final/g)).toHaveLength(i);
    expect(reopened.text()).not.toContain("original-content");
    expect(source.snapshot().messages).toHaveLength(i);
    expect((source as any).pending.size).toBe(0);
    reopened.view.dispose();
  }
  source.dispose(); session.dispose();
});

for (const first of [true, false]) test(`Pi transformed tool results ${first ? "before" : "after"} observer release pending output`, async () => {
  let gaps = 0;
  const { source, session } = lifecycle(first, current => expect(current.snapshot().messages).toHaveLength(++gaps));
  for (let i = 1; i <= 3; i++) {
    const toolCallId = `tool-${i}`;
    await session._handleAgentEvent({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "command" } });
    await session._handleAgentEvent({ type: "tool_execution_end", toolCallId, toolName: "bash", result: { content: [{ type: "text", text: "original-content" }] }, isError: false });
    await session._handleAgentEvent({ type: "message_end", message: result(toolCallId, "bash", "original-content") });
    const snapshot = source.snapshot();
    expect(snapshot.messages).toHaveLength(i);
    expect(snapshot.tools).toHaveLength(0);
    expect((source as any).pending.size).toBe(0);
    const reopened = inspect(source);
    expect(reopened.text().match(/canonical-final/g)).toHaveLength(i);
    expect(reopened.text()).not.toContain("original-content");
    reopened.view.dispose();
  }
  source.dispose(); session.dispose();
});

for (const nextTurn of [true, false]) test(`committed Pi boundary drafts refresh an open inspector at ${nextTurn ? "next assistant start" : "settlement"}`, async () => {
  const { sessionManager, source, session } = lifecycle(false, () => {}, event => ({ entries: [
    { type: "context_edit", targetId: event.messageEntryId, replacement: { content: "boundary-replacement" } },
    { type: "custom_message", customType: "boundary", content: "boundary-custom", display: true },
  ] }));
  const opened = inspect(source);
  try {
    const ended = assistant([{ type: "text", text: "original-content" }], 2, "stop");
    await session._handleAgentEvent({ type: "message_start", message: ended });
    await session._handleAgentEvent({ type: "message_end", message: ended });
    await session._handleAgentEvent({ type: "tool_execution_update", toolCallId: "inflight", toolName: "bash",
      args: { command: "inflight-command" }, partialResult: { content: [{ type: "text", text: "inflight-output" }] } });
    // The real dispatcher commits returned drafts only after all turn_end handlers.
    await session._handleAgentEvent({ type: "turn_end", message: ended, toolResults: [] });
    expect(sessionManager.getBranch().filter(entry => entry.type === "context_edit")).toHaveLength(1);
    expect(opened.text()).toContain("canonical-final");
    expect(opened.text()).not.toContain("boundary-replacement");
    const updates: TranscriptUpdate[] = [];
    source.subscribe(update => updates.push(update));
    if (nextTurn) {
      const message = assistant([{ type: "text", text: "next-answer" }, call("next", "bash", { command: "next-args" })], 3, "pending");
      await session._handleAgentEvent({ type: "message_start", message });
      expect(updates.map(update => update.type)).toEqual(["reset", "message"]);
      expect(updates[0].type === "reset" && updates[0].value.messages.some(value => value.streaming)).toBe(false);
      expect(source.snapshot().messages.filter(value => value.streaming)).toHaveLength(1);
      expect(opened.text().match(/next-answer/g)).toHaveLength(1);
      expect(opened.text().match(/next-args/g)).toHaveLength(1);
      await session._handleAgentEvent({ type: "message_update", message: { ...message,
        content: [{ type: "text", text: "next-answer" }, call("next", "bash", { command: "updated-args" })] }, assistantMessageEvent: {} });
      expect(opened.text().match(/updated-args/g)).toHaveLength(1);
      expect(opened.text()).not.toContain("next-args");
    } else {
      await session._emitAgentSettled();
    }
    expect(opened.text()).not.toContain("canonical-final");
    expect(opened.text()).not.toContain("original-content");
    expect(opened.text().match(/boundary-replacement/g)).toHaveLength(1);
    expect(opened.text().match(/boundary-custom/g)).toHaveLength(1);
    expect(opened.text().match(/inflight-command/g)).toHaveLength(1);
    expect(opened.text().match(/inflight-output/g)).toHaveLength(1);
    expect(source.snapshot().tools[0].partial).toBe(true);
  } finally {
    opened.view.dispose(); source.dispose(); session.dispose();
  }
});

test("persisted boundaries clear finalized omissions but preserve streaming args/results", async () => {
  const { sessionManager, source, session, runner } = lifecycle(true, () => {});
  const message = assistant([{ type: "text", text: "original-content" }], 2, "stop");
  await session._handleAgentEvent({ type: "message_end", message });
  const saved = sessionManager.getLeafId()!;
  sessionManager.appendContextEdit(saved, null);
  // Leave an additional finalized gap to exercise boundary cleanup itself.
  source.accept({ type: "message_end", message: result("finalized", "bash", "omitted") });
  source.accept({ type: "message_start", message: assistant([], 3, "pending") });
  source.accept({ type: "message_update", message: assistant([call("live", "bash", { command: "still-streaming" })], 3, "pending"), assistantMessageEvent: {} as any });
  source.accept({ type: "tool_execution_update", toolCallId: "live", toolName: "bash", args: { command: "still-streaming" }, partialResult: { content: [{ type: "text", text: "partial-retained" }] } });
  await runner.emit({ type: "agent_settled" });
  expect(source.snapshot().messages).toHaveLength(1);
  expect((source as any).pending.size).toBe(1);
  const reopened = inspect(source);
  expect(reopened.text()).toContain("still-streaming");
  expect(reopened.text()).toContain("partial-retained");
  expect(reopened.text()).not.toContain("canonical-final");
  expect(reopened.text()).not.toContain("omitted");
  reopened.view.dispose(); source.dispose(); session.dispose();
});

for (const reason of ["aborted", "error", "default-error"]) test(`native tools finalize ${reason} in hydration, streaming and reopen without completing interrupted args`, () => {
  const stopReason = reason === "default-error" ? "error" : reason;
  const failure = { ...assistant([call("failed", "edit", { path: "/tmp/interrupted", oldText: "part" })], 2, stopReason),
    ...(reason === "error" ? { errorMessage: "provider failure" } : {}) };
  const expected = reason === "aborted" ? "Operation aborted" : reason === "error" ? "provider failure" : "Error";
  const source = new Fixture({ messages: [], tools: [] });
  const streamed = inspect(source);
  source.emit({ type: "message", value: { id: "earlier", message: assistant([call("earlier", "bash", { command: "earlier-task" })]) } });
  source.emit({ type: "message", value: { id: "failed", message: { ...failure, stopReason: "pending" }, streaming: true } });
  source.emit({ type: "message", value: { id: "failed", message: failure, streaming: false } });
  expect(streamed.text()).toContain(expected);
  const state = (streamed.view as any).tools;
  expect(state.get("failed").result.isError).toBe(true);
  expect(state.get("failed").partial).toBe(false);
  expect(state.get("earlier").result).toBeUndefined();
  expect((streamed.view as any).toolComponents.get("failed").argsComplete).toBe(false);
  streamed.view.dispose();
  source.state = { messages: [{ id: "failed", message: failure }], tools: [] };
  for (let i = 0; i < 2; i++) {
    const reopened = inspect(source);
    expect(reopened.text()).toContain(expected);
    expect((reopened.view as any).toolComponents.get("failed").argsComplete).toBe(false);
    reopened.view.dispose();
  }
});

test("assistant failures replace partial outputs, preserve terminal results and stay scoped to their calls", () => {
  const failure = { ...assistant([call("partial", "bash", { command: "partial-command" }), call("done", "bash", { command: "done-command" })], 2, "error"), errorMessage: "final-failure" };
  const partial = { id: "partial", name: "bash", started: true, argsComplete: true,
    result: { content: [{ type: "text" as const, text: "partial-output" }], isError: false }, partial: true };
  const terminal = { ...partial, id: "done", result: { content: [{ type: "text" as const, text: "real-terminal" }], isError: false }, partial: false };
  const source = new Fixture({ messages: [], tools: [] });
  const live = inspect(source);
  source.emit({ type: "message", value: { id: "failed", message: { ...failure, stopReason: "pending" }, streaming: true } });
  source.emit({ type: "tool", value: partial });
  source.emit({ type: "tool", value: terminal });
  source.emit({ type: "message", value: { id: "failed", message: failure } });
  expect(live.text()).toContain("final-failure");
  expect(live.text()).toContain("real-terminal");
  expect(live.text()).not.toContain("partial-output");
  expect((live.view as any).tools.get("done").result.isError).toBe(false);
  source.emit({ type: "tool", value: { ...partial, id: "done" } });
  expect(live.text()).toContain("real-terminal");
  expect((live.view as any).tools.get("done").partial).toBe(false);
  live.view.dispose();
  source.state = { messages: [{ id: "failed", message: failure }, { id: "result", message: result("done", "bash", "real-terminal") }], tools: [partial, terminal] };
  const reopened = inspect(source);
  expect(reopened.text()).toContain("final-failure");
  expect(reopened.text().match(/real-terminal/g)).toHaveLength(1);
  expect(reopened.text()).not.toContain("partial-output");
  expect((reopened.view as any).tools.get("done").result.isError).toBe(false);
  reopened.view.dispose();
});

test("custom renderer precedence, native generic fallback and image safety before clipping", () => {
  const source = new Fixture({ messages: [
    { id: "a", message: assistant([call("x", "bash", { command: "hidden-by-custom" }), call("y", "unknown", { path: "fallback-path" })]) },
  ], tools: [] });
  source.resolveToolRenderers = (name: string) => name === "bash" ? { renderCall: () => new Text("custom-call-wins", 0, 0) } : undefined;
  const { view, text } = inspect(source);
  expect(text()).toContain("custom-call-wins");
  expect(text()).not.toContain("hidden-by-custom");
  expect(text()).toContain("fallback-path");
  expect(safeTextLines(["\x1b_Gpayload", "continuation\x1b\\"])).toEqual(["[Image/control output omitted in preview]"]);
  view.dispose();
  const images = new Fixture({ messages: [
    { id: "u", message: { role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1 } },
    { id: "a", message: assistant([call("r", "read", { path: "image.png" })]) },
    { id: "r", message: { ...result("r", "read", ""), content: [{ type: "image", data: "AA==", mimeType: "image/png" }] } },
  ], tools: [] });
  const imageView = inspect(images);
  expect(imageView.text()).toContain("Image omitted");
  expect(imageView.text()).not.toContain("\x1b_G");
  imageView.view.dispose();
});

test("native rows rebuild on theme invalidation", () => {
  const source = new Fixture({ messages: [{ id: "a", message: assistant([call("x", "bash", { command: "theme-check" })]) }], tools: [] });
  const { view } = inspect(source);
  const dark = view.render(80).join("\n");
  initTheme("light", false);
  view.invalidate();
  expect(view.render(80).join("\n")).not.toBe(dark);
  expect(strip(view.render(80).join("\n"))).toContain("theme-check");
  view.dispose();
  initTheme("dark", false);
});

test("installed Pi extension loader accepts the opt-in entry point", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-subagents-loader-"));
  try {
    const entry = fileURLToPath(new URL("../extensions/subagents/index.ts", import.meta.url));
    const loaded = await discoverAndLoadExtensions([entry], directory, directory);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    expect([...loaded.extensions[0].commands.keys()]).toEqual(["subagents", "subagents-preview"]);
    expect([...loaded.extensions[0].tools.keys()]).toEqual(["spawn_subagent", "resume_subagent", "steer_subagent"]);
    const tools = loaded.extensions[0].tools;
    const spawn = tools.get("spawn_subagent")!.definition.parameters;
    expect(Object.keys(spawn.properties)).toEqual(["name", "prompt", "model", "thinking", "role"]);
    expect(spawn.required).toEqual(["name", "prompt", "model", "thinking"]);
    expect(spawn.properties.name.maxLength).toBe(80);
    for (const [name, fields] of [["resume_subagent", ["agent_id", "prompt"]], ["steer_subagent", ["agent_id", "message"]]] as const) {
      const schema = tools.get(name)!.definition.parameters;
      expect(Object.keys(schema.properties)).toEqual(fields);
      expect(schema.required).toEqual(fields);
      expect(schema.additionalProperties).toBe(false);
    }
    expect(spawn.additionalProperties).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("extension opt-in command and source event subscriptions release on shutdown/reload", async () => {
  const handlers = new Map<string, Set<Function>>();
  const commands = new Map<string, any>();
  const pi = {
    on(name: string, handler: Function) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(handler);
      return () => handlers.get(name)!.delete(handler);
    },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerTool() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  preview(pi);
  expect([...commands.keys()]).toEqual(["subagents", "subagents-preview"]);
  const manager = SessionManager.inMemory("/tmp");
  let done: (() => void) | undefined;
  let active: TranscriptInspector | undefined;
  const ctx = {
    mode: "tui", cwd: "/tmp", sessionManager: manager,
    ui: { getEditorComponent: () => undefined, setEditorComponent() {}, setWidget() {}, custom(factory: Function) {
      return new Promise<void>(resolve => {
        done = resolve;
        active = factory({ terminal: { rows: 8 }, requestRender() {} }, theme, keys, resolve);
      });
    } },
  };
  const emit = (name: string) => { for (const handler of [...handlers.get(name) ?? []]) handler({}, ctx); };
  emit("session_start");
  expect(handlers.get("message_update")!.size).toBe(1);
  const opened = commands.get("subagents-preview").handler("", ctx);
  expect(active!.render(40)).toHaveLength(8);
  active!.handleInput("\x1b");
  await opened;
  // The bounded live collector survives close so reopening mid-stream works.
  expect(handlers.get("message_update")!.size).toBe(1);
  emit("session_shutdown");
  expect(handlers.get("message_update")!.size).toBe(0);
  emit("session_start");
  expect(handlers.get("message_update")!.size).toBe(1);
  const reopened = commands.get("subagents-preview").handler("", ctx);
  emit("session_shutdown");
  await reopened;
  expect(handlers.get("message_update")!.size).toBe(0);
});
