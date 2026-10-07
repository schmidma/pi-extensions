import { beforeAll, expect, spyOn, test } from "bun:test";
import { CustomMessageComponent, initTheme, ToolExecutionComponent, type ExtensionContext, Theme, type ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, Loader, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { delegationRenderers, reportRenderer, type RunLookup } from "../extensions/subagents/cards.ts";
import { OverviewAttachment, SubagentOverview } from "../extensions/subagents/overview.ts";
import { relevantTree } from "../extensions/subagents/relevance.ts";
import { TranscriptInspector } from "../extensions/subagents/inspector.ts";
import { registerBridge } from "../extensions/subagents/bridge.ts";
import { REPORT_TYPE, reportText, type OutcomeStatus, type RunRecord, type SubagentRecord, type SubagentState } from "../extensions/subagents/state.ts";
import type { TreeSource } from "../extensions/subagents/tree.ts";

beforeAll(() => initTheme("dark", false));
const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text, getBgAnsi: () => "", style: (text: string) => text } as unknown as Theme;
const strip = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
// The host's Theme.bold uses Chalk's TTY detection. Exercise its public styling
// callback deterministically in offline tests, even when stdout is not a TTY.
function withAnsiBold(base: Theme, calls: string[]): Theme {
  const themed = Object.create(base) as Theme;
  Object.defineProperty(themed, "bold", { value: (text: string) => { calls.push(text); return base.style(text, { bold: true }); } });
  return themed;
}
const record = (id: string, parentId = "root", name = "Review 界 authentication"): SubagentRecord => ({
  id, parentId, name, model: "fixture/model", requestedThinking: "high", effectiveThinking: "low", generation: 1,
  cwd: "/tmp", projectTrusted: false, sessionFile: "", sessionId: "",
});
const state = (...records: SubagentRecord[]): SubagentState => ({ version: 3, rootKey: "root", subagents: Object.fromEntries(records.map(value => [value.id, value])), runs: {} });
function add(snapshot: SubagentState, id: string, start: number, end?: number, status: OutcomeStatus = "completed"): RunRecord {
  const owner = snapshot.subagents[id];
  const run: RunRecord = { id: `run-${id}-${Object.keys(snapshot.runs).length}`, agentId: id, parentId: owner.parentId, parentRunId: null,
    receiverRunId: null, generation: ++owner.generation, phase: end === undefined ? "running" : "terminal", prompt: "task", boundary: null,
    startedAt: new Date(start * 1000).toISOString(), delivered: false,
    ...(end === undefined ? {} : { endedAt: new Date(end * 1000).toISOString(), outcome: { status, text: "full final **report**" } }) };
  snapshot.runs[run.id] = run; owner.currentRun = run.id;
  return run;
}
class Fixture implements TreeSource {
  listeners = new Set<() => void>();
  subscribed = 0; unsubscribed = 0;
  constructor(public state: SubagentState) {}
  snapshot() { return structuredClone(this.state); }
  subscribe(listener: () => void) { this.subscribed++; this.listeners.add(listener); return () => { this.unsubscribed++; this.listeners.delete(listener); }; }
  change() { for (const listener of this.listeners) listener(); }
}
function terminal(run: RunRecord, time: number, status: OutcomeStatus = "completed") {
  run.phase = "terminal"; run.endedAt = new Date(time * 1000).toISOString(); run.outcome = { status, text: "full" };
}
function view(source: Fixture, initialRows = 32) {
  let rows = initialRows, renders = 0;
  const ui = { terminal: { get rows() { return rows; } }, requestRender() { renders++; } } as TUI;
  const component = new SubagentOverview(source, ui, theme);
  return { component, ui, renders: () => renders, resize: (value: number) => { rows = value; } };
}

test("Relevant accumulates sequential nonoverlapping work with no automatic replacement", () => {
  const snapshot = state(record("a"), record("b"));
  const a = add(snapshot, "a", 1, 2);
  const baseline = new Set<string>();
  expect([...relevantTree(snapshot, baseline).members]).toEqual(["a"]);
  const b = add(snapshot, "b", 10); b.phase = "waiting";
  expect([...relevantTree(snapshot, baseline).members]).toEqual(["a", "b"]);
  terminal(b, 20, "error");
  expect([...relevantTree(snapshot, baseline).members]).toEqual(["a", "b"]);
  expect([...relevantTree(structuredClone(snapshot), baseline).members]).toEqual(["a", "b"]);
  baseline.add(a.id); baseline.add(b.id);
  expect(relevantTree(snapshot, baseline).nodes).toEqual([]);
  const resumed = add(snapshot, "a", 20, 21); // timestamp collisions are not identity
  expect([...relevantTree(snapshot, baseline).members]).toEqual(["a"]);
  expect(resumed.id).not.toBe(a.id);
  expect([...relevantTree(structuredClone(snapshot), baseline).members]).toEqual(["a"]);
});

test("explicit acknowledgment hides all known runs; new child includes acknowledged ancestors only as context", () => {
  const snapshot = state(record("old"), record("parent"), record("child", "parent"), record("other"));
  add(snapshot, "old", 1, 2); add(snapshot, "parent", 10, 20, "error"); add(snapshot, "other", 25, 26);
  const baseline = new Set(Object.keys(snapshot.runs));
  expect(relevantTree(snapshot, baseline).nodes).toEqual([]);
  const child = add(snapshot, "child", 30); child.phase = "waiting";
  const recent = relevantTree(snapshot, baseline);
  expect([...recent.members]).toEqual(["child"]);
  expect(recent.nodes.map(node => node.record.id)).toEqual(["parent", "child"]);
  terminal(child, 31, "aborted");
  expect(relevantTree(structuredClone(snapshot), baseline).nodes.map(node => node.record.id)).toEqual(["parent", "child"]);
  baseline.add(child.id);
  expect(relevantTree(snapshot, baseline).nodes).toEqual([]);
});

test("one public Loader only while actually running, stops waiting/terminal, restarts, and disposes once", async () => {
  const source = new Fixture(state(record("a"), record("b")));
  const a = add(source.state, "a", 1), b = add(source.state, "b", 1); a.phase = b.phase = "waiting";
  const start = spyOn(Loader.prototype, "start"), stop = spyOn(Loader.prototype, "stop");
  const f = view(source);
  try {
    expect(start).not.toHaveBeenCalled();
    const idleRenders = f.renders(); await Bun.sleep(110); expect(f.renders()).toBe(idleRenders);
    a.phase = b.phase = "running"; source.change();
    expect(start).toHaveBeenCalledTimes(1);
    const active = f.renders(); await Bun.sleep(110); expect(f.renders()).toBeGreaterThan(active);
    expect(f.component.render(120).join("\n").match(/[\u2800-\u28ff]/g)).toHaveLength(2);
    a.phase = b.phase = "waiting"; source.change();
    const waiting = f.renders(); await Bun.sleep(110); expect(f.renders()).toBe(waiting);
    expect(f.component.render(120).join("\n")).toMatch(/◷ .* · waiting/);
    b.phase = "running"; source.change(); expect(start).toHaveBeenCalledTimes(2);
    terminal(a, 3); terminal(b, 3, "aborted"); source.change();
    expect(f.component.render(120).join("\n")).toMatch(/⊘ .* · aborted/);
    add(source.state, "a", 4); source.change(); expect(start).toHaveBeenCalledTimes(3);
    f.component.dispose(); f.component.dispose();
    const disposed = f.renders(); source.change(); await Bun.sleep(110); expect(f.renders()).toBe(disposed);
    expect(source.listeners.size).toBe(0); expect(source.unsubscribed).toBe(1);
    expect(f.component.render(120)).toEqual([]); expect(stop.mock.calls.length).toBeGreaterThanOrEqual(3);
  } finally { f.component.dispose(); start.mockRestore(); stop.mockRestore(); }
});

test("active anchor retains contiguous nearby history; budget, directional overflow, tiny resize, depth and metadata are safe", () => {
  const records = Array.from({ length: 12 }, (_, i) => record(`stable-${i}`, i === 11 ? "stable-10" : "root"));
  records[11].name = "bad\x1b]52;unsafe\x07 界\nname";
  records[11].model = "model\x1b_Gunsafe";
  const source = new Fixture(state(...records));
  for (let i = 0; i < 11; i++) add(source.state, records[i].id, 1, 3, i === 0 ? "error" : "completed");
  add(source.state, records[11].id, 2).phase = "waiting";
  const f = view(source);
  try {
    const lines = f.component.render(140), output = lines.join("\n");
    expect(lines.length).toBe(8);
    expect(output.match(/✓/g)).toHaveLength(5); expect(output).not.toContain("✗"); expect(output).toMatch(/◷ .* · waiting/);
    expect(output).toContain("stable-11"); expect(output).toContain("stable-10"); expect(lines.at(-1)).toBe("↑ 6 above");
    expect(output).not.toContain("more");
    expect(output).not.toContain("/subagents"); expect(output).not.toContain("10 finished");
    expect(output).not.toContain("\x1b"); expect(output).not.toContain("\x07");
    for (const [rows, width] of [[32, 140], [24, 40], [12, 18], [3, 2], [1, 1], [0, 5], [32, 0]]) {
      f.resize(rows); const rendered = f.component.render(width);
      expect(rendered.length).toBeLessThanOrEqual(Math.min(8, rows));
      expect(rendered.every(line => visibleWidth(line) <= width)).toBe(true);
    }
    f.resize(12); expect(f.component.render(18).join("\n")).toContain("waiting");
    f.resize(32); const before = f.component.render(140); f.component.invalidate(); expect(f.component.render(140)).toEqual(before);
    const empty = view(new Fixture(state())); expect(empty.component.render(80)).toEqual([]); empty.component.dispose();
  } finally { f.component.dispose(); }
  const deep = state(...Array.from({ length: 30 }, (_, i) => record(`deep-${i}`, i ? `deep-${i - 1}` : "root")));
  add(deep, "deep-29", 1).phase = "waiting";
  const d = view(new Fixture(deep));
  expect(d.component.render(80).join("\n")).toContain("depth 30"); d.component.dispose();
});

test("attachment is root TUI-only, repeat attach subscribes once, replacement and host disposal release resources", () => {
  const source = new Fixture(state(record("a"))); add(source.state, "a", 1).phase = "waiting";
  const source2 = new Fixture(state(record("b"))); add(source2.state, "b", 2).phase = "waiting";
  const widgets = new Map<string, SubagentOverview>(); let installations = 0;
  const ctx = { mode: "tui", ui: { setWidget(key: string, factory: Function | undefined) {
    widgets.get(key)?.dispose(); widgets.delete(key);
    if (factory) { installations++; widgets.set(key, factory({ terminal: { rows: 32 }, requestRender() {} }, theme)); }
  } } } as unknown as ExtensionContext;
  const attachment = new OverviewAttachment();
  for (const mode of ["print", "rpc", "json"]) attachment.attach({ ...ctx, mode } as ExtensionContext, source);
  expect(installations).toBe(0);
  attachment.attach(ctx, source); attachment.attach(ctx, source); attachment.attach({ ...ctx }, source);
  expect(installations).toBe(1); expect(source.subscribed).toBe(1); expect(widgets.get("subagents")!.render(120).join("\n")).toContain("waiting");
  attachment.attach(ctx, source2); expect(source.unsubscribed).toBe(1); expect(source2.subscribed).toBe(1);
  attachment.dispose(); attachment.dispose(); expect(widgets.size).toBe(0); expect(source2.unsubscribed).toBe(1);
  attachment.attach(ctx, source2); widgets.get("subagents")!.dispose(); expect(source2.listeners.size).toBe(0); attachment.dispose();
});

const context = (args: unknown, overrides: object = {}) => ({ args, state: {}, toolCallId: "card", invalidate() {}, expanded: false, isPartial: false,
  isError: false, executionStarted: true, argsComplete: true, lastComponent: undefined, cwd: "/tmp", showImages: false, ...overrides }) as ToolRenderContext;
const ack = { name: "Review authentication", agent_id: "s-12345678-other", run_id: "i-full-run", model: "fixture/model", requestedThinking: "high", effectiveThinking: "low" };
const result = { content: [{ type: "text" as const, text: "unchanged model-facing acknowledgement JSON" }], details: ack };

test("spawn/resume/steer native cards respect expansion, plain guidance, partial and accepted vs task completion", () => {
  for (const [name, args, title] of [
    ["spawn_subagent", { name: "Review authentication", model: "fixture/model", thinking: "high", prompt: "FULL TASK\nsecond line\x1b]52;unsafe\x07" }, "Spawn subagent"],
    ["resume_subagent", { agent_id: ack.agent_id, prompt: "FULL TASK\nsecond line" }, "Resume subagent"],
    ["steer_subagent", { agent_id: ack.agent_id, message: "FULL TASK\nsecond line" }, "Steer subagent"],
  ] as const) {
    const renderers = delegationRenderers(name)!;
    const ctx = context(args); const original = JSON.stringify({ args, result });
    const call = renderers.renderCall!(args, theme, ctx);
    expect(call.render(120)).toHaveLength(3);
    expect(call.render(120).join("\n")).toContain(title); expect(call.render(120).join("\n")).not.toContain("FULL TASK");
    renderers.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx);
    expect(call.render(120).join("\n")).toContain("Review authentication");
    const done = renderers.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx).render(120).join("\n");
    expect(done).toBe("");
    expect(call.render(120).join("\n")).not.toContain("Accepted");
    expect(call.render(120).join("\n")).not.toContain("acknowledgement JSON");
    const partial = renderers.renderResult!(result, { expanded: false, isPartial: true }, theme, ctx).render(120).join("\n");
    expect(partial).toBe("");
    const expanded = renderers.renderCall!(args, theme, { ...ctx, expanded: true }).render(120).join("\n");
    expect(expanded).toContain("FULL TASK"); expect(expanded).toContain("second line"); expect(expanded).not.toContain("\x1b");
    expect(JSON.stringify({ args, result })).toBe(original);
    for (const width of [1, 5, 18, 120]) expect(call.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
  }
});

test("acknowledged cards and named reports redraw without registry lookups", () => {
  let lookups = 0;
  const lookup = () => { lookups++; return undefined; };
  for (const name of ["spawn_subagent", "resume_subagent", "steer_subagent"]) {
    const args = { agent_id: ack.agent_id, prompt: "Full task", message: "Full guidance" };
    const call = new ToolExecutionComponent(name, "lazy-card", args, { showImages: false }, delegationRenderers(name, lookup),
      { requestRender() {} } as TUI, "/tmp");
    call.updateResult({ ...result, isError: false });
    lookups = 0; // Pending cards may resolve an ID, acknowledged redraws must not.
    for (const expanded of [false, true]) {
      call.setExpanded(expanded);
      for (let frame = 0; frame < 10; frame++) expect(strip(call.render(160).join("\n"))).toContain(ack.name);
    }
    expect(lookups).toBe(0);
  }
  const message = { role: "custom" as const, customType: REPORT_TYPE,
    content: `Subagent ${ack.name} - completed\n\nFull report`, display: true, timestamp: 1,
    details: { agentId: ack.agent_id, outcome: "completed" } };
  for (const expanded of [false, true]) {
    expect(reportRenderer(lookup)(message, { expanded, outputPad: 0 }, theme)!.render(120).join("\n")).toContain(ack.name);
  }
  expect(lookups).toBe(0);
});

test("partial args and replay ID fallback work; readonly ID lookup disambiguates names and model/thinking", () => {
  const a = record("s-first-id", "root", "Duplicate"), b = record("s-second-id", "root", "Duplicate");
  const renderers = delegationRenderers("resume_subagent", id => [a, b].find(value => value.id === id))!;
  for (const args of [{}, { agent_id: "unknown-id" }, { agent_id: a.id }, { agent_id: b.id }]) {
    const output = renderers.renderCall!(args, theme, context(args, { argsComplete: false })).render(120).join("\n");
    if ("agent_id" in args) expect(output).toContain(args.agent_id.slice(0, 10));
    if (args.agent_id === a.id || args.agent_id === b.id) { expect(output).toContain("Duplicate"); expect(output).toContain("fixture/model"); expect(output).toContain("thinking: low"); }
    expect(output).not.toContain("{");
  }
  expect(delegationRenderers("read")).toBeUndefined();
});

test("one real ANSI panel covers every delegation action pending/partial/accepted/error in dark, light and transparent System", () => {
  const panelAnsi = (line: string) => line.match(/\x1b\[(?:48;[\d;]+|4[0-7]|10[0-7])m/)?.[0];
  try {
    for (const palette of ["dark", "light", "system", "transparent-light"]) {
      initTheme(palette === "transparent-light" ? "light" : palette, false);
      let shared: string | undefined;
      for (const name of ["spawn_subagent", "resume_subagent", "steer_subagent"]) {
        const args = { name: ack.name, agent_id: ack.agent_id, prompt: "FULL TASK", message: "FULL GUIDANCE" };
        const renderers = delegationRenderers(name)!;
        const nativeCall = renderers.renderCall!, nativeResult = renderers.renderResult!;
        let active: Theme | undefined;
        const boldCalls: string[] = [];
        const choose = (theme: Theme) => active ??= withAnsiBold(palette !== "transparent-light" ? theme
          : new Theme({ text: "#111", muted: "#555", dim: "#666", toolTitle: "#111", error: "#900", thinkingXhigh: "#555" } as any,
            { toolPendingBg: "", selectedBg: "" } as any, "truecolor", { appearance: "light" }), boldCalls);
        renderers.renderCall = (args, theme, context) => { const chosen = choose(theme); active = chosen; return nativeCall(args, chosen, context); };
        renderers.renderResult = (result, options, theme, context) => nativeResult(result, options, choose(theme), context);
        const component = new ToolExecutionComponent(name, "panel", args, { showImages: false }, renderers, { requestRender() {} } as TUI, "/tmp");
        const before = JSON.stringify({ args, result });
        const panel = () => {
          const lines = component.render(180).slice(1); // Native transcript spacing precedes our one panel.
          expect(lines.length).toBeGreaterThanOrEqual(3);
          const bg = panelAnsi(lines[0]); expect(bg).toBeDefined();
          expect(lines.every(line => panelAnsi(line) === bg)).toBe(true);
          expect(lines.every(line => visibleWidth(line) <= 180)).toBe(true);
          return bg!;
        };
        const background = panel(); shared ??= background; expect(background).toBe(shared);
        if (palette === "system" || palette === "transparent-light") expect(active!.getBgAnsi("toolPendingBg")).toBe("\x1b[49m");
        if (palette === "transparent-light") expect(background).toBe("\x1b[48;2;232;232;232m");
        component.updateResult({ ...result, isError: false }, true); expect(panel()).toBe(background);
        component.updateResult({ ...result, isError: false }); expect(panel()).toBe(background);
        const prefix = `${name === "spawn_subagent" ? "Spawn" : name === "resume_subagent" ? "Resume" : "Steer"} subagent:`;
        expect(component.render(180).join("\n")).toContain(`\x1b[1m${prefix}\x1b[22m`);
        expect(boldCalls).toContain(prefix);
        const text = strip(component.render(180).join("\n"));
        expect(text).toContain(`${name === "spawn_subagent" ? "Spawn" : name === "resume_subagent" ? "Resume" : "Steer"} subagent: ${ack.name}`);
        for (const unwanted of ["Accepted", "report arrives", "acknowledgement JSON", " | ", " / "]) expect(text).not.toContain(unwanted);
        expect(component.render(180)).toHaveLength(4); // Native spacer + one shell, not separate call/result padding.
        component.setExpanded(true); expect(panel()).toBe(background);
        expect(strip(component.render(180).join("\n"))).toContain(name === "steer_subagent" ? "FULL GUIDANCE" : "FULL TASK");
        component.updateResult({ content: [{ type: "text", text: "FULL ERROR" }], details: {}, isError: true }); expect(panel()).toBe(background);
        expect(strip(component.render(180).join("\n"))).toContain("FULL ERROR");
        expect(JSON.stringify({ args, result })).toBe(before);
        for (const width of [1, 2, 12, 40]) expect(component.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
      }
    }
  } finally { initTheme("dark", false); }
});

test("native tool execution supplies error/expansion flags, full error stays reachable and full task is expanded", () => {
  const args = { agent_id: "unknown", prompt: "ENTIRE PROMPT\nlast task line" };
  const component = new ToolExecutionComponent("resume_subagent", "native-card", args, { showImages: false }, delegationRenderers("resume_subagent"),
    { requestRender() {} } as TUI, "/tmp");
  const error = "Unable to resume\nfull diagnostic line\nlast error detail";
  component.updateResult({ content: [{ type: "text", text: error }], details: {}, isError: true });
  let output = strip(component.render(100).join("\n"));
  expect(output).toContain("Error: Unable to resume"); expect(output).not.toContain("Accepted"); expect(output).not.toContain("ENTIRE PROMPT");
  component.setExpanded(true); output = strip(component.render(100).join("\n"));
  expect(output).toContain("ENTIRE PROMPT"); expect(output).toContain("last task line"); expect(output).toContain("last error detail");
  component.setExpanded(false); expect(strip(component.render(100).join("\n"))).not.toContain("ENTIRE PROMPT");
});

test("native custom report component propagates initial expansion and toggles, preserves Markdown/IDs/diagnostic and empty fallback", () => {
  const owner = record("s-full-id", "root", "Review authentication"), snapshot = state(owner);
  const run = add(snapshot, owner.id, 1, 2, "error"); run.outcome!.diagnostic = "FULL DIAGNOSTIC";
  run.outcome!.text = "# Full Markdown heading\n\n**report body**\n\n```ts\nconst full = true;\n```\nlast final line";
  const message = { role: "custom" as const, customType: REPORT_TYPE, content: reportText(owner, run), display: true, timestamp: 1,
    details: { agentId: owner.id, runId: run.id, outcome: "error" } };
  const bytes = JSON.stringify(message);
  const component = new CustomMessageComponent(message, reportRenderer());
  let output = strip(component.render(120).join("\n"));
  expect(output).toContain("Review authentication"); expect(output).toContain("error"); expect(output).not.toContain("report body");
  component.setExpanded(true); output = strip(component.render(120).join("\n"));
  for (const text of ["Full Markdown heading", "report body", "const full = true;", "FULL DIAGNOSTIC", owner.id, run.id, "last final line"]) expect(output).toContain(text);
  component.setExpanded(false); expect(strip(component.render(120).join("\n"))).not.toContain("last final line");
  component.setExpanded(true); component.invalidate(); expect(strip(component.render(120).join("\n"))).toContain("last final line");
  expect(JSON.stringify(message)).toBe(bytes);
  run.outcome!.text = "";
  const empty = new CustomMessageComponent({ ...message, content: reportText(owner, run) }, reportRenderer()); empty.setExpanded(true);
  expect(strip(empty.render(120).join("\n"))).toContain("No final assistant text");
});

test("historical reports and malformed details never throw or hide full persisted content when expanded", () => {
  const saved = record("s-historical", "root", "Saved name");
  const renderer = reportRenderer(id => id === saved.id ? saved : undefined);
  for (const [content, details] of [
    ["Original historical v1 report", { specialistId: saved.id, invocationId: "old", outcome: "completed" }],
    ["Original historical v2 report", { agentId: saved.id, runId: "v2", outcome: "interrupted" }],
    ["Subagent Named - aborted\nagent_id: id-from-content\n\nFULL OLD BODY", undefined],
    ["malformed report FULL BODY", ["bad"]], ["malformed outcome FULL BODY", { outcome: { toString: null, valueOf: null } }], ["", null],
  ] as const) {
    const message = { role: "custom" as const, customType: REPORT_TYPE, content, details, display: true, timestamp: 1 };
    const collapsed = renderer(message, { expanded: false, outputPad: 0 }, theme)!.render(120).join("\n");
    expect(collapsed).toContain(content.includes("Named") ? "Named" : details && !Array.isArray(details) && ("specialistId" in details || "agentId" in details) ? "Saved name" : "Subagent report");
    const expanded = strip(renderer(message, { expanded: true, outputPad: 0 }, theme)!.render(120).join("\n"));
    for (const line of content.split("\n").filter(Boolean)) expect(expanded).toContain(line);
    if (!content) expect(expanded).toContain("No final assistant text");
  }
});

test("cold inspector uses the same native delegation cards and report renderer; native tool expansion key reveals both", () => {
  const args = { name: "Inspector name", prompt: "FULL INSPECTOR TASK", model: "fixture/model", thinking: "low" };
  const report = "Subagent Inspector name - completed\nagent_id: s-inspector\nrun_id: r-inspector\n\nFULL INSPECTOR REPORT";
  const run = { id: "r-inspector", agentId: "s-inspector", phase: "terminal", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:03.400Z" } as RunRecord;
  const source = { snapshot: () => ({ messages: [
    { id: "assistant", message: { role: "assistant", content: [{ type: "toolCall", id: "delegation", name: "spawn_subagent", arguments: args }], stopReason: "toolUse" } },
    { id: "result", message: { role: "toolResult", toolCallId: "delegation", toolName: "spawn_subagent", content: result.content, details: { ...ack, name: args.name }, isError: false } },
    { id: "report", message: { role: "custom", customType: REPORT_TYPE, content: report, display: true, timestamp: 1 } },
  ], tools: [] }), subscribe: () => () => {} };
  const inspector = new TranscriptInspector(source as any, { terminal: { rows: 40 }, requestRender() {} } as TUI, theme,
    new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tools" } }), "/tmp", () => {}, undefined, undefined, undefined,
    id => id === run.id ? run : undefined);
  let output = strip(inspector.render(120).join("\n")); expect(output).toContain("Spawn subagent: Inspector name");
  expect(output).toContain("63.4s");
  expect(output).not.toContain("FULL INSPECTOR TASK"); expect(output).not.toContain("FULL INSPECTOR REPORT");
  inspector.handleInput("\x0f"); output = strip(inspector.render(120).join("\n"));
  expect(output).toContain("FULL INSPECTOR TASK"); expect(output).toContain("FULL INSPECTOR REPORT"); expect(output).toContain("63.4s");
  inspector.handleInput("\x0f"); expect(strip(inspector.render(120).join("\n"))).not.toContain("FULL INSPECTOR REPORT"); inspector.dispose();
});

test("live inspector resolves its owning session's registered report renderer, including historical names", () => {
  const saved = record("s-live-child", "root", "Saved historical child");
  const expansion: boolean[] = [];
  const renderer = reportRenderer(id => id === saved.id ? saved : undefined);
  const source = {
    snapshot: () => ({ messages: [{ id: "report", message: { role: "custom", customType: REPORT_TYPE,
      content: "FULL HISTORICAL CHILD REPORT", details: { specialistId: saved.id, outcome: "error" }, display: true, timestamp: 1 } }], tools: [] }),
    subscribe: () => () => {},
    resolveMessageRenderer(type: string) {
      expect(type).toBe(REPORT_TYPE);
      return (message: any, options: any, activeTheme: Theme) => { expansion.push(options.expanded); return renderer(message, options, activeTheme); };
    },
  };
  const inspector = new TranscriptInspector(source as any, { terminal: { rows: 16 }, requestRender() {} } as TUI, theme,
    new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tools" } }), "/tmp", () => {});
  let output = strip(inspector.render(120).join("\n"));
  expect(output).toContain(saved.name); expect(output).toContain("error"); expect(output).not.toContain("FULL HISTORICAL CHILD REPORT");
  inspector.handleInput("\x0f"); output = strip(inspector.render(120).join("\n")); expect(output).toContain("FULL HISTORICAL CHILD REPORT");
  inspector.handleInput("\x0f"); expect(strip(inspector.render(120).join("\n"))).toContain(saved.name);
  expect(expansion).toEqual([false, true, false]); inspector.dispose();
});

test("completion reports own one delegation-family panel in dark/light/transparent System, collapsed and expanded", () => {
  const owner = record("s-report-panel", "root", "Finished work"), snapshot = state(owner);
  const run = add(snapshot, owner.id, 1, 64.4);
  run.outcome!.text = "# Full report\n\n**Body** with `code`.\n\nLast report line";
  const message = { role: "custom" as const, customType: REPORT_TYPE, content: reportText(owner, run), display: true, timestamp: 1,
    details: { agentId: owner.id, runId: run.id, outcome: "completed" } };
  const bytes = JSON.stringify({ message, snapshot });
  const background = (line: string) => line.match(/\x1b\[(?:48;[\d;]+|4[0-7]|10[0-7])m/)?.[0];
  try {
    for (const palette of ["dark", "light", "system", "transparent-light"]) {
      initTheme(palette === "transparent-light" ? "light" : palette, false);
      let selected: Theme | undefined;
      const boldCalls: string[] = [];
      const choose = (active: Theme) => selected ??= withAnsiBold(palette !== "transparent-light" ? active
        : new Theme({ text: "#111", toolTitle: "#111", customMessageLabel: "#555", customMessageText: "#111", success: "#050", muted: "#555", dim: "#666", thinkingXhigh: "#555" } as any,
          { toolPendingBg: "", selectedBg: "" } as any, "truecolor", { appearance: "light" }), boldCalls);
      const renderer = reportRenderer(() => undefined, id => snapshot.runs[id]);
      const component = new CustomMessageComponent(message, (message, options, active) => renderer(message, options, choose(active)));
      const call = delegationRenderers("spawn_subagent")!.renderCall!({ name: "Comparison" }, choose(selected!), context({}));
      const expected = background(call.render(140)[0]);
      for (const expanded of [false, true]) {
        component.setExpanded(expanded);
        const lines = component.render(140).slice(1); // Native transcript spacer, not a second padded box.
        if (expanded) expect(lines.length).toBeGreaterThan(3); else expect(lines).toHaveLength(3);
        expect(background(lines[0])).toBeDefined();
        expect(lines.every(line => background(line) === expected)).toBe(true);
        expect(lines.every(line => visibleWidth(line) === 140)).toBe(true);
        expect(strip(lines[1])).toContain("✓ Finished work [s-report-p] · 63.4s");
        expect(strip(lines[1])).not.toContain("finished");
        expect(strip(lines.join("\n"))).toContain("Finished work");
        if (expanded) for (const text of [owner.id, run.id, "Full report", "Body", "Last report line"]) expect(strip(lines.join("\n"))).toContain(text);
        else expect(strip(lines.join("\n"))).not.toContain("Last report line");
        expect(lines.join("\n")).toContain("\x1b[1mFinished work\x1b[22m");
        expect(boldCalls).toContain("Finished work");
        expect(boldCalls.some(value => strip(value) === "✓ finished")).toBe(false);
        for (const width of [0, 1, 2, 20, 40]) expect(component.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
      }
      if (palette === "transparent-light") expect(expected).toBe("\x1b[48;2;232;232;232m");
    }
  } finally { initTheme("dark", false); }
  expect(JSON.stringify({ message, snapshot })).toBe(bytes);
});

test("report wall seconds follow captured historical run IDs across resumes, aliases and text IDs, not latest state", () => {
  const owner = record("s-runtime", "root", "Historical generations"), snapshot = state(owner);
  const first = add(snapshot, owner.id, 1, 64.4), second = add(snapshot, owner.id, 70, 77.2), latest = add(snapshot, owner.id, 80);
  latest.phase = "waiting";
  const bytes = JSON.stringify(snapshot), reads: string[] = [];
  const renderer = reportRenderer(() => { throw new Error("Named report must not clone/read the registry"); }, id => { reads.push(id); return snapshot.runs[id]; });
  for (const [run, details, content] of [
    [first, { agentId: owner.id, runId: first.id }, reportText(owner, first)],
    [second, { agent_id: owner.id, deliveryId: second.id }, reportText(owner, second)],
    [first, { specialistId: owner.id, invocationId: first.id }, "LEGACY FULL BODY"],
    [second, undefined, reportText(owner, second).replaceAll("\n", "\r\n")],
  ] as const) {
    const message = { role: "custom" as const, customType: REPORT_TYPE, content, details: { name: owner.name, ...details }, display: true, timestamp: 1 };
    const original = JSON.stringify(message);
    for (const expanded of [false, true]) {
      const component = renderer(message, { expanded, outputPad: 1 }, theme)!;
      for (let draw = 0; draw < 3; draw++) {
        const output = strip(component.render(160).join("\n"));
        expect(output).toContain(run === first ? "63.4s" : "7.2s");
        if (expanded) expect(output).toContain(content === "LEGACY FULL BODY" ? content : "full final");
      }
    }
    expect(JSON.stringify(message)).toBe(original);
  }
  expect(reads).not.toContain(latest.id); expect(new Set(reads)).toEqual(new Set([first.id, second.id]));
  expect(JSON.stringify(snapshot)).toBe(bytes);
});

test("missing, invalid, foreign and nonterminal timing is omitted, zero/sub-tenth seconds remain accurate", () => {
  const owner = record("s-timing"), snapshot = state(owner), saved = add(snapshot, owner.id, 1, 2);
  const base = { role: "custom" as const, customType: REPORT_TYPE, content: reportText(owner, saved), display: true, timestamp: 1,
    details: { name: owner.name, agentId: owner.id, runId: saved.id } };
  for (const value of [undefined, { ...saved, id: "foreign-run" }, { ...saved, agentId: "foreign-agent" }, { ...saved, agentId: "" }, { ...saved, phase: "waiting" },
    { ...saved, phase: "running" }, { ...saved, startedAt: "bad" }, { ...saved, endedAt: "bad" }, { ...saved, endedAt: undefined },
    { ...saved, startedAt: 0 }, { ...saved, endedAt: "1970-01-01T00:00:00.000Z" }]) {
    const renderer = reportRenderer(() => undefined, (() => value) as RunLookup);
    for (const expanded of [false, true]) expect(strip(renderer(base, { expanded, outputPad: 0 }, theme)!.render(160).join("\n"))).not.toMatch(/\d+\.\d+s/);
  }
  const renderer = reportRenderer(() => undefined, id => id === saved.id ? saved : undefined);
  for (const details of [{ ...base.details, runId: "unknown" }, { ...base.details, agentId: "foreign" },
    { ...base.details, agent_id: "conflicting-agent" }, { ...base.details, specialistId: "conflicting-agent" }]) {
    expect(strip(renderer({ ...base, details }, { expanded: false, outputPad: 0 }, theme)!.render(160).join("\n"))).not.toMatch(/\d+\.\d+s/);
  }
  expect(strip(renderer({ ...base, content: reportText(owner, saved).replace(`agent_id: ${owner.id}`, "agent_id: foreign") },
    { expanded: false, outputPad: 0 }, theme)!.render(160).join("\n"))).not.toMatch(/\d+\.\d+s/);
  saved.endedAt = saved.startedAt;
  expect(strip(renderer(base, { expanded: false, outputPad: 0 }, theme)!.render(160).join("\n"))).toContain("0.0s");
  saved.endedAt = new Date(Date.parse(saved.startedAt) + 40).toISOString();
  expect(strip(renderer(base, { expanded: false, outputPad: 0 }, theme)!.render(160).join("\n"))).toContain("0.0s");
});

test("already-hydrated native reports acquire timing at draw time after read-only attachment, without expansion toggles", () => {
  const owner = record("s-late-timing"), snapshot = state(owner), run = add(snapshot, owner.id, 1, 64.4);
  let attached = false, reads = 0;
  const message = { role: "custom" as const, customType: REPORT_TYPE, content: reportText(owner, run), display: true, timestamp: 1,
    details: { agentId: owner.id, runId: run.id, outcome: "completed" } };
  for (const expanded of [false, true]) {
    attached = false;
    const component = new CustomMessageComponent(message, reportRenderer(() => undefined, id => { reads++; return attached ? snapshot.runs[id] : undefined; }));
    component.setExpanded(expanded);
    expect(strip(component.render(140).join("\n"))).not.toContain("63.4s");
    attached = true;
    expect(strip(component.render(140).join("\n"))).toContain("63.4s");
  }
  expect(reads).toBe(4);
});

test("bridge renderer stays lazy and read-only; optional run lookup and captured-service fallback resolve exact reports", async () => {
  const owner = record("s-bridge-timing"), snapshot = state(owner), run = add(snapshot, owner.id, 1, 64.4);
  for (const explicit of [false, true]) {
    let renderer: ReturnType<typeof reportRenderer> | undefined, activations = 0;
    const tools = new Map<string, any>();
    const service = { store: { state: snapshot }, owned: () => owner, steer() {}, get records() { throw new Error("No registry clone during named report draw"); } };
    registerBridge({ registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer: (_type: string, value: any) => renderer = value } as any,
      { actor: () => undefined, roles: () => { throw new Error("No roles during rendering"); },
        resolve: async () => { activations++; return { service, models: [] } as any; },
        ...(explicit ? { lookupRun: (id: string) => snapshot.runs[id] } : {}) });
    const message = { role: "custom" as const, customType: REPORT_TYPE, content: reportText(owner, run), display: true, timestamp: 1 };
    const component = renderer!(message, { expanded: false, outputPad: 0 }, theme)!;
    expect(strip(component.render(160).join("\n"))).toContain(explicit ? "63.4s" : owner.name);
    expect(activations).toBe(0);
    if (!explicit) {
      expect(strip(component.render(160).join("\n"))).not.toContain("63.4s");
      await tools.get("steer_subagent").execute("tool", { agent_id: owner.id, message: "unchanged guidance" }, undefined, undefined, {});
      expect(strip(component.render(160).join("\n"))).toContain("63.4s");
      expect(activations).toBe(1);
    }
  }
});

test("menu rows lead with activity icons and keep dim IDs next to names before metadata and diagnostics", () => {
  const snapshot = state(record("done", "root", "Finished task"), record("runner", "root", "Running task"),
    record("wait", "root", "Waiting task"), record("error", "root", "Failed task"));
  add(snapshot, "done", 1, 2); add(snapshot, "runner", 1);
  add(snapshot, "wait", 1).phase = "waiting"; add(snapshot, "error", 1, 2, "error");
  const themed = { ...theme, fg: (token: string, text: string) => token === "dim" ? `\x1b[2m${text}\x1b[22m` : text } as Theme;
  const ui = { terminal: { rows: 32 }, requestRender() {} } as TUI;
  const component = new SubagentOverview(new Fixture(snapshot), ui, themed, undefined, () => 3000);
  try {
    const raw = component.render(160), lines = raw.map(strip);
    expect(lines).toContain("  ✓ Finished task [done] · fixture/model · thinking: low · 1.0s");
    expect(lines.some(line => /^  [\u2800-\u28ff] Running task \[runner\] · fixture\/model · thinking: low · 2\.0s$/.test(line))).toBe(true);
    expect(lines).toContain("  ◷ Waiting task [wait] · fixture/model · thinking: low · waiting · 2.0s");
    expect(lines).toContain("  ✗ Failed task [error] · fixture/model · thinking: low · error · 1.0s");
    expect(raw.find(line => strip(line).includes("✓ Finished task"))).toContain("\x1b[2m [done]\x1b[22m");
    component.focused = true; ui.terminal.rows = 7;
    const compact = strip(component.render(160)[0]);
    expect(compact).toMatch(/^› [\u2800-\u28ff] Running task \[runner\] · 2\/4 · 2\.0s$/);
    expect(compact).not.toContain("Relevant");
    expect(compact).not.toContain("· running");
  } finally { component.dispose(); }
});

test("overview has a title/mode strip and pointer selection without highlights, status counts or focus-only chrome", () => {
  const snapshot = state(record("root-agent", "root", "Parent"), record("child-agent", "root-agent", "Child"));
  add(snapshot, "root-agent", 1, 2); add(snapshot, "child-agent", 1, 2);
  const source = new Fixture(snapshot), ui = { terminal: { rows: 32 }, requestRender() {} } as TUI;
  const themed = { ...theme, fg: (token: string, text: string) => token === "accent" ? `\x1b[36m${text}\x1b[39m` : text,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`, getBgAnsi: () => "\x1b[48;2;48;48;48m",
    bg: (_token: string, text: string) => `\x1b[48;2;48;48;48m${text}\x1b[49m` } as unknown as Theme;
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  const component = new SubagentOverview(source, ui, themed, { keys, inspect() {}, leave() { component.focused = false; } });
  try {
    const inactive = component.render(140), plain = inactive.map(strip);
    expect(plain[0]).toMatch(/^Subagents ─+$/);
    expect(inactive[0]).toContain("\x1b[1mSubagents\x1b[22m");
    expect(plain[0]).not.toMatch(/[>|]|finished|Tab|Enter|Esc|Up\/Down/);
    expect(plain[1]).toStartWith("  ✓ Parent [root-agent]"); expect(plain[2]).toStartWith("    └─ ✓ Child [child-agen]");
    expect(plain).toHaveLength(3);
    component.focused = true;
    const focused = component.render(140);
    expect(focused.join("\n")).not.toContain("\x1b[48;"); expect(inactive.join("\n")).not.toContain("\x1b[48;");
    expect(strip(focused[1])).toStartWith("› ✓ Parent"); expect(strip(focused[2])).toStartWith("    └─ ✓ Child");
    expect(focused.map(line => strip(line).replace(/^› /, "  ")).slice(0, 3)).toEqual(plain.slice(0, 3));
    expect(strip(focused.join("\n"))).not.toMatch(/2 finished|\/subagents/);
    expect(focused).toHaveLength(inactive.length);
    expect(strip(focused.join("\n"))).not.toMatch(/Up\/Down|Enter inspect|Esc prompt/);
    component.handleInput("\x1b[B"); expect(strip(component.render(140)[2])).toStartWith("›   └─ ✓ Child");
    component.handleInput("\t"); expect(strip(component.render(140)[0])).toStartWith("Subagents  [All]");
    for (const rows of [16, 12, 8, 7, 6, 3, 1]) {
      ui.terminal.rows = rows;
      const rendered = component.render(140);
      expect(rendered.length).toBeLessThanOrEqual(Math.min(8, Math.max(1, Math.floor(rows / 4))));
      expect(strip(rendered.join("\n"))).toContain("Child");
      if (rows < 12) expect(rendered.join("\n")).not.toContain("Up/Down");
      if (rows < 8) expect(strip(rendered[0])).toContain("2/2 · [All]");
    }
    ui.terminal.rows = 32;
    let shade = "dark";
    themed.fg = (_token, text) => `${shade}:${text}`;
    expect(component.render(120)[0]).toContain("dark:"); shade = "light"; component.invalidate();
    expect(component.render(120)[0]).toContain("light:"); expect(component.render(120)[0]).not.toContain("dark:");
  } finally { component.dispose(); }
});
