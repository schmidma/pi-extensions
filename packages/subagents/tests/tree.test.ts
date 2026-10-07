import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomEditor, CustomMessageComponent, initTheme, SessionManager, type ExtensionAPI, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as TuiKeys, TuiMainScreen, type TUI, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { agentTree, displayStatus, type TreeSource } from "../extensions/subagents/tree.ts";
import { SubagentOverview } from "../extensions/subagents/overview.ts";
import { REPORT_TYPE, reportText, type OutcomeStatus, type RunRecord, type SubagentRecord, type SubagentState } from "../extensions/subagents/state.ts";
import subagents from "../extensions/subagents/index.ts";
import { processServices, type Coordinator } from "../extensions/subagents/coordinator.ts";
import { ModelConfiguration } from "../extensions/subagents/configuration.ts";
import { NativeChildFactory } from "../extensions/subagents/runner.ts";
import { rootIdentity } from "../extensions/subagents/store.ts";
import { TranscriptInspector } from "../extensions/subagents/inspector.ts";
import { CurrentSessionSource } from "../extensions/subagents/source.ts";

beforeAll(() => initTheme("dark", false));
const theme = { fg: (_token: string, value: string) => value, bold: (value: string) => value, getBgAnsi: () => "", style: (value: string) => value } as Theme;
const plain = (text: string) => text;
const editorTheme = { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } };
const keys = new TuiKeys(TUI_KEYBINDINGS) as KeybindingsManager;
const record = (id: string, parentId = "root", name = "Review authentication"): SubagentRecord => ({
  id, parentId, name, model: "fixture/model", requestedThinking: "high", effectiveThinking: "low",
  generation: 1, cwd: "/tmp", projectTrusted: false, sessionFile: "", sessionId: "",
});
const state = (...records: SubagentRecord[]): SubagentState => ({ version: 3, rootKey: "root",
  subagents: Object.fromEntries(records.map(value => [value.id, value])), runs: {} });
function run(owner: SubagentRecord, phase: RunRecord["phase"], status?: OutcomeStatus, generation = 1): RunRecord {
  return { id: `run-${owner.id}-${generation}`, agentId: owner.id, parentId: owner.parentId,
    parentRunId: null, receiverRunId: null, phase, generation, prompt: "task", boundary: null,
    startedAt: "2026-01-01", delivered: false, ...(status ? { endedAt: "2026-01-02", outcome: { status, text: "" } } : {}) };
}
class Fixture implements TreeSource {
  listeners = new Set<() => void>();
  unsubscriptions = 0;
  constructor(public state: SubagentState) {}
  snapshot() { return structuredClone(this.state); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.unsubscriptions++; this.listeners.delete(listener); }; }
  change() { for (const listener of this.listeners) listener(); }
}
function history(source: Fixture) {
  for (const owner of Object.values(source.state.subagents)) {
    const completed = run(owner, "terminal", "completed"); source.state.runs[completed.id] = completed;
  }
}
function tree(source: Fixture, initialRows = 32) {
  let rows = initialRows, renders = 0;
  const selected: (string | undefined)[] = [];
  const ui = { terminal: { get rows() { return rows; } }, requestRender() { renders++; } } as TUI;
  const view = new SubagentOverview(source, ui, theme, { keys, inspect: id => selected.push(id), leave: () => { view.focused = false; selected.push(undefined); } });
  view.focused = true;
  return { view, selected, resize: (value: number) => { rows = value; }, renders: () => renders };
}

test("stable depth-first registry order includes three levels, siblings and completed nodes", () => {
  const snapshot = state(record("a"), record("b"), record("aa", "a"), record("ab", "a"), record("aaa", "aa"));
  const terminal = run(snapshot.subagents.aa, "terminal", "completed"); snapshot.runs[terminal.id] = terminal;
  expect(agentTree(snapshot).map(node => [node.record.id, node.depth, node.status])).toEqual([
    ["a", 0, "finished"], ["aa", 1, "finished"], ["aaa", 2, "finished"], ["ab", 1, "finished"], ["b", 0, "finished"],
  ]);
});
test("branch connectors distinguish siblings and continue ancestors without joining root rows", () => {
  const source = new Fixture(state(record("a", "root", "Root"), record("b", "root", "Other"),
    record("first", "a", "First"), record("last", "a", "Last"), record("inner", "first", "Inner"),
    record("leaf", "inner", "Leaf"), record("other-child", "b", "Other child"))); history(source);
  const { view } = tree(source); view.focused = false;
  try {
    expect(view.render(200).slice(1).map(line => line.split(" [")[0])).toEqual([
      "  ✓ Root", "    ├─ ✓ First", "    │ └─ ✓ Inner", "    │   └─ ✓ Leaf",
      "    └─ ✓ Last", "  ✓ Other", "    └─ ✓ Other child",
    ]);
    source.state.subagents.next = record("next", "a", "Next");
    view.focused = true; view.handleInput("\t"); view.focused = false; source.change();
    const updated = view.render(200).join("\n");
    expect(updated).toContain("    ├─ ✓ Last");
    expect(updated).toContain("    └─ ✓ Next");
    expect(updated).not.toContain("╰");
  } finally { view.dispose(); }
});
test("Relevant connectors ignore hidden siblings and All restores their continuation lines", () => {
  const source = new Fixture(state(record("a", "root", "Root"), record("first", "a", "First"),
    record("last", "a", "Last"), record("leaf", "first", "Leaf"))); history(source);
  const latest = run(source.state.subagents.leaf, "terminal", "completed", 2);
  latest.startedAt = "2026-02-01"; latest.endedAt = "2026-02-02"; source.state.runs[latest.id] = latest;
  const { view } = tree(source); view.focused = false;
  view.setAcknowledgedRuns(new Set(Object.keys(source.state.runs).filter(id => id !== latest.id)));
  try {
    let output = view.render(200).join("\n");
    expect(output).toContain("    └─ ✓ First");
    expect(output).toContain("      └─ ✓ Leaf");
    expect(output).not.toContain("│"); expect(output).not.toContain("Last");
    view.focused = true; view.handleInput("\t"); view.focused = false;
    output = view.render(200).join("\n");
    expect(output).toContain("    ├─ ✓ First");
    expect(output).toContain("    │ └─ ✓ Leaf");
    expect(output).toContain("    └─ ✓ Last");
  } finally { view.dispose(); }
});
test("scrolling keeps offscreen sibling continuations and all connector strokes dim", () => {
  const source = new Fixture(state(record("a", "root", "Root"), record("first", "a", "First"),
    record("last", "a", "Last"), ...Array.from({ length: 8 }, (_, i) => record(`leaf-${i}`, "first", `Leaf ${i}`)))); history(source);
  const { view } = tree(source);
  try {
    view.render(200); view.handleInput("\x1b[F"); view.handleInput("\x1b[A");
    const lines = view.render(200);
    expect(lines.join("\n")).toContain("↑ 5 above");
    expect(lines.some(line => line.slice(2).startsWith("  │ ├─ ✓ Leaf 3"))).toBe(true);
    expect(lines.some(line => line.slice(2).startsWith("  │ └─ ✓ Leaf 7"))).toBe(true);
    expect(lines.some(line => line.slice(2).startsWith("  └─ ✓ Last"))).toBe(true);
    view.handleInput("\x1b[H");
    expect(view.render(200).join("\n")).toContain("    ├─ ✓ First");
  } finally { view.dispose(); }
  const strokes: string[] = [];
  const themed = new SubagentOverview(source, { requestRender() {}, terminal: { rows: 32 } } as TUI,
    { ...theme, fg: (token: string, value: string) => { if (/[│├└]/.test(value)) strokes.push(token); return value; } } as Theme);
  try {
    themed.render(200);
    expect(strokes.length).toBeGreaterThan(0); expect(strokes.every(token => token === "dim")).toBe(true);
  } finally { themed.dispose(); }
});
test("state derives current running/waiting or latest terminal outcome, not generic finished", () => {
  for (const status of ["completed", "error", "aborted", "interrupted"] as const) {
    const owner = record(status), snapshot = state(owner);
    const previous = run(owner, "terminal", "completed"), latest = run(owner, "terminal", status, 2);
    snapshot.runs = { [latest.id]: latest, [previous.id]: previous }; owner.currentRun = previous.id;
    expect(displayStatus(snapshot, owner)).toBe(status === "completed" ? "finished" : status);
    expect(agentTree(snapshot)[0].run).toBe(latest);
    for (const phase of ["running", "waiting"] as const) {
      const current = run(owner, phase, undefined, 3); snapshot.runs[current.id] = current; owner.currentRun = current.id;
      expect(displayStatus(snapshot, owner)).toBe(phase);
      expect(agentTree(snapshot)[0].run).toBe(current);
    }
  }
});
test("malformed orphan and cyclic components remain finite and inspectable without recursion", () => {
  const snapshot = state(record("a"), record("orphan", "missing"), record("loop-a", "loop-b"), record("loop-b", "loop-a"), record("self", "self"));
  expect(agentTree(snapshot).map(node => node.record.id)).toEqual(["a", "orphan", "loop-a", "loop-b", "self"]);
  const deep = state(...Array.from({ length: 10000 }, (_, i) => record(`deep-${i}`, i ? `deep-${i - 1}` : "root")));
  expect(agentTree(deep).at(-1)?.depth).toBe(9999);
});
test("live grandchild and status preserve stable selected duplicate; inspecting does not unsubscribe inline tree", () => {
  const source = new Fixture(state(record("first"), record("second"), record("child", "first"))); history(source);
  const { view, selected } = tree(source);
  view.handleInput("\x1b[F"); expect(view.getSelectedAgentId()).toBe("second");
  source.state.subagents.grandchild = record("grandchild", "child");
  const waiting = run(source.state.subagents.second, "waiting", undefined, 2);
  source.state.subagents.second.currentRun = waiting.id; source.state.runs[waiting.id] = waiting; source.change();
  expect(view.getSelectedAgentId()).toBe("second");
  expect(view.render(180).join("\n")).toContain("waiting");
  view.handleInput("\t"); expect(view.render(180).join("\n")).toContain("grandchild");
  view.handleInput("\r"); expect(selected).toEqual(["second"]); expect(source.listeners.size).toBe(1);
  view.dispose(); view.dispose(); expect(source.unsubscriptions).toBe(1);
});
test("native Up/Down clamp, Home/End/page selection, Escape returns prompt without disposing live tree", () => {
  const source = new Fixture(state(...Array.from({ length: 20 }, (_, i) => record(`id-${i}`)))); history(source);
  const { view, selected } = tree(source); view.render(120);
  for (let i = 0; i < 3; i++) view.handleInput("\x1b[A");
  expect(view.getSelectedAgentId()).toBe("id-0");
  view.handleInput("\x1b[6~"); expect(view.getSelectedAgentId()).toBe("id-6");
  view.handleInput("\x1b[5~"); expect(view.getSelectedAgentId()).toBe("id-0");
  view.handleInput("\x1b[F"); expect(view.getSelectedAgentId()).toBe("id-19");
  for (let i = 0; i < 3; i++) { view.handleInput("\x1b[B"); view.handleInput("\x1b[6~"); }
  expect(view.getSelectedAgentId()).toBe("id-19");
  view.handleInput("\x1b[H");
  for (let i = 0; i < 3; i++) view.handleInput("\x1b[5~");
  expect(view.getSelectedAgentId()).toBe("id-0");
  view.handleInput("\x1b"); view.handleInput("\r"); expect(selected).toEqual([undefined]);
  expect(source.listeners.size).toBe(1); view.dispose(); expect(source.listeners.size).toBe(0);
});
test("configured selection keys clamp and confirm, with physical Right inspection and Left exit", () => {
  const source = new Fixture(state(record("first"), record("last"))); history(source);
  const rebound = new TuiKeys(TUI_KEYBINDINGS, { "tui.select.up": "k", "tui.select.down": "j", "tui.select.confirm": "x" }) as KeybindingsManager;
  const inspected: string[] = [], forwarded: (string | undefined)[] = [];
  const view = new SubagentOverview(source, { terminal: { rows: 32 }, requestRender() {} } as TUI, theme,
    { keys: rebound, inspect: id => inspected.push(id), leave: data => forwarded.push(data) });
  view.focused = true;
  try {
    for (let i = 0; i < 3; i++) view.handleInput("k");
    expect(view.getSelectedAgentId()).toBe("first");
    for (let i = 0; i < 3; i++) view.handleInput("j");
    expect(view.getSelectedAgentId()).toBe("last");
    view.handleInput("x"); view.handleInput("\x1b[1;1C");
    expect(inspected).toEqual(["last", "last"]); expect(forwarded).toEqual([]);
    view.handleInput("\x1b[D"); expect(forwarded).toEqual([undefined]);
  } finally { view.dispose(); }
});
test("one item and empty menu safely clamp every navigation key", () => {
  for (const count of [0, 1]) {
    const source = new Fixture(state(...(count ? [record("only")] : []))); history(source);
    const { view, selected } = tree(source);
    try {
      for (let i = 0; i < 3; i++) for (const key of ["\x1b[A", "\x1b[B", "\x1b[H", "\x1b[F", "\x1b[5~", "\x1b[6~"]) view.handleInput(key);
      expect(view.getSelectedAgentId()).toBe(count ? "only" : undefined);
      view.handleInput("\x1b[C"); expect(selected).toEqual(count ? ["only"] : []);
    } finally { view.dispose(); }
  }
});
test("Relevant retains latest outcomes; All reveals history without execution; mode/selection survive updates and resize", () => {
  const source = new Fixture(state(...Array.from({ length: 100 }, (_, i) => record(`stable-${i}`, "root", `Wide 界 task ${i}`)))); history(source);
  const latest = run(source.state.subagents["stable-78"], "waiting", undefined, 2); latest.startedAt = "2026-02-01";
  source.state.runs[latest.id] = latest; source.state.subagents["stable-78"].currentRun = latest.id;
  const { view, resize } = tree(source);
  view.setAcknowledgedRuns(new Set(Object.keys(source.state.runs).filter(id => id !== latest.id)));
  expect(view.getMode()).toBe("Relevant"); expect(view.getSelectedAgentId()).toBe("stable-78");
  expect(view.render(180).join("\n")).not.toContain("stable-0");
  view.handleInput("\t"); expect(view.getMode()).toBe("All"); expect(view.getSelectedAgentId()).toBe("stable-78");
  for (const [rows, width] of [[32, 100], [8, 40], [6, 18], [3, 5], [1, 1], [30, 120]]) {
    resize(rows); const lines = view.render(width);
    expect(lines.length).toBeLessThanOrEqual(Math.min(8, rows)); expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
    expect(view.getSelectedAgentId()).toBe("stable-78");
  }
  resize(32); expect(view.render(180).join("\n")).toContain("› ◷ Wide 界 task 78");
  view.handleInput("\x1b[H"); expect(view.getSelectedAgentId()).toBe("stable-0");
  view.handleInput("\t"); expect(view.getSelectedAgentId()).toBe("stable-78");
  latest.phase = "terminal"; latest.endedAt = "2026-02-02"; latest.outcome = { status: "error", text: "failed" }; source.change();
  expect(view.render(160).join("\n")).toContain("error");
  view.setAcknowledgedRuns(new Set(Object.keys(source.state.runs)));
  const next = run(source.state.subagents["stable-3"], "waiting", undefined, 3); next.startedAt = "2026-03-01";
  source.state.runs[next.id] = next; source.state.subagents["stable-3"].currentRun = next.id; source.change();
  expect(view.getSelectedAgentId()).toBe("stable-3"); view.dispose();
});
test("one-line focused tree shows the selected identity through navigation and resize", () => {
  const source = new Fixture(state(record("first", "root", "First agent"), record("second", "root", "Second agent"))); history(source);
  const { view, resize, selected } = tree(source);
  for (const rows of [7, 6, 3, 1]) {
    resize(rows); view.handleInput("\x1b[H");
    let lines = view.render(120);
    expect(lines).toHaveLength(1); expect(lines[0]).toContain("First agent"); expect(lines[0]).toContain("1/2");
    expect(lines[0]).not.toContain("Relevant"); expect(lines[0]).not.toContain("[All]");
    view.handleInput("\x1b[B"); lines = view.render(120);
    expect(lines).toHaveLength(1); expect(lines[0]).toContain("Second agent"); expect(lines[0]).toContain("[second]");
    expect(lines[0]).toContain("✓ Second agent [second]"); expect(lines[0]).not.toContain("finished");
    expect(lines[0]).toContain("2/2"); expect(lines[0]).not.toContain("First agent");
    view.handleInput("\r"); expect(selected.at(-1)).toBe("second");
    view.handleInput("\x1b[5~"); expect(view.getSelectedAgentId()).toBe("first");
  }
  resize(32); view.handleInput("\x1b[B"); expect(view.render(120).join("\n")).toContain("› ✓ Second agent");
  resize(7); view.handleInput("\t"); expect(view.render(120)[0]).toContain("Second agent"); expect(view.render(120)[0]).toContain("[All]");
  for (const width of [1, 2, 8, 40]) expect(visibleWidth(view.render(width)[0])).toBeLessThanOrEqual(width);
  view.handleInput("\x1b"); expect(view.render(120)[0]).toContain("Second agent"); view.dispose();
});

test("empty tree, control safety, theme invalidation and tiny view remain bounded", () => {
  const source = new Fixture(state()); const { view, resize } = tree(source);
  expect(view.render(80)).toEqual([]);
  source.state.subagents.unsafe = { ...record("unsafe"), name: "bad\x1b]52;escape\x07name", model: "model\nnext\x1b_Gpayload" };
  history(source); source.change();
  const safe = view.render(80).join("\n"); expect(safe).not.toContain("\x1b"); expect(safe).not.toContain("\x07");
  let color = "dark";
  const themed = new SubagentOverview(source, { requestRender() {}, terminal: { rows: 32 } } as TUI,
    { ...theme, fg: (_token: string, value: string) => `${color}:${value}` } as Theme);
  expect(themed.render(100).join("\n")).toContain("dark:"); color = "light"; themed.invalidate();
  expect(themed.render(100).join("\n")).toContain("light:"); expect(themed.render(100).join("\n")).not.toContain("dark:");
  resize(3); view.invalidate(); expect(view.render(4).length).toBeLessThanOrEqual(3); view.dispose(); themed.dispose();
});

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function commandFixture(cold = false) {
  const directory = mkdtempSync(join(tmpdir(), "pi-tree-ui-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const manager = SessionManager.create(directory, join(directory, "root")); manager.appendMessage({ role: "user", content: "saved main", timestamp: 1 });
  const key = rootIdentity(manager);
  const child = SessionManager.create(directory, join(directory, "child")); child.appendMessage({ role: "user", content: "NESTED SESSION ONLY", timestamp: 2 });
  const parent = record("parent", key), nested = { ...record("nested", "parent"), cwd: directory, sessionId: child.getSessionId(), sessionFile: child.getSessionFile()! };
  const snapshot = state(parent, nested); snapshot.rootKey = key;
  const source = new CurrentSessionSource(() => ({ sessionManager: child })); cleanup.push(() => source.dispose());
  const fixture = new Fixture(snapshot); history(fixture);
  const service = Object.assign(fixture, {
    store: { rootKey: key, state: snapshot }, attach() {}, detach() {}, async shutdown() {},
    get records() { return Object.values(fixture.state.subagents); }, runtime(id: string) { return !cold && id === "nested" ? { source } : undefined; },
  });
  processServices().set(key, service as unknown as Coordinator); cleanup.push(() => { processServices().delete(key); });
  const configuration = spyOn(ModelConfiguration.prototype, "resolve").mockResolvedValue({ runtime: {} as any, models: [] });
  const create = spyOn(NativeChildFactory.prototype, "create").mockImplementation(() => { throw new Error("Viewing must never create a runtime"); });
  cleanup.push(() => { configuration.mockRestore(); create.mockRestore(); });
  const commands = new Map<string, any>(), handlers = new Map<string, Function[]>(), renderers = new Map<string, any>();
  const pi = { registerCommand(name: string, command: any) { commands.set(name, command); }, registerTool() {},
    registerMessageRenderer(type: string, renderer: any) { renderers.set(type, renderer); },
    on(name: string, handler: Function) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => {}; } } as unknown as ExtensionAPI;
  subagents(pi);
  const views: TranscriptInspector[] = [];
  const tui = new TuiMainScreen({ rows: 32, columns: 120, hideCursor() {} } as any); let renders = 0;
  tui.requestRender = () => { renders++; };
  let editor: CustomEditor, factory: Function | undefined, widget: SubagentOverview | undefined;
  const ctx = { mode: "tui", sessionManager: manager, cwd: directory, isIdle: () => false, hasPendingMessages: () => false,
    ui: { notify() {}, getEditorComponent: () => factory, setEditorComponent(next: Function | undefined) {
      factory = next; editor = next ? next(tui, editorTheme, keys) : new CustomEditor(tui, editorTheme, keys); tui.setFocus(editor);
    }, setWidget(_name: string, next: Function | undefined) { widget?.dispose(); widget = next?.(tui, theme); },
    custom(make: Function) { return new Promise(resolve => {
      const view = make(tui, theme, keys, () => { handle.hide(); resolve(undefined); });
      const handle = tui.showOverlay(view); views.push(view); view.render(120);
    }); } } };
  const emit = async (name: string, event: object) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  await emit("session_start", {}); configuration.mockClear();
  cleanup.push(() => { void emit("session_shutdown", { reason: "reload" }); });
  return { fixture, source, child, ctx, views, commands, renderers, create, configuration, renders: () => renders, emit,
    get widget() { return widget!; }, get editor() { return editor!; },
    async view(index: number) { for (let attempt = 0; attempt < 20 && !views[index]; attempt++) await tick(); expect(views[index]).toBeDefined(); return views[index]; } };
}
for (const cold of [false, true]) test(`same inline tree -> nested ${cold ? "cold" : "live"} inspector -> same ID/mode/focus, no picker overlay`, async () => {
  const f = await commandFixture(cold); const original = f.widget, editor = f.editor;
  editor.handleInput("draft"); editor.handleInput("\x01");
  await f.commands.get("subagents").handler("", f.ctx);
  expect(original.focused).toBe(true); expect(editor.focused).toBe(false); expect(f.views).toHaveLength(0);
  original.handleInput("\t"); original.handleInput("\x1b[B"); expect(original.getSelectedAgentId()).toBe("nested"); original.handleInput("\x1b[C");
  const inspector = await f.view(0); expect(inspector).toBeInstanceOf(TranscriptInspector);
  expect(inspector.render(120).join("\n")).toContain("NESTED SESSION ONLY"); expect(f.fixture.listeners.size).toBe(1);
  inspector.handleInput("\x1b[C"); expect(original.focused).toBe(false);
  inspector.handleInput("\x1b[D"); inspector.handleInput("\x1b[D"); await tick();
  expect(f.widget).toBe(original); expect(original.focused).toBe(true); expect(original.getMode()).toBe("All"); expect(original.getSelectedAgentId()).toBe("nested");
  expect(editor.getText()).toBe("draft"); expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
  original.handleInput("\x1b[D"); expect(editor.focused).toBe(true); expect(f.fixture.listeners.size).toBe(1);
  expect(editor.getText()).toBe("draft"); expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
  expect(original.getMode()).toBe("Relevant"); expect(original.getSelectedAgentId()).toBe("parent");
  editor.handleInput("\x1b[D"); expect(original.focused).toBe(true); expect(original.getSelectedAgentId()).toBe("parent");
  expect(original.getMode()).toBe("Relevant"); expect(original.render(120)[0]).not.toContain("[All]");
  expect(f.views).toHaveLength(1); expect(f.create).not.toHaveBeenCalled(); expect(f.configuration).not.toHaveBeenCalled();
});
test("root registered reports use the exact historical run by readonly store lookup after attachment", async () => {
  const f = await commandFixture(), saved = f.fixture.state.subagents.nested;
  const first = Object.values(f.fixture.state.runs).find(run => run.agentId === saved.id)!;
  first.startedAt = "2026-01-01T00:00:00Z"; first.endedAt = "2026-01-01T00:01:03.400Z";
  const current = run(saved, "waiting", undefined, 2); f.fixture.state.runs[current.id] = current; saved.currentRun = current.id;
  const message = { role: "custom" as const, customType: REPORT_TYPE, content: reportText(saved, first), display: true, timestamp: 1,
    details: { agentId: saved.id, runId: first.id, outcome: "completed" } };
  const bytes = JSON.stringify({ message, state: f.fixture.state });
  const snapshot = spyOn(f.fixture, "snapshot").mockImplementation(() => { throw new Error("No whole-state cloning during report draw"); });
  try {
    const component = new CustomMessageComponent(message, f.renderers.get(REPORT_TYPE));
    for (const expanded of [false, true]) {
      component.setExpanded(expanded);
      expect(component.render(160).join("\n")).toContain("63.4s");
    }
    expect(snapshot).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); expect(f.configuration).not.toHaveBeenCalled();
    expect(JSON.stringify({ message, state: f.fixture.state })).toBe(bytes);
  } finally { snapshot.mockRestore(); }
});

for (const preview of [false, true]) test(`${preview ? "root preview" : "cold direct inspection"} fallback reports use readonly run lookup, without activating child sessions`, async () => {
  const f = await commandFixture(true), saved = f.fixture.state.subagents.nested;
  const historical = Object.values(f.fixture.state.runs).find(run => run.agentId === saved.id)!;
  historical.startedAt = "2026-01-01T00:00:00Z"; historical.endedAt = "2026-01-01T00:01:03.400Z";
  const content = reportText(saved, historical), details = { agentId: saved.id, runId: historical.id, outcome: "completed" };
  const manager = preview ? f.ctx.sessionManager : f.child;
  manager.appendCustomMessageEntry(REPORT_TYPE, content, true, details);
  const before = JSON.stringify(manager.getEntries());
  const opened = preview ? f.commands.get("subagents-preview").handler("", f.ctx) : f.commands.get("subagents").handler(saved.id, f.ctx);
  const inspector = await f.view(0);
  expect(inspector.render(160).join("\n")).toContain("63.4s");
  inspector.handleInput("\x1b[D"); await opened;
  expect(f.editor.focused).toBe(true);
  expect(JSON.stringify(manager.getEntries())).toBe(before); expect(f.create).not.toHaveBeenCalled(); expect(f.configuration).not.toHaveBeenCalled();
});

test("direct ID Left returns to prompt, and commands/preview cannot overlap inspection", async () => {
  const f = await commandFixture(true);
  f.editor.setText("draft"); f.editor.handleInput("\x01");
  await f.commands.get("subagents").handler("", f.ctx);
  f.widget.handleInput("\t"); f.widget.handleInput("\x1b[F");
  expect(f.widget.getMode()).toBe("All"); expect(f.widget.getSelectedAgentId()).toBe("nested");
  const opened = f.commands.get("subagents").handler("nested", f.ctx); const inspector = await f.view(0);
  await f.commands.get("subagents").handler("", f.ctx); await f.commands.get("subagents-preview").handler("", f.ctx);
  expect(f.views).toHaveLength(1); inspector.handleInput("\x1b[1;1D"); await opened;
  expect(f.editor.focused).toBe(true); expect(f.widget.focused).toBe(false); expect(f.configuration).not.toHaveBeenCalled();
  expect(f.editor.getText()).toBe("draft"); expect(f.editor.getCursor()).toEqual({ line: 0, col: 0 });
  expect(f.widget.getMode()).toBe("Relevant"); expect(f.widget.getSelectedAgentId()).toBe("parent");
});
for (const reason of ["reload", "switch", "quit"] as const) for (const at of ["tree", "inspector"] as const)
  test(`${reason} while ${at} focused releases subscriptions/focus and never revives stale widgets`, async () => {
    const f = await commandFixture(); await f.commands.get("subagents").handler("", f.ctx);
    const old = f.widget, oldEditor = f.editor;
    let active: SubagentOverview | TranscriptInspector = old;
    if (at === "inspector") { old.handleInput("\x1b[B"); old.handleInput("\r"); active = await f.view(0); }
    await f.emit("session_shutdown", { reason }); await tick();
    const count = f.views.length, renders = f.renders(); active.handleInput("\x1b"); oldEditor.handleInput("\x1b[D"); f.fixture.change(); await tick();
    expect(f.views).toHaveLength(count); expect(f.fixture.listeners.size).toBe(0); expect(f.renders()).toBe(renders); expect(old.render(100)).toEqual([]);
    expect(old.focused).toBe(false); expect(f.editor.focused).toBe(true); expect(f.create).not.toHaveBeenCalled();
  });
test("shutdown during lazy activation cannot focus tree after configuration await", async () => {
  const f = await commandFixture(); processServices().delete(rootIdentity(f.ctx.sessionManager));
  let release!: (value: any) => void; f.configuration.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const opened = f.commands.get("subagents").handler("", f.ctx); await tick(); expect(release).toBeFunction();
  await f.emit("session_shutdown", { reason: "reload" }); release({ runtime: {}, models: [] });
  await expect(opened).rejects.toThrow("activation was invalidated"); expect(f.views).toHaveLength(0); expect(f.create).not.toHaveBeenCalled();
});
test("session reset while inspecting closes overlay; new tree defaults Relevant and cannot be revived by old callback", async () => {
  const f = await commandFixture(); await f.commands.get("subagents").handler("", f.ctx);
  const old = f.widget; old.handleInput("\t"); old.handleInput("\x1b[B"); old.handleInput("\r"); await f.view(0);
  await f.emit("session_start", {}); await tick();
  expect(f.widget).not.toBe(old); expect(f.widget.getMode()).toBe("Relevant"); expect(f.editor.focused).toBe(true);
  old.handleInput("\r"); expect(f.views).toHaveLength(1); expect(f.fixture.listeners.size).toBe(1);
});
