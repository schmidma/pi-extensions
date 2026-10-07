import type { RunRecord, SubagentRecord, SubagentState } from "./state.ts";

export type DisplayStatus = "running" | "waiting" | "finished" | "error" | "aborted" | "interrupted";
export interface TreeNode { record: SubagentRecord; depth: number; status: DisplayStatus; run?: Readonly<RunRecord> }
export interface TreeSource {
  snapshot(): SubagentState;
  subscribe(listener: () => void): () => void;
}

function terminalRuns(state: SubagentState): Map<string, RunRecord> {
  const latest = new Map<string, RunRecord>();
  // Registry order is the tie-breaker for runs in the same generation.
  for (const run of Object.values(state.runs)) {
    const previous = latest.get(run.agentId);
    if (run.phase === "terminal" && (!previous || run.generation >= previous.generation)) latest.set(run.agentId, run);
  }
  return latest;
}
function displayedRun(state: SubagentState, record: SubagentRecord, latest: RunRecord | undefined): RunRecord | undefined {
  const current = record.currentRun ? state.runs[record.currentRun] : undefined;
  return current?.phase === "running" || current?.phase === "waiting" ? current : latest;
}
function statusFor(run: Readonly<RunRecord> | undefined): DisplayStatus {
  if (run?.phase === "running" || run?.phase === "waiting") return run.phase;
  const status = run?.outcome?.status;
  return !status || status === "completed" ? "finished" : status;
}
export function displayStatus(state: SubagentState, record: SubagentRecord): DisplayStatus {
  return statusFor(displayedRun(state, record, terminalRuns(state).get(record.id)));
}

/** Stable, fully expanded depth-first order; malformed orphan/cyclic components stay inspectable. */
export function agentTree(state: SubagentState): TreeNode[] {
  const records = Object.values(state.subagents);
  const latest = terminalRuns(state);
  const children = new Map<string, SubagentRecord[]>();
  for (const record of records) {
    const siblings = children.get(record.parentId) ?? [];
    siblings.push(record);
    children.set(record.parentId, siblings);
  }
  const nodes: TreeNode[] = [], visited = new Set<string>();
  const walk = (roots: SubagentRecord[]) => {
    const stack = roots.toReversed().map(record => ({ record, depth: 0 }));
    while (stack.length) {
      const { record, depth } = stack.pop()!;
      if (visited.has(record.id)) continue;
      visited.add(record.id);
      const run = displayedRun(state, record, latest.get(record.id));
      nodes.push({ record, depth, status: statusFor(run), run });
      const descendants = children.get(record.id) ?? [];
      for (let index = descendants.length - 1; index >= 0; index--) stack.push({ record: descendants[index], depth: depth + 1 });
    }
  };
  walk(children.get(state.rootKey) ?? []);
  // Do not recurse, discard records, or hang if an unexpected snapshot has a missing parent or loop.
  for (const record of records) if (!visited.has(record.id)) walk([record]);
  return nodes;
}
