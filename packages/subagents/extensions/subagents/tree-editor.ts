import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

export type TreeCompatibleEditor = EditorComponent & Pick<CustomEditor, "getCursor" | "isShowingAutocomplete" | "handleInput" | "render" |
  "onExtensionShortcut" | "onEscape" | "actionHandlers" | "focused" | "invalidate">;
type Controls = {
  keys: KeybindingsManager;
  enterTree(): boolean;
  renderTree(width: number, renderNative: () => string[]): string[] | undefined;
};

// Public capabilities, not instanceof: Pi loads extensions across jiti identities.
function compatible(editor: unknown): editor is TreeCompatibleEditor {
  if (!editor || typeof editor !== "object") return false;
  const candidate = editor as CustomEditor;
  return ["getCursor", "isShowingAutocomplete", "handleInput", "render", "invalidate", "getText", "setText", "onAction"]
    .every(key => typeof (candidate as unknown as Record<string, unknown>)[key] === "function") &&
    typeof candidate.actionHandlers?.get === "function" && typeof candidate.actionHandlers?.keys === "function" &&
    typeof candidate.focused === "boolean" && "onExtensionShortcut" in candidate &&
    (candidate.onExtensionShortcut === undefined || typeof candidate.onExtensionShortcut === "function");
}
function replaceable(editor: object, key: string): boolean {
  const own = Object.getOwnPropertyDescriptor(editor, key);
  return own ? own.configurable === true && "value" in own && own.writable === true : Object.isExtensible(editor);
}
function writableCallback(editor: object): boolean {
  for (let object: object | null = editor; object; object = Object.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, "onExtensionShortcut");
    if (descriptor) return "value" in descriptor && descriptor.writable === true &&
      (object === editor || Object.isExtensible(editor));
  }
  return Object.isExtensible(editor);
}

// Match CustomEditor's dispatch order, using its public registration map read-only.
// A configured binding alone is not a handler (e.g. modal-only Ctrl+A).
function appConsumesInput(editor: TreeCompatibleEditor, keys: KeybindingsManager, data: string): boolean {
  if (keys.matches(data, "app.clipboard.pasteImage")) return true;
  if (keys.matches(data, "app.interrupt")) {
    return !editor.isShowingAutocomplete() && !!(editor.onEscape ?? editor.actionHandlers.get("app.interrupt"));
  }
  if (keys.matches(data, "app.exit") && editor.getText().length === 0) return true;
  // History bypasses even a registered app action sharing its binding.
  if (keys.matches(data, "tui.editor.historyPrevious") || keys.matches(data, "tui.editor.historyNext")) return false;
  for (const action of editor.actionHandlers.keys()) {
    if (action !== "app.interrupt" && action !== "app.exit" && keys.matches(data, action)) return true;
  }
  return false;
}

/** Decorate the same native-compatible object, preserving its subclass and callbacks. */
export function decorateTreeEditor(editor: unknown, controls: Controls): (() => void) | undefined {
  if (!compatible(editor) || !replaceable(editor, "handleInput") || !replaceable(editor, "render") || !writableCallback(editor)) return;
  return installDecoration(editor, controls);
}
function installDecoration(editor: TreeCompatibleEditor, controls: Controls): () => void {
  let active: Controls | undefined = controls;
  let pasting = false, pasteTail = "", jumping = false;
  const inputDescriptor = Object.getOwnPropertyDescriptor(editor, "handleInput");
  const renderDescriptor = Object.getOwnPropertyDescriptor(editor, "render");
  const originalInput = editor.handleInput, originalRender = editor.render;
  const render = (width: number): string[] => active?.renderTree(width, () => originalRender.call(editor, width)) ?? originalRender.call(editor, width);
  const input = (data: string): void => {
    const current = active;
    if (!current) return originalInput.call(editor, data);
    const { keys } = current;
    const boundary = pasteTail + data;
    const transient = pasting || jumping || boundary.includes("\x1b[200~");
    // Only enough trailing text to recognize split native paste markers.
    for (const match of boundary.matchAll(/\x1b\[(200|201)~/g)) pasting = match[1] === "200";
    pasteTail = boundary.slice(-5);
    const nextJump = !transient && (keys.matches(data, "tui.editor.jumpForward") || keys.matches(data, "tui.editor.jumpBackward"));
    const cursor = editor.getCursor();
    if (!transient && matchesKey(data, Key.left) && cursor.line === 0 && cursor.col === 0 && !editor.isShowingAutocomplete()) {
      const owned = Object.keys(keys.getResolvedBindings()).some(action =>
        (action.startsWith("app.") || action.startsWith("tui.editor.") || action.startsWith("tui.input.")) && action !== "tui.editor.cursorLeft" &&
        keys.matches(data, action as Parameters<KeybindingsManager["matches"]>[1]));
      if (!owned) {
        const shortcut = editor.onExtensionShortcut;
        if (shortcut?.call(editor, data)) return;
        if (current.enterTree()) return;
        // A declined shortcut must not be called twice by CustomEditor. Keep
        // callback changes made by that shortcut (or by the focus attempt).
        const nextShortcut = editor.onExtensionShortcut;
        editor.onExtensionShortcut = undefined;
        try { originalInput.call(editor, data); }
        finally { if (editor.onExtensionShortcut === undefined) editor.onExtensionShortcut = nextShortcut; }
        return;
      }
    }
    // Capture dispatch state BEFORE native editing: Ctrl+D may delete the last
    // character. A declining extension shortcut can change that state, so check
    // again immediately after it runs, with the key delivered to CustomEditor.
    const shortcut = editor.onExtensionShortcut;
    let handled = false, appHandled = appConsumesInput(editor, keys, data);
    const observed = (value: string) => {
      const result = shortcut?.call(editor, value) ?? false;
      handled ||= result;
      if (!result) appHandled = appConsumesInput(editor, keys, value);
      return result;
    };
    editor.onExtensionShortcut = observed;
    try { originalInput.call(editor, data); }
    finally {
      if (editor.onExtensionShortcut === observed) editor.onExtensionShortcut = shortcut;
      if (!handled && !appHandled) jumping = nextJump;
    }
  };
  Object.defineProperty(editor, "handleInput", { configurable: true, enumerable: inputDescriptor?.enumerable ?? false, writable: true, value: input });
  Object.defineProperty(editor, "render", { configurable: true, enumerable: renderDescriptor?.enumerable ?? false, writable: true, value: render });
  return () => {
    // An outer decorator may still call us. Become a context-free pass-through
    // before restoring only properties that are still ours.
    active = undefined;
    if (Object.getOwnPropertyDescriptor(editor, "handleInput")?.value === input) {
      if (inputDescriptor) Object.defineProperty(editor, "handleInput", inputDescriptor);
      else delete (editor as Partial<TreeCompatibleEditor>).handleInput;
    }
    if (Object.getOwnPropertyDescriptor(editor, "render")?.value === render) {
      if (renderDescriptor) Object.defineProperty(editor, "render", renderDescriptor);
      else delete (editor as Partial<TreeCompatibleEditor>).render;
    }
  };
}

/** Standalone native fallback, using exactly the same boundary controller. */
export class TreeEditor extends CustomEditor {
  constructor(ui: TUI, theme: EditorTheme, keys: KeybindingsManager, enterTree: () => boolean,
    renderTree: Controls["renderTree"] = () => undefined) {
    super(ui, theme, keys);
    decorateTreeEditor(this, { keys, enterTree, renderTree });
  }
}
