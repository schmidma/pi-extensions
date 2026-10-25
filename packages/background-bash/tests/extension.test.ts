import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createBashToolDefinition, discoverAndLoadExtensions, initTheme, ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
let theme: Theme;
beforeAll(() => {
  initTheme("dark", false);
  // Capture the real host theme through its public rendering contract.
  new ToolExecutionComponent("theme", "theme", {}, {}, { renderCall(_args, current) {
    theme = current;
    return { render: () => [], invalidate() {} };
  } }, { requestRender() {} } as any, process.cwd());
});
import backgroundBash from "../extensions/background-bash/index.ts";
import { ENTRY_TYPE, MESSAGE_TYPE, type Snapshot } from "../extensions/background-bash/runtime.ts";
import { completionCard } from "../extensions/background-bash/render.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { decorate } from "../../terminal-ui/extensions/tool-lifecycle/index.ts";
import { Lifecycle } from "../../terminal-ui/extensions/tool-lifecycle/lifecycle.ts";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const cleanup: (() => Promise<void>)[] = [];
function harness(shared?: any) {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const renderers = new Map<string, Function>();
  const shortcuts = new Map<string, any>();
  const directory = shared?.directory ?? mkdtempSync("/var/tmp/pi-background-bash-extension-");
  const id = shared?.id ?? randomUUID();
  const branch: any[] = shared?.branch ?? [];
  const sent: any[] = [];
  let resolveNotification: (value: any) => void;
  const notification = new Promise(resolve => { resolveNotification = resolve; });
  const settings = { shellPath: "/bin/bash", shellCommandPrefix: "export TEST_BACKGROUND_PREFIX=preserved", outputPad: 1 };
  const ctx = { cwd: directory, thinkingLevel: "high", model: { provider: "test", id: "local" },
    sessionManager: { getSessionId: () => id, getSessionFile: () => `${directory}/session.jsonl`, getBranch: () => branch },
    ui: { notify() {} } } as any;
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerMessageRenderer: (name: string, renderer: Function) => renderers.set(name, renderer),
    registerShortcut: (key: string, value: any) => shortcuts.set(key, value),
    registerCommand() {}, getSettings: () => settings,
    appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data }),
    sendMessage: (message: any, options: any) => {
      expect(branch.some(e => e.customType === ENTRY_TYPE && e.data.id === message.details.id)).toBe(true);
      sent.push({ message, options }); resolveNotification(message);
    },
  } as any;
  backgroundBash(pi);
  const emit = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
  emit("session_start", { reason: shared ? "reload" : "startup" });
  const tool = tools.get("bash");
  const execute = (callId: string, args: any, update?: Function, signal?: AbortSignal) => tool.execute(callId, args, signal, update, ctx);
  const row = (callId: string, args: any, extra = {}) => ({ toolCallId: callId, args, state: {}, outputPad: 1,
    expanded: false, isPartial: false, executionStarted: true, invalidate() {}, ...extra });
  cleanup.push(async () => { await emit("session_shutdown", { reason: "quit" }); if (!shared) rmSync(directory, { force: true, recursive: true }); });
  return { tools, tool, ctx, settings, execute, row, emit, sent, notification, branch, id, directory, renderers, shortcuts };
}
const originalStateHome = process.env.XDG_STATE_HOME;
const stateDirectory = mkdtempSync("/var/tmp/pi-background-bash-state-");
process.env.XDG_STATE_HOME = stateDirectory;
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
process.on("exit", () => {
  if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalStateHome;
  rmSync(stateDirectory, { recursive: true, force: true });
});

test("foreground cancellation and spawn failure return errors without structured success values", async () => {
  const h = harness();
  const controller = new AbortController();
  const aborted = await h.execute("abort", { command: "sleep 30" }, () => controller.abort(), controller.signal);
  expect(aborted.isError).toBe(true);
  expect(aborted.details.status).toBe("aborted");
  expect(aborted.structuredContent).toBeUndefined();
  expect(aborted.content[0].text).toContain("aborted");
  h.ctx.cwd = `${h.directory}/missing-working-directory`;
  const failed = await h.execute("spawn-failure", { command: "true" });
  expect(failed.isError).toBe(true);
  expect(failed.details.status).toBe("failed");
  expect(failed.structuredContent).toBeUndefined();
  expect(failed.content[0].text).toContain("failed");
});

test("native bash composition is preserved for completed, failed, cancelled and historical rows", async () => {
  const h = harness();
  const life = new Lifecycle();
  const native = createBashToolDefinition(h.directory);
  const args = { command: "printf '界\\toutput'\nprintf more", timeout: 10 };
  const output = Array.from({ length: 9 }, (_, i) => `line ${i} - 界 ${"output ".repeat(6)}`).join("\n");
  for (const [status, exitCode, suffix, mark] of [
    ["exited", 0, "", "✓"], ["exited", 3, "\n\nCommand exited with code 3", "×"],
    ["aborted", null, "\n\nCommand aborted", "-"], ["timeout", null, "\n\nCommand timed out after 10 seconds", "×"],
  ] as const) {
    const id = `native-${status}-${exitCode}`;
    const snapshot = { version: 1, id, toolCallId: id, command: args.command, startedAt: 1000, endedAt: 7324000,
      status, exitCode, background: true, output, bytes: output.length, logBytes: output.length, logPath: "/log", truncated: false };
    const result = { content: [{ type: "text" as const, text: output + suffix }], details: undefined, isError: mark !== "✓", durationMs: 7323000 };
    life.set(id, mark === "✓" ? "success" : mark === "-" ? "cancelled" : "failure");
    const expected = new ToolExecutionComponent("bash", id, args, { showImages: false }, decorate(native, life, "bash"), { requestRender() {} } as any, h.directory);
    const actual = new ToolExecutionComponent("bash", id, args, { showImages: false }, decorate(h.tool, life, "bash"), { requestRender() {} } as any, h.directory);
    expected.updateResult(result, false);
    // The core acknowledgement is deliberately successful and has the wrong
    // duration. Process details, not that acknowledgement, own the final row.
    actual.updateResult({ ...result, details: snapshot, isError: false, durationMs: 1 }, false);
    for (const expanded of [false, true]) for (const pad of [0, 1, 3]) for (const width of [3, 20, 80, 120]) {
      expected.setExpanded(expanded); actual.setExpanded(expanded);
      expected.setOutputPad(pad); actual.setOutputPad(pad);
      // Exact ANSI comparison protects native backgrounds, spacing and styles,
      // not just text that happens to resemble the native tool.
      expect(actual.render(width)).toEqual(expected.render(width));
    }
    actual.setOutputPad(1); actual.setExpanded(false);
    const view = stripVTControlCharacters(actual.render(120).join("\n"));
    expect(view).toContain(`${mark} $ printf`);
    expect(view).toContain("(timeout 10s)");
    expect(view).toContain("earlier lines,");
    expect(view).toContain("to expand");
    expect(view).toContain("Took 2h 2m 3s");
  }
  life.stop();
});

test("native live row survives acknowledgement and agent end, then settles; delivery remains compact", async () => {
  const entry = fileURLToPath(new URL("../extensions/background-bash/index.ts", import.meta.url));
  const loaded = await discoverAndLoadExtensions([entry], stateDirectory, stateDirectory);
  expect(loaded.errors).toEqual([]);
  expect([...loaded.extensions[0].tools.keys()]).toEqual(["bash", "bash_output", "bash_tasks", "bash_kill"]);
  const h = harness();
  const gate = `${h.directory}/finish`;
  const args = { command: `printf start; sleep .1; printf middle; while [ ! -f '${gate}' ]; do sleep .01; done; printf finished`, background: true };
  let redraws = 0;
  const life = new Lifecycle();
  life.start([], true);
  life.set("live", "running");
  const component = new ToolExecutionComponent("bash", "live", args, { showImages: false }, decorate(h.tool, life, "bash"),
    { requestRender: () => redraws++ } as any, h.directory);
  component.markExecutionStarted();
  const ack = await h.execute("live", args, (update: any) => component.updateResult({ ...update, isError: false }, true));
  component.updateResult({ ...ack, isError: false, durationMs: 1 }, false);
  life.set("live", "success");
  life.settle(); // agent_end must not finalize process-owned work.
  const view = () => stripVTControlCharacters(component.render(120).join("\n"));
  expect(view()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \$/);
  expect(view()).toMatch(/Elapsed \d+\.\ds/);
  const initialElapsed = Number(view().match(/Elapsed ([\d.]+)s/)![1]);
  expect(view()).not.toContain("✓");
  await delay(180);
  expect(Number(view().match(/Elapsed ([\d.]+)s/)![1])).toBeGreaterThan(initialElapsed);
  expect(view()).toContain("middle");
  expect(redraws).toBeGreaterThan(0);
  expect(h.sent).toHaveLength(0);
  // Compare the still-pending shell/output with an ordinary native partial row.
  const baselineLife = new Lifecycle(); baselineLife.set("baseline", "running");
  const baseline = new ToolExecutionComponent("bash", "baseline", args, { showImages: false }, decorate(createBashToolDefinition(h.directory), baselineLife, "bash"),
    { requestRender() {} } as any, h.directory);
  baseline.markExecutionStarted();
  const result = { content: [{ type: "text" as const, text: "startmiddle" }], details: undefined, isError: false };
  baseline.updateResult(result, true);
  const normalize = (lines: string[]) => lines.map(line => line.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "⠋").replace(/Elapsed \d+\.\ds/, "Elapsed 0.0s"));
  try { expect(normalize(component.render(120))).toEqual(normalize(baseline.render(120))); }
  finally { baseline.updateResult(result, false); baselineLife.stop(); }
  writeFileSync(gate, "finish");
  const message: any = await h.notification;
  expect(view()).toContain("✓ $");
  expect(view()).toContain("finished");
  expect(view()).toMatch(/Took \d+\.\ds/);
  expect(view()).not.toContain("Elapsed");
  const stopped = redraws;
  await delay(1100); // Longer than Pi's native timer interval: no orphan clock may redraw.
  expect(redraws).toBe(stopped);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
  const completion = h.renderers.get(MESSAGE_TYPE)!(message, { expanded: false }, theme);
  expect(completion.render(100)).toHaveLength(4);
  const delivered = stripVTControlCharacters(completion.render(100).join("\n"));
  expect(delivered).toContain("✓ $ printf start;");
  expect(delivered).toContain("completion delivered");
  expect(delivered).not.toContain("startmiddlefinished");
  expect(delivered).not.toContain(message.details.id);
  h.settings.outputPad = 0;
  expect(stripVTControlCharacters(h.renderers.get(MESSAGE_TYPE)!(message, { expanded: false }, theme).render(100)[1])).toStartWith("✓ $");
  expect(ack.details.status).toBe("running");
  await h.emit("session_shutdown", { reason: "quit" });
  expect(view()).toContain("✓ $");
  expect(view()).toContain("finished");
  life.stop();
});

test("completion cards identify commands, use native semantic styling, and reveal details only when expanded", () => {
  const snapshot: Snapshot = { version: 1, id: "opaque-task-id", toolCallId: "call", command: "printf '\u001b[31m界\u001b[0m'\t\n" + "argument ".repeat(30) + "command-tail",
    startedAt: 1000, endedAt: 3500, status: "exited", exitCode: 0, background: true,
    output: "unique-output", bytes: 13, logBytes: 13, logPath: "/task/log", truncated: false };
  for (const [status, exitCode, marker, label] of [
    ["exited", 0, "✓", "exit 0"], ["exited", 7, "×", "exit 7"], ["timeout", null, "×", "timeout"],
    ["aborted", null, "-", "cancelled (aborted)"], ["killed", null, "-", "cancelled (killed)"],
  ] as const) {
    const current = { ...snapshot, status, exitCode };
    const card = completionCard(current, false, theme);
    const lines = card.render(120);
    const plain = lines.map(stripVTControlCharacters);
    expect(lines).toHaveLength(4);
    expect(plain[1].trim()).toStartWith(`${marker} $ printf '界' argument`);
    expect(visibleWidth(plain[1].trim())).toBeLessThanOrEqual(76);
    expect(plain[1]).toContain("...");
    expect(lines[1]).toContain(theme.fg("toolTitle", theme.bold(plain[1].trim().slice(2))));
    expect(plain[2]).toContain(`${label} · 2.5s · completion delivered`);
    // Both truncated lines retain their own styling and the card's background.
    const narrow = card.render(40);
    expect(narrow[1]).toContain(theme.fg("toolTitle", theme.bold(stripVTControlCharacters(narrow[1]).trim().slice(2))));
    expect(narrow[2]).toContain(theme.fg("muted", stripVTControlCharacters(narrow[2]).trim()));
    for (const line of [...lines, ...narrow]) expect(line).not.toContain("\u001b[0m");
    const text = plain.join("\n");
    expect(text).not.toContain(snapshot.id);
    expect(text).not.toContain(snapshot.output);
    expect(text).not.toContain("command-tail");
    const shortHeading = completionCard({ ...current, command: "printf ready" }, false, theme).render(120)[1];
    expect(shortHeading).toContain(theme.fg("toolTitle", theme.bold("$ printf ready")));
    expect(shortHeading).toContain(theme.fg(marker === "✓" ? "success" : marker === "-" ? "dim" : "error", marker));
    expect(lines[0]).toBe(theme.bg(status === "exited" && exitCode === 0 ? "toolSuccessBg" : "toolErrorBg", " ".repeat(120)));
    for (const expanded of [false, true]) for (const pad of [0, 1]) for (const width of [0, 1, 3, 12, 40, 80]) {
      expect(completionCard(current, expanded, theme, pad).render(width).every(line => visibleWidth(line) <= width)).toBe(true);
    }
  }
  const expanded = stripVTControlCharacters(completionCard(snapshot, true, theme).render(120).join("\n"));
  expect(expanded).toContain("command-tail");
  expect(expanded).toContain(snapshot.id);
  expect(expanded).toContain(snapshot.logPath);
  expect(expanded).toContain(snapshot.output);
});

test("live jobs survive reload without stale invalidators or duplicate delivery; reopened cards use branch snapshots", async () => {
  const first = harness();
  const args = { command: "sleep .18; printf reload-output", background: true };
  const ack = await first.execute("reload", args);
  let stale = 0;
  first.tool.renderCall(args, theme, first.row("reload", args, { invalidate: () => stale++ })).render(100);
  await first.emit("session_shutdown", { reason: "reload" });
  const next = harness(first);
  const context = next.row("reload", args);
  const card = next.tool.renderCall(args, theme, context);
  next.tool.renderResult(ack, {}, theme, context);
  expect(card.render(100).join("\n")).toContain("Elapsed");
  await next.notification;
  await delay(1100); // Reload must not leave either an invalidator or a native timer alive.
  expect(stale).toBe(0);
  expect(first.sent).toHaveLength(0);
  expect(next.sent).toHaveLength(1);
  await next.emit("session_shutdown", { reason: "quit" });
  const reopened = harness(next);
  const restoredContext = reopened.row("reload", args);
  const restored = reopened.tool.renderCall(args, theme, restoredContext);
  reopened.tool.renderResult(ack, {}, theme, restoredContext);
  expect(restored.render(100).join("\n")).toContain("reload-output");
  expect(restored.render(100).join("\n")).toContain("Took");
  expect(reopened.sent).toHaveLength(0);
  reopened.branch.length = 0;
  await reopened.emit("session_tree");
  const orphanContext = reopened.row("reload", args);
  const orphan = reopened.tool.renderCall(args, theme, orphanContext);
  reopened.tool.renderResult(ack, {}, theme, orphanContext);
  expect(orphan.render(100).join("\n")).toContain("unavailable");
  expect(orphan.render(100).join("\n")).not.toContain("running");
});

test("unowned error and historical results stay visible, and tree navigation does not contaminate its destination", async () => {
  const h = harness();
  const args = { command: "printf historical" };
  for (const isError of [false, true]) {
    const life = new Lifecycle();
    const component = new ToolExecutionComponent("bash", `unowned-${isError}`, args, { showImages: false },
      decorate(h.tool, life, "bash"), { requestRender() {} } as any, h.directory);
    const baseline = new ToolExecutionComponent("bash", `unowned-${isError}`, args, { showImages: false },
      decorate(createBashToolDefinition(h.directory), life, "bash"), { requestRender() {} } as any, h.directory);
    const result = { content: [{ type: "text" as const, text: isError ? "Invalid timeout" : "historical-output" }],
      details: { fullOutputPath: "/saved-output" }, isError, durationMs: 4100 };
    component.updateResult(result, false); baseline.updateResult(result, false);
    expect(component.render(80)).toEqual(baseline.render(80));
    const view = stripVTControlCharacters(component.render(80).join("\n"));
    expect(view).toContain(isError ? "Invalid timeout" : "historical-output");
    expect(view).toContain("Full output: /saved-output");
    life.stop();
  }
  const ack = await h.execute("abandoned", { command: "sleep 10", background: true });
  h.branch.length = 0; // Pi moves the active leaf before session_tree.
  await h.emit("session_tree");
  expect(h.branch).toEqual([]);
  expect(h.sent).toHaveLength(0);
  const context = h.row("abandoned", args);
  const card = h.tool.renderCall(args, theme, context);
  h.tool.renderResult(ack, {}, theme, context);
  expect(card.render(100).join("\n")).toContain("unavailable");
});

test("session replacement kills old jobs and does not notify the new session", async () => {
  const old = harness();
  await old.execute("old", { command: "sleep 10", background: true });
  await old.emit("session_shutdown", { reason: "new" });
  const fresh = harness();
  const result = await fresh.execute("fresh", { command: "printf fresh" });
  expect(result.details.output).toBe("fresh");
  expect(old.sent).toHaveLength(0);
  expect(fresh.sent).toHaveLength(0);
});

test("shell prefix, session environment, foreground errors, and manual promotion of parallel calls", async () => {
  const h = harness();
  const env = await h.execute("env", { command: "printf '%s|%s|%s|%s' \"$TEST_BACKGROUND_PREFIX\" \"$PI_SESSION_ID\" \"$PI_MODEL\" \"$PI_REASONING_LEVEL\"" });
  expect(env.details.output).toBe(`preserved|${h.id}|local|high`);
  const error = await h.execute("bad", { command: "printf failed; exit 3" });
  expect(error.isError).toBe(true);
  const pending = ["one", "two"].map(id => h.execute(id, { command: "sleep .15", timeout: 1 }));
  await h.shortcuts.get("ctrl+shift+b").handler(h.ctx);
  const acknowledgements = await Promise.all(pending);
  expect(acknowledgements.every(r => r.details.background && r.details.status === "running")).toBe(true);
  const updates: any[] = [];
  const foreground = await h.execute("fg", { command: "printf fg" }, (update: any) => updates.push(update));
  expect(foreground.details.output).toBe("fg");
  expect(updates).toHaveLength(1);
});
