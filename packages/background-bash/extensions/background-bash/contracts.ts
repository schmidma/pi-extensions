import { constants } from "node:os";
import { Type } from "typebox";
import type { Job, Snapshot } from "./runtime.ts";

// Keep programmatic values separate from the durable, UI-oriented snapshots.
const state = {
  task_id: Type.String(),
  state: Type.Union([Type.Literal("running"), Type.Literal("exited"), Type.Literal("killed"), Type.Literal("exit-unknown")]),
  exit_code: Type.Optional(Type.Number()),
  reason: Type.Optional(Type.Union([Type.Literal("killed by agent"), Type.Literal("killed by user"), Type.Literal("timed out"), Type.Literal("log limit passed")])),
};
const task = { ...state, command: Type.String(), started_at_ms: Type.Number(), ended_at_ms: Type.Optional(Type.Number()), runtime_ms: Type.Number() };
export const bashSchema = Type.Object({ output: Type.String(), truncated: Type.Boolean(),
  full_output_path: Type.Optional(Type.String()), exit_code: Type.Optional(Type.Number()),
  wall_time_seconds: Type.Number(), task_id: Type.Optional(Type.String()) });
export const outputSchema = Type.Object({ ...state, output: Type.String(), truncated: Type.Boolean(), unread_bytes: Type.Number() });
export const tasksSchema = Type.Object({ tasks: Type.Array(Type.Object(task)) });
export const killSchema = Type.Object({ ...task, outcome: Type.Union([
  Type.Literal("killed"), Type.Literal("finished"), Type.Literal("gone"), Type.Literal("cleared"), Type.Literal("stuck"), Type.Literal("leftover-stuck"),
]) });

export function stateData(job: Job): Record<string, string | number> {
  const s = job.snapshot();
  if (s.status === "running") return { task_id: s.id, state: "running" as const };
  if (s.status === "exited" && typeof s.exitCode === "number") return { task_id: s.id, state: "exited" as const, exit_code: s.exitCode };
  if (["killed", "timeout", "aborted"].includes(s.status)) return {
    task_id: s.id, state: "killed" as const,
    reason: s.status === "timeout" ? "timed out" as const : s.status === "aborted" ? "killed by user" as const : job.killedBy,
  };
  return { task_id: s.id, state: "exit-unknown" as const };
}
export function taskData(job: Job): Record<string, string | number> {
  const s = job.snapshot();
  return { ...stateData(job), command: job.options.displayCommand ?? job.options.command,
    started_at_ms: s.startedAt, ...(s.endedAt === undefined ? {} : { ended_at_ms: s.endedAt }),
    runtime_ms: Math.max(0, (s.endedAt ?? Date.now()) - s.startedAt) };
}
export function bashData(s: Snapshot, output: { output: string; truncated: boolean; full_output_path?: string }) {
  const exit = typeof s.exitCode === "number" ? s.exitCode
    : s.signal ? 128 + (constants.signals[s.signal as keyof typeof constants.signals] ?? 0) : undefined;
  return { ...output, wall_time_seconds: Math.round(Math.max(0, (s.endedAt ?? Date.now()) - s.startedAt) / 100) / 10,
    ...(s.status === "running" ? { task_id: s.id } : exit === undefined ? {} : { exit_code: exit }) };
}
