import { type FSWatcher, watch } from "node:fs";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, truncateToWidth } from "@earendil-works/pi-tui";
import { parseDirectCapture } from "./capture.ts";
import { showLaterCapture, showLaterManager } from "./manager.ts";
import { resolveRepository } from "./repository.ts";
import { LaterStore } from "./store.ts";
import { registerLaterTool, sourceFromContext } from "./tool.ts";
import type { LaterScope, RepositoryContext } from "./types.ts";

const DATABASE_PATH = join(getAgentDir(), "data", "later", "later.sqlite");
const STORE_CHANGED_EVENT = "later/store-changed/v1";
const STATUS_ID = "later-inbox";
const WIDGET_ID = "later-session-inbox";

function scopeLabel(scope: LaterScope): string {
	return scope[0].toUpperCase() + scope.slice(1);
}

const SCOPE_COMPLETIONS: AutocompleteItem[] = [
	{ value: "--session", label: "--session", description: "Save only for this session" },
	{ value: "--project", label: "--project", description: "Save for the current repository" },
	{ value: "--global", label: "--global", description: "Save across repositories" },
];

function getCaptureCompletions(prefix: string): AutocompleteItem[] | null {
	const value = prefix.trimStart();
	if (value.includes(" ")) return null;
	const matches = SCOPE_COMPLETIONS.filter((item) => item.value.startsWith(value));
	return matches.length ? matches : null;
}

export default function later(pi: ExtensionAPI): void {
	let store: LaterStore | undefined;
	let statusContext: ExtensionContext | undefined;
	let storeWatcher: FSWatcher | undefined;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	const getStore = () => (store ??= new LaterStore(DATABASE_PATH));
	const getRepository = (cwd: string): Promise<RepositoryContext | null> =>
		resolveRepository(pi, cwd);
	const refreshUI = async () => {
		const ctx = statusContext;
		if (!ctx) return;
		try {
			const repository = await getRepository(ctx.cwd);
			if (ctx !== statusContext) return;
			const currentCount = getStore().countInbox(repository?.id ?? null);
			ctx.ui.setStatus(STATUS_ID, currentCount ? String(currentCount) : undefined);
			const sessionId = ctx.sessionManager.getSessionId();
			const sessionCount = getStore().count({ scope: "session", sessionId, lifecycle: "inbox" });
			if (!sessionCount) {
				ctx.ui.setWidget(WIDGET_ID, undefined);
				return;
			}
			const shown = getStore().list({ scope: "session", sessionId, lifecycle: "inbox", limit: 5 });
			const overflow = sessionCount - shown.length;
			ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => ({
				render(width: number): string[] {
					const overflowLabel = overflow > 0 ? ` · +${overflow} more` : "";
					const heading = theme.fg("dim", `󰅐 later · session ${sessionCount}${overflowLabel}`);
					return [
						truncateToWidth(heading, width),
						...shown.map((item) => {
							const text = item.text.replace(/\s+/g, " ").trim();
							const line = `${theme.fg("dim", item.id)} ${theme.fg("muted", text)}`;
							return truncateToWidth(line, width);
						}),
					];
				},
				invalidate() {},
			}));
		} catch {
			if (ctx === statusContext) {
				ctx.ui.setStatus(STATUS_ID, undefined);
				ctx.ui.setWidget(WIDGET_ID, undefined);
			}
		}
	};
	const scheduleUIRefresh = () => {
		if (!statusContext) return;
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			void refreshUI();
		}, 75);
	};
	const notifyChanged = () => {
		pi.events.emit(STORE_CHANGED_EVENT, undefined);
		void refreshUI();
	};
	const unsubscribeStoreChanged = pi.events.on(STORE_CHANGED_EVENT, scheduleUIRefresh);

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		statusContext = ctx;
		getStore();
		try {
			storeWatcher = watch(dirname(DATABASE_PATH), (_eventType, filename) => {
				if (!filename || String(filename).startsWith("later.sqlite")) {
					pi.events.emit(STORE_CHANGED_EVENT, undefined);
				}
			});
			storeWatcher.on("error", () => {
				storeWatcher?.close();
				storeWatcher = undefined;
			});
		} catch {
			storeWatcher = undefined;
		}
		scheduleUIRefresh();
	});
	pi.on("session_shutdown", () => {
		statusContext?.ui.setStatus(STATUS_ID, undefined);
		statusContext?.ui.setWidget(WIDGET_ID, undefined);
		statusContext = undefined;
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = undefined;
		storeWatcher?.close();
		storeWatcher = undefined;
		unsubscribeStoreChanged();
		store?.close();
		store = undefined;
	});

	pi.registerCommand("later", {
		description: "Capture a private later item, or open the later manager",
		getArgumentCompletions: getCaptureCompletions,
		handler: async (args, ctx: ExtensionCommandContext) => {
			const capture = parseDirectCapture(args);
			if (!capture.text) {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("The /later manager requires interactive mode.", "error");
					return;
				}
				await showLaterManager({
					ctx,
					store: getStore(),
					repository: await getRepository(ctx.cwd),
					source: sourceFromContext(ctx),
					onChanged: notifyChanged,
					subscribeChanged: (listener) => pi.events.on(STORE_CHANGED_EVENT, listener),
				});
				return;
			}
			const repository = await getRepository(ctx.cwd);
			const scope = capture.scope ?? (repository ? "project" : "global");
			if (scope === "project" && !repository) {
				ctx.ui.notify(
					"Project scope requires the current directory to be in a Git repository.",
					"error",
				);
				return;
			}
			const item = getStore().add({
				repository: scope === "project" ? repository : null,
				scope,
				ownerSessionId: ctx.sessionManager.getSessionId(),
				text: capture.text,
				source: sourceFromContext(ctx),
			});
			notifyChanged();
			ctx.ui.notify(`Saved later:${item.id} to ${scopeLabel(item.scope)}`, "info");
		},
	});
	pi.registerShortcut("ctrl+alt+l", {
		description: "Quick-capture a later item",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") return;
			const repository = await getRepository(ctx.cwd);
			const capture = await showLaterCapture(ctx, repository);
			if (!capture) return;
			const item = getStore().add({
				repository: capture.scope === "project" ? repository : null,
				scope: capture.scope,
				ownerSessionId: ctx.sessionManager.getSessionId(),
				text: capture.text,
				source: sourceFromContext(ctx),
			});
			notifyChanged();
			ctx.ui.notify(`Saved later:${item.id} to ${scopeLabel(item.scope)}`, "info");
		},
	});
	registerLaterTool(pi, { getStore, getRepository, onChanged: notifyChanged });
}
