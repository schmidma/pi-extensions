import { beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession, DefaultResourceLoader, SessionManager, SettingsManager, estimateTokens, initTheme,
  type Theme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as TuiKeys, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { AgentSessionSource, ColdSessionSource } from "../extensions/subagents/source.ts";
import { formatContextUsage } from "../extensions/subagents/context-usage.ts";
import { TranscriptInspector } from "../extensions/subagents/inspector.ts";
import { SubagentOverview } from "../extensions/subagents/overview.ts";
import { Coordinator } from "../extensions/subagents/coordinator.ts";
import { SubagentStore } from "../extensions/subagents/store.ts";
import type { SubagentRecord, SubagentState } from "../extensions/subagents/state.ts";

beforeAll(() => initTheme("dark", false));
const model = { id: "physical", provider: "fixture", api: "openai-completions", contextWindow: 1000, maxTokens: 100,
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as any;
function assistant(totalTokens = 421, stopReason = "stop") {
  return { role: "assistant", content: [{ type: "text", text: "response" }], api: model.api, model: model.id, provider: model.provider,
    stopReason, timestamp: 2, usage: { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any;
}
function fixture() {
  const manager = SessionManager.inMemory("/tmp");
  const agent = new Agent({ initialState: { model } });
  const session = new AgentSession({ agent, sessionManager: manager, cwd: "/tmp",
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    resourceLoader: new DefaultResourceLoader({ cwd: "/tmp", agentDir: "/tmp" }), initialActiveToolNames: [] } as any);
  const source = new AgentSessionSource(session);
  const cold = () => new ColdSessionSource("/tmp", [manager.getHeader()!, ...manager.getEntries()], model.contextWindow);
  return { manager, session, source, cold, dispose() { source.dispose(); session.dispose(); } };
}

test("cold usage matches native projection across edits, compaction unknown/recovery, invalid usage and branches", () => {
  const f = fixture();
  const parity = () => expect(f.cold().getContextUsage()).toEqual(f.session.getContextUsage());
  try {
    parity(); expect(formatContextUsage(f.cold().getContextUsage())).toBe("0.0%");
    const user = f.manager.appendMessage({ role: "user", content: "request", timestamp: 1 });
    const response = f.manager.appendMessage(assistant());
    parity(); expect(formatContextUsage(f.cold().getContextUsage())).toBe("42.1%");
    f.manager.appendMessage({ role: "user", content: "next request", timestamp: 3 }); parity();
    f.manager.appendContextEdit(user, { role: "user", content: "edited", timestamp: 1 });
    parity(); expect(f.cold().getContextUsage()!.tokens).toBeLessThan(421);
    f.manager.appendMessage(assistant(1200, "length")); parity();
    expect(formatContextUsage(f.cold().getContextUsage())).toBe("120.0%");
    f.manager.appendCompaction("summary", response, 1200);
    parity(); expect(f.cold().getContextUsage()!.tokens).toBeNull(); // retained older usage does not qualify
    for (const [tokens, reason] of [[421, "error"], [421, "aborted"], [0, "stop"]] as const) {
      f.manager.appendMessage(assistant(tokens, reason)); parity();
      expect(f.cold().getContextUsage()!.percent).toBeNull();
    }
    f.manager.appendMessage(assistant(250)); parity(); expect(f.cold().getContextUsage()!.percent).toBe(25);
    f.manager.branch(response);
    f.manager.appendCustomEntry("branch-selected", {}); // Persist a last entry on the selected branch.
    parity(); expect(f.cold().getContextUsage()!.percent).toBe(42.1);
  } finally { f.dispose(); }
});

test("invalid usage without compaction estimates current content rather than trusting provider totals", () => {
  const f = fixture();
  try {
    for (const reason of ["error", "aborted", "stop"]) {
      const message = assistant(reason === "stop" ? 0 : 900, reason);
      f.manager.appendMessage(message);
    }
    expect(f.cold().getContextUsage()).toEqual(f.session.getContextUsage());
    expect(f.cold().getContextUsage()!.tokens).toBe(f.manager.buildSessionProjection().messages.reduce((n, message) => n + estimateTokens(message), 0));
    expect(new ColdSessionSource("/tmp", [f.manager.getHeader()!, ...f.manager.getEntries()], undefined).getContextUsage()).toBeUndefined();
  } finally { f.dispose(); }
});

const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text } as Theme;
const keys = new TuiKeys(TUI_KEYBINDINGS) as KeybindingsManager;
const record: SubagentRecord = { id: "child", parentId: "root", name: "A very long child name", model: "fixture/physical",
  requestedThinking: "off", effectiveThinking: "off", cwd: "/tmp", projectTrusted: false, generation: 1, sessionId: "", sessionFile: "" };

test("both surfaces reserve context metadata, update after commit/compaction, and cache native scans between draws", async () => {
  const f = fixture();
  let renders = 0;
  const ui = { terminal: { rows: 32 }, requestRender() { renders++; } } as TUI;
  const state: SubagentState = { version: 3, rootKey: "root", subagents: { child: record }, runs: {
    run: { id: "run", agentId: "child", parentId: "root", parentRunId: null, receiverRunId: null, phase: "terminal", generation: 1,
      prompt: "task", boundary: null, startedAt: "2026-01-01", endedAt: "2026-01-02", delivered: false, outcome: { status: "completed", text: "response" } },
  } };
  const tree = new SubagentOverview({ snapshot: () => state, subscribe: listener => f.source.subscribe(() => listener()),
    getContextUsage: () => f.source.getContextUsage() }, ui, theme);
  const view = new TranscriptInspector(f.source, ui, theme, keys, "/tmp", () => {}, undefined,
    "Subagent long title and role ".repeat(10) + "(read-only, images disabled)");
  const usage = spyOn(f.session, "getContextUsage");
  try {
    f.manager.appendMessage(assistant());
    for (let i = 0; i < 20; i++) {
      expect(tree.render(48).join("\n")).toContain(" · 42.1%");
      expect(view.render(24)[0]).toEndWith(" · 42.1%");
      expect(view.render(6)[0]).toBe("42.1%");
    }
    expect(usage).toHaveBeenCalledTimes(1);
    expect(tree.render(48).join("\n")).not.toContain("thinking:");
    tree.focused = true;
    expect(tree.renderFocusedSelection(24)[0]).toContain(" · 42.1%");
    expect(tree.renderFocusedSelection(24)[0]).toContain("1/1");
    const before = renders;
    const message = assistant(600);
    let gapUsage: number | null | undefined;
    const unbind = f.source.subscribe(update => {
      if (update.type === "message") gapUsage = f.source.getContextUsage()?.percent;
    });
    await (f.session as any)._handleAgentEvent({ type: "message_end", message });
    unbind();
    expect(gapUsage).toBe(42.1);
    // message_end observers render before persistence; the next committed boundary refreshes chrome.
    await (f.session as any)._handleAgentEvent({ type: "agent_end", messages: [message] });
    expect(renders).toBeGreaterThan(before);
    expect(view.render(60)[0]).toEndWith(" · 60.0%");
    expect(tree.render(48).join("\n")).toContain(" · 60.0%");
    f.manager.appendCompaction("summary", f.manager.getLeafId(), 600);
    const committed = renders;
    (f.session as any)._emit({ type: "compaction_end", reason: "manual", result: {}, aborted: false, willRetry: false });
    expect(renders).toBeGreaterThan(committed);
    expect(view.render(60)[0]).toEndWith(" · ?%");
    expect(tree.render(48).join("\n")).toContain(" · ?%");
    for (const width of [8, 24, 48, 120]) {
      expect(view.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
      expect(tree.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
    }
  } finally { usage.mockRestore(); tree.dispose(); view.dispose(); f.dispose(); }
});

test("cold coordinator metadata is read-only, cached, refreshed on opening and current exact-model window changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-context-"));
  const manager = SessionManager.inMemory(directory);
  manager.appendMessage(assistant());
  const sessionFile = join(directory, "child.jsonl");
  const bytes = [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(sessionFile, bytes);
  const child = { ...record, cwd: directory, sessionFile, sessionId: manager.getSessionId() };
  let creates = 0;
  const factory = { models: [{ model }], create: async () => { creates++; throw new Error("inspection must not create a runtime"); } };
  const store = new SubagentStore(directory, "root");
  const service = new Coordinator(store, factory);
  store.state.subagents.child = child;
  const projection = spyOn(SessionManager.prototype, "buildSessionProjection");
  try {
    expect(service.getContextUsage("child")!.percent).toBe(42.1);
    for (let i = 0; i < 20; i++) expect(service.getContextUsage("child")!.percent).toBe(42.1);
    expect(projection).toHaveBeenCalledTimes(1);
    const first = service.createColdSource("child")!;
    expect(first.getContextUsage()).toEqual(service.getContextUsage("child"));
    expect(projection).toHaveBeenCalledTimes(2);
    // Rendering no longer depends on the file; each viewer independently refreshes it.
    manager.appendMessage({ ...assistant(600), content: [{ type: "text", text: "newer response" }] });
    const updated = [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(sessionFile, updated);
    expect(service.getContextUsage("child")!.percent).toBe(42.1);
    const second = service.createColdSource("child")!;
    expect(second).not.toBe(first);
    expect(second.getContextUsage()!.percent).toBe(60);
    expect(first.getContextUsage()!.percent).toBe(42.1);
    const ui = { terminal: { rows: 32 }, requestRender() {} } as TUI;
    const earlierView = new TranscriptInspector(first, ui, theme, keys, directory, () => {});
    const refreshedView = new TranscriptInspector(second, ui, theme, keys, directory, () => {});
    try {
      expect(earlierView.render(100)[0]).toEndWith(" · 42.1%");
      expect(earlierView.render(100).join("\n")).not.toContain("newer response");
      expect(refreshedView.render(100)[0]).toEndWith(" · 60.0%");
      expect(refreshedView.render(100).join("\n")).toContain("newer response");
    } finally { earlierView.dispose(); refreshedView.dispose(); }
    for (let i = 0; i < 20; i++) expect(service.getContextUsage("child")!.percent).toBe(60);
    expect(projection).toHaveBeenCalledTimes(3); // Opening refreshes the menu cache with the same projection.
    service.updateFactory({ ...factory, models: [{ model: { ...model, contextWindow: 2000 } }] });
    expect(service.getContextUsage("child")!.percent).toBe(30);
    service.updateFactory({ ...factory, models: [{ model: { ...model, id: "root-only", contextWindow: 5000 } }] });
    expect(service.getContextUsage("child")).toBeUndefined();
    expect(readFileSync(sessionFile, "utf8")).toBe(updated);
    expect(creates).toBe(0);
    expect(formatContextUsage(undefined)).toBe("?%");
    expect(formatContextUsage({ tokens: null, contextWindow: 1000, percent: null })).toBe("?%");
  } finally { projection.mockRestore(); await service.shutdown(); rmSync(directory, { recursive: true, force: true }); }
});
