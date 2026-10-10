import { expect, test } from "bun:test";
import { Lifecycle, resultPhase, watchLifecycle } from "./lifecycle.ts";

const theme = { fg: (_: string, text: string) => text } as any;
const context = (id: string, invalidate = () => {}, extra = {}) => ({ toolCallId: id, isPartial: true, invalidate, ...extra }) as any;
const result = (text: string) => ({ content: [{ type: "text", text }] });
const marker = (life: Lifecycle, id: string) => life.marker(context(id), theme);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function harness() {
  const handlers = new Map<string, Function>();
  const life = new Lifecycle();
  const ctx = { mode: "tui", sessionManager: { getBranch: () => [] }, signal: undefined };
  watchLifecycle({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any, life);
  const emit = (name: string, event = {}, custom = ctx) => handlers.get(name)?.(event, custom);
  emit("session_start");
  return { life, emit, ctx };
}

test("per-call ready precedes assistant message end, and sibling calls remain composing", () => {
  const { life, emit } = harness();
  const partial = { content: [{ type: "toolCall", id: "a" }, { type: "toolCall", id: "b" }] };
  const update = (type: string, contentIndex: number) => emit("message_update", { assistantMessageEvent: { type, contentIndex, partial } });
  update("toolcall_start", 0); update("toolcall_delta", 1);
  expect(marker(life, "a")).toBe("✎");
  update("toolcall_end", 0);
  expect(marker(life, "a")).toBe("○"); expect(marker(life, "b")).toBe("✎");
  emit("message_end", { message: { role: "assistant", content: partial.content, stopReason: "toolUse" } });
  emit("tool_execution_start", { toolCallId: "a" });
  expect(marker(life, "a")).toBe("⠋"); expect(marker(life, "b")).toBe("○");
  emit("tool_execution_end", { toolCallId: "a", result: result("accepted"), isError: false });
  expect(marker(life, "a")).toBe("✓");
  emit("agent_end");
  expect(marker(life, "a")).toBe("✓"); expect(marker(life, "b")).toBe("-");
  life.stop();
});

test("historical successes, failures and missing results are static, never executing", () => {
  const life = new Lifecycle();
  life.start([{ type: "message", message: { role: "assistant", content: ["ok", "bad", "abort", "missing"].map(id => ({ type: "toolCall", id })) } },
    ...[["ok", false, "done"], ["bad", true, "error"], ["abort", true, "Operation aborted"]].map(([id, isError, text]) =>
      ({ type: "message", message: { role: "toolResult", toolCallId: id, isError, ...result(text as string) } }))], true);
  expect(["ok", "bad", "abort", "missing"].map(id => life.marker(context(id, () => {}, { executionStarted: true }), theme)))
    .toEqual(["✓", "×", "-", "-"]);
  expect(life.marker(context("export", () => {}, { executionStarted: true, isPartial: false }), theme)).toBe("✓");
  life.stop();
});

test("historical shell cancellations retain dash, including captured output, after tree/reload", () => {
  const { life, emit, ctx } = harness();
  const entries = ["Command aborted", "some output\n\nCommand aborted"].map((text, i) => ({ type: "message",
    message: { role: "toolResult", toolName: i === 0 ? "bash" : "powershell", toolCallId: `shell-${i}`, isError: true, ...result(text) } }));
  for (const event of ["session_start", "session_tree"]) {
    emit(event, {}, { ...ctx, sessionManager: { getBranch: () => entries } } as any);
    expect(marker(life, "shell-0")).toBe("-"); expect(marker(life, "shell-1")).toBe("-");
  }
  expect(resultPhase(result("Command aborted"), true, "unrelated")).toBe("failure");
  expect(resultPhase(result("Command timed out after 3 seconds"), true, "bash")).toBe("failure");
  life.stop();
});

test("cancellation during streaming or execution, nested calls and known skipped outcomes", () => {
  const { life, emit, ctx } = harness();
  emit("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id: "stream" }], stopReason: "aborted" } });
  expect(marker(life, "stream")).toBe("-");
  emit("tool_execution_start", { toolCallId: "nested", parentToolCallId: "outer" });
  expect(marker(life, "nested")).toBe("-");
  emit("tool_execution_end", { toolCallId: "a", result: result("custom abort text"), isError: true }, { ...ctx, signal: { aborted: true } } as any);
  expect(marker(life, "a")).toBe("-");
  expect(resultPhase(result("Tool execution was blocked"), true)).toBe("cancelled");
  expect(resultPhase(result('Tool call "write" was not executed: the response hit the output token limit, so its arguments may be truncated.'), true)).toBe("cancelled");
  expect(resultPhase(result("Operation aborted"), false)).toBe("success");
  expect(resultPhase(result("Error: not aborted"), true)).toBe("failure");
  life.stop();
});

test("animation ignores unrelated dialogs and stops at completion/shutdown", async () => {
  const { life, emit } = harness();
  let redraws = 0;
  life.set("a", "running");
  const row = context("a", () => { redraws++; });
  const first = life.marker(row, theme);
  await delay(130);
  expect(redraws).toBeGreaterThan(0); expect(life.marker(row, theme)).not.toBe(first);
  life.set("waiting", "ready");
  emit("ui_prompt_start");
  expect(life.marker(row, theme)).not.toBe("○");
  expect(marker(life, "waiting")).toBe("○");
  const active = redraws;
  await delay(130); expect(redraws).toBeGreaterThan(active);
  emit("ui_prompt_end");
  expect(life.marker(row, theme)).not.toBe("○");
  emit("tool_execution_end", { toolCallId: "a", isError: false, result: result("done") });
  const completed = redraws;
  await delay(130); expect(redraws).toBe(completed); expect(life.marker(row, theme)).toBe("✓");
  life.set("b", "running"); life.marker(context("b", () => { redraws++; }), theme);
  emit("session_shutdown");
  const stopped = redraws;
  await delay(130); expect(redraws).toBe(stopped);
  emit("session_start"); expect(marker(life, "b")).toBe("-");
  life.stop();
});
