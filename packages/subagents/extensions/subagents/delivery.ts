import { closeSync, fsyncSync, openSync, readFileSync } from "node:fs";
import type { CustomMessageEntryDraft, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { REPORT_TYPE, reportText, type RunRecord } from "./state.ts";
import type { SubagentStore } from "./store.ts";

export interface ParentBinding {
  manager: ExtensionContext["sessionManager"];
  idle(): boolean;
  pending(): boolean;
  send(message: Omit<CustomMessageEntryDraft, "type">): void;
  error(error: unknown): void;
}
export function reportDraft(store: SubagentStore, run: RunRecord): CustomMessageEntryDraft {
  return { type: "custom_message", customType: REPORT_TYPE, display: true,
    content: reportText(store.state.subagents[run.agentId], run),
    details: { deliveryId: run.id, agentId: run.agentId, runId: run.id, outcome: run.outcome?.status } };
}
/** One immediate recipient's durable outbox and native delivery reservations. */
export class Mailbox {
  binding?: ParentBinding;
  private sent = new Set<string>();
  private drafted = new Set<string>();
  private idleRetry?: ReturnType<typeof setTimeout>;
  private compactionTransition = false;
  constructor(private store: SubagentStore, readonly ownerId: string, private fail: (error: unknown) => never,
    private flushReceipt: (fd: number) => void = fsyncSync, private changedState: () => void = () => {}) {}
  attach(binding: ParentBinding): void {
    if (this.binding && this.binding.manager !== binding.manager) throw new Error(`Subagent mailbox already has another live ${this.ownerId === this.store.rootKey ? "root " : ""}owner`);
    clearTimeout(this.idleRetry);
    this.idleRetry = undefined;
    this.binding = binding;
    this.reconcile();
    this.deliverIdle();
    if (this.compactionTransition) this.afterCompaction();
  }
  detach(): void {
    this.binding = undefined;
    clearTimeout(this.idleRetry);
    this.idleRetry = undefined;
  }
  pending(): RunRecord[] {
    return Object.values(this.store.state.runs).filter(run => run.parentId === this.ownerId && run.outcome && !run.delivered &&
      !this.sent.has(run.id) && !this.drafted.has(run.id));
  }
  reconcile(): void {
    const binding = this.binding;
    if (!binding) return;
    const candidates = new Map<string, RunRecord>();
    for (const entry of binding.manager.getEntries()) {
      if (entry.type !== "custom_message" || entry.customType !== REPORT_TYPE) continue;
      const id = (entry.details as { deliveryId?: string } | undefined)?.deliveryId;
      const run = id ? this.store.state.runs[id] : undefined;
      if (run?.outcome && !run.delivered && run.parentId === this.ownerId) candidates.set(entry.id, run);
    }
    if (!candidates.size) return;
    const old = [...candidates.values()].map(run => ({ run, delivered: run.delivered, receiptEntryId: run.receiptEntryId }));
    try {
      const file = binding.manager.getSessionFile();
      if (!file) throw new Error("Receiver session has no file");
      const fd = openSync(file, "r");
      try {
        // append mutates native memory before writing; abandoned branches can prove receipt, not consumption.
        const receipts = new Set<string>();
        for (const line of readFileSync(fd, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const entry = JSON.parse(line);
          const run = candidates.get(entry.id);
          if (run && entry.type === "custom_message" && entry.customType === REPORT_TYPE &&
            entry.details?.deliveryId === run.id && JSON.stringify(entry.content) === JSON.stringify((binding.manager.getEntry(entry.id) as CustomMessageEntryDraft).content)) receipts.add(entry.id);
        }
        if ([...candidates.keys()].some(id => !receipts.has(id))) throw new Error("Native receiver append is missing on disk");
        this.flushReceipt(fd);
      } finally { closeSync(fd); }
      for (const [entryId, run] of candidates) { run.delivered = true; run.receiptEntryId = entryId; }
      this.store.save();
      this.changedState();
      for (const run of candidates.values()) { this.sent.delete(run.id); this.drafted.delete(run.id); }
    } catch (error) {
      for (const saved of old) { saved.run.delivered = saved.delivered; saved.run.receiptEntryId = saved.receiptEntryId; }
      this.fail(new Error(`Cannot establish durable ${this.ownerId === this.store.rootKey ? "root" : "parent"} receipt; reopen the main session for recovery: ${String(error)}`));
    }
  }
  drafts(): CustomMessageEntryDraft[] {
    this.reconcile();
    const pending = this.pending();
    for (const run of pending) this.drafted.add(run.id);
    return pending.map(run => reportDraft(this.store, run));
  }
  postCommit(): void {
    clearTimeout(this.idleRetry);
    this.idleRetry = undefined;
    this.compactionTransition = false;
    this.reconcile();
    this.drafted.clear();
    this.deliverIdle();
  }
  deliverIdle(): void {
    // A child continuation is owned/awaited by the coordinator, never an SDK deferred wake.
    if (this.ownerId !== this.store.rootKey) return;
    const binding = this.binding;
    if (!binding || !binding.idle() || this.sent.size) return;
    const run = this.pending()[0];
    if (!run) return;
    this.sent.add(run.id);
    try { const { type: _type, ...message } = reportDraft(this.store, run); binding.send(message); }
    catch (error) { this.fail(new Error(`Subagent report send failed; reopen the main session for recovery: ${String(error)}`)); }
  }
  afterCompaction(): void {
    this.compactionTransition = true;
    if (this.idleRetry || !this.binding || this.sent.size || !this.pending().length) return;
    const binding = this.binding;
    this.idleRetry = setTimeout(() => {
      this.idleRetry = undefined;
      if (this.binding !== binding) return;
      if (!binding.idle()) { this.afterCompaction(); return; }
      this.compactionTransition = false;
      try { this.postCommit(); } catch (error) { binding.error(error); }
    }, 10);
    this.idleRetry.unref();
  }
  changed(): void {
    this.reconcile();
    this.deliverIdle();
    if (this.compactionTransition) this.afterCompaction();
  }
}
