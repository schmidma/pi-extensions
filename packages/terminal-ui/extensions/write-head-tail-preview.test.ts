import { beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	createAgentSession,
	createWriteToolDefinition,
	DefaultResourceLoader,
	initTheme,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type Theme,
	type ToolRendererResolver,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import writePreview from "./write-head-tail-preview.ts";

type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;
const context = (expanded = false): RenderContext => ({
	args: {}, toolCallId: "write", state: {}, invalidate() {}, lastComponent: undefined,
	cwd: "/tmp", executionStarted: true, argsComplete: true, isPartial: false,
	expanded, showImages: false, isError: false, durationMs: undefined, outputPad: 1,
});
const plain = (lines: string[]) => lines.map(line => stripTerminalSequences(line).trimEnd()).join("\n");

beforeAll(() => initTheme("dark", false));

test("write preview keeps head/tail, expansion, partial arguments and native result rendering", () => {
	let resolve!: ToolRendererResolver;
	writePreview({ registerToolRenderer: (resolver) => { resolve = resolver; } } as ExtensionAPI);
	const native = createWriteToolDefinition("/tmp") as unknown as ToolRenderers;
	const renderers = resolve("write", () => native)!;
	const content = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`);
	const args = { path: "note.txt", content: content.join("\n") + "\n\n" };
	const collapsed = plain(renderers.renderCall!(args, theme, context()).render(120));
	expect(collapsed).toContain("write note.txt\n\n" + content.slice(0, 5).join("\n"));
	expect(collapsed).toContain("(4 lines omitted,");
	expect(collapsed).not.toContain("line 6\n");
	expect(collapsed).toEndWith(content.slice(-5).join("\n"));
	expect(plain(renderers.renderCall!(args, theme, context(true)).render(120)))
		.toBe("write note.txt\n\n" + content.join("\n"));
	expect(plain(renderers.renderCall!({ path: "note.txt", content: "one\ntwo\n" }, theme, context()).render(120)))
		.toBe("write note.txt\n\none\ntwo");
	expect(plain(renderers.renderCall!({}, theme, context()).render(120))).toBe("write [invalid path]");
	expect(plain(renderers.renderCall!({ path: "code.ts", content: "const value = 1;" }, theme, context()).render(120)))
		.toContain("const value = 1;");
	for (const isError of [false, true]) {
		const result = { content: [{ type: "text" as const, text: "Native write result" }], details: undefined };
		const ctx = { ...context(), isError };
		const options = { expanded: false, isPartial: false };
		expect(renderers.renderResult!(result, options, theme, ctx).render(120))
			.toEqual(native.renderResult!(result, options, theme, ctx).render(120));
	}
	// A renderer registered later still owns results and shell policy, even on other tools.
	const downstream: ToolRenderers = { renderShell: "self", renderResult: native.renderResult };
	expect(resolve("write", () => downstream)?.renderResult).toBe(downstream.renderResult);
	expect(resolve("write", () => downstream)?.renderShell).toBe("self");
	expect(resolve("read", () => downstream)).toBe(downstream);
});

test("preview leaves native write execution, cwd, metadata and cancellation intact in an SDK session", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-write-preview-"));
	const relativePath = `${basename(directory)}/output.txt`;
	const wrongPath = join(process.cwd(), relativePath);
	const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory,
			settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true,
			noPromptTemplates: true, noThemes: true, extensionFactories: [writePreview] });
		await loader.reload();
		({ session } = await createAgentSession({ cwd: directory, agentDir: directory, resourceLoader: loader,
			modelRuntime: runtime, settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(directory), tools: ["write"] }));
		const write = session.agent.state.tools.find(tool => tool.name === "write")!;
		const native = createWriteToolDefinition(directory);
		expect(write.constrainedSampling).toEqual(native.constrainedSampling);
		expect(write.parameters).toEqual(native.parameters);
		expect(write.description).toBe(native.description);
		const result = await write.execute("write", { path: relativePath, content: "first\n" });
		expect(result).toEqual({ content: [{ type: "text", text: `Successfully wrote to ${relativePath}` }], details: undefined });
		expect(readFileSync(join(directory, relativePath), "utf8")).toBe("first\n");
		expect(existsSync(wrongPath)).toBe(false);
		await write.execute("overwrite", { path: relativePath, content: "replacement" });
		expect(readFileSync(join(directory, relativePath), "utf8")).toBe("replacement");
		const abort = new AbortController(); abort.abort();
		await expect(write.execute("cancel", { path: relativePath, content: "must not write" }, abort.signal)).rejects.toThrow("Operation aborted");
		expect(readFileSync(join(directory, relativePath), "utf8")).toBe("replacement");
	} finally {
		session?.dispose();
		rmSync(directory, { recursive: true, force: true });
		// Keep a regression against process.cwd() from leaving its test output behind.
		rmSync(join(process.cwd(), basename(directory)), { recursive: true, force: true });
	}
});
