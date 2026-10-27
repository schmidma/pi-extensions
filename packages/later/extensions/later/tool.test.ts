import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { findPiHost, resolveHostPackage } from "../../../../tests/pi-host.mjs";
import type { LaterStore } from "./store.ts";
import type { LaterItem } from "./types.ts";

// Resolve the same host-provided dependencies Pi uses, without installing local copies.
const host = findPiHost("PI_LATER_HOST");
const dependencies = new Map(
	["@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"].map((name) => [
		name,
		pathToFileURL(resolveHostPackage(host, name).entry!).href,
	]),
);
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		return nextResolve(dependencies.get(specifier) ?? specifier, context);
	},
});
const { registerLaterTool } = await import("./tool.ts");
hooks.deregister();

const theme = { fg: (_color: string, text: string) => text } as Theme;
const item: LaterItem = {
	id: "L-42",
	text: `First line ${"long item text ".repeat(30)}\nLast line of item`,
	context: "Supporting context\nLast line of context",
	lifecycle: "inbox",
	scope: "global",
	repositoryId: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-02T00:00:00.000Z",
	source: { cwd: "/source", sessionId: "session", sessionFile: "/source/session.jsonl" },
};
const ctx = {
	cwd: "/source",
	sessionManager: { getSessionId: () => "session", getSessionFile: () => "/source/session.jsonl" },
} as ExtensionContext;

function setup(items = [item]) {
	let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
	const store = {
		getVisible: () => item,
		list: () => items,
		add: () => item,
		update: () => item,
		archive: () => item,
		softDelete: () => item,
		restore: () => item,
		move: () => item,
	} as unknown as LaterStore;
	registerLaterTool({ registerTool: (definition) => { tool = definition; } } as ExtensionAPI, {
		getStore: () => store,
		getRepository: async () => null,
		onChanged() {},
	});
	return tool;
}

function render(tool: ReturnType<typeof setup>, result: Awaited<ReturnType<typeof tool.execute>>, expanded: boolean, width = 100) {
	return tool.renderResult!(result, { expanded, isPartial: false }, theme, {} as never)
		.render(width).map((line) => line.trimEnd()).join("\n");
}

function assertFullItem(text: string) {
	for (const expected of [item.id, "Last line of item", "Supporting context", "Last line of context", "Repository: none", item.createdAt, item.updatedAt, item.source.cwd, item.source.sessionFile!]) {
		assert.ok(text.includes(expected), `Missing ${expected}`);
	}
}

test("get collapses to an item preview, expands fully, and preserves agent output", async () => {
	const tool = setup();
	const result = await tool.execute("get", { action: "get", id: item.id }, undefined, undefined, ctx);
	const original = structuredClone(result);
	assertFullItem(result.content[0].type === "text" ? result.content[0].text : "");
	for (const width of [40, 100]) {
		const collapsed = render(tool, result, false, width);
		assert.ok(collapsed.includes(item.id));
		assert.ok(collapsed.includes("..."));
		assert.ok(!collapsed.includes("Last line of item"));
		assert.ok(!collapsed.includes("Supporting context"));
		assert.ok(collapsed.split("\n").length <= 4);
		assertFullItem(render(tool, result, true, width));
		assert.equal(render(tool, result, false, width), collapsed);
	}
	assert.deepEqual(result, original);
});

test("every mutation expands to the full resulting item while keeping its compact summary", async () => {
	const tool = setup();
	for (const action of ["add", "update", "archive", "delete", "restore", "move"]) {
		const result = await tool.execute(action, { action, id: item.id, text: item.text, scope: "global" }, undefined, undefined, ctx);
		const original = structuredClone(result);
		const collapsed = render(tool, result, false);
		assert.ok(collapsed.startsWith(`OK ${item.id}`), action);
		assert.ok(!collapsed.includes("Last line of item"), action);
		assert.ok(!collapsed.includes("Supporting context"), action);
		assertFullItem(render(tool, result, true));
		assert.deepEqual(result, original);
	}
});

test("list bounds collapsed rows and reveals all full items when expanded", async () => {
	const items = Array.from({ length: 7 }, (_, index) => ({ ...item, id: `L-${index + 1}` }));
	const tool = setup(items);
	const result = await tool.execute("list", { action: "list" }, undefined, undefined, ctx);
	const original = structuredClone(result);
	const collapsed = render(tool, result, false);
	assert.ok(collapsed.includes("7 later item(s)"));
	assert.ok(collapsed.includes("L-5"));
	assert.ok(!collapsed.includes("L-6"));
	assert.ok(collapsed.includes("... 2 more"));
	assert.ok(!collapsed.includes("Last line of item"));
	assert.ok(!collapsed.includes("Supporting context"));
	const expanded = render(tool, result, true);
	assert.ok(expanded.includes("L-7"));
	assert.equal(expanded.split("Last line of context").length - 1, 7);
	assert.equal(expanded.split("Last line of item").length - 1, 7);
	assert.deepEqual(result, original);
});

test("empty lists and detail-less results remain readable in both states", async () => {
	const tool = setup([]);
	const empty = await tool.execute("list", { action: "list" }, undefined, undefined, ctx);
	for (const expanded of [false, true]) assert.equal(render(tool, empty, expanded), "0 later item(s)");
	const fallback = {
		content: [{ type: "text" as const, text: `Failure: ${"long diagnostic ".repeat(30)}\nDiagnostic tail` }],
		details: undefined,
	};
	assert.ok(!render(tool, fallback, false).includes("Diagnostic tail"));
	assert.ok(render(tool, fallback, false).includes("..."));
	assert.ok(render(tool, fallback, true).includes("Diagnostic tail"));
	assert.equal(render(tool, { content: [], details: undefined }, false), "");
});
