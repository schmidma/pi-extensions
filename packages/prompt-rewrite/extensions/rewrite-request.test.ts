import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRewrite } from "./rewrite-request.ts";
import { parseModelConfig } from "./model-config.ts";

const current = { provider: "virtual", id: "current" };
const override = { provider: "custom", id: "override" };
const response = (stopReason = "stop") => ({ stopReason, content: [{ type: "text", text: "new draft" }] });

async function harness(fn: (h: any) => Promise<void> | void) {
	const dir = mkdtempSync(join(tmpdir(), "rewrite-test-"));
	const path = join(dir, "config.json");
	const calls: any[] = [];
	let selected = current;
	let available: any = override;
	let reply = async (_model: any, _options: any) => response();
	const ctx: any = {
		get model() { return selected; },
		modelRegistry: {
			find: () => available,
			streamSimple: (model: any, _context: any, options: any) => {
				calls.push({ model, options });
				return { result: () => reply(model, options) };
			},
		},
	};
	try {
		await fn({ path, calls, ctx, setModel: (m: any) => selected = m,
			setAvailable: (m: any) => available = m, setReply: (r: any) => reply = r,
			config: (c: any) => writeFileSync(path, JSON.stringify(c)),
			run: (signal = new AbortController().signal) => prepareRewrite(ctx, path, "draft", "system").run(signal) });
	} finally { rmSync(dir, { recursive: true, force: true }); }
}

test("missing/empty config follows the current model on every invocation, without auth prechecks", async () => {
	await harness(async (h) => {
		await h.run();
		h.config({}); h.setModel(override); await h.run();
		expect(h.calls.map((c: any) => c.model)).toEqual([current, override]);
		expect(h.calls[0].options.reasoning).toBe("low");
	});
});

test("strict schema and unreadable/malformed config fail without requests", async () => {
	for (const value of [null, [], { provider: "x" }, { model: "x" }, { provider: " ", model: "m" }, { fallbackToCurrentModel: 1 }, { extra: true }]) {
		expect(() => parseModelConfig(value)).toThrow();
	}
	await harness((h) => {
		writeFileSync(h.path, "{"); expect(() => prepareRewrite(h.ctx, h.path, "x", "s")).toThrow("Invalid");
		rmSync(h.path); mkdirSync(h.path); expect(() => prepareRewrite(h.ctx, h.path, "x", "s")).toThrow("Cannot read");
		expect(h.calls).toHaveLength(0);
	});
});

test("explicit override is used; unavailable override only falls back with opt-in", async () => {
	await harness(async (h) => {
		h.config({ provider: override.provider, model: override.id }); await h.run();
		expect(h.calls[0].model).toBe(override);
		h.setAvailable(undefined);
		expect(() => prepareRewrite(h.ctx, h.path, "x", "s")).toThrow("unavailable");
		h.config({ provider: override.provider, model: override.id, fallbackToCurrentModel: true });
		await h.run(); expect(h.calls[1].model).toBe(current);
	});
});

test("failure fallback is opt-in, distinct, and attempted only once", async () => {
	await harness(async (h) => {
		h.setReply(async () => { throw new Error("unavailable credentials"); });
		h.config({ provider: override.provider, model: override.id });
		expect((await h.run()).status).toBe("error"); expect(h.calls).toHaveLength(1);
		h.config({ provider: override.provider, model: override.id, fallbackToCurrentModel: true });
		expect((await h.run()).message).toContain("fallback failed"); expect(h.calls).toHaveLength(3);
		h.setModel(override); await h.run(); expect(h.calls).toHaveLength(4);
		h.setModel(current); h.setAvailable(undefined); await h.run(); expect(h.calls).toHaveLength(5);
		h.config({}); await h.run(); expect(h.calls).toHaveLength(6);
	});
});

test("abort signal and aborted responses never trigger fallback or success", async () => {
	await harness(async (h) => {
		h.config({ provider: override.provider, model: override.id, fallbackToCurrentModel: true });
		h.setReply(async () => response("aborted"));
		expect((await h.run()).status).toBe("cancelled"); expect(h.calls).toHaveLength(1);
		const abort = new AbortController();
		h.setReply(async () => { abort.abort(); throw new Error("cancelled"); });
		expect((await h.run(abort.signal)).status).toBe("cancelled"); expect(h.calls).toHaveLength(2);
		expect((await h.run(abort.signal)).status).toBe("cancelled"); expect(h.calls).toHaveLength(2);
		h.setReply(async () => { throw new DOMException("aborted", "AbortError"); });
		expect((await h.run()).status).toBe("cancelled"); expect(h.calls).toHaveLength(3);
	});
});

test("fallback can succeed with captured current model, even if selection changes during request", async () => {
	await harness(async (h) => {
		h.config({ provider: override.provider, model: override.id, fallbackToCurrentModel: true });
		h.setReply(async (m: any) => {
			if (m === override) { h.setModel(override); throw new Error("failed"); }
			return response();
		});
		expect(await h.run()).toEqual({ status: "success", text: "new draft" });
		expect(h.calls.map((c: any) => c.model)).toEqual([override, current]);
	});
});
