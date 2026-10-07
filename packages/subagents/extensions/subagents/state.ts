import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

// Keep native custom types stable so historical markers and receipts remain readable.
export const REPORT_TYPE = "subagents.report.v1";
export const TERMINAL_TYPE = "subagents.terminal.v1";
export interface RoleSnapshot {
  name: string;
  displayName?: string;
  description: string;
  body: string;
  promptMode: "append" | "replace";
  source: string;
}
export interface SubagentRecord {
  id: string;
  parentId: string;
  role?: RoleSnapshot;
  name: string;
  cwd: string;
  projectTrusted: boolean;
  model: string;
  requestedThinking: ThinkingLevel;
  effectiveThinking: ThinkingLevel;
  sessionFile: string;
  sessionId: string;
  generation: number;
  currentRun?: string;
}
export type OutcomeStatus = "completed" | "error" | "aborted" | "interrupted";
export interface Outcome {
  status: OutcomeStatus;
  text: string;
  diagnostic?: string;
}
export interface RunRecord {
  id: string;
  agentId: string;
  parentId: string;
  /** Run that initiated this work; immutable, null for a direct child of the main agent. */
  parentRunId: string | null;
  /** Transferred only when the immediate parent is explicitly resumed. */
  receiverRunId: string | null;
  phase: "running" | "waiting" | "terminal";
  receiptEntryId?: string;
  processedBy?: { runId: string; assistantEntryId: string };
  generation: number;
  prompt: string;
  boundary: string | null;
  startedAt: string;
  endedAt?: string;
  outcome?: Outcome;
  delivered: boolean;
}
export interface SubagentState {
  version: 3;
  rootKey: string;
  subagents: Record<string, SubagentRecord>;
  runs: Record<string, RunRecord>;
}
/** A receipt is not consumption. Only the immediate parent's successful generation satisfies an obligation. */
export function obligations(state: SubagentState, runId: string): RunRecord[] {
  return Object.values(state.runs).filter(run => run.receiverRunId === runId && !run.processedBy);
}
export const NAME_LIMIT = 80;
export function validateName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !name.trim() || name.length > NAME_LIMIT || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    throw new Error("Subagent name must be a readable task/topic on one line, 1-80 characters, without control characters; for example, 'Review authentication'.");
  }
}
export function subagentLabel(subagent: SubagentRecord): string {
  return `${subagent.name} (${subagent.id})`;
}
export function reportText(subagent: SubagentRecord, run: RunRecord): string {
  const outcome = run.outcome!;
  return [`Subagent ${subagent.name} - ${outcome.status}`,
    `agent_id: ${subagent.id}`, `run_id: ${run.id}`,
    ...(subagent.role ? [`Role: ${subagent.role.displayName ?? subagent.role.name}`] : []),
    ...(outcome.diagnostic ? [outcome.diagnostic] : []), "", outcome.text || "[No final assistant text in this run.]"].join("\n");
}
