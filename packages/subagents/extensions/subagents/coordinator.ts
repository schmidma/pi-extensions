import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SubagentStore } from "./store.ts";
import type { ChildHooks, ChildRuntime, ChildRuntimeFactory } from "./runner.ts";
import { REPORT_TYPE, obligations, subagentLabel, validateName, type RunRecord, type Outcome, type SubagentRecord, type SubagentState } from "./state.ts";
import { Mailbox, reportDraft, type ParentBinding } from "./delivery.ts";
import { bridgeContext, registerBridge } from "./bridge.ts";
import { exactModel, loadRoles } from "./configuration.ts";
export type { ParentBinding } from "./delivery.ts";

export interface Actor { agentId: string; runId: string }
interface LiveChild {
  runtime?: ChildRuntime;
  configurationKey?: object;
  preparing?: Promise<ChildRuntime>;
  running?: Promise<void>;
  guidance: string[];
  stopping: boolean;
}
export type NewSubagent = Omit<SubagentRecord, "id" | "parentId" | "sessionId" | "sessionFile" | "generation" | "currentRun">;
export class Coordinator {
  private live = new Map<string, LiveChild>();
  private mailboxes = new Map<string, Mailbox>();
  private listeners = new Set<() => void>();
  private stopping = false;
  private fault?: Error;
  private shutdownPromise?: Promise<void>;
  private releasing = new Set<Promise<void>>();
  constructor(readonly store: SubagentStore, private factory: ChildRuntimeFactory) {
    try { store.recover(); } catch (error) { store.close(); throw error; }
  }
  /** Detached copies: the inspector can read every depth without tool-control authority. */
  snapshot(): SubagentState { return structuredClone(this.store.state); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void { for (const listener of this.listeners) { try { listener(); } catch { /* observers do not own execution */ } } }
  private save(): void {
    try { this.store.save(); } catch (error) { this.fail(error); }
    this.changed();
  }
  private fail(error: unknown): never {
    if (!this.fault) {
      this.fault = error instanceof Error ? error : new Error(String(error));
      // Stop every delivery driver as well as native execution: a previously armed
      // compaction retry must not wake the main agent after a durability fault.
      const binding = this.mailboxes.get(this.store.rootKey)?.binding;
      for (const mailbox of this.mailboxes.values()) mailbox.detach();
      for (const live of this.live.values()) live.runtime?.abort?.();
      try { binding?.error(this.fault); } catch { /* notification only */ }
    }
    throw this.fault;
  }
  private mailbox(id = this.store.rootKey): Mailbox {
    let mailbox = this.mailboxes.get(id);
    if (!mailbox) {
      mailbox = new Mailbox(this.store, id, error => this.fail(error), fd => this.flushRootReceipt(fd), () => this.changed());
      this.mailboxes.set(id, mailbox);
    }
    return mailbox;
  }
  attach(binding: ParentBinding, factory: ChildRuntimeFactory): void {
    if (this.stopping) throw new Error("Subagent group is shutting down");
    if (this.fault) throw this.fault;
    this.factory = factory;
    this.mailbox().attach(binding);
  }
  updateFactory(factory: ChildRuntimeFactory): void { this.factory = factory; }
  detach(): void { this.mailbox().detach(); }
  afterCompaction(): void { if (!this.fault) this.mailbox().afterCompaction(); }
  get records(): SubagentRecord[] { return Object.values(this.store.state.subagents); }
  runtime(id: string): ChildRuntime | undefined { return this.live.get(id)?.runtime; }
  private flushRootReceipt(fd: number): void { fsyncSync(fd); }
  reconcile(): void { if (this.fault) throw this.fault; this.mailbox().reconcile(); }
  postCommit(_settled = false): void {
    if (this.fault) throw this.fault;
    this.mailbox().postCommit();
  }
  beforeSettle(): { entries: ReturnType<Mailbox["drafts"]>; continue: boolean } | undefined {
    if (!this.mailbox().binding) return;
    if (this.fault) throw this.fault;
    const entries = this.mailbox().drafts();
    if (entries.length) return { entries, continue: true };
  }
  checkActor(actor?: Actor): string {
    if (this.fault) throw this.fault;
    if (this.stopping) throw new Error("Subagent group is shutting down");
    if (!actor) {
      if (!this.mailbox().binding) throw new Error("Subagent group is not attached to an active main session");
      return this.store.rootKey;
    }
    const record = this.store.state.subagents[actor.agentId];
    const run = this.store.state.runs[actor.runId];
    if (!record || record.currentRun !== actor.runId || !run || run.agentId !== actor.agentId || run.outcome) throw new Error("Subagent caller no longer owns its current run");
    return actor.agentId;
  }
  owned(id: string, actor?: Actor): SubagentRecord {
    const parentId = this.checkActor(actor);
    const record = this.store.state.subagents[id];
    if (!record || record.parentId !== parentId) throw new Error(`Unknown direct subagent ${id}; only your own direct children may be controlled.`);
    return record;
  }
  private actor(id: string): Actor {
    const runId = this.store.state.subagents[id]?.currentRun;
    if (!runId) throw new Error("Subagent caller has no current run");
    const actor = { agentId: id, runId };
    this.checkActor(actor);
    return actor;
  }
  private hooks(record: SubagentRecord): ChildHooks {
    const mailbox = this.mailbox(record.id);
    const roles = () => loadRoles(this.factory.agentDir!, record.cwd, record.projectTrusted);
    return {
      register: pi => {
        registerBridge(pi, { actor: () => this.actor(record.id),
          resolve: async () => {
            if (!this.factory.models || !this.factory.agentDir) throw new Error("Subagent delegation has no current model configuration");
            return { service: this, models: this.factory.models };
          }, roles });
        pi.on("before_agent_start", event => {
          // The service, not a stale main ExtensionContext, owns this current catalogue.
          if (this.factory.models && this.factory.agentDir) event.systemPromptOptions.appendSystemPrompt = bridgeContext(event.systemPromptOptions.appendSystemPrompt, this.factory.models, roles());
        });
      },
      beforeSettle: outcome => {
        if (this.fault) throw this.fault;
        mailbox.postCommit();
        return outcome === "completed" && !this.stopping ? mailbox.drafts() : [];
      },
      postCommit: () => { if (this.fault) throw this.fault; mailbox.postCommit(); },
      prepare: messages => this.prepareReports(this.actor(record.id), messages),
      processed: (ids, entry) => this.processed(this.actor(record.id), ids, entry),
    };
  }
  private prepareReports(actor: Actor, input: AgentMessage[]): ReturnType<ChildHooks["prepare"]> {
    this.checkActor(actor);
    this.mailbox(actor.agentId).reconcile();
    const messages = [...input];
    const reports = obligations(this.store.state, actor.runId).filter(run => run.outcome && run.delivered).map(run => {
      const draft = reportDraft(this.store, run);
      const content = draft.content as string;
      const present = messages.some(message => message.role === "custom" && message.customType === REPORT_TYPE &&
        (message.details as { deliveryId?: string } | undefined)?.deliveryId === run.id && message.content === content);
      // Compaction, context edits and abandoned branches cannot consume a report.
      // Restore it request-locally, retaining its single durable receipt identity.
      if (!present) messages.push({ role: "custom", customType: REPORT_TYPE, content, display: true, details: draft.details, timestamp: Date.now() });
      return { id: run.id, content };
    });
    return { messages, reports };
  }
  private processed(actor: Actor, ids: string[], assistantEntryId: string): void {
    this.checkActor(actor);
    const mailbox = this.mailbox(actor.agentId);
    mailbox.reconcile();
    const reports = ids.map(id => this.store.state.runs[id]);
    if (reports.some(run => !run || run.parentId !== actor.agentId || run.receiverRunId !== actor.runId || !run.delivered || !run.receiptEntryId || !run.outcome)) this.fail(new Error("Invalid child report processing acknowledgement"));
    const file = mailbox.binding?.manager.getSessionFile();
    if (!file) this.fail(new Error("Receiver has no native transcript"));
    const changed = reports.filter(run => !run.processedBy);
    if (!changed.length) return;
    try {
      const fd = openSync(file, "r");
      try {
        const response = readFileSync(fd, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).find(entry => entry.id === assistantEntryId);
        if (!response || response.type !== "message" || response.message.role !== "assistant" || !["stop", "toolUse"].includes(response.message.stopReason)) throw new Error("Successful assistant response is missing on disk");
        this.flushProcessing(fd);
      } finally { closeSync(fd); }
      for (const run of changed) run.processedBy = { runId: actor.runId, assistantEntryId };
      this.save();
    } catch (error) {
      for (const run of changed) delete run.processedBy;
      this.fail(new Error(`Cannot establish durable report processing: ${String(error)}`));
    }
  }
  private flushProcessing(fd: number): void { fsyncSync(fd); }
  async invoke(prompt: string, options: { resume: string } | { subagent: NewSubagent }, actor?: Actor): Promise<{ agentId: string; runId: string; role?: string; name: string; model: string; requestedThinking: string; effectiveThinking: string }> {
    const parentId = this.checkActor(actor);
    const factory = this.factory;
    const resume = "resume" in options;
    let subagent: SubagentRecord;
    if (resume) {
      subagent = this.owned(options.resume, actor);
      if (subagent.currentRun) throw new Error(`Subagent ${subagentLabel(subagent)} has an open run; use steer_subagent instead.`);
      if (factory.models) exactModel(factory.models, subagent.model);
    } else {
      validateName(options.subagent.name);
      if (factory.models) exactModel(factory.models, options.subagent.model);
      subagent = { ...structuredClone(options.subagent), name: options.subagent.name.trim(), id: `s-${randomUUID()}`, parentId,
        sessionId: "", sessionFile: "", generation: 0 };
      this.store.state.subagents[subagent.id] = subagent;
    }
    const run: RunRecord = { id: `i-${randomUUID()}`, agentId: subagent.id, parentId,
      parentRunId: actor?.runId ?? null, receiverRunId: actor?.runId ?? null, phase: "running",
      generation: ++subagent.generation, prompt, boundary: null, startedAt: new Date().toISOString(), delivered: false };
    subagent.currentRun = run.id;
    this.store.state.runs[run.id] = run;
    // Reservation and explicit adoption are one durable transition, before every await.
    if (resume) for (const childRun of Object.values(this.store.state.runs)) {
      if (childRun.parentId === subagent.id && !childRun.processedBy) childRun.receiverRunId = run.id;
    }
    this.save();
    let live = this.live.get(subagent.id);
    if (!live) { live = { stopping: false, guidance: [] }; this.live.set(subagent.id, live); }
    try {
      if (!live.runtime || live.configurationKey !== factory.configurationKey) {
        const stale = live.runtime;
        live.runtime = undefined;
        live.configurationKey = factory.configurationKey;
        this.mailbox(subagent.id).detach();
        live.preparing = (async () => {
          await stale?.shutdown();
          if (live!.stopping || this.stopping) throw new Error("Main session shut down during child initialization");
          return factory.create(subagent, this.store.childDirectory(subagent.id), resume, this.hooks(subagent));
        })();
        live.runtime = await live.preparing;
        live.preparing = undefined;
        if (live.runtime.binding) this.mailbox(subagent.id).attach(live.runtime.binding);
      }
      // A prior run may have published its terminal marker just before its cycle's finally.
      // The new run is already reserved, but must not disappear behind that old reservation.
      if (live.running) await live.running;
      run.boundary = live.runtime.boundary;
      this.save();
      if (live.stopping || this.stopping) {
        await live.runtime.shutdown();
        this.finish(subagent, run, { status: "interrupted", text: "", diagnostic: "Main session shut down during child initialization." }, live.runtime);
      } else this.startCycle(subagent, run, live, true);
    } catch (error) {
      if (!this.fault && !run.outcome) this.finish(subagent, run, { status: "error", text: "", diagnostic: String(error) }, live.runtime);
      throw error;
    }
    return { agentId: subagent.id, runId: run.id, ...(subagent.role ? { role: subagent.role.name } : {}), name: subagent.name,
      model: subagent.model, requestedThinking: subagent.requestedThinking, effectiveThinking: subagent.effectiveThinking };
  }
  private startCycle(subagent: SubagentRecord, run: RunRecord, live: LiveChild, initial = false): void {
    if (live.running || live.preparing || live.stopping || this.stopping || this.fault || run.outcome) return;
    const runtime = live.runtime!;
    const entries = this.mailbox(subagent.id).drafts();
    const guidance = live.guidance.splice(0);
    run.phase = "running";
    this.save();
    // Reserve synchronously; never invoke prompt from agent_settled or hold a mutex across it.
    const running = Promise.resolve().then(async () => {
      let outcome: Outcome;
      try {
        if (initial && !entries.length && !guidance.length) outcome = await runtime.run(run);
        else {
          if (!runtime.continueCycle) throw new Error("Native runtime does not support logical-run continuation");
          outcome = await runtime.continueCycle(run, entries, initial ? [run.prompt, ...guidance] : guidance);
        }
      } catch (error) { outcome = { status: "error", text: "", diagnostic: String(error) }; }
      if (this.fault) return;
      this.mailbox(subagent.id).postCommit();
      if (live.stopping || this.stopping) outcome = { status: "interrupted", text: "", diagnostic: "Main session shut down." };
      if (outcome.status === "completed" && obligations(this.store.state, run.id).some(child => child.delivered)) {
        outcome = { status: "error", text: "", diagnostic: "A received child report was not included in a successful assistant response; explicit resume is required." };
      }
      if (outcome.status === "completed" && (obligations(this.store.state, run.id).length || live.guidance.length)) {
        run.phase = "waiting";
        this.save();
      } else this.finish(subagent, run, outcome, runtime);
    }).catch(error => { try { this.fail(new Error(`Subagent persistence failed; reopen the main session for recovery: ${String(error)}`)); } catch { /* owned detached work */ } })
      .finally(() => {
        if (live.running === running) live.running = undefined;
        try { this.drive(subagent.id); } catch (error) { try { this.fail(error); } catch { /* owned detached work */ } }
      });
    live.running = running;
  }
  private drive(id: string): void {
    const subagent = this.store.state.subagents[id];
    const run = subagent?.currentRun ? this.store.state.runs[subagent.currentRun] : undefined;
    const live = this.live.get(id);
    if (!run || run.phase !== "waiting" || !live?.runtime || live.running || live.preparing || live.stopping || this.stopping || this.fault) return;
    const ready = obligations(this.store.state, run.id).some(child => child.outcome);
    if (ready || live.guidance.length) this.startCycle(subagent, run, live);
  }
  private finish(subagent: SubagentRecord, run: RunRecord, outcome: Outcome, runtime?: ChildRuntime): void {
    if (run.outcome) return;
    const outstanding = obligations(this.store.state, run.id);
    if (outcome.status === "completed" && outstanding.length) throw new Error("Cannot publish a provisional subagent report");
    if (outstanding.length) outcome = { ...outcome, diagnostic: [outcome.diagnostic,
      `Outstanding direct child runs (not cancelled): ${outstanding.map(child => `${child.agentId}/${child.id}`).join(", ")}`].filter(Boolean).join("\n") };
    runtime?.marker(run.id, outcome);
    this.store.finish(run, outcome);
    const live = this.live.get(subagent.id);
    if (live) live.guidance = [];
    this.save();
    if (!this.stopping) {
      this.mailbox(run.parentId).changed();
      if (run.parentId !== this.store.rootKey) this.drive(run.parentId);
    }
  }
  steer(id: string, message: string, actor?: Actor): void {
    const subagent = this.owned(id, actor);
    if (!subagent.currentRun) throw new Error(`Subagent ${subagentLabel(subagent)} is finished; its report is delivered automatically. Use resume_subagent only for new or follow-up work, not to retrieve the previous report.`);
    const live = this.live.get(id);
    if (!live?.runtime || live.stopping) throw new Error(`Subagent ${subagentLabel(subagent)} is initializing or shutting down; steering was not queued.`);
    const run = this.store.state.runs[subagent.currentRun];
    if (run.phase === "running" && live.runtime.steer(message) !== false) return;
    live.guidance.push(message);
    this.drive(id);
  }
  async releaseIdle(): Promise<void> {
    if (this.stopping) return;
    const cleanups: Promise<void>[] = [];
    for (const [id, live] of this.live) {
      if (live.preparing || live.running || this.store.state.subagents[id].currentRun || !live.runtime?.idle) continue;
      this.live.delete(id);
      this.mailbox(id).detach();
      const cleanup = Promise.resolve().then(() => live.runtime!.shutdown());
      // A concurrent root shutdown still owns these runtimes until cleanup settles.
      this.releasing.add(cleanup);
      void cleanup.then(() => this.releasing.delete(cleanup), () => this.releasing.delete(cleanup));
      cleanups.push(cleanup);
    }
    const errors = (await Promise.allSettled(cleanups)).flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, `Idle child cleanup failed: ${errors.map(String).join("; ")}`);
  }
  shutdown(): Promise<void> { return this.shutdownPromise ??= this.close(); }
  private async close(): Promise<void> {
    this.stopping = true;
    const errors: unknown[] = [];
    for (const mailbox of this.mailboxes.values()) mailbox.detach();
    // Abort every depth BEFORE awaiting any cleanup: parent/child tool calls may overlap.
    for (const live of this.live.values()) {
      live.stopping = true;
      try { live.runtime?.abort?.(); } catch (error) { errors.push(error); }
    }
    const results = await Promise.allSettled([...this.releasing, ...[...this.live.values()].map(async live => {
      if (live.preparing) await live.preparing.catch(() => undefined); // invoke() owns initialization failures.
      try { await live.runtime?.shutdown(); } catch (error) { errors.push(error); }
      // A failed shutdown must not skip the native cycle's final persistence.
      await live.running;
    })]);
    for (const result of results) if (result.status === "rejected") errors.push(result.reason);
    try {
      for (const record of this.records) {
        if (this.fault || !record.currentRun) continue;
        try {
          this.finish(record, this.store.state.runs[record.currentRun], { status: "interrupted", text: "", diagnostic: "Main session shut down." }, this.live.get(record.id)?.runtime);
        } catch (error) { errors.push(error); }
      }
    } finally {
      this.live.clear();
      this.mailboxes.clear();
      try { this.store.close(); } catch (error) { errors.push(error); }
      this.changed();
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, `Subagent shutdown failed: ${errors.map(String).join("; ")}`);
  }
}

const PROCESS_KEY = Symbol.for("local.pi-subagents.services.v5");
const LEGACY_PROCESS_KEYS = [1, 2, 3, 4].map(version => Symbol.for(`local.pi-subagents.services.v${version}`));
type ProcessRegistry = Map<string, Coordinator>;
type LegacyServices = Map<string, { shutdown(): Promise<void> }>;
function legacyServices(): LegacyServices[] {
  const processGlobal = globalThis as typeof globalThis & { [key: symbol]: LegacyServices | undefined };
  return LEGACY_PROCESS_KEYS.flatMap(key => processGlobal[key] ? [processGlobal[key]!] : []);
}
export function processServices(): ProcessRegistry {
  if (legacyServices().some(services => services.size)) throw new Error("Subagents interface upgrade requires a Pi process restart. Quit Pi and reopen the saved main session; /reload cannot migrate live subagents from an earlier interface.");
  const processGlobal = globalThis as typeof globalThis & { [PROCESS_KEY]?: ProcessRegistry };
  return processGlobal[PROCESS_KEY] ??= new Map();
}
export async function shutdownLegacyService(rootKey: string): Promise<void> {
  const results = await Promise.allSettled(legacyServices().map(async legacy => {
    const service = legacy.get(rootKey);
    if (!service) return;
    await service.shutdown();
    if (legacy.get(rootKey) === service) legacy.delete(rootKey);
    // On failure keep the restart guard: old shutdown code may still own resources.
  }));
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, `Legacy subagent shutdown failed: ${errors.map(String).join("; ")}`);
}
