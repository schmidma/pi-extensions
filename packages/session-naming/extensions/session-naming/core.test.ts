import { describe, expect, test } from "bun:test";
import {
	cleanGeneratedTitle,
	findLatestOwnership,
	LEGACY_SESSION_HUD_STATE_TYPE,
	SESSION_NAMING_STATE_TYPE,
	SessionNamingController,
	type GenerationMode,
	type PersistedOwnership,
} from "./core.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function marker(
	ownership: "attempted" | "auto" | "manual",
	title: string | null,
	customType = SESSION_NAMING_STATE_TYPE,
) {
	return {
		type: "custom",
		customType,
		data: { v: 1, ownership, title },
	};
}

function createHarness(options?: {
	name?: string;
	generate?: (
		input: string,
		signal: AbortSignal,
		mode: GenerationMode,
	) => Promise<string | undefined>;
	emitOwnRename?: boolean;
}) {
	let name = options?.name;
	let controller!: SessionNamingController;
	const names: string[] = [];
	const markers: PersistedOwnership[] = [];
	const inputs: string[] = [];
	const signals: AbortSignal[] = [];
	const modes: GenerationMode[] = [];

	controller = new SessionNamingController({
		getSessionName: () => name,
		setSessionName: (nextName) => {
			name = nextName;
			names.push(nextName);
			if (options?.emitOwnRename) controller.handleSessionInfoChanged(nextName);
		},
		appendOwnership: (entry) => markers.push(entry),
		generateTitle: async (input, signal, mode) => {
			inputs.push(input);
			signals.push(signal);
			modes.push(mode);
			return options?.generate?.(input, signal, mode);
		},
	});

	return {
		controller,
		get name() {
			return name;
		},
		names,
		markers,
		inputs,
		signals,
		modes,
	};
}

describe("title validation", () => {
	test("accepts concise model output and rejects malformed output", () => {
		expect(cleanGeneratedTitle('Title: "Fix session naming."')).toBe(
			"Fix session naming",
		);
		expect(cleanGeneratedTitle("Fix auth")).toBeUndefined();
		expect(
			cleanGeneratedTitle("One two three four five six seven eight nine"),
		).toBeUndefined();
		expect(
			cleanGeneratedTitle(`${"a".repeat(70)} second third`),
		).toBeUndefined();
		expect(cleanGeneratedTitle("Untitled")).toBeUndefined();
	});
});

describe("state-key migration", () => {
	test("reads both legacy and current state keys in append order", () => {
		expect(
			findLatestOwnership([
				marker("auto", "Legacy title", LEGACY_SESSION_HUD_STATE_TYPE),
				marker("manual", "Current title"),
			]),
		).toEqual({ v: 1, ownership: "manual", title: "Current title" });
		expect(
			findLatestOwnership([
				marker("auto", "Legacy title", LEGACY_SESSION_HUD_STATE_TYPE),
			]),
		).toEqual({ v: 1, ownership: "auto", title: "Legacy title" });
	});
});

describe("automatic naming", () => {
	test("names an eligible session once and persists automatic ownership", async () => {
		const harness = createHarness({
			generate: async () => "Persistent session naming",
			emitOwnRename: true,
		});
		harness.controller.restore([]);
		harness.controller.handlePrompt("Build persistent session naming");
		await flush();

		expect(harness.inputs).toEqual(["Build persistent session naming"]);
		expect(harness.modes).toEqual(["automatic"]);
		expect(harness.names).toEqual(["Persistent session naming"]);
		expect(harness.markers).toEqual([
			{ v: 1, ownership: "auto", title: "Persistent session naming" },
		]);
	});

	test("leaves Pi unnamed and does not retry when the model is unavailable", async () => {
		const harness = createHarness({ generate: async () => undefined });
		harness.controller.restore([]);
		harness.controller.handlePrompt("First prompt");
		await flush();
		harness.controller.handlePrompt("Second prompt");
		await flush();

		expect(harness.inputs).toEqual(["First prompt"]);
		expect(harness.names).toHaveLength(0);
		expect(harness.markers).toEqual([
			{ v: 1, ownership: "attempted", title: null },
		]);
	});

	test("restores a failed legacy attempt without retrying", async () => {
		const harness = createHarness({ generate: async () => "Unexpected title" });
		harness.controller.restore([
			marker("attempted", null, LEGACY_SESSION_HUD_STATE_TYPE),
		]);
		harness.controller.handlePrompt("Do not retry after migration");
		await flush();

		expect(harness.inputs).toHaveLength(0);
		expect(harness.names).toHaveLength(0);
	});

	test("preserves existing names and explicit clears as manual", async () => {
		const named = createHarness({ name: "Hand-written title" });
		named.controller.restore([]);
		named.controller.handlePrompt("Do not overwrite this");

		const cleared = createHarness();
		cleared.controller.restore([{ type: "session_info", name: "" }]);
		cleared.controller.handlePrompt("Do not overwrite the clear");
		await flush();

		expect(named.inputs).toHaveLength(0);
		expect(cleared.inputs).toHaveLength(0);
	});

	test("restores matching automatic ownership without regenerating", async () => {
		const harness = createHarness({ name: "Generated session title" });
		harness.controller.restore([marker("auto", "Generated session title")]);
		harness.controller.handlePrompt("A later prompt");
		await flush();

		expect(harness.inputs).toHaveLength(0);
		expect(harness.name).toBe("Generated session title");
	});
});

describe("races and explicit retitling", () => {
	test("a manual rename cancels an in-flight automatic result", async () => {
		const pending = deferred<string | undefined>();
		const harness = createHarness({ generate: () => pending.promise });
		harness.controller.restore([]);
		harness.controller.handlePrompt("Generate later");
		harness.controller.handleSessionInfoChanged("Manual title");
		pending.resolve("Stale generated title");
		await flush();

		expect(harness.signals[0]?.aborted).toBe(true);
		expect(harness.names).toHaveLength(0);
		expect(harness.markers).toEqual([
			{ v: 1, ownership: "manual", title: "Manual title" },
		]);
	});

	test("shutdown prevents stale completion from naming another session", async () => {
		const pending = deferred<string | undefined>();
		const harness = createHarness({ generate: () => pending.promise });
		harness.controller.restore([]);
		harness.controller.handlePrompt("Old session prompt");
		harness.controller.shutdown();
		pending.resolve("Old session title");
		await flush();

		expect(harness.signals[0]?.aborted).toBe(true);
		expect(harness.names).toHaveLength(0);
	});

	test("retitle uses supplied conversation context", async () => {
		const harness = createHarness({
			name: "Manual title",
			generate: async () => "Current conversation task",
		});
		harness.controller.restore([]);
		const result = await harness.controller.retitle(
			"Original request: old task\nRecent conversation: current task",
		);

		expect(result).toEqual({
			status: "applied",
			title: "Current conversation task",
			source: "model",
		});
		expect(harness.modes).toEqual(["retitle"]);
		expect(harness.name).toBe("Current conversation task");
	});

	test("failed retitle preserves the existing name without fallback", async () => {
		const harness = createHarness({
			name: "Manual title",
			generate: async () => undefined,
		});
		harness.controller.restore([]);

		expect(await harness.controller.retitle("bounded context")).toEqual({
			status: "failed",
		});
		expect(harness.name).toBe("Manual title");
		expect(harness.markers).toHaveLength(0);
	});

	test("a second retitle aborts and supersedes the first", async () => {
		const first = deferred<string | undefined>();
		let call = 0;
		const harness = createHarness({
			name: "Manual title",
			generate: () =>
				++call === 1 ? first.promise : Promise.resolve("Newest session title"),
		});
		harness.controller.restore([]);
		const firstResult = harness.controller.retitle("first context");
		const firstSignal = harness.signals[0];
		const secondResult = harness.controller.retitle("second context");
		first.resolve("Stale session title");

		expect(await secondResult).toEqual({
			status: "applied",
			title: "Newest session title",
			source: "model",
		});
		expect(await firstResult).toEqual({ status: "cancelled" });
		expect(firstSignal?.aborted).toBe(true);
	});
});
