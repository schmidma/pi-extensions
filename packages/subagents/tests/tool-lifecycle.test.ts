import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition, discoverAndLoadExtensions, initTheme, ToolExecutionComponent, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { decorate } from "../../terminal-ui/extensions/tool-lifecycle/index.ts";
import { Lifecycle } from "../../terminal-ui/extensions/tool-lifecycle/lifecycle.ts";
import { delegationRenderers } from "../extensions/subagents/cards.ts";

beforeAll(() => initTheme("dark", false));
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const strip = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const ui = { requestRender() {} } as TUI;
const context = (id: string, extra = {}) => ({ args: {}, toolCallId: id, state: {}, invalidate() {}, lastComponent: undefined,
  cwd: "/tmp", executionStarted: false, argsComplete: false, isPartial: true, expanded: false, showImages: false, isError: false, ...extra });

function component(name: string, id: string, args: any, renderers: ToolRenderers | undefined) {
  return new ToolExecutionComponent(name, id, args, { showImages: false }, renderers, ui, "/tmp");
}

test("installed Pi loads the lifecycle extension as rendering-only", async () => {
  const entry = fileURLToPath(new URL("../../terminal-ui/extensions/tool-lifecycle/index.ts", import.meta.url));
  const loaded = await discoverAndLoadExtensions([entry], "/tmp", "/tmp");
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(1);
  expect(loaded.extensions[0].tools.size).toBe(0);
  expect(loaded.extensions[0].toolRenderers).toHaveLength(1);
});

test("built-in shared renderer state and lastComponent reuse survive call decoration", () => {
  const life = new Lifecycle(); life.set("bash", "ready");
  const base = createBashToolDefinition("/tmp");
  const wrapped = decorate(base, life)!;
  const ctx = context("bash");
  const first = wrapped.renderCall!({ command: "echo 界" }, theme, ctx);
  const second = wrapped.renderCall!({ command: "echo updated" }, theme, { ...ctx, lastComponent: first, executionStarted: true });
  expect(strip(second.render(60).join("\n"))).toContain("○ $ echo updated");
  expect(ctx.state).toHaveProperty("startedAt");
  expect(wrapped.renderResult).toBe(base.renderResult);
  const output = wrapped.renderResult!({ content: [{ type: "text", text: "original output" }], details: undefined },
    { expanded: true, isPartial: false }, theme, { ...ctx, isPartial: false });
  expect(strip(output.render(60).join("\n"))).toContain("original output");
  expect(ctx.state).toHaveProperty("endedAt");
  life.stop();
});

test("native self-framed edit keeps padding, live preview and result shared state with one heading marker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-edit-marker-"));
  const life = new Lifecycle();
  try {
    const path = join(directory, "example.ts");
    writeFileSync(path, "old text\n");
    const args = { path, edits: [{ oldText: "old text", newText: "new text" }] };
    const native = createEditToolDefinition(directory);
    expect(native.renderShell).toBe("self");
    const marked = decorate(native, life, "edit")!;
    let nativePreviewReady!: () => void, markedPreviewReady!: () => void;
    const nativeReady = new Promise<void>(resolve => { nativePreviewReady = resolve; });
    const markedReady = new Promise<void>(resolve => { markedPreviewReady = resolve; });
    const nativeCtx = context("plain-edit", { args, invalidate: () => nativePreviewReady() });
    const markedCtx = context("edit", { args, invalidate: () => markedPreviewReady() });
    life.set("edit", "composing");
    let nativeCall = native.renderCall!(args, theme, nativeCtx);
    let markedCall = marked.renderCall!(args, theme, markedCtx);
    const sameContent = (glyph: string) => {
      const lines = markedCall.render(120).map(strip);
      expect(lines.filter(line => line.includes(`${glyph} edit `))).toHaveLength(1);
      expect(lines.find(line => line.includes(`${glyph} edit `))).toStartWith(` ${glyph} edit `);
      expect(lines.map(line => line.replace(`${glyph} `, "").trimEnd()))
        .toEqual(nativeCall.render(120).map(line => strip(line).trimEnd()));
    };
    sameContent("✎");
    life.set("edit", "ready");
    nativeCtx.argsComplete = markedCtx.argsComplete = true;
    nativeCall = native.renderCall!(args, theme, { ...nativeCtx, lastComponent: nativeCall });
    markedCall = marked.renderCall!(args, theme, { ...markedCtx, lastComponent: markedCall });
    await Promise.all([nativeReady, markedReady]);
    nativeCall = native.renderCall!(args, theme, { ...nativeCtx, lastComponent: nativeCall });
    markedCall = marked.renderCall!(args, theme, { ...markedCtx, lastComponent: markedCall });
    sameContent("○");
    expect(strip(markedCall.render(120).join("\n"))).toContain("old text");
    expect(strip(markedCall.render(120).join("\n"))).toContain("new text");
    life.set("edit", "running");
    sameContent("⠋");
    life.set("edit", "success");
    const result = { content: [{ type: "text", text: "Edited" }], details: { diff: "-1 old text\n+1 final text", firstChangedLine: 1 } } as any;
    const options = { expanded: false, isPartial: false };
    // Native renderResult rebuilds the call Box with the authoritative final diff.
    // Check it immediately, without another renderCall that could hide a lost marker.
    const nativeOutput = native.renderResult!(result, options, theme, { ...nativeCtx, isPartial: false });
    const markedOutput = marked.renderResult!(result, options, theme, { ...markedCtx, isPartial: false });
    sameContent("✓");
    expect(markedOutput.render(120)).toEqual(nativeOutput.render(120));
    expect(strip(markedCall.render(120).join("\n"))).toContain("final text");
    expect(strip(markedCall.render(120).join("\n"))).not.toContain("new text");
    expect((markedCtx.state as any).callComponent).toBe(markedCall);
    const nativeRow = component("edit", "plain-row", args, native);
    const markedRow = component("edit", "edit", args, marked);
    nativeRow.updateResult({ ...result, isError: false }); markedRow.updateResult({ ...result, isError: false });
    for (const expanded of [false, true]) {
      nativeRow.setExpanded(expanded); markedRow.setExpanded(expanded);
      const lines = markedRow.render(120).map(strip);
      expect(lines.filter(line => line.includes("✓ edit "))).toHaveLength(1);
      expect(lines.map(line => line.replace("✓ ", "").trimEnd()))
        .toEqual(nativeRow.render(120).map(line => strip(line).trimEnd()));
    }
    life.set("edit", "failure");
    const error = { content: [{ type: "text", text: "Edit denied" }], details: undefined } as any;
    const nativeError = native.renderResult!(error, options, theme, { ...nativeCtx, isPartial: false, isError: true });
    const markedError = marked.renderResult!(error, options, theme, { ...markedCtx, isPartial: false, isError: true });
    sameContent("×");
    expect(markedError.render(120)).toEqual(nativeError.render(120));
    expect(strip(markedError.render(120).join("\n"))).toContain("Edit denied");
    for (const width of [8, 24, 120]) expect(markedCall.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
  } finally {
    life.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a single heading marker preserves previews/results and all reflowed content within width", () => {
  const life = new Lifecycle(); life.set("write", "success");
  const base = createWriteToolDefinition("/tmp");
  const args = { path: "/tmp/example.ts", content: "const one = 1;\nconst two = 2;" };
  const original = component("write", "plain", args, base);
  const marked = component("write", "write", args, decorate(base, life));
  const result = { content: [{ type: "text", text: "Successfully wrote file" }], details: undefined, isError: false } as any;
  original.updateResult(result); marked.updateResult(result);
  const plainLines = original.render(120).map(strip), markedLines = marked.render(120).map(strip);
  const title = markedLines.findIndex(line => line.includes("✓"));
  markedLines[title] = markedLines[title].replace("✓ ", "");
  expect(markedLines.map(line => line.trimEnd())).toEqual(plainLines.map(line => line.trimEnd()));
  const call = decorate({ renderCall: () => new Text("heading-界-with-a-long-name\nbody original", 0, 0) }, life)!
    .renderCall!({}, theme, context("write"));
  for (const width of [0, 1, 2, 3, 4, 8, 20, 80]) {
    const lines = call.render(width);
    expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
    if (width > 3) expect(lines.join("\n").match(/✓/g)).toHaveLength(1);
    if (width >= 2) {
      const text = strip(lines.join("")).replace("✓ ", "");
      expect(text.replace(/\s/g, "")).toContain("heading-界-with-a-long-namebodyoriginal");
    }
  }
  life.stop();
});

test("self-framed delegation marker lives inside heading and successful spawn means launch accepted", () => {
  const life = new Lifecycle(); life.set("spawn", "ready");
  const card = component("spawn_subagent", "spawn", { name: "Review", model: "fixture/model", thinking: "high", prompt: "Original task" },
    decorate(delegationRenderers("spawn_subagent"), life));
  expect(strip(card.render(100).join("\n"))).toContain(" ○ Spawn subagent: Review");
  life.set("spawn", "success");
  card.updateResult({ content: [{ type: "text", text: "Acknowledgement" }], details: { agent_id: "a", run_id: "r", name: "Review" }, isError: false });
  const collapsed = strip(card.render(100).join("\n"));
  expect(collapsed).toContain(" ✓ Spawn subagent: Review");
  expect(collapsed.match(/✓/g)).toHaveLength(1); expect(collapsed).not.toContain("Acknowledgement");
  card.setExpanded(true);
  expect(strip(card.render(100).join("\n"))).toContain("Original task");
  for (const width of [1, 2, 3, 8, 40]) expect(card.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
  life.stop();
});

test("custom interactive call components retain focus, input and mouse coordinates", () => {
  const life = new Lifecycle(); life.set("custom", "ready");
  let input = "", mouse: any;
  const inner = { focused: false, wantsKeyRelease: true, render: () => ["heading"], invalidate() {},
    handleInput: (data: string) => { input = data; }, handleMouse: (event: any) => { mouse = event; return { handled: true }; } };
  const wrapped = decorate({ renderCall: () => inner }, life)!.renderCall!({}, theme, context("custom"));
  (wrapped as any).focused = true; expect(inner.focused).toBe(true);
  expect(wrapped.wantsKeyRelease).toBe(true);
  wrapped.handleInput!("key"); expect(input).toBe("key");
  wrapped.render(40); wrapped.handleMouse!({ x: 7, y: 0, width: 40 } as any);
  expect(mouse.x).toBe(5); expect(mouse.width).toBe(40);
  life.stop();
});

test("unknown self shells retain their behavior and default call fallback retains its formatting", () => {
  const life = new Lifecycle();
  const body = new Text("border\ncustom content", 0, 0);
  const self = { renderShell: "self", renderCall: () => body } as ToolRenderers;
  expect(decorate(self, life)!.renderCall!({}, theme, context("unknown"))).toBe(body);
  expect(decorate(self, life, "edit")!.renderCall!({}, theme, context("unknown-edit"))).toBe(body);
  const resultOnly = { renderResult: () => body };
  const wrapped = decorate(resultOnly, life, "custom")!;
  expect(wrapped.renderResult).toBe(resultOnly.renderResult); expect(decorate(undefined, life)).toBeUndefined();
  life.set("custom", "success");
  for (const expanded of [false, true]) {
    const args = { text: "original\nmultiline\targument", object: { number: 42 }, long: "z".repeat(120) };
    const plain = component("custom", "plain", args, resultOnly);
    const marked = component("custom", "custom", args, wrapped);
    plain.setExpanded(expanded); marked.setExpanded(expanded);
    const original = plain.render(80).map(line => strip(line).trimEnd());
    const decorated = marked.render(80).map(line => strip(line).replace("✓ ", "").trimEnd());
    // A long heading reflows with the extra marker columns, but every character remains.
    if (expanded) expect(decorated).toEqual(original);
    else expect(decorated.join("").replace(/\s/g, "")).toBe(original.join("").replace(/\s/g, ""));
  }
  life.stop();
});
