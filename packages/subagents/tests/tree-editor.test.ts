import { beforeAll, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { CustomEditor, getPackageDir, initTheme, type ExtensionAPI, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, getKeybindings, setKeybindings, KeybindingsManager as TuiKeys, TuiAltScreen, TuiMainScreen, type EditorTheme } from "@earendil-works/pi-tui";
import { OverviewAttachment, SubagentOverview } from "../extensions/subagents/overview.ts";
import { decorateTreeEditor } from "../extensions/subagents/tree-editor.ts";
import completionKeys from "../../completion-keys/extensions/fish-autosuggestion-keys.ts";
import type { SubagentState } from "../extensions/subagents/state.ts";

beforeAll(() => initTheme("dark", false));
const plain = (text: string) => text;
const editorTheme: EditorTheme = { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } };
const theme = { fg: (_token: string, text: string) => text, bold: plain, getBgAnsi: () => "", style: plain } as Theme;
// Use the installed host's complete definitions, including modal-only app keys.
const { KEYBINDINGS: definitions } = await import(`${getPackageDir()}/dist/core/keybindings.js`);
const makeKeys = (bindings = {}) => new TuiKeys(definitions, bindings) as KeybindingsManager;
function fixture(fullscreen = false, keys = makeKeys()) {
  const terminal = { rows: 32, columns: 80, hideCursor() {} } as any;
  const tui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  tui.requestRender = () => {};
  const defaultEditor = new CustomEditor(tui, editorTheme, keys);
  let editor = defaultEditor, widget: SubagentOverview | undefined, factory: Function | undefined, installations = 0;
  tui.addChild(editor); tui.setFocus(editor);
  const notifications: string[] = [];
  const widgets: Function[] = [];
  const ctx = { mode: "tui", ui: { notify: (text: string) => notifications.push(text), getEditorComponent: () => factory,
    setEditorComponent(next: Function | undefined) {
      // Match Pi: publish the outer factory BEFORE invocation, then transfer
      // default callbacks/settings and the previous prompt (not cursor/history).
      factory = next; installations++;
      const text = editor.getText();
      tui.removeChild(editor);
      editor = next ? next(tui, editorTheme, keys) : defaultEditor;
      editor.onSubmit = defaultEditor.onSubmit; editor.onChange = defaultEditor.onChange;
      editor.setText(text);
      editor.borderColor = defaultEditor.borderColor;
      editor.setPaddingX?.(defaultEditor.getPaddingX());
      editor.setAutocompleteMaxVisible?.(defaultEditor.getAutocompleteMaxVisible());
      if (typeof editor.onAction === "function") {
        editor.onEscape ??= defaultEditor.onEscape;
        editor.onCtrlD ??= defaultEditor.onCtrlD;
        editor.onPasteImage ??= defaultEditor.onPasteImage;
        editor.onExtensionShortcut ??= defaultEditor.onExtensionShortcut;
      }
      tui.addChild(editor); tui.setFocus(editor);
    }, setWidget(_name: string, next: Function | undefined, options: unknown) {
      if (widget) { tui.removeChild(widget); widget.dispose(); }
      if (next) { widgets.push(next); expect(options).toEqual({ placement: "aboveEditor" }); }
      widget = next?.(tui, theme); if (widget) tui.addChild(widget);
    } } } as unknown as ExtensionContext;
  const snapshot: SubagentState = { version: 3, rootKey: "root", subagents: {
    a: { id: "a", parentId: "root", name: "Inspect", model: "fixture/model", requestedThinking: "low", effectiveThinking: "low",
      generation: 1, currentRun: "r", cwd: "/tmp", projectTrusted: false, sessionFile: "", sessionId: "" },
  }, runs: { r: { id: "r", agentId: "a", parentId: "root", parentRunId: null, receiverRunId: null, phase: "waiting", generation: 1,
    prompt: "task", boundary: null, startedAt: "2026-01-01", delivered: false } } };
  const listeners = new Set<() => void>();
  const source = { snapshot: () => structuredClone(snapshot), subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const attachment = new OverviewAttachment();
  const install = () => { attachment.installEditor(ctx, () => {}); attachment.attach(ctx, source); };
  return { tui, keys, ctx, attachment, source, snapshot, listeners, install, widgets, notifications, defaultEditor,
    get editor() { return editor!; }, get widget() { return widget!; }, get installations() { return installations; } };
}
for (const fullscreen of [false, true]) test(`native ${fullscreen ? "fullscreen" : "regular"} editor: Left only absolute start; Esc preserves text/cursor/undo/history`, () => {
  const f = fixture(fullscreen); f.install();
  try {
    const editor = f.editor;
    expect(editor).toBeInstanceOf(CustomEditor);
    editor.handleInput("draft"); const cursor = editor.getCursor();
    editor.handleInput("\x1b[D"); expect(editor.getCursor().col).toBe(cursor.col - 1); expect(editor.focused).toBe(true);
    editor.handleInput("\x01");
    const native = editor.render(80);
    expect(native.join("\n")).toContain("\x1b[7m"); expect(native.join("\n")).toContain(CURSOR_MARKER);
    editor.handleInput("\x1b[D");
    expect(f.widget.focused).toBe(true); expect(editor.focused).toBe(false);
    const inactive = editor.render(80).join("\n");
    expect(inactive.split("\n")).toEqual(native.map(line => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, ""))));
    expect(inactive).toContain("draft"); expect(inactive).not.toContain("Prompt (inactive)");
    expect(inactive.split("\n")[0]).toMatch(/^─+$/); expect(inactive.split("\n").at(-1)).toMatch(/^─+$/);
    expect(inactive).not.toContain(CURSOR_MARKER); expect(inactive).not.toContain("\x1b[7m");
    f.widget.handleInput("\x1b"); expect(editor.render(80)).toEqual(native); expect(editor.focused).toBe(true); expect(editor.getText()).toBe("draft"); expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
    editor.handleInput("\x1b[D"); f.widget.handleInput("Z"); expect(editor.getText()).toBe("Zdraft"); expect(editor.getCursor().col).toBe(1);
    editor.handleInput("\x1f"); expect(editor.getText()).toBe("draft"); expect(editor.getCursor().col).toBe(0);
    editor.addToHistory("history survives"); editor.setText("");
    editor.handleInput("\x1b[D"); f.widget.handleInput("\x1b"); editor.handleInput("\x1b[A"); expect(editor.getText()).toBe("history survives");
    editor.setText("first\nsecond"); editor.handleInput("\x01"); expect(editor.getCursor()).toEqual({ line: 1, col: 0 });
    editor.handleInput("\x1b[D"); expect(editor.focused).toBe(true); expect(editor.getCursor().line).toBe(0);
    editor.setText("a long wrapped editor line"); editor.render(8); editor.handleInput("\x01"); editor.handleInput("\x06");
    editor.handleInput("\x1b[D"); expect(editor.focused).toBe(true); // Nonzero logical column before the key.
    f.install(); expect(f.editor).toBe(editor); expect(f.installations).toBe(1); expect(f.listeners.size).toBe(1);
  } finally { f.attachment.dispose(); }
});
for (const fullscreen of [false, true]) test(`acknowledged ${fullscreen ? "fullscreen" : "regular"} history opens directly in All when Relevant is empty`, () => {
  const f = fixture(fullscreen); f.install();
  try {
    f.snapshot.runs.r.phase = "terminal";
    f.attachment.setAcknowledgedRuns(new Set(["r"]));
    expect(f.widget.render(80)).toEqual([]);
    const editor = f.editor;
    editor.setText("draft"); editor.handleInput("\x01"); editor.handleInput("\x1b[D");
    expect(f.widget.focused).toBe(true); expect(f.widget.hasAgents()).toBe(true);
    expect(f.widget.getMode()).toBe("All"); expect(f.widget.getSelectedAgentId()).toBe("a");
    expect(f.widget.render(80).join("\n")).toContain("[All]");
    expect(f.widget.render(80).join("\n")).toContain("Inspect");
    expect(f.widget.render(80).join("\n")).not.toContain("Relevant");
    for (const rows of [7, 3, 1]) {
      f.tui.terminal.rows = rows;
      expect(f.widget.render(80).join("\n")).toContain("[All]");
      expect(f.widget.render(80).join("\n")).toContain("Inspect");
      if (fullscreen) expect(editor.render(80)).toEqual(f.widget.render(80));
    }
    f.tui.terminal.rows = 32;
    f.widget.handleInput("\t"); expect(f.widget.getMode()).toBe("Relevant");
    for (const key of ["\r", "\x1b[C", "\x1b[A", "\x1b[B", "\x1b[H", "\x1b[F", "\x1b[5~", "\x1b[6~"]) f.widget.handleInput(key);
    expect(f.widget.getSelectedAgentId()).toBeUndefined(); expect(f.widget.focused).toBe(true);
    for (const listener of f.listeners) listener(); expect(f.widget.focused).toBe(true);
    for (const rows of [7, 3, 1]) {
      f.tui.terminal.rows = rows;
      expect(f.widget.render(80)).toEqual(["No unacknowledged subagents"]);
      if (fullscreen) expect(editor.render(80)).toEqual(["No unacknowledged subagents"]);
      expect(f.widget.render(1)).toHaveLength(1);
    }
    f.tui.terminal.rows = 32;
    f.widget.handleInput("\t"); expect(f.widget.getMode()).toBe("All");
    expect(f.widget.render(80).join("\n")).toContain("Inspect");
    f.widget.handleInput("\x1b[A"); f.widget.handleInput("\x1b[B"); expect(f.widget.getSelectedAgentId()).toBe("a");
    f.tui.setFocus(editor); f.attachment.focus(); expect(f.widget.getMode()).toBe("All"); // inspection blur
    f.widget.handleInput("\t");
    f.tui.setFocus(editor); f.attachment.focus(); expect(f.widget.getMode()).toBe("Relevant"); // preserve an explicitly chosen empty view on inspection return
    f.widget.handleInput("\x1b[D");
    expect(editor.focused).toBe(true); expect(f.widget.render(80)).toEqual([]);
    expect(editor.getText()).toBe("draft"); expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
    expect(f.attachment.focus()).toBe(true); // /subagents uses this same boundary
    expect(f.widget.getMode()).toBe("All"); expect(f.widget.getSelectedAgentId()).toBe("a");
    f.widget.handleInput("\x1b[D");
    f.snapshot.runs.resumed = { ...f.snapshot.runs.r, id: "resumed", phase: "waiting", generation: 2 };
    f.snapshot.subagents.a.currentRun = "resumed";
    for (const listener of f.listeners) listener();
    expect(f.widget.getMode()).toBe("Relevant"); expect(f.widget.render(80).join("\n")).toContain("Inspect");
    expect(f.attachment.focus()).toBe(true); expect(f.widget.getMode()).toBe("Relevant");
    f.widget.handleInput("\x1b[D");
    f.attachment.setAcknowledgedRuns(new Set(["r", "resumed"]));
    const factory = f.widgets.at(-1)!;
    const recreated = factory(f.tui, theme) as SubagentOverview;
    expect(recreated.render(80)).toEqual([]); expect(recreated.hasAgents()).toBe(true);
    expect(f.attachment.focus()).toBe(true); expect(recreated.getMode()).toBe("All");
    expect(recreated.render(80).join("\n")).toContain("Inspect");
    f.snapshot.subagents = {}; f.snapshot.runs = {}; for (const listener of f.listeners) listener();
    expect(f.attachment.focus()).toBe(false); expect(editor.focused).toBe(true);
  } finally { f.attachment.dispose(); }
});

test("short fullscreen tree selection uses reserved editor space without changing native editing state", () => {
  const f = fixture(true); f.install();
  try {
    const editor = f.editor;
    editor.handleInput("draft"); editor.handleInput("\x01");
    f.tui.terminal.rows = 7;
    const normal = editor.render(80);
    editor.handleInput("\x1b[D");
    expect(f.widget.focused).toBe(true);
    expect(editor.render(80)).toEqual(f.widget.renderFocusedSelection(80));
    expect(editor.render(80)[0]).toContain("Inspect");
    expect(editor.render(80).join("\n")).not.toContain("Prompt (inactive)");
    f.tui.terminal.rows = 8;
    expect(editor.render(80)).toEqual(f.widget.renderFocusedSelection(80));
    expect(editor.render(80)[0]).toContain("1/1");
    expect(f.widget.render(80).join("\n")).toContain("Inspect");
    expect(editor.getText()).toBe("draft"); expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
    f.tui.terminal.rows = 32; expect(editor.render(80).length).toBeGreaterThan(1);
    f.tui.terminal.rows = 7; f.widget.handleInput("\x1b");
    expect(editor.render(80)).toEqual(normal);
    editor.handleInput("Z"); expect(editor.getText()).toBe("Zdraft");
    editor.handleInput("\x1f"); expect(editor.getText()).toBe("draft");
    expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
  } finally { f.attachment.dispose(); }
});

for (const fullscreen of [false, true]) test(`native ${fullscreen ? "fullscreen" : "regular"} inactive prompt preserves layout and borders, follows theme and restores native rendering when another component owns focus`, () => {
  const f = fixture(fullscreen); f.install();
  const original = theme.fg;
  try {
    const editor = f.editor;
    editor.setText("first draft\nsecond draft\nthird draft\x1b[7munsafe\x1b[27m");
    editor.handleInput("\x01"); editor.handleInput("\x1b[A"); editor.handleInput("\x1b[A"); editor.handleInput("\x1b[D");
    expect(f.widget.focused).toBe(true);
    const text = editor.getText(), cursor = editor.getCursor();
    const native = CustomEditor.prototype.render.call(editor, 24).map(line => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, "")));
    let shade = "dark";
    theme.fg = (token, text) => { expect(token).toBe("dim"); return `${shade}:${text}`; };
    const preview = editor.render(24);
    expect(preview).toEqual(native.map(line => `dark:${line}`));
    expect(preview.join("\n")).toContain("first draft"); expect(preview.join("\n")).toContain("second draft");
    expect(preview.join("\n")).not.toContain("Prompt (inactive)");
    expect(preview.join("\n")).not.toContain(CURSOR_MARKER); expect(preview.join("\n")).not.toContain("\x1b[7m");
    shade = "light"; editor.invalidate();
    expect(editor.render(24).join("\n")).toContain("light:"); expect(editor.render(24).join("\n")).not.toContain("dark:");
    expect(editor.getText()).toBe(text); expect(editor.getCursor()).toEqual(cursor);
    theme.fg = original;
    const other = { focused: false, render: () => ["Other native modal"], invalidate() {} };
    f.tui.setFocus(other); expect(f.widget.focused).toBe(false);
    expect(editor.render(80)).toEqual(CustomEditor.prototype.render.call(editor, 80));
    expect(editor.render(80).join("\n")).not.toContain("Prompt (inactive)");
    expect(f.attachment.focus()).toBe(true);
    const inactive = editor.render(80);
    expect(inactive).toEqual(CustomEditor.prototype.render.call(editor, 80).map(line => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, ""))));
    expect(inactive.join("\n")).not.toContain("\x1b[7m");
    f.widget.handleInput("\x1b[D"); expect(editor.focused).toBe(true);
    expect(editor.render(80)).toEqual(CustomEditor.prototype.render.call(editor, 80));
    expect(editor.getText()).toBe(text); expect(editor.getCursor()).toEqual(cursor);
  } finally { theme.fg = original; f.attachment.dispose(); }
});

test("physical and Kitty Left enter tree, Ctrl+B stays editor, Kitty printable returns once, global Ctrl+C keeps app semantics", () => {
  const f = fixture(); f.install();
  try {
    const editor = f.editor; let cleared = 0; editor.onAction("app.clear", () => { cleared++; });
    editor.handleInput("\x02"); expect(editor.focused).toBe(true);
    for (const left of ["\x1b[D", "\x1b[1;1D", "\x1b[1;1:1D"]) {
      editor.setText(""); editor.handleInput(left); expect(f.widget.focused).toBe(true);
      f.widget.handleInput("\x1b[97u"); expect(editor.getText()).toBe("a"); expect(editor.focused).toBe(true);
    }
    editor.handleInput("\x01"); editor.handleInput("\x1b[D"); f.widget.handleInput("\x03");
    expect(cleared).toBe(1); expect(editor.focused).toBe(true);
  } finally { f.attachment.dispose(); }
});
test("split bracketed paste and pending character jump never interpret embedded Left as focus", () => {
  const f = fixture(); f.install();
  const native = new CustomEditor(f.tui, editorTheme, f.keys);
  try {
    for (const data of ["\x1b[200~", "\x1b[D", "pasted", "\x1b[20", "1~"]) {
      f.editor.handleInput(data); native.handleInput(data); expect(f.editor.focused).toBe(true);
    }
    expect(f.editor.getText()).toBe(native.getText()); expect(f.editor.getCursor()).toEqual(native.getCursor());
    f.editor.setText(""); f.editor.handleInput("\x1d"); f.editor.handleInput("\x1b[D"); expect(f.editor.focused).toBe(true);
    f.editor.handleInput("\x1b[D"); expect(f.widget.focused).toBe(true);
    f.widget.handleInput("\x1b");
    f.editor.handleInput("\x1d");
    f.editor.onExtensionShortcut = data => data === "x";
    f.editor.handleInput("x"); f.editor.handleInput("\x1b[D"); expect(f.editor.focused).toBe(true);
    f.editor.handleInput("\x1b[D"); expect(f.widget.focused).toBe(true);
    f.widget.handleInput("\x1b");
    f.editor.onAction("app.clear", () => {});
    f.editor.handleInput("\x1d"); f.editor.handleInput("\x03"); f.editor.handleInput("\x1b[D"); expect(f.editor.focused).toBe(true);
    f.editor.handleInput("\x1b[D"); expect(f.widget.focused).toBe(true);
  } finally { f.attachment.dispose(); }
});
test("native visible autocomplete at absolute start keeps Left and prompt Tab native", async () => {
  const f = fixture(); f.install();
  try {
    f.editor.setAutocompleteProvider({
      async getSuggestions() { return { items: [{ value: "one", label: "one" }, { value: "two", label: "two" }], prefix: "" }; },
      applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
      shouldTriggerFileCompletion: () => true,
    });
    f.editor.handleInput("\t"); await Bun.sleep(20);
    expect(f.editor.isShowingAutocomplete()).toBe(true); expect(f.editor.getCursor()).toEqual({ line: 0, col: 0 });
    f.editor.handleInput("\x1b[D"); expect(f.editor.focused).toBe(true); expect(f.widget.getMode()).toBe("Relevant");
    f.editor.handleInput("\x1b");
  } finally { f.attachment.dispose(); }
});
test("extension shortcuts and explicitly rebound app/history/editor actions take precedence over Left", () => {
  const f = fixture(); f.install();
  try {
    let shortcut = 0; f.editor.onExtensionShortcut = () => { shortcut++; return true; };
    f.editor.handleInput("\x1b[D"); expect(shortcut).toBe(1); expect(f.editor.focused).toBe(true);
    f.editor.onExtensionShortcut = () => { shortcut++; return false; };
    f.snapshot.subagents = {}; f.snapshot.runs = {}; for (const listener of f.listeners) listener();
    f.editor.handleInput("\x1b[D"); expect(shortcut).toBe(2); expect(f.editor.focused).toBe(true);
  } finally { f.attachment.dispose(); }
  for (const action of ["app.tools.expand", "tui.editor.historyPrevious", "tui.editor.cursorRight"]) {
    const f = fixture(false, makeKeys({ [action]: "left" })); f.install();
    let expanded = 0; f.editor.onAction("app.tools.expand", () => { expanded++; });
    try { f.editor.handleInput("\x1b[D"); expect(f.editor.focused).toBe(true); if (action === "app.tools.expand") expect(expanded).toBe(1); }
    finally { f.attachment.dispose(); }
  }
});
test("unsupported editor stays unchanged with one warning; later replacement survives teardown", () => {
  const f = fixture();
  const unsupported = new Editor(f.tui, editorTheme);
  const existing = () => unsupported;
  const originalInput = unsupported.handleInput, originalRender = unsupported.render;
  f.ctx.ui.setEditorComponent(existing);
  f.install(); f.install(); expect(f.editor).toBe(unsupported);
  expect(unsupported.handleInput).toBe(originalInput); expect(unsupported.render).toBe(originalRender);
  expect(f.notifications).toHaveLength(1); expect(f.notifications[0]).toContain("unsupported custom editor unchanged");
  expect(f.attachment.focus()).toBe(false); f.attachment.dispose(); expect(f.ctx.ui.getEditorComponent()).toBe(existing);
  f.ctx.ui.setEditorComponent(undefined); f.install(); const old = f.editor, oldWidgetFactory = f.widgets.at(-1)!;
  f.ctx.ui.setEditorComponent(existing); const newer = f.editor;
  expect(f.attachment.focus()).toBe(false);
  f.attachment.dispose(); expect(f.editor).toBe(newer); expect(f.ctx.ui.getEditorComponent()).toBe(existing);
  expect(oldWidgetFactory(f.tui, theme).render(80)).toEqual([]); expect(f.listeners.size).toBe(0);
  f.ctx.ui.setEditorComponent(undefined); f.install(); old.handleInput("\x1b[D"); expect(f.editor.focused).toBe(true); f.attachment.dispose();
});
test("explicit Esc/Left/typing restore compact Relevant viewport and next focus default, without retained All scroll", () => {
  const f = fixture();
  f.snapshot.runs.r.startedAt = "2026-01-02";
  for (let i = 0; i < 20; i++) {
    const id = `old-${i}`, runId = `old-run-${i}`;
    f.snapshot.subagents[id] = { ...f.snapshot.subagents.a, id, name: `Old task ${i}`, currentRun: runId };
    f.snapshot.runs[runId] = { ...f.snapshot.runs.r, id: runId, agentId: id, phase: "terminal", startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:01Z", outcome: { status: "completed", text: "full" } };
  }
  f.attachment.setAcknowledgedRuns(new Set(Object.keys(f.snapshot.runs).filter(id => id !== "r")));
  f.install();
  try {
    for (const key of ["\x1b", "\x1b[D", "\x1b[1;1D", "Z"]) {
      f.editor.setText("draft"); f.editor.handleInput("\x01");
      f.editor.handleInput("\x1b[D"); expect(f.widget.getSelectedAgentId()).toBe("a");
      const height = f.widget.render(120).length;
      f.widget.handleInput("\t"); f.widget.handleInput("\x1b[F");
      expect(f.widget.getSelectedAgentId()).toBe("old-19"); expect(f.widget.render(120).join("\n")).toContain("↑ 15 above");
      f.widget.handleInput(key);
      expect(f.editor.focused).toBe(true); expect(f.widget.getMode()).toBe("Relevant"); expect(f.widget.getSelectedAgentId()).toBe("a");
      expect(f.widget.render(120)).toHaveLength(height); expect(f.widget.render(120).join("\n")).not.toContain("Old task");
      expect(f.editor.getText()).toBe(key === "Z" ? "Zdraft" : "draft");
      f.editor.handleInput("\x01"); f.editor.handleInput("\x1b[D");
      expect(f.widget.focused).toBe(true); expect(f.widget.getSelectedAgentId()).toBe("a");
      f.widget.handleInput("\x1b");
    }
    f.editor.handleInput("\x1b[D"); expect(f.widget.focused).toBe(true);
    f.snapshot.subagents = {}; f.snapshot.runs = {}; for (const listener of f.listeners) listener();
    expect(f.editor.focused).toBe(true); expect(f.widget.render(120)).toEqual([]); // focus restoration precedes empty reset
  } finally { f.attachment.dispose(); }
});

function completion(f: ReturnType<typeof fixture>) {
  const handlers = new Map<string, Function>();
  completionKeys({ on: (event: string, handler: Function) => { handlers.set(event, handler); } } as unknown as ExtensionAPI);
  return { start: (ctx = f.ctx) => handlers.get("session_start")!({}, ctx), stop: () => handlers.get("session_shutdown")!({}, f.ctx) };
}
async function showCompletion(editor: CustomEditor, prefix = "he") {
  editor.setAutocompleteProvider({
    async getSuggestions() { return { items: [{ value: "hello", label: "hello" }, { value: "help", label: "help" }], prefix }; },
    applyCompletion(lines, cursorLine, cursorCol, item) {
      return { lines: [item.value], cursorLine: 0, cursorCol: item.value.length };
    }, shouldTriggerFileCompletion: () => true,
  });
  editor.setText(prefix); editor.handleInput("\t"); await Bun.sleep(20);
  expect(editor.isShowingAutocomplete()).toBe(true);
}

for (const fullscreen of [false, true]) for (const order of ["tree-first", "fish-first"]) {
  test(`${order}, ${fullscreen ? "fullscreen" : "regular"}: real native subclass keeps identity, Tab acceptance, navigation, and one input dispatch`, async () => {
    const f = fixture(fullscreen), fish = completion(f);
    const created: CustomEditor[] = [], received: string[] = [], shortcuts: string[] = [], changes: string[] = [];
    class ForeignNative extends CustomEditor {
      override handleInput(data: string) { received.push(data); super.handleInput(data); }
      override render(width: number) { return super.render(width); }
    }
    f.defaultEditor.onChange = value => changes.push(value);
    f.defaultEditor.onExtensionShortcut = data => { shortcuts.push(data); return false; };
    f.defaultEditor.setPaddingX(2); f.defaultEditor.setAutocompleteMaxVisible(4);
    f.editor.setText("startup draft");
    const originalFactory = (ui: any, theme: any, keys: any) => {
      const editor = new ForeignNative(ui, theme, keys); created.push(editor); return editor;
    };
    f.ctx.ui.setEditorComponent(originalFactory);
    if (order === "tree-first") { f.install(); fish.start(); } else { fish.start(); f.install(); }
    try {
      const editor = f.editor;
      expect(editor).toBe(created.at(-1)!); expect(Object.getPrototypeOf(editor)).toBe(ForeignNative.prototype);
      expect(editor.getText()).toBe("startup draft"); expect(editor.getPaddingX()).toBe(2); expect(editor.getAutocompleteMaxVisible()).toBe(4);
      const count = f.installations;
      f.install(); fish.start(); f.attachment.attach(f.ctx, f.source);
      expect(f.installations).toBe(count); expect(f.editor).toBe(editor); expect(f.notifications).toEqual([]);
      for (const accept of ["\x1b[C", "\x06", "\x1b[1;1C", "\x1b[102;5u"]) {
        await showCompletion(editor);
        received.length = 0; shortcuts.length = 0; changes.length = 0;
        editor.handleInput(accept);
        expect(received).toEqual(["\t"]); expect(shortcuts).toEqual(["\t"]);
        expect(editor.getText()).toBe("hello"); expect(editor.getCursor()).toEqual({ line: 0, col: 5 });
        expect(changes).toEqual(["hello"]); expect(editor.isShowingAutocomplete()).toBe(false);
        editor.handleInput("\x1f"); expect(editor.getText()).toBe("he"); expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
      }
      await showCompletion(editor, ""); received.length = 0; shortcuts.length = 0;
      editor.handleInput("\x1b[D"); expect(editor.focused).toBe(true); expect(f.widget.focused).toBe(false);
      expect(received).toEqual(["\x1b[D"]); expect(shortcuts).toEqual(["\x1b[D"]);
      editor.handleInput("\x1b"); editor.setText("draft"); editor.handleInput("\x01");
      received.length = 0; shortcuts.length = 0;
      editor.handleInput("\x1b[D"); expect(f.widget.focused).toBe(true);
      expect(received).toEqual([]); expect(shortcuts).toEqual(["\x1b[D"]);
      expect(editor.render(80).join("\n")).not.toContain(CURSOR_MARKER);
      expect(editor.render(80)[0]).toMatch(/^─+$/);
      f.widget.handleInput("Z"); expect(editor.getText()).toBe("Zdraft"); expect(received).toEqual(["Z"]);
      editor.setText(""); received.length = 0; shortcuts.length = 0;
      f.snapshot.subagents = {}; f.snapshot.runs = {}; for (const listener of f.listeners) listener();
      editor.handleInput("\x1b[D"); expect(received).toEqual(["\x1b[D"]); expect(shortcuts).toEqual(["\x1b[D"]);
      expect(f.installations).toBe(count);
      // The abandoned editor from the first chain construction is inactive.
      for (const old of created.slice(0, -1)) old.handleInput("\x1b[D");
      expect(editor.focused).toBe(true);
    } finally { f.attachment.dispose(); fish.stop(); }
  });
}

for (const order of ["tree-first", "fish-first"]) test(`${order}: multiline, split paste, pending jumps and native shortcut precedence survive cooperation`, () => {
  const f = fixture(), fish = completion(f);
  if (order === "tree-first") { f.install(); fish.start(); } else { fish.start(); f.install(); }
  try {
    const editor = f.editor, native = new CustomEditor(f.tui, editorTheme, f.keys);
    for (const data of ["\x1b[200~", "\x1b[D", "pasted\nsecond", "\x1b[20", "1~"]) {
      editor.handleInput(data); native.handleInput(data);
      expect(editor.focused).toBe(true); expect(editor.getText()).toBe(native.getText()); expect(editor.getCursor()).toEqual(native.getCursor());
    }
    editor.setText("first\nsecond"); editor.handleInput("\x01"); editor.handleInput("\x1b[D");
    expect(editor.focused).toBe(true); expect(editor.getCursor()).toEqual({ line: 0, col: 5 });
    editor.setText(""); editor.handleInput("\x1d");
    let shortcuts = 0; editor.onExtensionShortcut = data => { shortcuts++; return data === "x"; };
    editor.handleInput("x"); editor.handleInput("\x1b[D"); expect(editor.focused).toBe(true); expect(shortcuts).toBe(2);
    editor.handleInput("\x1b[D"); expect(f.widget.focused).toBe(true); expect(shortcuts).toBe(3);
    f.widget.handleInput("\x1b");
    let clears = 0; editor.onAction("app.clear", () => { clears++; });
    editor.handleInput("\x1d"); editor.handleInput("\x03"); editor.handleInput("\x1b[D");
    expect(clears).toBe(1); expect(editor.focused).toBe(true);
    editor.handleInput("\x1b[D"); f.widget.handleInput("\x03"); expect(clears).toBe(2);
  } finally { f.attachment.dispose(); fish.stop(); }
  const rebound = fixture(false, makeKeys({ "tui.editor.historyPrevious": "left", "tui.editor.cursorLeft": [] })), reboundFish = completion(rebound);
  const previousKeys = getKeybindings(); setKeybindings(rebound.keys);
  if (order === "tree-first") { rebound.install(); reboundFish.start(); } else { reboundFish.start(); rebound.install(); }
  try {
    rebound.editor.addToHistory("old prompt"); rebound.editor.handleInput("\x1b[D");
    expect(rebound.editor.getText()).toBe("old prompt"); expect(rebound.editor.focused).toBe(true);
  } finally { rebound.attachment.dispose(); reboundFish.stop(); setKeybindings(previousKeys); }
});

test("public structural compatibility does not depend on CustomEditor class identity", () => {
  const f = fixture(), fish = completion(f);
  // Like separate jiti identities, this native object exposes the full public
  // contract without passing the consumer's instanceof check.
  const editor = new Proxy(new CustomEditor(f.tui, editorTheme, f.keys), { getPrototypeOf: () => Object.prototype });
  expect(editor instanceof CustomEditor).toBe(false);
  f.ctx.ui.setEditorComponent(() => editor); fish.start(); f.install();
  try {
    expect(f.editor).toBe(editor); expect(f.notifications).toEqual([]);
    editor.handleInput("\x1b[D"); expect(f.widget.focused).toBe(true);
    f.widget.handleInput("Z"); expect(editor.getText()).toBe("Z");
  } finally { f.attachment.dispose(); fish.stop(); }
});

test("declined boundary shortcut is called once and preserves callback replacement", () => {
  const f = fixture(); f.install();
  try {
    f.snapshot.subagents = {}; f.snapshot.runs = {}; for (const listener of f.listeners) listener();
    let calls = 0;
    const replacement = () => { calls++; return false; };
    f.editor.onExtensionShortcut = () => { calls++; f.editor.onExtensionShortcut = replacement; return false; };
    f.editor.handleInput("\x1b[D"); expect(calls).toBe(1); expect(f.editor.onExtensionShortcut).toBe(replacement);
  } finally { f.attachment.dispose(); }
});

function beginJump(f: ReturnType<typeof fixture>, text = "") {
  f.editor.setText(text); f.editor.handleInput("\x01"); f.editor.handleInput("\x1d");
}
function expectPendingJump(f: ReturnType<typeof fixture>, pending: boolean) {
  f.editor.handleInput("\x1b[D");
  if (pending) {
    expect(f.editor.focused).toBe(true); expect(f.widget.focused).toBe(false);
    f.editor.handleInput("\x1b[D");
  }
  expect(f.widget.focused).toBe(true);
  f.widget.handleInput("\x1b");
}

for (const order of ["tree-first", "fish-first"]) test(`${order}: full host Ctrl+D fallthrough and modal-only Ctrl+A cancel pending native jumps`, () => {
  const f = fixture(), fish = completion(f);
  const previousKeys = getKeybindings(); setKeybindings(f.keys);
  if (order === "tree-first") { f.install(); fish.start(); } else { fish.start(); f.install(); }
  try {
    expect(f.keys.matches("\x01", "app.tree.filter.all")).toBe(true);
    let exits = 0; f.editor.onCtrlD = () => { exits++; };
    beginJump(f, "x"); f.editor.handleInput("\x04");
    expect(f.editor.getText()).toBe(""); expect(exits).toBe(0);
    expectPendingJump(f, false); // Must classify before Ctrl+D empties the text.
    beginJump(f, "x"); f.editor.handleInput("\x01");
    expect(f.editor.getCursor()).toEqual({ line: 0, col: 0 });
    expectPendingJump(f, false); // Configured modal action, not an editor handler.
    beginJump(f); f.editor.handleInput("\x04"); expect(exits).toBe(1);
    expectPendingJump(f, true);
    f.editor.onCtrlD = undefined;
    beginJump(f); f.editor.handleInput("\x04"); expectPendingJump(f, true); // Empty exit consumes even without callback.
  } finally { f.attachment.dispose(); fish.stop(); setKeybindings(previousKeys); }
});

test("pre-existing foreign app registrations preserve jumps, while native history has priority", () => {
  const f = fixture(false, makeKeys({ "tui.editor.historyPrevious": "ctrl+o" }));
  const previousKeys = getKeybindings(); setKeybindings(f.keys);
  const editor = new CustomEditor(f.tui, editorTheme, f.keys);
  let clears = 0, expands = 0, exits = 0;
  editor.onAction("app.clear", () => { clears++; });
  editor.onAction("app.tools.expand", () => { expands++; });
  editor.onAction("app.exit", () => { exits++; });
  const handlers = editor.actionHandlers, originalEntries = [...handlers];
  f.ctx.ui.setEditorComponent(() => editor); f.install();
  try {
    expect(f.editor).toBe(editor);
    beginJump(f); editor.handleInput("\x03"); expect(clears).toBe(1); expectPendingJump(f, true);
    beginJump(f); editor.handleInput("\x0f"); expect(expands).toBe(0); expectPendingJump(f, false);
    beginJump(f); editor.handleInput("\x04"); expect(exits).toBe(1); expectPendingJump(f, true);
    expect(editor.actionHandlers).toBe(handlers); expect([...handlers]).toEqual(originalEntries);
  } finally { f.attachment.dispose(); setKeybindings(previousKeys); }
  expect(editor.actionHandlers).toBe(handlers); expect([...handlers]).toEqual(originalEntries);
});

test("clipboard consumes before history with or without its dynamic callback", () => {
  const f = fixture(false, makeKeys({ "app.clipboard.pasteImage": "ctrl+v", "tui.editor.historyPrevious": "ctrl+v" }));
  const previousKeys = getKeybindings(); setKeybindings(f.keys); f.install();
  try {
    let pastes = 0;
    for (const callback of [undefined, () => { pastes++; }]) {
      f.editor.onPasteImage = callback;
      beginJump(f); f.editor.handleInput("\x16"); expectPendingJump(f, true);
    }
    expect(pastes).toBe(1);
  } finally { f.attachment.dispose(); setKeybindings(previousKeys); }
});

test("interrupt dispatch distinguishes no handler, registered/dynamic handlers, and autocomplete fallthrough", async () => {
  const f = fixture(); const previousKeys = getKeybindings(); setKeybindings(f.keys); f.install();
  try {
    let registered = 0, dynamic = 0;
    beginJump(f); f.editor.handleInput("\x1b"); expectPendingJump(f, false);
    f.editor.onAction("app.interrupt", () => { registered++; });
    beginJump(f); f.editor.handleInput("\x1b"); expect(registered).toBe(1); expectPendingJump(f, true);
    f.editor.onEscape = () => { dynamic++; };
    beginJump(f); f.editor.handleInput("\x1b"); expect(dynamic).toBe(1); expect(registered).toBe(1); expectPendingJump(f, true);
    await showCompletion(f.editor, ""); f.editor.handleInput("\x1d");
    expect(f.editor.isShowingAutocomplete()).toBe(true);
    f.editor.handleInput("\x1b"); expect(f.editor.isShowingAutocomplete()).toBe(false);
    expect(dynamic).toBe(1); expect(registered).toBe(1); expectPendingJump(f, false);
  } finally { f.attachment.dispose(); setKeybindings(previousKeys); }
});

test("declining extension shortcut text/callback mutations are classified before actual app dispatch", () => {
  const f = fixture(); const previousKeys = getKeybindings(); setKeybindings(f.keys); f.install();
  try {
    let exits = 0, shortcuts = 0;
    const replacement = () => false;
    f.editor.onCtrlD = () => { exits++; };
    for (const text of ["", "x"]) {
      beginJump(f, text ? "" : "x");
      f.editor.onExtensionShortcut = data => {
        shortcuts++; expect(data).toBe("\x04");
        f.editor.setText(text); f.editor.onExtensionShortcut = replacement;
        return false;
      };
      f.editor.handleInput("\x04");
      expect(f.editor.onExtensionShortcut).toBe(replacement);
      f.editor.setText(""); // Position at the boundary without changing native jump mode.
      expectPendingJump(f, !text);
    }
    expect(shortcuts).toBe(2); expect(exits).toBe(1);
    beginJump(f);
    let expands = 0;
    f.editor.onExtensionShortcut = () => {
      shortcuts++; f.editor.onAction("app.tools.expand", () => { expands++; });
      f.editor.onExtensionShortcut = replacement; return false;
    };
    f.editor.handleInput("\x0f"); expect(shortcuts).toBe(3); expect(expands).toBe(1); expectPendingJump(f, true);
  } finally { f.attachment.dispose(); setKeybindings(previousKeys); }
});

test("declining extension shortcut can dismiss autocomplete before dynamic interrupt dispatch", async () => {
  const f = fixture(); const previousKeys = getKeybindings(); setKeybindings(f.keys); f.install();
  try {
    await showCompletion(f.editor, ""); f.editor.handleInput("\x1d");
    let shortcuts = 0, interrupts = 0;
    f.editor.onEscape = () => { interrupts++; };
    const replacement = () => false;
    f.editor.onExtensionShortcut = data => {
      shortcuts++; expect(data).toBe("\x1b"); f.editor.setText("");
      f.editor.onExtensionShortcut = replacement; return false;
    };
    f.editor.handleInput("\x1b");
    expect(shortcuts).toBe(1); expect(interrupts).toBe(1);
    expect(f.editor.onExtensionShortcut).toBe(replacement); expectPendingJump(f, true);
  } finally { f.attachment.dispose(); setKeybindings(previousKeys); }
});

test("decorator restores exact own/inherited descriptors, but never overwrites a later decorator", () => {
  const f = fixture();
  for (const own of [false, true]) {
    const editor = new CustomEditor(f.tui, editorTheme, f.keys);
    if (own) {
      Object.defineProperty(editor, "handleInput", { configurable: true, writable: true, enumerable: true, value: editor.handleInput });
      Object.defineProperty(editor, "render", { configurable: true, writable: true, enumerable: true, value: editor.render });
    }
    const input = Object.getOwnPropertyDescriptor(editor, "handleInput"), render = Object.getOwnPropertyDescriptor(editor, "render");
    let enters = 0, renders = 0;
    const controls = { keys: f.keys, enterTree: () => { enters++; return true; }, renderTree: () => { renders++; return ["tree"]; } };
    const dispose = decorateTreeEditor(editor, controls)!;
    editor.handleInput("\x1b[D"); expect(enters).toBe(1); expect(editor.render(80)).toEqual(["tree"]);
    dispose(); dispose();
    expect(Object.getOwnPropertyDescriptor(editor, "handleInput")).toEqual(input);
    expect(Object.getOwnPropertyDescriptor(editor, "render")).toEqual(render);
    const innerDispose = decorateTreeEditor(editor, controls)!;
    const innerInput = editor.handleInput, innerRender = editor.render;
    const outerInput = (data: string) => innerInput.call(editor, data), outerRender = (width: number) => innerRender.call(editor, width);
    editor.handleInput = outerInput; editor.render = outerRender;
    innerDispose();
    expect(editor.handleInput).toBe(outerInput); expect(editor.render).toBe(outerRender);
    editor.handleInput("\x1b[D"); expect(enters).toBe(1);
    expect(editor.render(80)).not.toEqual(["tree"]); expect(renders).toBe(1);
  }
});

test("nonwritable/nonconfigurable native methods and callback reject tree decoration atomically", () => {
  const f = fixture();
  for (const key of ["handleInput", "render", "onExtensionShortcut"] as const) for (const writable of [false, true]) {
    if (key === "onExtensionShortcut" && writable) continue; // a writable native callback need not be configurable
    const editor = new CustomEditor(f.tui, editorTheme, f.keys);
    Object.defineProperty(editor, key, { value: editor[key], configurable: writable ? false : true, writable });
    const before = Object.getOwnPropertyDescriptors(editor);
    expect(decorateTreeEditor(editor, { keys: f.keys, enterTree: () => true, renderTree: () => undefined })).toBeUndefined();
    expect(Object.getOwnPropertyDescriptors(editor)).toEqual(before);
  }
});

for (const order of ["tree-first", "fish-first"]) test(`${order}: chain reconstruction, outer/inner cleanup and host-cleared reload fence old callbacks`, () => {
  const f = fixture(), fish = completion(f);
  let inspections = 0;
  const install = () => { f.attachment.installEditor(f.ctx, () => { inspections++; }); f.attachment.attach(f.ctx, f.source); };
  if (order === "tree-first") { install(); fish.start(); } else { fish.start(); install(); }
  const oldEditors: CustomEditor[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const old = f.editor; oldEditors.push(old);
      const configured = f.ctx.ui.getEditorComponent();
      f.ctx.ui.setEditorComponent(configured);
      const current = f.editor;
      old.setText(""); old.handleInput("\x1b[D"); expect(current.focused).toBe(true);
      current.handleInput("\x1b[D"); expect(f.widget.focused).toBe(true);
      f.widget.handleInput("\r"); expect(inspections).toBe(i + 1);
      f.widget.handleInput("\x1b");
      const count = f.installations; install(); fish.start(); expect(f.installations).toBe(count);
    }
    const staleWidget = f.widget, staleFactory = f.ctx.ui.getEditorComponent()!;
    // Dispose the inner owner first. Operational ownership must not grant it
    // permission to remove the outer factory, which remains safe to call.
    if (order === "tree-first") f.attachment.dispose(); else fish.stop();
    expect(f.ctx.ui.getEditorComponent()).toBe(staleFactory);
    if (order === "tree-first") {
      f.editor.handleInput("\x1b[D"); expect(f.editor.focused).toBe(true);
      fish.stop();
    } else { f.editor.handleInput("\x1b[D"); expect(f.widget.focused).toBe(true); f.attachment.dispose(); }
    const oldInspections = inspections;
    staleWidget.handleInput("\r"); expect(inspections).toBe(oldInspections);
    f.ctx.ui.setEditorComponent(staleFactory);
    expect(Object.hasOwn(f.editor, "handleInput")).toBe(false);
    expect(Object.hasOwn(f.editor, "render")).toBe(false);
    expect(f.attachment.focus()).toBe(false);
    // Actual reload clears the host factory before shutdown. Neither extension
    // may reinstall its predecessor after that clear.
    f.ctx.ui.setEditorComponent(undefined); install(); fish.start();
    f.ctx.ui.setEditorComponent(undefined); const count = f.installations;
    f.attachment.dispose(); fish.stop();
    expect(f.ctx.ui.getEditorComponent()).toBeUndefined(); expect(f.installations).toBe(count);
    install(); fish.start();
    for (const old of oldEditors) old.handleInput("\x1b[D");
    expect(f.editor.focused).toBe(true); expect(f.widget.focused).toBe(false);
  } finally { f.attachment.dispose(); fish.stop(); }
});

test("completion alone restores descriptors, preserves foreign replacement, and deactivates under a later method wrapper", async () => {
  const f = fixture(), fish = completion(f);
  const editor = new CustomEditor(f.tui, editorTheme, f.keys);
  Object.defineProperty(editor, "handleInput", { configurable: true, writable: true, enumerable: true, value: editor.handleInput });
  const original = Object.getOwnPropertyDescriptor(editor, "handleInput");
  const predecessor = () => editor;
  f.ctx.ui.setEditorComponent(predecessor); fish.start();
  await showCompletion(editor); const inner = editor.handleInput;
  const outer = (data: string) => inner.call(editor, data);
  editor.handleInput = outer;
  const replacement = () => new CustomEditor(f.tui, editorTheme, f.keys);
  f.ctx.ui.setEditorComponent(replacement); const current = f.editor, count = f.installations;
  fish.stop(); fish.stop();
  expect(f.installations).toBe(count); expect(f.editor).toBe(current); expect(f.ctx.ui.getEditorComponent()).toBe(replacement);
  expect(editor.handleInput).toBe(outer);
  editor.handleInput("\x1b[C"); expect(editor.getText()).toBe("he"); // inactive inner no longer accepts popup
  editor.handleInput = original!.value;
  f.ctx.ui.setEditorComponent(predecessor); fish.start(); fish.stop();
  expect(Object.getOwnPropertyDescriptor(editor, "handleInput")).toEqual(original);
  expect(f.ctx.ui.getEditorComponent()).toBe(predecessor);
});

test("completion preserves original popup shortcut precedence and native motion without a popup", async () => {
  const f = fixture(), fish = completion(f); fish.start();
  try {
    const editor = f.editor, seen: string[] = [];
    await showCompletion(editor);
    editor.onExtensionShortcut = data => { seen.push(data); return data === "\t"; };
    editor.handleInput("\x1b[C"); expect(seen).toEqual(["\t"]); expect(editor.getText()).toBe("he");
    editor.onExtensionShortcut = undefined; editor.handleInput("\x1b"); editor.handleInput("\x01");
    editor.handleInput("\x1b[C"); expect(editor.getCursor().col).toBe(1);
    editor.handleInput("\x06"); expect(editor.getCursor().col).toBe(2);
  } finally { fish.stop(); }
});

test("completion returns unsupported/nonwritable editors untouched, warns once, and never installs in non-TUI modes", () => {
  const f = fixture(), fish = completion(f);
  for (const mode of ["print", "json", "rpc"]) fish.start({ ...f.ctx, mode } as ExtensionContext);
  expect(f.installations).toBe(0);
  for (const blocked of ["unsupported", "nonwritable", "nonconfigurable"]) {
    const editor = blocked === "unsupported" ? new Editor(f.tui, editorTheme) : new CustomEditor(f.tui, editorTheme, f.keys);
    if (blocked !== "unsupported") Object.defineProperty(editor, "handleInput", {
      value: editor.handleInput, writable: blocked === "nonconfigurable", configurable: blocked === "nonwritable",
    });
    const descriptor = Object.getOwnPropertyDescriptor(editor, "handleInput"), input = editor.handleInput;
    f.ctx.ui.setEditorComponent(() => editor); f.notifications.length = 0;
    fish.start(); const count = f.installations; fish.start();
    expect(f.installations).toBe(count); expect(f.editor).toBe(editor);
    expect(editor.handleInput).toBe(input); expect(Object.getOwnPropertyDescriptor(editor, "handleInput")).toEqual(descriptor);
    expect(f.notifications).toHaveLength(1); expect(f.notifications[0]).toContain("Right/Ctrl+F completion is unavailable");
    fish.stop();
  }
});

test("print/JSON/RPC never install editor/widgets or subscribe, even if called explicitly", () => {
  const f = fixture();
  for (const mode of ["print", "json", "rpc"]) {
    const ctx = { ...f.ctx, mode } as ExtensionContext;
    f.attachment.installEditor(ctx, () => {}); f.attachment.attach(ctx, f.source);
  }
  expect(f.installations).toBe(0); expect(f.widgets).toHaveLength(0); expect(f.listeners.size).toBe(0);
});
