import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { FileEntry, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NAME_LIMIT, TERMINAL_TYPE, validateName, type SubagentState, type RunRecord, type Outcome, type SubagentRecord } from "./state.ts";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(x => typeof x === "string");
function invariant(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function rootIdentity(manager: ExtensionContext["sessionManager"]): string {
  const file = manager.getSessionFile();
  if (!file || !existsSync(file)) throw new Error("Subagents require a saved root session; ephemeral or not-yet-saved sessions are unsupported.");
  return createHash("sha256").update(`${manager.getSessionId()}\0${realpathSync(file)}`).digest("hex");
}
export function validateOutcome(value: unknown): asserts value is Outcome {
  invariant(object(value) && typeof value.status === "string" && ["completed", "error", "aborted", "interrupted"].includes(value.status) && typeof value.text === "string" &&
    (value.diagnostic === undefined || typeof value.diagnostic === "string"), "Corrupt subagent outcome");
}
function validateState(value: unknown, rootKey: string): asserts value is SubagentState {
  invariant(object(value) && value.version === 3 && value.rootKey === rootKey && object(value.subagents) && object(value.runs), "Corrupt or incompatible subagent registry");
  for (const [id, record] of Object.entries(value.subagents)) {
    invariant(object(record) && record.id === id && typeof record.parentId === "string" && typeof record.name === "string" &&
      typeof record.cwd === "string" && typeof record.projectTrusted === "boolean" && typeof record.model === "string" &&
      typeof record.requestedThinking === "string" && levels.has(record.requestedThinking) &&
      typeof record.effectiveThinking === "string" && levels.has(record.effectiveThinking) && typeof record.sessionFile === "string" &&
      typeof record.sessionId === "string" && Number.isInteger(record.generation) && Number(record.generation) >= 0 &&
      (record.role === undefined || (object(record.role) && typeof record.role.name === "string" && typeof record.role.description === "string" && typeof record.role.body === "string" &&
      typeof record.role.source === "string" && typeof record.role.promptMode === "string" && ["append", "replace"].includes(record.role.promptMode) &&
      (record.role.displayName === undefined || typeof record.role.displayName === "string"))), `Corrupt subagent ${id}`);
    validateName(record.name);
    invariant(record.pendingChildren === undefined && record.unprocessedReports === undefined, `Obligations must be derived from runs for ${id}`);
    const ancestors = new Set([id]);
    let parent = record.parentId;
    while (parent !== rootKey) {
      const owner = value.subagents[parent];
      invariant(!ancestors.has(parent) && object(owner) && typeof owner.parentId === "string", `Invalid subagent ancestry ${id}`);
      ancestors.add(parent);
      parent = owner.parentId;
    }
    const current = typeof record.currentRun === "string" ? value.runs[record.currentRun] : undefined;
    invariant(record.currentRun === undefined || (object(current) && current.agentId === id && current.outcome === undefined), `Missing or invalid run for ${id}`);
  }
  for (const [id, record] of Object.entries(value.runs)) {
    invariant(object(record) && record.id === id && typeof record.agentId === "string" && object(value.subagents[record.agentId]) &&
      typeof record.parentId === "string" && Number.isInteger(record.generation) && typeof record.prompt === "string" &&
      (record.boundary === null || typeof record.boundary === "string") && typeof record.startedAt === "string" && typeof record.delivered === "boolean", `Corrupt run ${id}`);
    const subagent = value.subagents[record.agentId] as Record<string, unknown>;
    invariant(record.parentId === subagent.parentId && Number(record.generation) > 0 && Number(record.generation) <= Number(subagent.generation), `Invalid run owner/generation ${id}`);
    invariant(record.phase === "running" || record.phase === "waiting" || record.phase === "terminal", `Invalid run phase ${id}`);
    invariant((record.phase === "terminal") === (record.outcome !== undefined), `Inconsistent terminal run ${id}`);
    invariant(record.outcome !== undefined || subagent.currentRun === id, `Unowned open run ${id}`);
    invariant(record.outcome === undefined ? record.endedAt === undefined : typeof record.endedAt === "string", `Invalid run end ${id}`);
    if (record.outcome !== undefined) validateOutcome(record.outcome);
    invariant(!record.delivered || record.outcome !== undefined, `Delivered unfinished run ${id}`);
    invariant(record.receiptEntryId === undefined || (record.delivered && typeof record.receiptEntryId === "string"), `Invalid receipt ${id}`);
    for (const key of ["parentRunId", "receiverRunId"]) {
      const owner = typeof record[key] === "string" ? value.runs[record[key]] : undefined;
      invariant(record.parentId === rootKey ? record[key] === null : object(owner) && owner.agentId === record.parentId, `Invalid ${key} for ${id}`);
    }
    if (record.parentId !== rootKey) {
      const receiver = value.runs[String(record.receiverRunId)] as Record<string, unknown>;
      const initiator = value.runs[String(record.parentRunId)] as Record<string, unknown>;
      invariant(Number(receiver.generation) >= Number(initiator.generation), `Receiver predates initiating run ${id}`);
      invariant(!record.delivered || typeof record.receiptEntryId === "string", `Missing nested receipt ${id}`);
      invariant(record.processedBy !== undefined || !object(receiver.outcome) || receiver.outcome.status !== "completed", `Successful parent has outstanding child run ${id}`);
    }
    if (record.processedBy !== undefined) {
      invariant(record.parentId !== rootKey && record.delivered && typeof record.receiptEntryId === "string" && object(record.processedBy) &&
        record.processedBy.runId === record.receiverRunId && typeof record.processedBy.assistantEntryId === "string", `Invalid report consumption ${id}`);
    }
  }
}
/** Registry-only v1 migration. Native conversations, marker IDs and receipts stay untouched. */
function migrateV1(value: Record<string, unknown>, rootKey: string): Record<string, unknown> {
  invariant(value.rootKey === rootKey && object(value.specialists) && object(value.invocations), "Corrupt v1 subagent registry");
  const subagents = Object.fromEntries(Object.entries(value.specialists).map(([id, record]) => {
    invariant(object(record) && object(record.role) &&
      (record.description === undefined || typeof record.description === "string") &&
      (record.role.allowedSubagents === "all" || strings(record.role.allowedSubagents)), `Corrupt v1 subagent ${id}`);
    const { description, currentInvocation, role, ...rest } = record;
    // allowedSubagents was legacy metadata, not a policy carried into v2.
    const { allowedSubagents: _ignored, ...savedRole } = role;
    const name = [description, role.displayName, role.name, id].filter((text): text is string => typeof text === "string")
      .map(text => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, NAME_LIMIT).trim())
      .find(Boolean) ?? "Subagent";
    return [id, { ...rest, name, role: savedRole, currentRun: currentInvocation }];
  }));
  const runs = Object.fromEntries(Object.entries(value.invocations).map(([id, record]) => {
    invariant(object(record), `Corrupt v1 run ${id}`);
    const { specialistId, ...rest } = record;
    return [id, { ...rest, agentId: specialistId }];
  }));
  return { version: 2, rootKey, subagents, runs };
}
function migrateV2(value: Record<string, unknown>, rootKey: string): SubagentState {
  invariant(value.rootKey === rootKey && object(value.subagents) && object(value.runs), "Corrupt v2 subagent registry");
  const subagents = Object.fromEntries(Object.entries(value.subagents).map(([id, record]) => {
    invariant(object(record) && record.parentId === rootKey && strings(record.pendingChildren) && !record.pendingChildren.length &&
      strings(record.unprocessedReports) && !record.unprocessedReports.length, `Cannot migrate v2 obligations for ${id}`);
    const { pendingChildren: _children, unprocessedReports: _reports, ...saved } = record;
    return [id, saved];
  }));
  const runs = Object.fromEntries(Object.entries(value.runs).map(([id, record]) => {
    invariant(object(record), `Corrupt v2 run ${id}`);
    return [id, { ...record, parentRunId: null, receiverRunId: null, phase: record.outcome === undefined ? "running" : "terminal" }];
  }));
  const migrated = { version: 3, rootKey, subagents, runs };
  validateState(migrated, rootKey);
  return migrated;
}
/** Unlike native open(), never treats missing, malformed, or foreign files as new sessions. */
export function readChildEntries(record: Pick<SubagentRecord, "sessionFile" | "sessionId">): FileEntry[] {
  let entries: FileEntry[];
  try {
    entries = readFileSync(record.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  } catch (error) { throw new Error(`Cannot open saved child ${record.sessionFile}: ${String(error)}`); }
  const header = entries[0];
  invariant(header?.type === "session" && header.version === 3 && header.id === record.sessionId, `Invalid child session header: ${record.sessionFile}`);
  const ids = new Set<string>();
  for (const entry of entries.slice(1)) {
    invariant(object(entry) && typeof entry.type === "string" && entry.type !== "session" && typeof entry.id === "string" &&
      !ids.has(entry.id) && (entry.parentId === null || ids.has(String(entry.parentId))), `Corrupt child transcript: ${record.sessionFile}`);
    ids.add(entry.id);
    if (entry.type === "message") invariant(object(entry.message) && typeof entry.message.role === "string", `Corrupt child message: ${record.sessionFile}`);
  }
  return entries;
}
function processGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
/** Synchronous transitions serialize intents without ever holding a lock across a model run. */
export class SubagentStore {
  readonly directory: string;
  state: SubagentState;
  private token = randomUUID();
  private closed = false;
  constructor(agentDir: string, readonly rootKey: string) {
    this.directory = join(agentDir, "subagent-sessions", rootKey);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.acquire();
    try {
      const path = join(this.directory, "registry.json");
      const saved: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 3, rootKey, subagents: {}, runs: {} };
      const legacy = object(saved) && (saved.version === 1 || saved.version === 2);
      const previous = object(saved) && saved.version === 1 ? migrateV1(saved, rootKey) : saved;
      const state = object(previous) && previous.version === 2 ? migrateV2(previous, rootKey) : previous;
      validateState(state, rootKey);
      this.state = state;
      // The existing exclusive writer lock covers validation and atomic replacement.
      if (legacy) this.save();
    } catch (error) { this.close(); throw error; }
  }
  private acquire(): void {
    const path = join(this.directory, "owner.lock");
    const create = () => {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token: this.token })); fsyncSync(fd); }
      finally { closeSync(fd); }
    };
    try { create(); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    // A separate exclusive recovery guard prevents two stale-owner removals. A broken
    // guard or unknown/remote owner is deliberately not guessed safe.
    const guardPath = join(this.directory, "recovery.lock");
    let guard: number;
    try { guard = openSync(guardPath, "wx", 0o600); }
    catch { throw new Error(`Subagent registry recovery is already owned: ${this.directory}`); }
    try {
      if (existsSync(path)) {
        const owner = JSON.parse(readFileSync(path, "utf8"));
        invariant(owner.host === hostname() && Number.isInteger(owner.pid) && owner.pid > 0 && processGone(owner.pid), `Subagent registry has another live or unverifiable writer: ${this.directory}`);
        unlinkSync(path);
      }
      create();
    } finally { closeSync(guard); unlinkSync(guardPath); }
  }
  save(): void {
    invariant(!this.closed, "Subagent registry is closed");
    validateState(this.state, this.rootKey);
    const path = join(this.directory, "registry.json");
    const temporary = `${path}.${this.token}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(this.state)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  recover(): void {
    for (const run of Object.values(this.state.runs)) {
      if (run.outcome) continue;
      const subagent = this.state.subagents[run.agentId];
      let marker: Outcome | undefined;
      let diagnostic = "Process ended before a durable terminal marker. Work was not replayed.";
      try {
        const entries = readChildEntries(subagent);
        for (const entry of entries) {
          if (entry.type !== "custom" || entry.customType !== TERMINAL_TYPE || !object(entry.data) || (entry.data.runId ?? entry.data.invocationId) !== run.id) continue;
          validateOutcome(entry.data.outcome);
          marker = entry.data.outcome;
        }
      } catch (error) { diagnostic = String(error); }
      const outstanding = Object.values(this.state.runs).filter(child => child.receiverRunId === run.id && !child.processedBy);
      if (outstanding.length) diagnostic += ` Outstanding direct child runs: ${outstanding.map(child => `${child.agentId}/${child.id}`).join(", ")}.`;
      this.finish(run, marker ?? { status: "interrupted", text: "", diagnostic });
    }
    this.save();
  }
  finish(run: RunRecord, outcome: Outcome): void {
    if (run.outcome) throw new Error(`Run ${run.id} is already terminal`);
    run.outcome = outcome;
    run.phase = "terminal";
    run.endedAt = new Date().toISOString();
    const subagent = this.state.subagents[run.agentId];
    if (subagent.currentRun === run.id) delete subagent.currentRun;
  }
  childDirectory(id: string): string { return join(this.directory, "children", id); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const path = join(this.directory, "owner.lock");
    if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).token === this.token) unlinkSync(path);
  }
}
