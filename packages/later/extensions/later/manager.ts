import type {
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { insertLaterReference } from "./selection.ts";
import type { LaterStore } from "./store.ts";
import type {
	LaterItem,
	LaterLifecycle,
	LaterScope,
	LaterSource,
	RepositoryContext,
} from "./types.ts";

const LIFECYCLES = ["inbox", "archived", "deleted"] as const;
const MAX_VISIBLE_ITEMS = 12;
type ManagerMode = "list" | "search" | "add" | "edit" | "view" | "help" | "move";
type ManagerView = "here" | "global" | "all";

interface LaterManagerOptions {
	tui: TUI;
	theme: Theme;
	store: LaterStore;
	repository: RepositoryContext | null;
	source: LaterSource;
	onChanged(): void;
	done(reference: string | null): void;
}
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function scopeLabel(scope: LaterScope | LaterLifecycle): string {
	return scope[0].toUpperCase() + scope.slice(1);
}

export class LaterManager implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly store: LaterStore;
	private readonly repository: RepositoryContext | null;
	private readonly source: LaterSource;
	private readonly onChanged: () => void;
	private readonly done: (reference: string | null) => void;
	private readonly editor: Editor;
	private mode: ManagerMode = "list";
	private lifecycle: LaterLifecycle = "inbox";
	private view: ManagerView;
	private addScope: LaterScope;
	private moveScope: LaterScope = "session";
	private query = "";
	private queryBeforeSearch = "";
	private items: LaterItem[] = [];
	private counts: Record<LaterLifecycle, number> = { inbox: 0, archived: 0, deleted: 0 };
	private selectedIndex = 0;
	private message?: { kind: "success" | "error"; text: string };
	private cachedWidth?: number;
	private cachedLines?: string[];
	private _focused = false;
	constructor(options: LaterManagerOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.store = options.store;
		this.repository = options.repository;
		this.source = options.source;
		this.onChanged = options.onChanged;
		this.done = options.done;
		this.view = "here";
		this.addScope = "session";
		const editorTheme: EditorTheme = {
			borderColor: (text) => this.theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => this.theme.fg("accent", text),
				selectedText: (text) => this.theme.fg("accent", text),
				description: (text) => this.theme.fg("muted", text),
				scrollInfo: (text) => this.theme.fg("dim", text),
				noMatch: (text) => this.theme.fg("warning", text),
			},
		};
		this.editor = new Editor(this.tui, editorTheme);
		this.editor.onChange = () => {
			if (this.mode === "search") {
				this.query = this.editor.getText();
				this.refreshItems();
			}
			this.refresh();
		};
		this.editor.onSubmit = (value) => this.submitEditor(value);
		this.refreshItems();
	}
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}
	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.editor.invalidate();
	}
	private refresh(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.tui.requestRender();
	}
	refreshFromStore(): void {
		if (
			this.mode === "add" ||
			this.mode === "edit" ||
			this.mode === "move" ||
			this.mode === "view"
		) {
			return;
		}
		this.refreshItems();
		this.refresh();
	}
	private sessionId(): string {
		return this.source.sessionId ?? "";
	}
	private countForView(lifecycle: LaterLifecycle): number {
		if (this.view === "here") {
			const sessionCount = this.store.count({
				scope: "session",
				sessionId: this.sessionId(),
				lifecycle,
			});
			const projectCount = this.repository
				? this.store.count({
						scope: "project",
						repositoryId: this.repository.id,
						lifecycle,
					})
				: 0;
			return sessionCount + projectCount;
		}
		return this.store.count({
			scope: this.view,
			sessionId: this.sessionId(),
			lifecycle,
		});
	}
	private listForView(): LaterItem[] {
		const common = {
			lifecycle: this.lifecycle,
			query: this.query,
			limit: null,
		} as const;
		if (this.view === "here") {
			const sessionItems = this.store.list({
				...common,
				scope: "session",
				sessionId: this.sessionId(),
			});
			const projectItems = this.repository
				? this.store.list({
						...common,
						scope: "project",
						repositoryId: this.repository.id,
					})
				: [];
			return [...sessionItems, ...projectItems];
		}
		return this.store.list({
			...common,
			scope: this.view,
			sessionId: this.sessionId(),
		});
	}
	private refreshItems(): void {
		for (const lifecycle of LIFECYCLES) {
			this.counts[lifecycle] = this.countForView(lifecycle);
		}
		this.items = this.listForView();
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.items.length - 1));
	}
	private selectedItem(): LaterItem | undefined {
		return this.items[this.selectedIndex];
	}
	private setMode(mode: ManagerMode, initialText = ""): void {
		this.mode = mode;
		this.message = undefined;
		if (mode === "search" || mode === "add" || mode === "edit") this.editor.setText(initialText);
		this.refresh();
	}
	private cycleAddScope(): void {
		const choices: LaterScope[] = this.repository
			? ["session", "project", "global"]
			: ["session", "global"];
		this.addScope = choices[(choices.indexOf(this.addScope) + 1) % choices.length];
		this.refresh();
	}
	private submitEditor(value: string): void {
		if (this.mode === "search") {
			this.query = value.trim();
			this.mode = "list";
			this.refreshItems();
			this.refresh();
			return;
		}
		const text = value.trim();
		if (!text) {
			this.message = { kind: "error", text: "Text must not be empty" };
			this.refresh();
			return;
		}
		try {
			if (this.mode === "add") {
				const item = this.store.add({
					repository: this.addScope === "project" ? this.repository : null,
					scope: this.addScope,
					ownerSessionId: this.sessionId(),
					text,
					source: this.source,
				});
				this.message = {
					kind: "success",
					text: `Saved later:${item.id} to ${scopeLabel(item.scope)}`,
				};
			} else if (this.mode === "edit") {
				const selected = this.selectedItem();
				if (!selected) throw new Error("No later item is selected");
				const item = this.store.update(selected.id, { text }, this.sessionId());
				if (!item) throw new Error("Later item not found");
				this.message = { kind: "success", text: `Updated ${item.id}` };
			}
			this.mode = "list";
			this.editor.setText("");
			this.onChanged();
			this.refreshItems();
		} catch (error) {
			this.message = { kind: "error", text: errorMessage(error) };
		}
		this.refresh();
	}
	private mutate(operation: (item: LaterItem, sessionId: string) => LaterItem | undefined): void {
		const selected = this.selectedItem();
		if (!selected) return;
		try {
			const item = operation(selected, this.sessionId());
			if (!item) throw new Error("Later item not found");
			this.message = { kind: "success", text: `${item.id} is now ${item.lifecycle}` };
			this.onChanged();
			this.refreshItems();
		} catch (error) {
			this.message = { kind: "error", text: errorMessage(error) };
		}
		this.refresh();
	}
	private selectLifecycle(lifecycle: LaterLifecycle): void {
		this.lifecycle = lifecycle;
		this.selectedIndex = 0;
		this.mode = "list";
		this.message = undefined;
		this.refreshItems();
		this.refresh();
	}
	private cycleLifecycle(direction: -1 | 1): void {
		const current = LIFECYCLES.indexOf(this.lifecycle);
		const next = (current + direction + LIFECYCLES.length) % LIFECYCLES.length;
		this.selectLifecycle(LIFECYCLES[next]);
	}
	private setView(view: ManagerView): void {
		this.view = view;
		this.selectedIndex = 0;
		this.mode = "list";
		this.message = undefined;
		this.refreshItems();
		this.refresh();
	}
	private cycleView(): void {
		const views: ManagerView[] = ["here", "global", "all"];
		this.setView(views[(views.indexOf(this.view) + 1) % views.length]);
	}
	private submitMove(): void {
		const selected = this.selectedItem();
		if (!selected) return;
		try {
			const item = this.store.move(
				selected.id,
				{
					scope: this.moveScope,
					repository: this.moveScope === "project" ? this.repository : null,
					ownerSessionId: this.sessionId(),
				},
				this.sessionId(),
			);
			if (!item) throw new Error("Later item not found");
			this.message = { kind: "success", text: `Moved ${item.id} to ${scopeLabel(item.scope)}` };
			this.mode = "list";
			this.onChanged();
			this.refreshItems();
		} catch (error) {
			this.message = { kind: "error", text: errorMessage(error) };
		}
		this.refresh();
	}
	handleInput(data: string): void {
		if (this.mode === "search" || this.mode === "add" || this.mode === "edit") {
			if (matchesKey(data, Key.escape)) {
				if (this.mode === "search") this.query = this.queryBeforeSearch;
				this.mode = "list";
				this.editor.setText("");
				this.refreshItems();
				this.refresh();
				return;
			}
			if (this.mode === "add" && matchesKey(data, Key.tab)) {
				this.cycleAddScope();
				return;
			}
			this.editor.handleInput(data);
			this.refresh();
			return;
		}
		if (this.mode === "move") {
			if (matchesKey(data, Key.escape)) {
				this.mode = "list";
				this.refreshItems();
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.tab)) {
				this.cycleAddScope();
				this.moveScope = this.addScope;
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) this.submitMove();
			return;
		}
		if (this.mode === "view" || this.mode === "help") {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.space)) {
				this.mode = "list";
				this.refreshItems();
				this.refresh();
			}
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.cycleLifecycle(-1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.cycleLifecycle(1);
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.selectedIndex = Math.min(Math.max(0, this.items.length - 1), this.selectedIndex + 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const selected = this.selectedItem();
			if (selected) this.done(`later:${selected.id}`);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.cycleView();
			return;
		}
		if (data === "h") {
			this.setView("here");
			return;
		}
		if (data === "g") {
			this.setView("global");
			return;
		}
		if (data === "A") {
			this.setView("all");
			return;
		}
		if (data === "1" || data === "2" || data === "3") {
			this.selectLifecycle(LIFECYCLES[Number(data) - 1]);
			return;
		}
		if (data === "/") {
			this.queryBeforeSearch = this.query;
			this.setMode("search", this.query);
			return;
		}
		if (data === "a") {
			const selected = this.selectedItem();
			this.addScope =
				this.view === "here"
					? selected?.scope === "project"
						? "project"
						: "session"
					: this.view === "global"
						? "global"
						: this.repository
							? "project"
							: "global";
			this.setMode("add");
			return;
		}
		if (data === "e") {
			const selected = this.selectedItem();
			if (selected) this.setMode("edit", selected.text);
			return;
		}
		if (matchesKey(data, Key.space) || data === "v") {
			if (this.selectedItem()) this.setMode("view");
			return;
		}
		if (data === "m") {
			const selected = this.selectedItem();
			if (selected) {
				this.moveScope = selected.scope;
				this.addScope = selected.scope;
				this.setMode("move");
			}
			return;
		}
		if (data === "x") {
			this.mutate((item, sessionId) => this.store.archive(item.id, sessionId));
			return;
		}
		if (data === "d") {
			this.mutate((item, sessionId) => this.store.softDelete(item.id, sessionId));
			return;
		}
		if (data === "r") {
			this.mutate((item, sessionId) => this.store.restore(item.id, sessionId));
			return;
		}
		if (data === "c") {
			this.query = "";
			this.refreshItems();
			this.refresh();
			return;
		}
		if (data === "?") {
			this.setMode("help");
			return;
		}
		if (matchesKey(data, Key.escape)) this.done(null);
	}
	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const renderWidth = Math.max(1, width);
		const lines: string[] = [];
		const add = (text = "") => lines.push(truncateToWidth(text, renderWidth, ""));
		const addWrapped = (text: string, prefix = "") => {
			const wrapped = wrapTextWithAnsi(text, Math.max(1, renderWidth - visibleWidth(prefix)));
			wrapped.forEach((line, index) =>
				add(`${index ? " ".repeat(visibleWidth(prefix)) : prefix}${line}`),
			);
		};
		add(this.theme.fg("accent", "-".repeat(renderWidth)));
		const viewTabs: Array<{ view: ManagerView; label: string }> = [
			{
				view: "here",
				label: this.repository ? `Here: ${this.repository.displayName}` : "Here",
			},
			{ view: "global", label: "Global" },
			{ view: "all", label: "Everywhere" },
		];
		add(
			` ${this.theme.fg("accent", this.theme.bold("Later"))}  ${this.theme.fg("muted", "View:")} ${viewTabs
				.map(({ view, label }) =>
					view === this.view
						? this.theme.fg("accent", this.theme.bold(`[${label}]`))
						: this.theme.fg("dim", label),
				)
				.join("   ")}`,
		);
		add(
			`        ${this.theme.fg("muted", "State:")} ${this.theme.fg("dim", "<")} ${LIFECYCLES.map(
				(lifecycle) => {
					const active = lifecycle === this.lifecycle;
					const label = `${scopeLabel(lifecycle)} (${this.counts[lifecycle]})`;
					return active
						? this.theme.fg("accent", this.theme.bold(`[${label}]`))
						: this.theme.fg("dim", label);
				},
			).join(this.theme.fg("dim", " | "))} ${this.theme.fg("dim", ">")}`,
		);
		if (this.mode === "help") {
			lines.push("");
			[
				"Up/Down or j/k navigate",
				"Enter insert selected reference",
				"/ search, c clear search",
				"a add, e edit, m move",
				"Space/v view full item",
				"x/d/r archive, delete, restore",
				"Left/Right switch inbox, archived, deleted",
				"1/2/3 select a lifecycle directly",
				"Tab cycle Here/Global/Everywhere",
				"h/g/A open Here, Global, or Everywhere",
				"Esc close",
			].forEach((help) => add(` ${this.theme.fg("muted", help)}`));
		} else if (this.mode === "view") {
			const item = this.selectedItem();
			lines.push("");
			if (item) {
				add(
					` ${this.theme.fg("accent", item.id)} ${this.theme.fg("muted", `[${item.lifecycle}, ${item.scope}]`)}`,
				);
				add(` ${this.theme.fg("dim", item.repositoryName ?? "")}`);
				lines.push("");
				addWrapped(item.text, " ");
				if (item.context) {
					lines.push("");
					add(` ${this.theme.fg("muted", "Context")}`);
					addWrapped(item.context, " ");
				}
			}
			lines.push("");
			add(` ${this.theme.fg("dim", "Space or Esc to return")}`);
		} else if (this.mode === "move") {
			lines.push("");
			add(` ${this.theme.fg("muted", `Move to: ${scopeLabel(this.moveScope)}`)}`);
			add(` ${this.theme.fg("dim", "Tab changes destination - Enter moves - Esc cancels")}`);
		} else {
			if (this.query)
				add(` ${this.theme.fg("muted", "Search:")} ${this.theme.fg("accent", this.query)}`);
			lines.push("");
			const start = Math.max(
				0,
				Math.min(
					this.selectedIndex - Math.floor(MAX_VISIBLE_ITEMS / 2),
					this.items.length - MAX_VISIBLE_ITEMS,
				),
			);
			const visibleItems = this.items.slice(start, start + MAX_VISIBLE_ITEMS);
			const renderItem = (item: LaterItem, index: number) => {
				const selected = index === this.selectedIndex;
				add(
					`${selected ? this.theme.fg("accent", "> ") : "  "}${this.theme.fg(selected ? "accent" : "muted", item.id)}${this.view === "all" && item.repositoryName ? this.theme.fg("dim", ` ${item.repositoryName}`) : ""} ${this.theme.fg(selected ? "text" : "muted", `[${item.scope}] ${oneLine(item.text)}`)}`,
				);
			};
			if (this.view === "here") {
				const scopes: LaterScope[] = this.repository ? ["session", "project"] : ["session"];
				for (const scope of scopes) {
					const scopedItems = this.items.filter((item) => item.scope === scope);
					add(
						` ${this.theme.fg("accent", scopeLabel(scope))} ${this.theme.fg("dim", `(${scopedItems.length})`)}`,
					);
					const visibleScopedItems = visibleItems.filter((item) => item.scope === scope);
					if (!scopedItems.length) {
						add(`   ${this.theme.fg("dim", "No matching items")}`);
					} else if (!visibleScopedItems.length) {
						add(`   ${this.theme.fg("dim", "...")}`);
					} else {
						for (const item of visibleScopedItems) renderItem(item, this.items.indexOf(item));
					}
					if (scope !== scopes[scopes.length - 1]) lines.push("");
				}
			} else if (!this.items.length) {
				add(` ${this.theme.fg("dim", "No matching later items.")}`);
			} else {
				visibleItems.forEach((item, offset) => renderItem(item, start + offset));
			}
			if (this.mode === "search" || this.mode === "add" || this.mode === "edit") {
				lines.push("");
				const label =
					this.mode === "search"
						? "Search"
						: this.mode === "add"
							? `New item - ${scopeLabel(this.addScope)}`
							: "Edit item";
				add(` ${this.theme.fg("muted", `${label}:`)}`);
				this.editor.render(Math.max(1, renderWidth - 2)).forEach((line) => add(` ${line}`));
				add(
					` ${this.theme.fg("dim", this.mode === "add" ? "Tab changes destination - Enter saves - Esc cancels" : "Enter applies - Esc cancels")}`,
				);
			} else {
				lines.push("");
				add(` ${this.theme.fg("dim", "Tab view - Left/Right state - Up/Down items - ? help")}`);
			}
		}
		if (this.message) {
			lines.push("");
			add(
				` ${this.theme.fg(this.message.kind === "error" ? "error" : "success", this.message.text)}`,
			);
		}
		add(this.theme.fg("accent", "-".repeat(renderWidth)));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

interface CaptureResult {
	text: string;
	scope: LaterScope;
}
class LaterCapture implements Component, Focusable {
	private readonly input = new Input();
	private scope: LaterScope = "session";
	private _focused = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly repository: RepositoryContext | null,
		private readonly done: (result: CaptureResult | undefined) => void,
	) {
		this.input.onSubmit = (text) => {
			if (text.trim()) done({ text: text.trim(), scope: this.scope });
		};
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	invalidate(): void {
		this.input.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			const scopes: LaterScope[] = this.repository
				? ["session", "project", "global"]
				: ["session", "global"];
			this.scope = scopes[(scopes.indexOf(this.scope) + 1) % scopes.length];
			this.tui.requestRender();
			return;
		}
		this.input.handleInput(data);
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		return [
			truncateToWidth(
				` ${this.theme.fg("accent", "Later capture")} ${this.theme.fg("muted", `- ${scopeLabel(this.scope)}`)}`,
				width,
				"",
			),
			...this.input.render(contentWidth).map((line) => truncateToWidth(` ${line}`, width, "")),
			truncateToWidth(
				` ${this.theme.fg("dim", "Tab changes destination - Enter saves - Esc cancels")}`,
				width,
				"",
			),
		];
	}
}
export async function showLaterCapture(
	ctx: ExtensionContext,
	repository: RepositoryContext | null,
): Promise<CaptureResult | undefined> {
	return ctx.ui.custom(
		(tui, theme, _keybindings, done) => new LaterCapture(tui, theme, repository, done),
	);
}
interface ShowLaterManagerOptions {
	ctx: ExtensionCommandContext;
	store: LaterStore;
	repository: RepositoryContext | null;
	source: LaterSource;
	onChanged(): void;
	subscribeChanged(listener: () => void): () => void;
}
export async function showLaterManager(options: ShowLaterManagerOptions): Promise<void> {
	const { ctx, store, repository, source, onChanged, subscribeChanged } = options;
	let tui: TUI | undefined;
	let unsubscribe = () => {};
	let reference: string | null = null;
	try {
		reference = await ctx.ui.custom<string | null>((currentTui, theme, _keybindings, done) => {
			tui = currentTui;
			const manager = new LaterManager({
				tui: currentTui,
				theme,
				store,
				repository,
				source,
				onChanged,
				done,
			});
			unsubscribe = subscribeChanged(() => manager.refreshFromStore());
			return manager;
		});
	} finally {
		unsubscribe();
	}
	if (!tui) return;
	insertLaterReference(reference, ctx.ui, tui);
}
