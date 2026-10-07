import { stripVTControlCharacters } from "node:util";
import { CustomEditor, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, Loader, matchesKey, SelectList, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { decorateTreeEditor, type TreeCompatibleEditor } from "./tree-editor.ts";
import { agentTree, type TreeNode, type TreeSource } from "./tree.ts";
import { relevantTree } from "./relevance.ts";
import { metadataText, runElapsed, shortId, statusColor, statusMark } from "./presentation.ts";

const MAX_INDENT = 3;
interface Branch { nextSibling: boolean; ancestors: Branch[] }

/** Geometry for the filtered tree, before viewport clipping. Keep ancestry bounded. */
function branches(nodes: TreeNode[]): Branch[] {
  const path: Branch[] = [];
  return nodes.map(({ depth }) => {
    if (path[depth]) path[depth].nextSibling = true;
    path.length = depth;
    // Root rows have no connector. Retain only the ancestor columns we render;
    // references pick up later siblings without copying full paths in deep trees.
    const branch: Branch = { nextSibling: false, ancestors: path.slice(1, MAX_INDENT) };
    path.push(branch);
    return branch;
  });
}

const EMPTY_RELEVANT = "No unacknowledged subagents";

/** One bounded inline tree; focus changes input ownership, never composer contents. */
export class SubagentOverview implements Component {
  private acknowledged: ReadonlySet<string> = new Set();
  private nodes: TreeNode[] = [];
  private branches: Branch[] = [];
  private allNodes: TreeNode[] = [];
  private relevant: TreeNode[] = [];
  private mode: "Relevant" | "All" = "Relevant";
  // Overlay blur releases input, not the user's browsing selection/mode.
  private browsing = false;
  private ownsInput = false;
  get focused(): boolean { return this.ownsInput; }
  set focused(value: boolean) {
    if (value && !this.browsing && !this.relevant.length && this.allNodes.length) {
      this.mode = "All";
      this.updateNodes();
    }
    this.ownsInput = value;
    if (value) this.browsing = true;
  }
  private selectedId: string | undefined;
  private list: SelectList | undefined;
  private capacity = 1;
  private members = new Set<string>();
  private unsubscribe: () => void;
  private loader: Loader | undefined;
  private elapsedTimer: ReturnType<typeof setInterval> | undefined;
  private marker = "●";
  private disposed = false;
  constructor(private source: TreeSource, private ui: TUI, private theme: Theme,
    private controls?: { keys: KeybindingsManager; inspect(id: string): void; leave(data?: string): void },
    private now: () => number = Date.now) {
    this.unsubscribe = source.subscribe(() => {
      if (this.disposed) return;
      this.refresh(); this.ui.requestRender();
    });
    this.refresh();
  }
  private refresh(): void {
    const snapshot = this.source.snapshot();
    const batch = relevantTree(snapshot, this.acknowledged);
    this.allNodes = agentTree(snapshot); this.relevant = batch.nodes; this.members = batch.members;
    this.updateNodes();
  }
  private syncClock(): void {
    const running = this.nodes.some(node => node.status === "running");
    const ticking = this.nodes.some(node => node.run?.phase !== "terminal" && runElapsed(node.run, this.now()) !== undefined);
    if (!running && this.loader) { this.loader.stop(); this.loader = undefined; }
    if (running || !ticking) { clearInterval(this.elapsedTimer); this.elapsedTimer = undefined; }
    if (running && !this.loader) {
      // Loader's public color callback supplies its current frame. The component
      // owns every render request and stop(), because Loader has no dispose().
      this.loader = new Loader(this.ui,
        frame => { this.marker = frame; return frame; }, value => value, "");
    } else if (!running && ticking && !this.elapsedTimer) this.elapsedTimer = setInterval(() => {
      if (!this.disposed) this.ui.requestRender();
    }, 1000);
  }
  private updateNodes(): void {
    this.nodes = this.mode === "All" ? this.allNodes : this.relevant;
    this.branches = branches(this.nodes);
    if (!this.browsing || !this.nodes.some(node => node.record.id === this.selectedId)) this.selectedId = this.passiveAnchor()?.record.id;
    this.list = undefined;
    this.syncClock();
    if (!this.allNodes.length && this.focused) this.controls?.leave();
  }
  private passiveAnchor(): TreeNode | undefined {
    return this.nodes.find(node => node.status === "running") ?? this.nodes.find(node => node.status === "waiting")
      ?? this.nodes.find(node => this.members.has(node.record.id)) ?? this.nodes[0];
  }
  /** Explicit prompt return ends browsing; overlay focus changes do not. */
  resetBrowsing(): void {
    if (this.disposed) return;
    this.browsing = false; this.mode = "Relevant"; this.selectedId = undefined; this.updateNodes();
  }
  setAcknowledgedRuns(ids: ReadonlySet<string>): void {
    if (this.disposed) return;
    this.acknowledged = new Set(ids); this.refresh(); this.ui.requestRender();
  }
  hasAgents(): boolean { return !this.disposed && this.allNodes.length > 0; }
  getSelectedAgentId(): string | undefined { return this.selectedId; }
  getMode(): "Relevant" | "All" { return this.mode; }
  private selector(): SelectList {
    if (!this.list) {
      const plain = (value: string) => value;
      this.list = new SelectList(this.nodes.map(node => ({ value: node.record.id, label: node.record.name })), this.capacity,
        { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain });
      this.list.setSelectedIndex(Math.max(0, this.nodes.findIndex(node => node.record.id === this.selectedId)));
      this.list.onSelectionChange = item => { this.selectedId = item.value; };
    }
    return this.list;
  }
  handleInput(data: string): void {
    if (this.disposed || !this.focused || !this.controls) return;
    const { keys } = this.controls;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) this.controls.leave();
    else if (matchesKey(data, Key.tab)) { this.mode = this.mode === "Relevant" ? "All" : "Relevant"; this.updateNodes(); }
    else if (matchesKey(data, Key.right) || keys.matches(data, "tui.select.confirm")) { if (this.selectedId) this.controls.inspect(this.selectedId); }
    else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
      const index = this.nodes.findIndex(node => node.record.id === this.selectedId);
      const list = this.selector();
      list.setSelectedIndex(index + (keys.matches(data, "tui.select.up") ? -1 : 1));
      this.selectedId = list.getSelectedItem()?.value;
    } else if (matchesKey(data, Key.home) || matchesKey(data, Key.end) || keys.matches(data, "tui.select.pageUp") || keys.matches(data, "tui.select.pageDown")) {
      const index = this.nodes.findIndex(node => node.record.id === this.selectedId);
      const target = matchesKey(data, Key.home) ? 0 : matchesKey(data, Key.end) ? this.nodes.length - 1
        : index + (keys.matches(data, "tui.select.pageUp") ? -this.capacity : this.capacity);
      const list = this.selector(); list.setSelectedIndex(target); this.selectedId = list.getSelectedItem()?.value;
    } else this.controls.leave(data); // Typing and app shortcuts go to the actual editor exactly once.
    this.ui.requestRender();
  }
  private window(capacity: number): { nodes: TreeNode[]; start: number; end: number; above: number; below: number } {
    const anchor = this.focused || this.mode === "All" ? this.selectedId : this.passiveAnchor()?.record.id;
    const index = Math.max(0, this.nodes.findIndex(node => node.record.id === anchor));
    const start = Math.max(0, Math.min(index - Math.floor(capacity / 2), this.nodes.length - capacity));
    const end = Math.min(this.nodes.length, start + capacity);
    return { nodes: this.nodes.slice(start, end), start, end, above: start, below: this.nodes.length - end };
  }
  /** Keep native borders, wrapping and scroll indicators; remove cursor paint. */
  renderInactivePrompt(lines: string[]): string[] {
    return lines.map(line => this.theme.fg("dim", stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, ""))));
  }
  renderFocusedSelection(width: number): string[] {
    if (this.disposed || !this.focused || !this.allNodes.length || width <= 0) return [];
    if (!this.nodes.length) return [truncateToWidth(this.theme.fg("muted", EMPTY_RELEVANT), width)];
    const index = Math.max(0, this.nodes.findIndex(node => node.record.id === this.selectedId));
    const { record, status, run } = this.nodes[index];
    const marker = this.theme.fg(statusColor(status), status === "running" ? this.marker : statusMark[status]);
    const diagnostic = status === "running" || status === "finished" ? "" : ` · ${this.theme.fg(statusColor(status), status)}`;
    const suffix = `${diagnostic} · ${index + 1}/${this.nodes.length}${this.mode === "All" ? " · [All]" : ""}`;
    const identity = width >= 48 ? this.theme.fg("dim", ` [${shortId(record.id)}]`) : "";
    const prefix = `› ${marker} `;
    const nameBudget = Math.max(1, width - visibleWidth(prefix + identity + suffix));
    let selected = prefix + this.theme.fg("text", truncateToWidth(metadataText(record.name), nameBudget)) + identity + suffix;
    const elapsed = runElapsed(run, this.now());
    const timing = elapsed ? this.theme.fg("dim", ` · ${elapsed}`) : "";
    if (visibleWidth(selected + timing) <= width) selected += timing;
    return [truncateToWidth(selected, width)];
  }
  render(width: number): string[] {
    if (this.disposed || (!this.nodes.length && (!this.focused || !this.allNodes.length)) || width <= 0) return [];
    const height = Math.max(0, Math.floor(this.ui.terminal.rows));
    const budget = Math.min(8, height, Math.max(1, Math.floor(height / 4)));
    if (!budget) return [];

    const title = this.theme.fg(this.focused ? "accent" : "muted", this.theme.bold("Subagents"))
      + this.theme.fg("dim", this.mode === "All" ? "  [All] " : " ");
    const header = title + this.theme.fg(this.focused ? "borderAccent" : "borderMuted", "─".repeat(Math.max(0, width - visibleWidth(title))));
    if (budget === 1 && this.focused) {
      this.capacity = 1;
      return this.renderFocusedSelection(width);
    }
    if (!this.nodes.length) return [header, this.theme.fg("muted", EMPTY_RELEVANT)]
      .slice(0, budget).map(line => truncateToWidth(line, width));
    // Always leave at least one identity row. Decoration yields to narrow panes.
    const available = Math.max(1, budget - (budget >= 2 ? 1 : 0));
    const overflowFooter = this.nodes.length > available && available > 1;
    const capacity = available - Number(overflowFooter);
    this.capacity = Math.max(1, capacity);
    const window = this.window(capacity);
    const now = this.now();
    const rows = window.nodes.map((node, offset) => {
      const { record, depth, status, run } = node;
      const indentLimit = Math.max(0, Math.min(MAX_INDENT, Math.floor((width - 24) / 4)));
      const selected = this.focused && record.id === this.selectedId;
      const indent = selected ? "› " : "  ";
      const geometry = this.branches[window.start + offset];
      const columns = Math.min(depth, indentLimit);
      const branch = depth ? this.theme.fg("dim", (columns ? "  " : "")
        + geometry.ancestors.slice(0, Math.max(0, columns - 1)).map(ancestor => ancestor.nextSibling ? "│ " : "  ").join("")
        + (geometry.nextSibling ? "├─ " : "└─ ")) : "";
      const context = this.mode === "All" || this.members.has(record.id) || width < 48 ? "" : this.theme.fg("dim", " · context");
      const nesting = depth > indentLimit && width >= 24 ? this.theme.fg("dim", ` · depth ${depth + 1}`) : "";
      const marker = this.theme.fg(statusColor(status), status === "running" ? this.marker : statusMark[status]);
      const diagnostic = status === "running" || status === "finished" ? "" : ` · ${this.theme.fg(statusColor(status), status)}`;
      const suffix = diagnostic + context + nesting;
      const identity = width >= 48 ? this.theme.fg("dim", ` [${shortId(record.id)}]`) : "";
      const prefix = `${indent}${branch}${marker} `;
      // Keep identity and exceptional states ahead of optional model metadata.
      const nameBudget = Math.max(1, width - visibleWidth(prefix + identity + suffix));
      const name = truncateToWidth(metadataText(record.name), nameBudget);
      let line = prefix + this.theme.fg("text", name) + identity;
      const secondary = this.theme.fg("dim", ` · ${metadataText(record.model)} · thinking: ${metadataText(record.effectiveThinking)}`);
      if (visibleWidth(line + secondary + suffix) <= width) line += secondary;
      line += suffix;
      const elapsed = runElapsed(run, now);
      const timing = elapsed ? this.theme.fg("dim", ` · ${elapsed}`) : "";
      if (visibleWidth(line + timing) <= width) line += timing;
      return line;
    });
    const overflow = [window.above ? `↑ ${window.above} above` : "", window.below ? `↓ ${window.below} below` : ""].filter(Boolean).join(" · ");
    return [...(budget >= 2 ? [header] : []), ...rows,
      ...(overflowFooter && overflow ? [this.theme.fg("muted", overflow)] : [])]
      .slice(0, budget).map(line => truncateToWidth(line, width));
  }
  invalidate(): void { /* Theme-dependent strings are rebuilt on every render. */ }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.focused = false; this.unsubscribe(); this.loader?.stop(); this.loader = undefined;
    clearInterval(this.elapsedTimer); this.elapsedTimer = undefined;
  }
}

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;
type EditorBinding = { owner?: OverviewAttachment };

/** Root-only ownership, idempotent attachment, and explicit pre-shutdown cleanup. */
export class OverviewAttachment {
  private source: TreeSource | undefined;
  private context: ExtensionContext | undefined;
  private component: SubagentOverview | undefined;
  private editor: TreeCompatibleEditor | undefined;
  private ui: TUI | undefined;
  private keys: KeybindingsManager | undefined;
  private editorContext: ExtensionContext | undefined;
  private factory: EditorFactory | undefined;
  private predecessor: EditorFactory | undefined;
  private observedFactory: EditorFactory | undefined;
  private binding: EditorBinding | undefined;
  private widgetBinding: EditorBinding | undefined;
  private undecorate: (() => void) | undefined;
  private generation = 0;
  private inspect: ((id: string) => void) | undefined;
  private warned = false;
  private acknowledged: ReadonlySet<string> = new Set();

  setAcknowledgedRuns(ids: ReadonlySet<string>): void {
    this.acknowledged = new Set(ids);
    this.component?.setAcknowledgedRuns(this.acknowledged);
  }

  installEditor(ctx: ExtensionContext, inspect: (id: string) => void): void {
    if (ctx.mode !== "tui") return;
    if (this.binding && this.observedFactory === ctx.ui.getEditorComponent()) {
      this.editorContext = ctx; this.inspect = inspect;
      return;
    }
    this.disposeEditor();
    this.inspect = inspect; this.editorContext = ctx;
    this.predecessor = ctx.ui.getEditorComponent();
    this.binding = { owner: this };
    this.factory = OverviewAttachment.chain(this.predecessor, this.binding);
    ctx.ui.setEditorComponent(this.factory);
  }
  // Kept outside the instance closure: after disposal a retained outer factory
  // only holds a cleared binding and the predecessor, not a session or its UI.
  private static chain(predecessor: EditorFactory | undefined, binding: EditorBinding): EditorFactory {
    return (ui, theme, keys) => {
      binding.owner?.releaseDecoration();
      const editor = predecessor ? predecessor(ui, theme, keys) : new CustomEditor(ui, theme, keys);
      binding.owner?.bindEditor(editor, ui, keys);
      return editor;
    };
  }
  private bindEditor(editor: ReturnType<EditorFactory>, ui: TUI, keys: KeybindingsManager): void {
    // Pi publishes the outer factory before invoking the chain. Both owned
    // factories return this same instance; a later replacement cannot inherit
    // operational ownership without actually invoking us again.
    this.observedFactory = this.editorContext?.ui.getEditorComponent();
    const generation = ++this.generation;
    const undecorate = decorateTreeEditor(editor, {
      keys, enterTree: () => generation === this.generation && this.editor === editor && this.focus(),
      renderTree: (width, renderNative) => generation !== this.generation || !this.ownsEditor() || !this.component?.focused ? undefined
        // Native fullscreen layout clips the widget in these short panes.
        : ui.mode === "fullscreen" && ui.terminal.rows <= 8 ? this.component.renderFocusedSelection(width)
        : this.component.renderInactivePrompt(renderNative()),
    });
    if (!undecorate) {
      if (!this.warned) this.editorContext?.ui.notify("Subagents: keeping the unsupported custom editor unchanged. Inline tree focus is unavailable; use /subagents <id> to inspect.", "warning");
      this.warned = true;
      return;
    }
    this.undecorate = undecorate; this.editor = editor as TreeCompatibleEditor; this.ui = ui; this.keys = keys;
  }
  private releaseDecoration(): void {
    ++this.generation;
    this.undecorate?.(); this.undecorate = undefined;
    this.editor = undefined; this.ui = undefined; this.keys = undefined;
  }
  private ownsEditor(): boolean {
    return !!this.editor && !!this.factory && this.editorContext?.ui.getEditorComponent() === this.observedFactory;
  }
  focus(): boolean {
    if (!this.ownsEditor() || !this.component?.hasAgents()) return false;
    this.ui!.setFocus(this.component); this.ui!.requestRender();
    return true;
  }
  returnToEditor(data?: string): void {
    if (!this.ownsEditor()) return;
    this.ui!.setFocus(this.editor!);
    this.component?.resetBrowsing();
    if (data) this.editor!.handleInput(data);
    this.ui!.requestRender();
  }
  private disposeEditor(): void {
    const ctx = this.editorContext, factory = this.factory, predecessor = this.predecessor;
    if (this.binding) this.binding.owner = undefined;
    this.binding = undefined; this.releaseDecoration();
    this.editorContext = undefined; this.factory = undefined; this.predecessor = undefined; this.observedFactory = undefined;
    this.inspect = undefined;
    // Operational ownership of an outer chain is not permission to replace it.
    // Reload may also have cleared the host factory before session_shutdown.
    if (factory && ctx?.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(predecessor);
  }
  attach(ctx: ExtensionContext, source: TreeSource): void {
    if (ctx.mode !== "tui") return;
    if (this.source === source && this.context) return;
    this.detachWidget();
    this.source = source; this.context = ctx;
    this.widgetBinding = { owner: this };
    ctx.ui.setWidget("subagents", OverviewAttachment.widgetFactory(this.widgetBinding), { placement: "aboveEditor" });
  }
  private static widgetFactory(binding: EditorBinding): (ui: TUI, theme: Theme) => Component {
    return (ui, theme) => {
      const owner = binding.owner;
      if (!owner?.source) return { render: () => [], invalidate() {}, dispose() {} };
      owner.component?.dispose();
      owner.component = new SubagentOverview(owner.source, ui, theme, owner.keys ? {
        keys: owner.keys, inspect: id => binding.owner?.inspect?.(id), leave: data => binding.owner?.returnToEditor(data),
      } : undefined);
      owner.component.setAcknowledgedRuns(owner.acknowledged);
      return owner.component;
    };
  }
  private detachWidget(): void {
    if (this.component?.focused) this.returnToEditor();
    this.component?.dispose(); this.component = undefined;
    if (this.widgetBinding) this.widgetBinding.owner = undefined;
    this.widgetBinding = undefined;
    const ctx = this.context;
    this.context = undefined; this.source = undefined;
    ctx?.ui.setWidget("subagents", undefined);
  }
  dispose(): void {
    this.detachWidget(); this.disposeEditor(); this.inspect = undefined; this.keys = undefined;
  }
}
