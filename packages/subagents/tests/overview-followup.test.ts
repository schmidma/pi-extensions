import { beforeAll, expect, spyOn, test } from "bun:test";
import { initTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as TuiKeys, Loader, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { reportRenderer } from "../extensions/subagents/cards.ts";
import { SubagentOverview } from "../extensions/subagents/overview.ts";
import { runElapsed } from "../extensions/subagents/presentation.ts";
import { REPORT_TYPE, reportText, type RunRecord, type SubagentRecord, type SubagentState } from "../extensions/subagents/state.ts";
import { agentTree } from "../extensions/subagents/tree.ts";

beforeAll(() => initTheme("dark", false));

const theme = { fg: (_token: string, value: string) => value, bold: (value: string) => value, getBgAnsi: () => "", style: (value: string) => value } as Theme;
const keys = new TuiKeys(TUI_KEYBINDINGS) as KeybindingsManager;
function fixture(count = 20) {
  const state: SubagentState = { version: 3, rootKey: "root", subagents: {}, runs: {} };
  for (let i = 0; i < count; i++) {
    const id = `id-${i}`;
    const owner: SubagentRecord = { id, name: `Name ${i}`, parentId: "root", model: "fixture/model", requestedThinking: "low", effectiveThinking: "low",
      generation: 1, cwd: "/tmp", projectTrusted: false, sessionFile: "", sessionId: "", currentRun: `run-${i}` };
    state.subagents[id] = owner;
    state.runs[`run-${i}`] = { id: `run-${i}`, agentId: id, parentId: "root", parentRunId: null, receiverRunId: null, generation: 1,
      phase: "terminal", startedAt: new Date(1000).toISOString(), endedAt: new Date(64000).toISOString(), outcome: { status: "completed", text: "**FULL REPORT**" },
      prompt: "task", boundary: null, delivered: false };
  }
  const listeners = new Set<() => void>();
  const source = { snapshot: () => structuredClone(state), subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); } };
  let renders = 0, now = 65000;
  const ui = { terminal: { rows: 32 }, requestRender() { renders++; } } as TUI;
  const view = new SubagentOverview(source, ui, theme, { keys, inspect() {}, leave() { view.focused = false; view.resetBrowsing(); } }, () => now);
  return { state, view, ui, listeners, change() { for (const fn of listeners) fn(); }, renders: () => renders, advance(ms: number) { now += ms; } };
}
function ids(lines: string[]): string[] { return lines.flatMap(line => /\[(id-\d+)\]/.exec(line)?.[1] ?? []); }

test("contiguous directional windows have exact top/middle/bottom counts, no hidden gaps and stable focus height", () => {
  const f = fixture();
  try {
    const passive = f.view.render(180);
    expect(ids(passive)).toEqual(["id-0", "id-1", "id-2", "id-3", "id-4", "id-5"]);
    expect(passive.at(-1)).toBe("↓ 14 below");
    f.view.focused = true;
    expect(f.view.render(180)).toHaveLength(passive.length);
    f.view.handleInput("\x1b[6~");
    let lines = f.view.render(180);
    expect(ids(lines)).toEqual(["id-3", "id-4", "id-5", "id-6", "id-7", "id-8"]);
    expect(lines.at(-1)).toBe("↑ 3 above · ↓ 11 below");
    expect(lines.find(line => line.startsWith("› "))).toContain("[id-6]");
    f.view.handleInput("\x1b[F"); lines = f.view.render(180);
    expect(ids(lines)).toEqual(["id-14", "id-15", "id-16", "id-17", "id-18", "id-19"]);
    expect(lines.at(-1)).toBe("↑ 14 above");
    for (const rows of [32, 24, 16, 12, 8, 7, 3, 1]) {
      f.ui.terminal.rows = rows;
      lines = f.view.render(80);
      expect(lines.some(line => line.startsWith("› ") && line.includes("[id-19]"))).toBe(true);
      expect(lines.every(line => visibleWidth(line) <= 80)).toBe(true);
      expect(lines.join("\n")).not.toMatch(/more|Up\/Down|Enter inspect|\/subagents|finished/);
    }
  } finally { f.view.dispose(); }
});

test("passive anchor prefers running over earlier waiting and deduplicates deep contiguous context", () => {
  const f = fixture(20);
  try {
    for (let i = 1; i < 20; i++) f.state.subagents[`id-${i}`].parentId = `id-${i - 1}`;
    f.state.subagents.alias = { ...f.state.subagents["id-18"] }; // malformed duplicate record ID stays a single node
    f.state.runs["run-0"].phase = "waiting";
    f.state.runs["run-18"].phase = "running";
    f.change();
    let lines = f.view.render(180);
    expect(ids(lines)).toEqual(["id-14", "id-15", "id-16", "id-17", "id-18", "id-19"]);
    expect(lines.at(-1)).toBe("↑ 14 above");
    expect(f.view.getSelectedAgentId()).toBe("id-18");
    expect(lines.join("\n")).toContain("depth 19");
    expect(agentTree(f.state)).toHaveLength(20);
    f.state.runs["run-18"].phase = "terminal"; f.change();
    lines = f.view.render(180);
    expect(ids(lines)[0]).toBe("id-0"); expect(f.view.getSelectedAgentId()).toBe("id-0");
    f.state.runs["run-0"].phase = "terminal"; f.change();
    f.view.setAcknowledgedRuns(new Set(Object.keys(f.state.runs)));
    const recent = { ...f.state.runs["run-19"], id: "recent", generation: 2, startedAt: new Date(70000).toISOString(), endedAt: new Date(75000).toISOString() };
    f.state.runs.recent = recent; f.state.subagents["id-19"].currentRun = recent.id; f.change();
    expect(f.view.getSelectedAgentId()).toBe("id-19"); // acknowledged ancestors are context, not default selection
    expect(ids(f.view.render(180)).at(-1)).toBe("id-19");
  } finally { f.view.dispose(); }
});

test("explicit exits reset Relevant selection but temporary overlay blur preserves All and selected ID", () => {
  const f = fixture();
  try {
    f.view.focused = true; f.view.handleInput("\t"); f.view.handleInput("\x1b[F");
    f.view.focused = false; f.change(); f.view.focused = true;
    expect(f.view.getMode()).toBe("All"); expect(f.view.getSelectedAgentId()).toBe("id-19");
    for (const key of ["\x1b", "\x1b[D", "typed"]) {
      f.view.handleInput(key);
      expect(f.view.focused).toBe(false); expect(f.view.getMode()).toBe("Relevant"); expect(f.view.getSelectedAgentId()).toBe("id-0");
      expect(f.view.render(180).at(-1)).toBe("↓ 14 below");
      f.view.focused = true;
      expect(f.view.getSelectedAgentId()).toBe("id-0");
      f.view.handleInput("\t"); f.view.handleInput("\x1b[F");
    }
  } finally { f.view.dispose(); }
});

test("one owned clock ticks waiting, shares Loader while running, freezes terminal and cleans on disposal/recreation", () => {
  const intervals = new Map<number, { callback: () => void; delay: number }>();
  let serial = 0;
  const set = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay: number) => {
    expect(intervals.size).toBe(0); // clock handoffs never overlap registered intervals
    const id = ++serial; intervals.set(id, { callback, delay }); return id;
  }) as any);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(((id: number) => { intervals.delete(id); }) as any);
  const start = spyOn(Loader.prototype, "start");
  let f: ReturnType<typeof fixture> | undefined;
  try {
    f = fixture(2); expect(intervals.size).toBe(0);
    f.state.runs["run-0"].phase = "waiting"; f.change();
    expect([...intervals.values()].map(timer => timer.delay)).toEqual([1000]); expect(start).not.toHaveBeenCalled();
    expect(f.view.render(180).join("\n")).toContain("· waiting · 64.0s");
    const previous = f.renders(); f.advance(1000); intervals.values().next().value!.callback();
    expect(f.renders()).toBe(previous + 1);
    expect(f.view.render(180).join("\n")).toContain("· waiting · 65.0s");
    f.change(); expect(intervals.size).toBe(1); // state updates never create a second timer
    f.state.runs["run-1"].phase = "running"; f.change();
    expect([...intervals.values()].map(timer => timer.delay)).toEqual([80]); expect(start).toHaveBeenCalledTimes(1);
    f.advance(1000); intervals.values().next().value!.callback();
    expect(f.view.render(180).join("\n")).toContain("· waiting · 66.0s");
    f.state.runs["run-1"].phase = "waiting"; f.change();
    expect([...intervals.values()].map(timer => timer.delay)).toEqual([1000]);
    for (const run of Object.values(f.state.runs)) { run.phase = "terminal"; run.endedAt = new Date(68000).toISOString(); }
    f.change(); expect(intervals.size).toBe(0);
    const frozen = f.view.render(180); f.advance(3600000); expect(f.view.render(180)).toEqual(frozen);
    const next = { ...f.state.runs["run-0"], id: "resumed", generation: 2, phase: "waiting" as const, startedAt: new Date(3660000).toISOString(), endedAt: undefined };
    f.state.runs.resumed = next; f.state.subagents["id-0"].currentRun = next.id; f.change();
    expect(f.view.render(180).join("\n")).toContain("· waiting · 7.0s"); expect(intervals.size).toBe(1);
    expect(agentTree(f.state)[0].run?.id).toBe(next.id);
    f.view.focused = true; f.view.handleInput("\t");
    f.advance(1000);
    const all = f.view.render(180).join("\n");
    expect(all).toContain("· waiting · 8.0s"); expect(all).toContain("· 67.0s");
    const stale = intervals.values().next().value!.callback;
    f.view.dispose(); f.view.dispose(); expect(intervals.size).toBe(0); expect(f.listeners.size).toBe(0);
    const count = f.renders(); f.change(); stale(); expect(f.renders()).toBe(count);
    const replacement = new SubagentOverview({ snapshot: () => f!.state, subscribe: () => () => {} }, f.ui, theme, undefined, () => 3668000);
    expect(intervals.size).toBe(1); replacement.dispose(); expect(intervals.size).toBe(0);
  } finally { f?.view.dispose(); start.mockRestore(); set.mockRestore(); clear.mockRestore(); }
});

test("run timing validates missing/invalid dates, clamps open future starts, and terminal times never use now", () => {
  const f = fixture(1);
  try {
    const run = f.state.runs["run-0"];
    expect(runElapsed(run, NaN)).toBe("63.0s");
    for (const invalid of [{ ...run, startedAt: "bad" }, { ...run, endedAt: undefined }, { ...run, endedAt: "bad" }, { ...run, endedAt: new Date(0).toISOString() }]) expect(runElapsed(invalid)).toBeUndefined();
    expect(runElapsed(undefined)).toBeUndefined();
    const waiting = { ...run, phase: "waiting" as const };
    expect(runElapsed(waiting, 0)).toBe("0.0s"); expect(runElapsed(waiting, Infinity)).toBeUndefined();
    run.startedAt = "bad"; f.change(); expect(f.view.render(180).join("\n")).not.toMatch(/\d+\.\d+s/);
  } finally { f.view.dispose(); }
});

test("report headers order marker/name/ID/status/time in both views, retain original body and omit conflicting run aliases", () => {
  const f = fixture(1);
  try {
    const owner = f.state.subagents["id-0"], run = f.state.runs["run-0"];
    const renderer = reportRenderer(() => undefined, id => f.state.runs[id]);
    for (const [outcome, marker] of [["completed", "✓"], ["error", "✗"], ["aborted", "⊘"], ["interrupted", "!"]] as const) {
      run.outcome!.status = outcome;
      const message = { role: "custom" as const, customType: REPORT_TYPE, content: reportText(owner, run), display: true, timestamp: 1,
        details: { agentId: owner.id, runId: run.id, outcome } };
      const bytes = JSON.stringify({ message, state: f.state });
      for (const expanded of [false, true]) {
        const lines = renderer(message, { expanded, outputPad: 0 }, theme)!.render(180);
        expect(lines[1].trim()).toBe(`${marker} Name 0 [id-0]${outcome === "completed" ? "" : ` · ${outcome}`} · 63.0s`);
        expect(lines[1]).not.toContain("Subagent Name"); expect(lines[1]).not.toContain("finished");
        if (expanded) for (const original of ["Subagent Name 0", "agent_id: id-0", "run_id: run-0", "FULL REPORT"]) expect(lines.join("\n")).toContain(original);
      }
      expect(JSON.stringify({ message, state: f.state })).toBe(bytes);
      for (const aliases of [{ runId: "foreign" }, { invocationId: "foreign" }, { deliveryId: "foreign" }]) {
        const mismatched = { ...message, details: { ...message.details, ...aliases } };
        expect(renderer(mismatched, { expanded: false, outputPad: 0 }, theme)!.render(180).join("\n")).not.toContain("63.0s");
      }
    }
  } finally { f.view.dispose(); }
});
