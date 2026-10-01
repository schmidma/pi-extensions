// Run in its own Bun process: the host mock must not affect other suites.
import { afterAll, test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "model-extensions-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
class Loader {
	controller = new AbortController();
	get signal() { return this.controller.signal; }
	onAbort?: () => void;
	constructor(..._args: any[]) {}
}
mock.module("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => dir, BorderedLoader: Loader, keyText: () => "ctrl+z",
}));
const { default: naming } = await import("../packages/session-naming/extensions/session-naming/index.ts");
const { default: rewrite } = await import("../packages/prompt-rewrite/extensions/prompt-rewrite.ts");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const good = { stopReason: "stop", content: [{ type: "text", text: "A useful session title" }] };

test("captured naming context reads fresh current model and external config; shutdown rejects late title", async () => {
	const handlers: any = {}, commands: any = {}, calls: any[] = [], names: string[] = [];
	let selected: any = { provider: "virtual", id: "first" };
	let name: string | undefined;
	let reply: any = async () => good;
	const ctx: any = {
		get model() { return selected; },
		ui: { notify() {} },
		sessionManager: { getEntries: () => [], buildSessionProjection: () => ({ messages: [{ role: "user", content: "Fix the session names", timestamp: 0 }] }) },
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			streamSimple: (model: any, _context: any, options: any) => {
				calls.push({ model, options }); return { result: () => reply() };
			},
		},
	};
	naming({ on: (n: string, h: any) => handlers[n] = h, registerCommand: (n: string, c: any) => commands[n] = c,
		getSessionName: () => name, setSessionName: (n: string) => { name = n; names.push(n); }, appendEntry() {} } as any);
	handlers.session_start({}, ctx);
	selected = { provider: "virtual", id: "second" };
	handlers.before_agent_start({ prompt: "Fix the session names" }); await flush();
	expect(calls[0].model.id).toBe("second");
	selected = { provider: "virtual", id: "third" };
	await commands.retitle.handler("", ctx); expect(calls[1].model.id).toBe("third");
	writeFileSync(join(dir, "session-naming.json"), '{"provider":"custom","model":"override"}');
	await commands.retitle.handler("", ctx); expect(calls[2].model.id).toBe("override");
	let resolve!: (r: any) => void; reply = () => new Promise((r) => resolve = r);
	const pending = commands.retitle.handler("", ctx);
	handlers.session_shutdown(); expect(calls[3].options.signal.aborted).toBe(true);
	resolve(good); await pending; expect(names).toHaveLength(3);
});

test("rewrite applies normally with undo notification, preserves changed editor, and cancels safely", async () => {
	let handler: any, shutdown: any, editor = "original draft", loader: Loader;
	let reply: any = async () => ({ ...good, content: [{ type: "text", text: "rewritten draft" }] });
	const notices: string[] = [], calls: any[] = [];
	const ctx: any = {
		mode: "tui", model: { provider: "custom", id: "no-key" },
		modelRegistry: {
			streamSimple: (_m: any, _c: any, options: any) => { calls.push(options); return { result: () => reply() }; },
		},
		ui: {
			getEditorText: () => editor, setEditorText: (text: string) => editor = text,
			notify: (text: string) => notices.push(text),
			custom: (factory: any) => new Promise((resolve) => { loader = factory({}, {}, {}, resolve); }),
		},
	};
	rewrite({ on: (_name: string, callback: any) => shutdown = callback,
		registerShortcut: (_key: string, shortcut: any) => handler = shortcut.handler } as any);
	await handler(ctx); expect(editor).toBe("rewritten draft"); expect(notices.at(-1)).toContain("ctrl+z");
	editor = "original draft";
	reply = async () => { editor = "edited meanwhile"; return good; };
	await handler(ctx); expect(editor).toBe("edited meanwhile"); expect(notices.at(-1)).toContain("not applied");
	editor = "original draft";
	let resolve!: (r: any) => void; reply = () => new Promise((r) => resolve = r);
	const pending = handler(ctx); loader!.controller.abort(); loader!.onAbort!();
	await pending; resolve(good); await flush();
	expect(editor).toBe("original draft"); expect(notices.at(-1)).toContain("cancelled");
	writeFileSync(join(dir, "prompt-rewrite.json"), '{"provider":"partial"}');
	const before = calls.length; await handler(ctx);
	expect(calls).toHaveLength(before); expect(notices.at(-1)).toContain("paired nonempty");
	rmSync(join(dir, "prompt-rewrite.json"));
	const stopped = handler(ctx); shutdown();
	expect(calls.at(-1).signal.aborted).toBe(true);
	await stopped; resolve(good); await flush();
	expect(editor).toBe("original draft");
});
