import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateWithTitleModel } from "./generate-title.ts";
import { parseModelConfig } from "./model-config.ts";

async function harness(fn: (h: any) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "title-test-"));
	const path = join(dir, "config.json");
	const calls: any[] = [], notices: string[] = [];
	let model: any = { provider: "virtual", id: "first" };
	let reply: any = async () => ({ stopReason: "stop", content: [{ type: "text", text: "A useful session title" }] });
	const override = { provider: "custom", id: "override" };
	const ctx: any = {
		get model() { return model; },
		ui: { notify: (text: string) => notices.push(text) },
		modelRegistry: {
			find: (p: string, m: string) => p === override.provider && m === override.id ? override : undefined,
			streamSimple: (selected: any, context: any, options: any) => {
				calls.push({ model: selected, context, options });
				return { result: () => reply(options.signal) };
			},
		},
	};
	try { await fn({ path, calls, notices, override, setModel: (m: any) => model = m,
		setReply: (r: any) => reply = r, config: (c: any) => writeFileSync(path, JSON.stringify(c)),
		run: (signal = new AbortController().signal, timeout = 1000) => generateWithTitleModel(ctx, "draft", signal, "automatic", path, timeout) });
	} finally { rmSync(dir, { recursive: true, force: true }); }
}

test("title uses invocation's current model without auth prechecks, and config edits apply immediately", async () => {
	await harness(async (h) => {
		await h.run(); h.config({}); h.setModel(h.override); await h.run();
		h.config({ provider: "custom", model: "override" }); h.setModel(undefined); await h.run();
		expect(h.calls.map((c: any) => c.model.id)).toEqual(["first", "override", "override"]);
		expect(h.calls[0].options.maxTokens).toBe(48);
		expect(h.calls[0].options.reasoning).toBe("low");
	});
});

test("invalid and unreadable naming config notify and skip requests; unknown models skip", async () => {
	for (const value of [null, [], { provider: "x" }, { model: "x" }, { provider: "", model: "m" }, { extra: true }]) {
		expect(() => parseModelConfig(value)).toThrow();
	}
	await harness(async (h) => {
		writeFileSync(h.path, "{"); expect(await h.run()).toBeUndefined();
		h.config({ provider: "x" }); expect(await h.run()).toBeUndefined();
		rmSync(h.path); mkdirSync(h.path); expect(await h.run()).toBeUndefined();
		expect(h.notices).toHaveLength(3);
		rmSync(h.path, { recursive: true }); h.config({ provider: "unknown", model: "unknown" });
		expect(await h.run()).toBeUndefined(); expect(h.calls).toHaveLength(0);
	});
});

test("aborts and timeout discard even a successful late response", async () => {
	await harness(async (h) => {
		const abort = new AbortController(); abort.abort();
		expect(await h.run(abort.signal)).toBeUndefined(); expect(h.calls).toHaveLength(0);
		h.setReply(async (signal: AbortSignal) => {
			await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
			return { stopReason: "stop", content: [{ type: "text", text: "Late successful title" }] };
		});
		expect(await h.run(undefined, 1)).toBeUndefined();
		const active = new AbortController(); const pending = h.run(active.signal);
		active.abort(); expect(await pending).toBeUndefined();
		h.setReply(async () => ({ stopReason: "aborted", content: [] }));
		expect(await h.run()).toBeUndefined();
	});
});
