import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { LaterStore } from "./store.ts";
import type {
	LaterItem,
	LaterLifecycle,
	LaterListScope,
	LaterScope,
	LaterSource,
	RepositoryContext,
} from "./types.ts";

const LaterAction = StringEnum([
	"list",
	"get",
	"add",
	"update",
	"archive",
	"delete",
	"restore",
	"move",
] as const);
const LaterLifecycleSchema = StringEnum(["inbox", "archived", "deleted"] as const);
const LaterScopeSchema = StringEnum(["session", "project", "global", "all"] as const);

const LaterParameters = Type.Object({
	action: LaterAction,
	id: Type.Optional(
		Type.String({ description: "Item ID or reference, for example L-42 or later:L-42" }),
	),
	text: Type.Optional(
		Type.String({ description: "Item text for add or replacement text for update" }),
	),
	context: Type.Optional(
		Type.String({
			description:
				"Optional supporting context or discussion summary for add/update; an empty string clears it",
		}),
	),
	query: Type.Optional(Type.String({ description: "Case-insensitive text filter for list" })),
	lifecycle: Type.Optional(LaterLifecycleSchema),
	scope: Type.Optional(LaterScopeSchema),
	allRepositories: Type.Optional(
		Type.Boolean({
			description:
				"List across every persistent scope plus the current session. Defaults to false inside a repository.",
		}),
	),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 100, description: "Maximum list results" }),
	),
});

type LaterToolInput = Static<typeof LaterParameters>;
interface LaterToolDetails {
	action: string;
	item?: LaterItem;
	items?: LaterItem[];
}
export interface LaterToolDependencies {
	getStore(): LaterStore;
	getRepository(cwd: string): Promise<RepositoryContext | null>;
	onChanged(): void;
}
interface LaterActionResult {
	content: Array<{ type: "text"; text: string }>;
	details: LaterToolDetails;
}
type LaterActionHandler = (
	params: LaterToolInput,
	ctx: ExtensionContext,
	dependencies: LaterToolDependencies,
) => LaterActionResult | Promise<LaterActionResult>;

export function sourceFromContext(ctx: ExtensionContext): LaterSource {
	return {
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile(),
	};
}
function requireParameter(value: string | undefined, name: string): string {
	if (!value?.trim()) throw new Error(`${name} is required`);
	return value;
}
function preview(text: string, length = 120): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > length ? `${line.slice(0, length - 3)}...` : line;
}
function scopeName(scope: LaterScope): string {
	return scope[0].toUpperCase() + scope.slice(1);
}
function formatList(items: LaterItem[]): string {
	if (!items.length) return "No matching later items.";
	return [
		`${items.length} later item${items.length === 1 ? "" : "s"}:`,
		...items.map(
			(item) =>
				`${item.id} [${item.lifecycle}, ${item.scope}${item.repositoryName ? `, ${item.repositoryName}` : ""}] ${preview(item.text)}`,
		),
	].join("\n");
}
function formatItem(item: LaterItem): string {
	const lines = [
		`${item.id} [${item.lifecycle}, ${item.scope}]`,
		`Repository: ${item.repositoryName ?? "none"}`,
		`Created: ${item.createdAt}`,
		`Updated: ${item.updatedAt}`,
		"",
		item.text,
	];
	if (item.context) lines.push("", "Context:", item.context);
	lines.push("", `Source cwd: ${item.source.cwd}`);
	if (item.source.sessionFile) lines.push(`Source session: ${item.source.sessionFile}`);
	return lines.join("\n");
}
function changedResult(action: string, item: LaterItem | undefined): LaterActionResult {
	if (!item) throw new Error("Later item not found");
	return {
		content: [
			{
				type: "text",
				text: `${action}: ${item.id} [${item.lifecycle}, ${item.scope}] ${preview(item.text)}`,
			},
		],
		details: { action, item },
	};
}
async function resolveScope(
	params: LaterToolInput,
	ctx: ExtensionContext,
	dependencies: LaterToolDependencies,
): Promise<{ scope: LaterScope; repository: RepositoryContext | null; sessionId: string }> {
	const requested = params.scope;
	if (requested === "all") throw new Error("Scope 'all' is available only when listing items");
	const repository = await dependencies.getRepository(ctx.cwd);
	const scope = (requested ?? (repository ? "project" : "global")) as LaterScope;
	if (scope === "project" && !repository)
		throw new Error("Project scope requires the current directory to be in a Git repository");
	return { scope, repository, sessionId: ctx.sessionManager.getSessionId() };
}
const listItems: LaterActionHandler = async (params, ctx, dependencies) => {
	const repository = await dependencies.getRepository(ctx.cwd);
	const sessionId = ctx.sessionManager.getSessionId();
	const explicit = params.scope as LaterListScope | undefined;
	const scope = explicit ?? (params.allRepositories ? "all" : repository ? "project" : "global");
	if (scope === "project" && !repository)
		throw new Error("Project scope requires the current directory to be in a Git repository");
	const items = dependencies.getStore().list({
		scope,
		repositoryId: scope === "project" ? repository?.id : undefined,
		sessionId,
		lifecycle: (params.lifecycle ?? "inbox") as LaterLifecycle,
		query: params.query,
		limit: params.limit ?? 50,
	});
	return {
		content: [{ type: "text", text: formatList(items) }],
		details: { action: "list", items },
	};
};
function requireVisibleItem(
	params: LaterToolInput,
	ctx: ExtensionContext,
	dependencies: LaterToolDependencies,
): LaterItem {
	const item = dependencies
		.getStore()
		.getVisible(requireParameter(params.id, "id"), ctx.sessionManager.getSessionId());
	if (!item) throw new Error("Later item not found");
	return item;
}

const getItem: LaterActionHandler = (params, ctx, dependencies) => {
	const item = requireVisibleItem(params, ctx, dependencies);
	return {
		content: [{ type: "text", text: formatItem(item) }],
		details: { action: "get", item },
	};
};
const addItem: LaterActionHandler = async (params, ctx, dependencies) => {
	const owner = await resolveScope(params, ctx, dependencies);
	const item = dependencies.getStore().add({
		repository: owner.repository,
		scope: owner.scope,
		ownerSessionId: owner.sessionId,
		text: requireParameter(params.text, "text"),
		context: params.context,
		source: sourceFromContext(ctx),
	});
	dependencies.onChanged();
	return changedResult("Added", item);
};
const updateItem: LaterActionHandler = (params, ctx, dependencies) => {
	if (params.text === undefined && params.context === undefined) {
		throw new Error("text or context is required for update");
	}
	const visible = requireVisibleItem(params, ctx, dependencies);
	const item = dependencies
		.getStore()
		.update(
			visible.id,
			{ text: params.text, context: params.context },
			ctx.sessionManager.getSessionId(),
		);
	dependencies.onChanged();
	return changedResult("Updated", item);
};
const archiveItem: LaterActionHandler = (params, ctx, dependencies) => {
	const visible = requireVisibleItem(params, ctx, dependencies);
	const item = dependencies.getStore().archive(visible.id, ctx.sessionManager.getSessionId());
	dependencies.onChanged();
	return changedResult("Archived", item);
};
const deleteItem: LaterActionHandler = (params, ctx, dependencies) => {
	const visible = requireVisibleItem(params, ctx, dependencies);
	const item = dependencies.getStore().softDelete(visible.id, ctx.sessionManager.getSessionId());
	dependencies.onChanged();
	return changedResult("Deleted", item);
};
const restoreItem: LaterActionHandler = (params, ctx, dependencies) => {
	const visible = requireVisibleItem(params, ctx, dependencies);
	const item = dependencies.getStore().restore(visible.id, ctx.sessionManager.getSessionId());
	dependencies.onChanged();
	return changedResult("Restored", item);
};
const moveItem: LaterActionHandler = async (params, ctx, dependencies) => {
	if (!params.scope) throw new Error("scope is required for move");
	const visible = requireVisibleItem(params, ctx, dependencies);
	const owner = await resolveScope(params, ctx, dependencies);
	const item = dependencies.getStore().move(
		visible.id,
		{
			scope: owner.scope,
			repository: owner.repository,
			ownerSessionId: owner.sessionId,
		},
		ctx.sessionManager.getSessionId(),
	);
	dependencies.onChanged();
	return changedResult(`Moved to ${scopeName(owner.scope)}`, item);
};
const ACTION_HANDLERS = {
	list: listItems,
	get: getItem,
	add: addItem,
	update: updateItem,
	archive: archiveItem,
	delete: deleteItem,
	restore: restoreItem,
	move: moveItem,
} satisfies Record<LaterToolInput["action"], LaterActionHandler>;
function executeLaterAction(
	params: LaterToolInput,
	ctx: ExtensionContext,
	dependencies: LaterToolDependencies,
) {
	const handler = ACTION_HANDLERS[params.action as keyof typeof ACTION_HANDLERS];
	return handler(params, ctx, dependencies);
}
function renderLaterCall(args: LaterToolInput, theme: Theme): Text {
	let text = theme.fg("toolTitle", theme.bold("later ")) + theme.fg("muted", args.action);
	if (args.id) text += ` ${theme.fg("accent", args.id)}`;
	if (args.scope) text += ` ${theme.fg("dim", args.scope)}`;
	if (args.text) text += ` ${theme.fg("dim", preview(args.text, 70))}`;
	return new Text(text, 0, 0);
}
function renderLaterResult(options: {
	details?: LaterToolDetails;
	contentText: string;
	expanded: boolean;
	theme: Theme;
}): Text {
	const { details, contentText, expanded, theme } = options;
	if (!details || details.action === "get") return new Text(contentText, 0, 0);
	if (details.action === "list" && details.items) {
		const shown = expanded ? details.items : details.items.slice(0, 5);
		let text = theme.fg("success", `${details.items.length} later item(s)`);
		for (const item of shown)
			text += `\n${theme.fg("accent", item.id)} ${theme.fg("muted", `[${item.scope}] ${preview(item.text, 90)}`)}`;
		if (!expanded && details.items.length > shown.length)
			text += `\n${theme.fg("dim", `... ${details.items.length - shown.length} more`)}`;
		return new Text(text, 0, 0);
	}
	const item = details.item;
	return new Text(
		item
			? `${theme.fg("success", "OK")} ${theme.fg("accent", item.id)} ${theme.fg("muted", preview(item.text, 100))}`
			: theme.fg("muted", "Done"),
		0,
		0,
	);
}
export function registerLaterTool(pi: ExtensionAPI, dependencies: LaterToolDependencies): void {
	pi.registerTool({
		name: "later",
		label: "Later",
		description:
			"Manage private later items. References such as later:L-42 are stable records. Actions: list, get, add, update, archive, delete (recoverable), restore, and move. Scopes are global, project, and session. Session items belong only to the current exact session; use scope all to list global/project items plus this session, never other sessions. Use only when the user explicitly asks to interact with later items.",
		promptSnippet: "Store and retrieve private later items by references such as later:L-42",
		promptGuidelines: [
			"Use the later tool only when the user explicitly asks to save, list, retrieve, update, archive, delete, restore, move, or work from a later item.",
			"Use scope session for items the user wants only in this conversation, project for the current Git repository, global for any project, and all only when listing across scopes.",
			"When the user references later:L-N, use the later tool with action get before acting on that item.",
		],
		parameters: LaterParameters,
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			return executeLaterAction(params, ctx, dependencies);
		},
		renderCall: renderLaterCall,
		renderResult(result, { expanded }, theme) {
			const content = result.content[0];
			return renderLaterResult({
				details: result.details as LaterToolDetails | undefined,
				contentText: content?.type === "text" ? content.text : "",
				expanded,
				theme,
			});
		},
	});
}
