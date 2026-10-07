import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Coordinator, type NewSubagent, type ParentBinding } from "../extensions/subagents/coordinator.ts";
import { SubagentStore, readChildEntries, rootIdentity } from "../extensions/subagents/store.ts";
import { REPORT_TYPE, TERMINAL_TYPE, obligations, type RunRecord, type Outcome, type SubagentRecord } from "../extensions/subagents/state.ts";
import type { ChildRuntime, ChildRuntimeFactory } from "../extensions/subagents/runner.ts";
import { loadRoles, replaceRoster } from "../extensions/subagents/configuration.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), "pi-delegation-")); directories.push(directory); return directory; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const spec: NewSubagent = { role: { name: "worker", description: "Role", body: "Saved role", source: "role.md", promptMode: "append" },
  name: "Description", cwd: "/tmp", projectTrusted: false, model: "fake/model", requestedThinking: "high", effectiveThinking: "high" };
class FakeChild implements ChildRuntime {
  source = { snapshot: () => ({ messages: [], tools: [] }), subscribe: () => () => {} };
  idle = true;
  closed = false;
  steers: string[] = [];
  requests: RunRecord[] = [];
  result = deferred<Outcome>();
  constructor(readonly manager: SessionManager) {}
  get boundary() { return this.manager.getLeafId(); }
  async run(run: RunRecord) {
    this.requests.push(run);
    this.result = deferred<Outcome>();
    this.idle = false;
    const outcome = await this.result.promise;
    this.idle = true;
    return outcome;
  }
  steer(message: string) { if (this.idle) throw new Error("resume"); this.steers.push(message); }
  marker(runId: string, outcome: Outcome) { this.manager.appendCustomEntry(TERMINAL_TYPE, { runId, outcome }); }
  async shutdown() { this.closed = true; if (!this.idle) this.result.resolve({ status: "aborted", text: "" }); }
}
class FakeFactory implements ChildRuntimeFactory {
  children: FakeChild[] = [];
  async create(record: SubagentRecord, directory: string, resume: boolean) {
    if (resume) readChildEntries(record);
    const manager = resume ? SessionManager.open(record.sessionFile) : SessionManager.create(record.cwd, directory);
    if (!resume) manager.appendMessage({ role: "user", content: "fixture native history", timestamp: 1 });
    record.sessionFile = manager.getSessionFile()!;
    record.sessionId = manager.getSessionId();
    const child = new FakeChild(manager);
    this.children.push(child);
    return child;
  }
}
function fixture() {
  const directory = temporary();
  const parent = SessionManager.create(directory, join(directory, "roots"));
  parent.appendMessage({ role: "user", content: "root", timestamp: 1 });
  const key = rootIdentity(parent);
  const factory = new FakeFactory();
  const store = new SubagentStore(directory, key);
  const service = new Coordinator(store, factory);
  let idle = false;
  const sent: Parameters<ParentBinding["send"]>[0][] = [];
  const binding: ParentBinding = { manager: parent, idle: () => idle, pending: () => false, send: message => { sent.push(message); }, error: error => { throw error; } };
  service.attach(binding, factory);
  return { directory, parent, key, factory, store, service, binding, sent, setIdle: (value: boolean) => { idle = value; } };
}
function commit(parent: SessionManager, drafts: ReturnType<Coordinator["beforeSettle"]>) {
  for (const draft of drafts?.entries ?? []) parent.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
}

// Compatibility-only fixture: v1 specialists/invocations and their native IDs are
// intentionally not expressed through the current spawn API or coordinator acks.
async function legacyFixture(options: {
  active?: boolean; delivered?: boolean; description?: string; displayName?: string;
  roleName?: string; promptMode?: "append" | "replace";
} = {}) {
  const f = fixture();
  await f.service.shutdown();
  const agentId = "s-original-v1";
  const runId = "i-original-v1";
  const childDirectory = f.store.childDirectory(agentId);
  const child = SessionManager.create(f.directory, childDirectory);
  child.appendMessage({ role: "user", content: "original native child history", timestamp: 1 });
  child.appendMessage({ role: "assistant", content: [{ type: "text", text: "original answer" }],
    api: "openai-responses", provider: "fake", model: "model", stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 2 });
  const outcome: Outcome = { status: "completed", text: "saved v1 report" };
  const specialist = {
    id: agentId, parentId: f.key, description: options.description,
    role: { ...spec.role!, name: options.roleName ?? "worker", displayName: options.displayName,
      body: "saved legacy instructions\nnot current role files", promptMode: options.promptMode ?? "append",
      allowedSubagents: ["old-nested-role"] },
    cwd: spec.cwd, projectTrusted: spec.projectTrusted, model: spec.model,
    requestedThinking: spec.requestedThinking, effectiveThinking: spec.effectiveThinking,
    sessionFile: child.getSessionFile()!, sessionId: child.getSessionId(), generation: 1,
    ...(options.active ? { currentInvocation: runId } : {}), pendingChildren: [], unprocessedReports: [],
  };
  const invocation = {
    id: runId, specialistId: agentId, parentId: f.key, generation: 1, prompt: "original v1 task",
    boundary: child.getLeafId(), startedAt: "2025-01-01T00:00:00.000Z",
    ...(options.active ? {} : { endedAt: "2025-01-01T00:01:00.000Z", outcome }),
    delivered: options.delivered ?? false,
  };
  const legacy = { version: 1, rootKey: f.key, specialists: { [agentId]: specialist }, invocations: { [runId]: invocation } };
  const registry = join(f.store.directory, "registry.json");
  const bytes = `${JSON.stringify(legacy)}\n`;
  writeFileSync(registry, bytes);
  return { ...f, agentId, runId, child, childDirectory, specialist, invocation, legacy, registry, bytes, outcome };
}

test("busy delivery is full, durable, committed before receipt, and emitted once", async () => {
  const f = fixture();
  const ack = await f.service.invoke("task", { subagent: spec });
  expect(ack.agentId).toStartWith("s-");
  expect(ack.runId).toStartWith("i-");
  const text = "entire-report\n".repeat(20000);
  f.factory.children[0].result.resolve({ status: "completed", text });
  await tick();
  expect(f.sent).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(f.store.directory, "registry.json"), "utf8")).runs[ack.runId].outcome.text).toBe(text);
  const drafts = f.service.beforeSettle();
  expect(drafts?.continue).toBe(true);
  expect(drafts?.entries[0].content).toEndWith(text);
  expect(f.store.state.runs[ack.runId].delivered).toBe(false);
  expect(f.service.beforeSettle()).toBeUndefined();
  commit(f.parent, drafts);
  f.service.postCommit();
  expect(f.store.state.runs[ack.runId].delivered).toBe(true);
  expect(f.service.beforeSettle()).toBeUndefined();
  await f.service.shutdown();
});

test("idle sends are not receipts; reload detach/reattach preserves work and prevents duplicate sends", async () => {
  const f = fixture();
  f.setIdle(true);
  const ack = await f.service.invoke("task", { subagent: spec });
  const child = f.factory.children[0];
  f.service.detach();
  child.result.resolve({ status: "completed", text: "final after reload" });
  await tick();
  expect(f.sent).toHaveLength(0);
  const fresh: typeof f.sent = [];
  f.service.attach({ ...f.binding, send: message => { fresh.push(message); } }, f.factory);
  expect(fresh).toHaveLength(1);
  expect(f.sent).toHaveLength(0);
  expect(f.store.state.runs[ack.runId].delivered).toBe(false);
  f.service.detach();
  f.service.attach({ ...f.binding, send: message => { fresh.push(message); } }, f.factory);
  expect(fresh).toHaveLength(1);
  expect(child.closed).toBe(false);
  const message = fresh[0];
  f.parent.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
  f.service.postCommit(true);
  expect(f.store.state.runs[ack.runId].delivered).toBe(true);
  await f.service.shutdown();
});

test("idle deferred wake remains single and reserved across settlement and reload", async () => {
  const f = fixture();
  await f.service.invoke("one", { subagent: spec });
  await f.service.invoke("two", { subagent: spec });
  for (const child of f.factory.children) child.result.resolve({ status: "completed", text: "report" });
  await tick();
  f.setIdle(true);
  f.service.postCommit(true);
  expect(f.sent).toHaveLength(1);
  f.service.postCommit(true); // Native deferred actions are absent from hasPendingMessages().
  f.service.detach();
  f.service.attach(f.binding, f.factory);
  expect(f.sent).toHaveLength(1);
  const message = f.sent[0];
  f.parent.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
  f.service.postCommit(true);
  expect(f.sent).toHaveLength(2);
  f.service.postCommit(true);
  expect(f.sent).toHaveLength(2);
  await f.service.shutdown();
});

test("failed native root append is not a durable receipt", async () => {
  const f = fixture();
  const ack = await f.service.invoke("task", { subagent: spec });
  f.factory.children[0].result.resolve({ status: "completed", text: "must survive" });
  await tick();
  const drafts = f.service.beforeSettle();
  const persist = (f.parent as any)._persist;
  (f.parent as any)._persist = () => { throw new Error("injected root append failure"); };
  expect(() => commit(f.parent, drafts)).toThrow("injected root append failure");
  (f.parent as any)._persist = persist;
  expect(f.parent.getEntries().some(entry => entry.type === "custom_message")).toBe(true);
  expect(() => f.service.postCommit()).toThrow("durable root receipt");
  expect(f.store.state.runs[ack.runId].delivered).toBe(false);
  await f.service.shutdown();
  const reopened = new Coordinator(new SubagentStore(f.directory, f.key), f.factory);
  reopened.attach({ ...f.binding, manager: SessionManager.open(f.parent.getSessionFile()!) }, f.factory);
  expect(reopened.beforeSettle()?.entries).toHaveLength(1);
  expect(f.factory.children).toHaveLength(1);
  await reopened.shutdown();
});

for (const fail of [false, true]) test(`root receipt fsync precedes registry acknowledgement, failure=${fail}`, async () => {
  const f = fixture();
  const ack = await f.service.invoke("task", { subagent: spec });
  f.factory.children[0].result.resolve({ status: "completed", text: "durable" });
  await tick();
  commit(f.parent, f.service.beforeSettle());
  const order: string[] = [];
  const flush = (f.service as any).flushRootReceipt.bind(f.service);
  (f.service as any).flushRootReceipt = (fd: number) => {
    expect(readFileSync(f.parent.getSessionFile()!, "utf8")).toContain(ack.runId);
    order.push("root-fsync");
    if (fail) throw new Error("injected fsync failure");
    flush(fd);
  };
  const save = f.store.save.bind(f.store);
  f.store.save = () => { order.push("registry-save"); save(); };
  if (fail) expect(() => f.service.postCommit()).toThrow("injected fsync failure");
  else f.service.postCommit();
  expect(order).toEqual(fail ? ["root-fsync"] : ["root-fsync", "registry-save"]);
  expect(f.store.state.runs[ack.runId].delivered).toBe(!fail);
  expect(JSON.parse(readFileSync(join(f.store.directory, "registry.json"), "utf8")).runs[ack.runId].delivered).toBe(!fail);
  await f.service.shutdown();
  const recovered = new Coordinator(new SubagentStore(f.directory, f.key), f.factory);
  recovered.attach(f.binding, f.factory);
  expect(recovered.store.state.runs[ack.runId].delivered).toBe(true);
  expect(recovered.beforeSettle()).toBeUndefined();
  expect(f.factory.children).toHaveLength(1);
  await recovered.shutdown();
});

test("manual compaction with an empty outbox does not arm an idle retry", async () => {
  const f = fixture();
  f.service.afterCompaction();
  f.service.afterCompaction();
  expect((f.service as any).mailbox().idleRetry).toBeUndefined();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect((f.service as any).mailbox().idleRetry).toBeUndefined();
  expect(f.sent).toHaveLength(0);
  await f.service.shutdown();
});

test("late outcome during slow compaction handlers wakes once when the root becomes idle", async () => {
  const f = fixture();
  await f.service.invoke("task", { subagent: spec });
  f.service.afterCompaction();
  expect((f.service as any).mailbox().idleRetry).toBeUndefined();
  f.factory.children[0].result.resolve({ status: "completed", text: "late report" });
  await tick();
  expect((f.service as any).mailbox().idleRetry).toBeDefined();
  f.setIdle(true);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(f.sent).toHaveLength(1);
  expect((f.service as any).mailbox().idleRetry).toBeUndefined();
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(f.sent).toHaveLength(1);
  expect((f.service as any).mailbox().idleRetry).toBeUndefined();
  await f.service.shutdown();
});

test("late outcome during slow compaction handlers arms a retry only until detach", async () => {
  const f = fixture();
  await f.service.invoke("task", { subagent: spec });
  f.service.afterCompaction();
  expect((f.service as any).mailbox().idleRetry).toBeUndefined();
  f.factory.children[0].result.resolve({ status: "completed", text: "late report" });
  await tick();
  expect((f.service as any).mailbox().idleRetry).toBeDefined();
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(f.sent).toHaveLength(0);
  f.service.detach();
  expect((f.service as any).mailbox().idleRetry).toBeUndefined();
  f.setIdle(true);
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(f.sent).toHaveLength(0);
  f.service.attach(f.binding, f.factory);
  expect(f.sent).toHaveLength(1);
  expect((f.service as any).mailbox().idleRetry).toBeUndefined();
  await f.service.shutdown();
});

test("compaction retry is coalesced and cancelled on detach; reattach uses only the new binding", async () => {
  const f = fixture();
  await f.service.invoke("task", { subagent: spec });
  f.factory.children[0].result.resolve({ status: "completed", text: "held" });
  await tick();
  f.service.afterCompaction();
  f.service.afterCompaction();
  f.service.detach();
  f.setIdle(true);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(f.sent).toHaveLength(0);
  const fresh: typeof f.sent = [];
  f.service.attach({ ...f.binding, send: message => { fresh.push(message); } }, f.factory);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(fresh).toHaveLength(1);
  expect(f.sent).toHaveLength(0);
  await f.service.shutdown();
});

test("root settlement keeps active children; question then warm and cold resume preserve identity", async () => {
  const f = fixture();
  const first = await f.service.invoke("question", { subagent: spec });
  const child = f.factory.children[0];
  await f.service.releaseIdle();
  expect(child.closed).toBe(false);
  f.service.steer(first.agentId, "guidance");
  expect(child.steers).toEqual(["guidance"]);
  await expect(f.service.invoke("race", { resume: first.agentId })).rejects.toThrow("steer_subagent");
  child.result.resolve({ status: "completed", text: "Which file?" });
  await tick();
  const runsBeforeSteer = Object.keys(f.store.state.runs);
  const requestsBeforeSteer = child.requests.length;
  expect(() => f.service.steer(first.agentId, "late")).toThrow(`Subagent Description (${first.agentId}) is finished`);
  expect(() => f.service.steer(first.agentId, "late")).toThrow("its report is delivered automatically");
  expect(() => f.service.steer(first.agentId, "late")).toThrow("only for new or follow-up work, not to retrieve the previous report");
  await tick();
  expect(Object.keys(f.store.state.runs)).toEqual(runsBeforeSteer);
  expect(child.requests).toHaveLength(requestsBeforeSteer);
  expect(child.steers).toEqual(["guidance"]);
  const second = await f.service.invoke("file.ts", { resume: first.agentId });
  expect(second.agentId).toBe(first.agentId);
  expect(second.runId).not.toBe(first.runId);
  expect(f.factory.children).toHaveLength(1);
  child.result.resolve({ status: "completed", text: "done" });
  await tick();
  await f.service.releaseIdle();
  expect(child.closed).toBe(true);
  await f.service.shutdown();
  const store = new SubagentStore(f.directory, f.key);
  const reopened = new Coordinator(store, f.factory);
  reopened.attach(f.binding, f.factory);
  const third = await reopened.invoke("more", { resume: first.agentId });
  expect(third.role).toBe("worker");
  expect(third.requestedThinking).toBe("high");
  expect(f.factory.children).toHaveLength(2);
  expect(f.factory.children[1].manager.getSessionId()).toBe(child.manager.getSessionId());
  f.factory.children[1].result.resolve({ status: "completed", text: "new only" });
  await tick();
  await reopened.shutdown();
});

test("simultaneous cold resume is reserved before factory initialization", async () => {
  const f = fixture();
  const first = await f.service.invoke("one", { subagent: spec });
  f.factory.children[0].result.resolve({ status: "completed", text: "one" });
  await tick();
  await f.service.releaseIdle();
  const gate = deferred<void>();
  const delayed: ChildRuntimeFactory = { create: async (...args) => { await gate.promise; return f.factory.create(...args); } };
  f.service.attach(f.binding, delayed);
  const resume = f.service.invoke("two", { resume: first.agentId });
  await expect(f.service.invoke("three", { resume: first.agentId })).rejects.toThrow("steer_subagent");
  gate.resolve();
  await resume;
  f.factory.children[1].result.resolve({ status: "completed", text: "two" });
  await tick();
  await f.service.shutdown();
});

test("marker-to-registry crash repairs outcome; unmarked work is interrupted and never replayed", async () => {
  const f = fixture();
  const ack = await f.service.invoke("task", { subagent: spec });
  f.service.detach();
  const child = f.factory.children[0];
  child.marker(ack.runId, { status: "completed", text: "durable marker report" });
  // Simulate a process loss: don't complete or replay its pending fake run.
  f.store.close();
  const reopened = new SubagentStore(f.directory, f.key);
  reopened.recover();
  expect(reopened.state.runs[ack.runId].outcome?.text).toBe("durable marker report");
  expect(reopened.state.subagents[ack.agentId].currentRun).toBeUndefined();
  reopened.close();
  const g = fixture();
  const interrupted = await g.service.invoke("never replay", { subagent: spec });
  g.service.detach();
  g.store.close();
  const recovered = new Coordinator(new SubagentStore(g.directory, g.key), g.factory);
  expect(recovered.store.state.runs[interrupted.runId].outcome?.status).toBe("interrupted");
  expect(g.factory.children).toHaveLength(1);
  await recovered.shutdown();
});

test("receipt on any branch repairs registry-to-receipt crash window and fork has a different group", async () => {
  const f = fixture();
  const ack = await f.service.invoke("task", { subagent: spec });
  f.factory.children[0].result.resolve({ status: "completed", text: "report" });
  await tick();
  const originalLeaf = f.parent.getLeafId()!;
  commit(f.parent, f.service.beforeSettle());
  f.parent.branch(originalLeaf);
  expect(rootIdentity(f.parent)).toBe(f.key);
  f.service.detach();
  f.store.close();
  const reopened = new Coordinator(new SubagentStore(f.directory, f.key), f.factory);
  reopened.attach(f.binding, f.factory);
  expect(reopened.store.state.runs[ack.runId].delivered).toBe(true);
  expect(reopened.beforeSettle()).toBeUndefined();
  const fork = SessionManager.forkFrom(f.parent.getSessionFile()!, f.directory, join(f.directory, "forks"));
  expect(rootIdentity(fork)).not.toBe(f.key);
  await reopened.shutdown();
});

test("duplicate writer refused, proven dead local owner recovered, corrupt registry never reset", () => {
  const f = fixture();
  expect(() => new SubagentStore(f.directory, f.key)).toThrow("writer");
  const otherManager = SessionManager.open(f.parent.getSessionFile()!);
  expect(() => f.service.attach({ ...f.binding, manager: otherManager }, f.factory)).toThrow("another live root owner");
  f.store.close();
  writeFileSync(join(f.store.directory, "owner.lock"), JSON.stringify({ pid: 2147483647, host: hostname(), token: "dead" }));
  const recovered = new SubagentStore(f.directory, f.key);
  recovered.close();
  writeFileSync(join(f.store.directory, "registry.json"), "{bad");
  expect(() => new SubagentStore(f.directory, f.key)).toThrow();
  expect(readFileSync(join(f.store.directory, "registry.json"), "utf8")).toBe("{bad");
});

test("missing or corrupt child history never silently creates a new context", async () => {
  const f = fixture();
  const ack = await f.service.invoke("task", { subagent: spec });
  f.factory.children[0].result.resolve({ status: "completed", text: "report" });
  await tick();
  await f.service.releaseIdle();
  const record = f.store.state.subagents[ack.agentId];
  writeFileSync(record.sessionFile, "not json");
  await expect(f.service.invoke("resume", { resume: record.id })).rejects.toThrow("Cannot open saved child");
  expect(f.factory.children).toHaveLength(1);
  expect(readFileSync(record.sessionFile, "utf8")).toBe("not json");
  await f.service.shutdown();
});

test("shutdown interrupts active children and retains durable outcome without using stale binding", async () => {
  const f = fixture();
  f.setIdle(true);
  const ack = await f.service.invoke("task", { subagent: spec });
  await f.service.shutdown();
  expect(f.factory.children[0].closed).toBe(true);
  expect(f.sent).toHaveLength(0);
  const reopened = new SubagentStore(f.directory, f.key);
  expect(reopened.state.runs[ack.runId].outcome?.status).toBe("interrupted");
  reopened.close();
});

test("stripped boundary drafts are retried only after a postcommit boundary", async () => {
  const f = fixture();
  await f.service.invoke("task", { subagent: spec });
  f.factory.children[0].result.resolve({ status: "error", text: "full diagnostic report" });
  await tick();
  expect(f.service.beforeSettle()?.entries).toHaveLength(1);
  expect(f.service.beforeSettle()).toBeUndefined();
  f.service.postCommit();
  const retry = f.service.beforeSettle();
  expect(retry?.entries[0].content).toContain("full diagnostic report");
  commit(f.parent, retry);
  f.service.postCommit();
  expect(f.service.beforeSettle()).toBeUndefined();
  await f.service.shutdown();
});

test("shutdown aborts every depth and awaits cycles even when abort and cleanup reject", async () => {
  const f = fixture();
  const parent = await f.service.invoke("parent", { subagent: spec });
  const child = await f.service.invoke("child", { subagent: spec }, parent);
  const [a, b] = f.factory.children;
  const order: string[] = [];
  const abortError = new Error("parent abort failed"), shutdownError = new Error("parent shutdown failed");
  (a as ChildRuntime).abort = () => { order.push("abort parent"); throw abortError; };
  (b as ChildRuntime).abort = () => { order.push("abort child"); };
  a.shutdown = async () => { order.push("shutdown parent"); throw shutdownError; };
  const gate = deferred<void>();
  b.shutdown = async () => { order.push("shutdown child"); await gate.promise; b.result.resolve({ status: "aborted", text: "" }); };
  let settled = false;
  const stopping = f.service.shutdown();
  const observed = stopping.catch(error => error).finally(() => { settled = true; });
  expect(f.service.shutdown()).toBe(stopping);
  await tick();
  expect(order).toEqual(["abort parent", "abort child", "shutdown parent", "shutdown child"]);
  expect(existsSync(join(f.store.directory, "owner.lock"))).toBe(true);
  gate.resolve();
  await tick();
  expect(settled).toBe(false); // The rejecting runtime's run is still active.
  expect(existsSync(join(f.store.directory, "owner.lock"))).toBe(true);
  a.result.resolve({ status: "aborted", text: "" });
  const error = await observed;
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([abortError, shutdownError]);
  expect(f.service.runtime(parent.agentId)).toBeUndefined();
  expect(f.service.runtime(child.agentId)).toBeUndefined();
  expect(f.store.state.runs[parent.runId].outcome?.status).toBe("interrupted");
  expect(f.store.state.runs[child.runId].outcome?.status).toBe("interrupted");
  expect(existsSync(join(f.store.directory, "owner.lock"))).toBe(false);
  const reopened = new SubagentStore(f.directory, f.key); reopened.close();
  expect(f.service.shutdown()).toBe(stopping);
});

test("idle release cleans all terminal idle children after failure but preserves waiting and active work", async () => {
  const f = fixture();
  const first = await f.service.invoke("first", { subagent: spec });
  const second = await f.service.invoke("second", { subagent: spec });
  const waiting = await f.service.invoke("waiting", { subagent: spec });
  const active = await f.service.invoke("active", { subagent: spec }, waiting);
  for (const child of f.factory.children.slice(0, 3)) child.result.resolve({ status: "completed", text: "done" });
  await tick();
  const [a, b, c, d] = f.factory.children;
  const failure = new Error("idle shutdown failed");
  a.shutdown = async () => { a.closed = true; throw failure; };
  await expect(f.service.releaseIdle()).rejects.toBe(failure);
  expect(a.closed).toBe(true); expect(b.closed).toBe(true);
  expect(c.closed).toBe(false); expect(d.closed).toBe(false);
  expect(f.service.runtime(first.agentId)).toBeUndefined();
  expect(f.service.runtime(second.agentId)).toBeUndefined();
  expect(f.service.runtime(waiting.agentId)).toBe(c);
  expect(f.service.runtime(active.agentId)).toBe(d);
  expect(f.store.state.runs[waiting.runId].phase).toBe("waiting");
  await f.service.shutdown();
});

test("root shutdown waits for an already detached idle release before unlocking", async () => {
  const f = fixture();
  await f.service.invoke("done", { subagent: spec });
  f.factory.children[0].result.resolve({ status: "completed", text: "done" });
  await tick();
  const gate = deferred<void>();
  const failure = new Error("delayed idle failure");
  f.factory.children[0].shutdown = async () => { await gate.promise; throw failure; };
  const release = f.service.releaseIdle().catch(error => error);
  const stopping = f.service.shutdown().catch(error => error);
  await tick();
  expect(existsSync(join(f.store.directory, "owner.lock"))).toBe(true);
  gate.resolve();
  expect(await release).toBe(failure);
  expect(await stopping).toBe(failure);
  expect(existsSync(join(f.store.directory, "owner.lock"))).toBe(false);
});

test("nested state derives unfinished and unprocessed obligations; root may yield", async () => {
  const f = fixture();
  const parent = await f.service.invoke("parent", { subagent: spec });
  const child = await f.service.invoke("child", { subagent: spec }, parent);
  f.factory.children[0].result.resolve({ status: "completed", text: "provisional" });
  await tick();
  expect(f.store.state.runs[parent.runId].phase).toBe("waiting");
  expect(f.service.beforeSettle()).toBeUndefined();
  await f.service.releaseIdle();
  expect(f.factory.children[0].closed).toBe(false);
  const state = f.service.snapshot();
  expect(obligations(state, parent.runId).map(run => run.id)).toEqual([child.runId]);
  state.runs[child.runId].outcome = { status: "completed", text: "report" };
  state.runs[child.runId].delivered = true;
  expect(obligations(state, parent.runId)).toHaveLength(1);
  state.runs[child.runId].processedBy = { runId: parent.runId, assistantEntryId: "response" };
  expect(obligations(state, parent.runId)).toHaveLength(0);
  await f.service.shutdown();
});

for (const promptMode of ["append", "replace"] as const) test(`v1 delivered completion retains identity, snapshots and native bytes without resend (${promptMode})`, async () => {
  const f = await legacyFixture({ delivered: true, description: "Original task", promptMode });
  const childBytes = readFileSync(f.specialist.sessionFile);
  const rootBytes = readFileSync(f.parent.getSessionFile()!);
  const store = new SubagentStore(f.directory, f.key);
  expect(store.state.version).toBe(3);
  expect(store.state.rootKey).toBe(f.key);
  expect(Object.keys(store.state.subagents)).toEqual([f.agentId]);
  expect(Object.keys(store.state.runs)).toEqual([f.runId]);
  const { description: _description, role, pendingChildren: _children, unprocessedReports: _reports, ...savedSpecialist } = f.specialist;
  const { allowedSubagents: _allowed, ...savedRole } = role;
  expect(store.state.subagents[f.agentId]).toEqual({ ...savedSpecialist, name: "Original task", role: savedRole });
  const { specialistId: _specialistId, ...savedInvocation } = f.invocation;
  expect(store.state.runs[f.runId]).toEqual({ ...savedInvocation, agentId: f.agentId, parentRunId: null, receiverRunId: null, phase: "terminal" });
  expect(store.childDirectory(f.agentId)).toBe(f.childDirectory);
  const persisted = JSON.parse(readFileSync(f.registry, "utf8"));
  expect(persisted.version).toBe(3);
  expect(persisted).not.toHaveProperty("specialists");
  expect(persisted).not.toHaveProperty("invocations");
  expect(persisted.subagents[f.agentId]).not.toHaveProperty("description");
  expect(persisted.subagents[f.agentId]).not.toHaveProperty("currentInvocation");
  expect(persisted.subagents[f.agentId].role).not.toHaveProperty("allowedSubagents");
  expect(persisted.runs[f.runId]).not.toHaveProperty("specialistId");
  const service = new Coordinator(store, f.factory);
  f.setIdle(true);
  service.attach(f.binding, f.factory);
  expect(service.beforeSettle()).toBeUndefined();
  service.postCommit(true);
  expect(f.sent).toHaveLength(0);
  expect(f.factory.children).toHaveLength(0);
  expect(readFileSync(f.specialist.sessionFile)).toEqual(childBytes);
  expect(readFileSync(f.parent.getSessionFile()!)).toEqual(rootBytes);
  await service.shutdown();
  const reopened = new Coordinator(new SubagentStore(f.directory, f.key), f.factory);
  reopened.attach(f.binding, f.factory);
  expect(reopened.store.state.runs[f.runId].outcome).toEqual(f.outcome);
  expect(reopened.beforeSettle()).toBeUndefined();
  expect(f.sent).toHaveLength(0);
  expect(f.factory.children).toHaveLength(0);
  await reopened.shutdown();
});

test("v1 pending completed outbox delivers once and its receipt survives reopening", async () => {
  const f = await legacyFixture({ description: "Pending old task" });
  const childBytes = readFileSync(f.specialist.sessionFile);
  const service = new Coordinator(new SubagentStore(f.directory, f.key), f.factory);
  f.setIdle(true);
  service.attach(f.binding, f.factory);
  expect(f.sent).toHaveLength(1);
  const message = f.sent[0];
  expect(message.content).toContain("Pending old task");
  expect(message.content).toContain(`agent_id: ${f.agentId}`);
  expect(message.content).toContain(`run_id: ${f.runId}`);
  expect(message.content).toEndWith(f.outcome.text);
  expect(message.details).toMatchObject({ deliveryId: f.runId, agentId: f.agentId, runId: f.runId });
  expect(service.store.state.runs[f.runId].delivered).toBe(false);
  service.postCommit(true);
  service.detach();
  service.attach(f.binding, f.factory);
  expect(f.sent).toHaveLength(1);
  expect(service.beforeSettle()).toBeUndefined();
  f.parent.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
  service.postCommit(true);
  expect(service.store.state.runs[f.runId].delivered).toBe(true);
  expect(JSON.parse(readFileSync(f.registry, "utf8")).runs[f.runId].delivered).toBe(true);
  await service.shutdown();
  const reopened = new Coordinator(new SubagentStore(f.directory, f.key), f.factory);
  reopened.attach(f.binding, f.factory);
  reopened.postCommit(true);
  expect(reopened.beforeSettle()).toBeUndefined();
  expect(f.sent).toHaveLength(1);
  expect(f.parent.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(1);
  expect(f.factory.children).toHaveLength(0);
  expect(readFileSync(f.specialist.sessionFile)).toEqual(childBytes);
  await reopened.shutdown();
});

test("v1 invocationId terminal marker repairs a crash without replaying or changing the outcome", async () => {
  const f = await legacyFixture({ active: true, description: "Recovered task" });
  const outcome: Outcome = { status: "error", text: "full legacy failure report", diagnostic: "original diagnostic" };
  // Old native markers use invocationId, not the current runId spelling.
  f.child.appendCustomEntry(TERMINAL_TYPE, { invocationId: f.runId, outcome });
  const childBytes = readFileSync(f.specialist.sessionFile);
  const store = new SubagentStore(f.directory, f.key);
  expect(store.state.subagents[f.agentId].currentRun).toBe(f.runId);
  expect(store.state.runs[f.runId].outcome).toBeUndefined();
  const service = new Coordinator(store, f.factory);
  expect(store.state.runs[f.runId].outcome).toEqual(outcome);
  expect(store.state.runs[f.runId].endedAt).toBeString();
  expect(store.state.subagents[f.agentId].currentRun).toBeUndefined();
  service.attach(f.binding, f.factory);
  const drafts = service.beforeSettle();
  expect(drafts?.entries).toHaveLength(1);
  expect(drafts?.entries[0].content).toContain("original diagnostic");
  expect(drafts?.entries[0].content).toEndWith(outcome.text);
  commit(f.parent, drafts);
  service.postCommit();
  await service.shutdown();
  const reopened = new Coordinator(new SubagentStore(f.directory, f.key), f.factory);
  reopened.attach(f.binding, f.factory);
  expect(reopened.store.state.runs[f.runId].outcome).toEqual(outcome);
  expect(reopened.beforeSettle()).toBeUndefined();
  expect(f.factory.children).toHaveLength(0);
  expect(readFileSync(f.specialist.sessionFile)).toEqual(childBytes);
  await reopened.shutdown();
});

test("v1 parent receipt details deduplicate across migration, including abandoned branches", async () => {
  const f = await legacyFixture({ description: "Already received" });
  const originalLeaf = f.parent.getLeafId()!;
  // Legacy report receipt fields intentionally retain specialistId.
  f.parent.appendCustomMessageEntry(REPORT_TYPE, "original old report", true,
    { deliveryId: f.runId, specialistId: f.agentId });
  f.parent.branch(originalLeaf);
  const rootBytes = readFileSync(f.parent.getSessionFile()!);
  const service = new Coordinator(new SubagentStore(f.directory, f.key), f.factory);
  expect(service.store.state.runs[f.runId].delivered).toBe(false);
  f.setIdle(true);
  service.attach(f.binding, f.factory);
  expect(service.store.state.runs[f.runId].delivered).toBe(true);
  expect(service.beforeSettle()).toBeUndefined();
  expect(f.sent).toHaveLength(0);
  await service.shutdown();
  const reopened = new Coordinator(new SubagentStore(f.directory, f.key), f.factory);
  reopened.attach({ ...f.binding, manager: SessionManager.open(f.parent.getSessionFile()!) }, f.factory);
  reopened.postCommit(true);
  expect(reopened.beforeSettle()).toBeUndefined();
  expect(f.sent).toHaveLength(0);
  expect(f.factory.children).toHaveLength(0);
  expect(readFileSync(f.parent.getSessionFile()!)).toEqual(rootBytes);
  await reopened.shutdown();
});

for (const [options, expected] of [
  [{ description: "  Review\n\tauth\u0000\u200b\u2028flow  " }, "Review auth flow"],
  [{ description: "x".repeat(100) }, "x".repeat(80)],
  [{ displayName: "  Saved\nRole  " }, "Saved Role"],
  [{ description: "", displayName: "Saved role label" }, "Saved role label"],
  [{ description: " \n\u0000 ", displayName: "" }, "worker"],
  [{ description: "", displayName: "", roleName: "" }, "s-original-v1"],
] as const) test(`v1 names are safe and fall back when descriptions are absent or empty: ${expected.slice(0, 24)}`, async () => {
  const f = await legacyFixture(options);
  const store = new SubagentStore(f.directory, f.key);
  expect(store.state.subagents[f.agentId].name).toBe(expected);
  expect(JSON.parse(readFileSync(f.registry, "utf8")).subagents[f.agentId].name).toBe(expected);
  store.close();
});

for (const corruption of ["foreign owner", "dangling current run", "dangling run agent", "malformed snapshot", "array prompt mode", "array requested thinking", "array effective thinking", "array outcome status"] as const) {
  test(`corrupt v1 ${corruption} is rejected without rewrite and releases the writer lock`, async () => {
    const f = await legacyFixture({ active: true });
    const corrupt = JSON.parse(f.bytes);
    if (corruption === "foreign owner") corrupt.specialists[f.agentId].parentId = "another-root";
    if (corruption === "dangling current run") corrupt.specialists[f.agentId].currentInvocation = "missing-run";
    if (corruption === "dangling run agent") corrupt.invocations[f.runId].specialistId = "missing-agent";
    if (corruption === "malformed snapshot") corrupt.specialists[f.agentId].role.body = 42;
    if (corruption === "array prompt mode") corrupt.specialists[f.agentId].role.promptMode = ["replace"];
    if (corruption === "array requested thinking") corrupt.specialists[f.agentId].requestedThinking = ["high"];
    if (corruption === "array effective thinking") corrupt.specialists[f.agentId].effectiveThinking = ["high"];
    if (corruption === "array outcome status") {
      delete corrupt.specialists[f.agentId].currentInvocation;
      corrupt.invocations[f.runId].outcome = { status: ["completed"], text: "invalid status must not be preserved" };
    }
    const bytes = `${JSON.stringify(corrupt, null, 2)}\n`;
    writeFileSync(f.registry, bytes);
    expect(() => new SubagentStore(f.directory, f.key)).toThrow();
    expect(readFileSync(f.registry, "utf8")).toBe(bytes);
    expect(existsSync(join(f.store.directory, "owner.lock"))).toBe(false);
    expect(existsSync(join(f.store.directory, "recovery.lock"))).toBe(false);
    // A second attempt must fail on the same data, not on a leaked lock.
    expect(() => new SubagentStore(f.directory, f.key)).toThrow();
    expect(readFileSync(f.registry, "utf8")).toBe(bytes);
    expect(existsSync(join(f.store.directory, "owner.lock"))).toBe(false);
    writeFileSync(f.registry, f.bytes);
    const repaired = new SubagentStore(f.directory, f.key);
    expect(repaired.state.version).toBe(3);
    repaired.close();
  });
}

for (const name of ["", "   ", "\t", "two\nlines", "two\rlines", "control\u0000", "format\u200b", "line\u2028separator", "x".repeat(81)]) {
  test(`invalid name ${JSON.stringify(name)} is rejected before any records are reserved`, async () => {
    const f = fixture();
    const registry = join(f.store.directory, "registry.json");
    const bytes = readFileSync(registry, "utf8");
    await expect(f.service.invoke("must not run", { subagent: { ...spec, name } })).rejects.toThrow("Subagent name");
    expect(f.store.state.subagents).toEqual({});
    expect(f.store.state.runs).toEqual({});
    expect(readFileSync(registry, "utf8")).toBe(bytes);
    expect(f.factory.children).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
    await f.service.shutdown();
  });
}

test("duplicate names are permitted without roles and reports include the name and full machine IDs", async () => {
  const f = fixture();
  const { role: _role, ...nativeSpec } = spec;
  const first = await f.service.invoke("first task", { subagent: { ...nativeSpec, name: "  Review authentication  " } });
  const second = await f.service.invoke("second task", { subagent: { ...nativeSpec, name: "Review authentication" } });
  expect(first.name).toBe("Review authentication");
  expect(second.name).toBe(first.name);
  expect(second.agentId).not.toBe(first.agentId);
  expect(second.runId).not.toBe(first.runId);
  for (const ack of [first, second]) {
    expect(ack).not.toHaveProperty("role");
    expect(f.store.state.subagents[ack.agentId]).not.toHaveProperty("role");
  }
  f.factory.children[0].result.resolve({ status: "completed", text: "first report" });
  f.factory.children[1].result.resolve({ status: "completed", text: "second report" });
  await tick();
  const drafts = f.service.beforeSettle();
  expect(drafts?.entries).toHaveLength(2);
  for (const [index, ack] of [first, second].entries()) {
    const report = drafts!.entries[index];
    expect(report.content).toStartWith("Subagent Review authentication - completed");
    expect(report.content).toContain(`agent_id: ${ack.agentId}\nrun_id: ${ack.runId}`);
    expect(report.content).not.toContain("Role:");
    expect(report.content).toEndWith(index === 0 ? "first report" : "second report");
    expect(report.details).toMatchObject({ deliveryId: ack.runId, agentId: ack.agentId, runId: ack.runId });
  }
  commit(f.parent, drafts);
  f.service.postCommit();
  expect(f.service.beforeSettle()).toBeUndefined();
  await f.service.shutdown();
});

test("no role files means no bundled roles, and allowed_subagents is ignored metadata", () => {
  const directory = temporary();
  expect([...loadRoles(directory, directory, false).roles]).toEqual([]);
  expect([...loadRoles(directory, directory, true).roles]).toEqual([]);
  mkdirSync(join(directory, "agents"));
  const path = join(directory, "agents/custom.md");
  writeFileSync(path, "---\nname: custom\nallowed_subagents: all\n---\nuser instructions");
  const original = loadRoles(directory, directory, false).roles.get("custom");
  expect(original).not.toHaveProperty("allowedSubagents");
  for (const metadata of ["[]", "[worker]", "42"]) {
    writeFileSync(path, `---\nname: custom\nallowed_subagents: ${metadata}\n---\nuser instructions`);
    expect(loadRoles(directory, directory, false).roles.get("custom")).toEqual(original);
  }
});

test("roles respect enabled and parent project trust, snapshots, supported fields, and reject unsupported execution", () => {
  const directory = temporary();
  mkdirSync(join(directory, "agents"));
  mkdirSync(join(directory, ".pi/agents"), { recursive: true });
  writeFileSync(join(directory, "agents/worker.md"), "---\nname: worker\nprompt_mode: append\nallowed_subagents: all\ndescription: Worker\n---\noriginal");
  writeFileSync(join(directory, "agents/off.md"), "---\nname: off\nenabled: false\n---");
  writeFileSync(join(directory, ".pi/agents/project.md"), "---\nname: worker\nprompt_mode: replace\n---\nproject");
  const untrusted = loadRoles(directory, directory, false).roles;
  expect([...untrusted.keys()]).toEqual(["worker"]);
  expect(untrusted.get("worker")?.body).toBe("original");
  expect(loadRoles(directory, directory, true).roles.get("worker")?.body).toBe("project");
  writeFileSync(join(directory, "agents/worker.md"), "---\nname: worker\nmodel: wrong\n---\nchanged");
  expect(untrusted.get("worker")?.body).toBe("original");
  const invalid = loadRoles(directory, directory, false);
  expect([...invalid.roles]).toEqual([]);
  expect(invalid.invalid.get("worker")).toContain("unsupported role field model");
  expect(invalid.diagnostics).toEqual([`${join(directory, "agents/worker.md")}: unsupported role field model`]);
  expect(() => rootIdentity(SessionManager.inMemory())).toThrow("saved root");
});

test("delegation context refresh replaces owned sections without accumulating guidance", () => {
  const context = (value: string) => ["subagent_model_options", "subagent_roles", "subagent_coordination"]
    .map(tag => `<${tag}>${value}</${tag}>`).join("\n");
  const base = "Native instructions\n<other_extension>Keep me</other_extension>";
  const first = replaceRoster(base, context("old"));
  const refreshed = replaceRoster(first, context("new"));
  expect(refreshed).toBe(`${base}\n\n${context("new")}`);
  expect(replaceRoster(refreshed, context("new"))).toBe(refreshed);
});

test("invalid trusted role overrides shadow known names without blocking other profiles", () => {
  const directory = temporary();
  mkdirSync(join(directory, "agents"));
  mkdirSync(join(directory, ".pi/agents"), { recursive: true });
  writeFileSync(join(directory, "agents/worker.md"), "---\nname: worker\n---\nglobal worker");
  writeFileSync(join(directory, "agents/other.md"), "---\nname: other\n---\nvalid other");
  const project = join(directory, ".pi/agents/custom-file.md");
  writeFileSync(project, "---\nname: worker\nmodel: forbidden\n---\ninvalid override");
  expect(loadRoles(directory, directory, false).roles.get("worker")?.body).toBe("global worker");
  const invalid = loadRoles(directory, directory, true);
  expect([...invalid.roles.keys()]).toEqual(["other"]);
  expect(invalid.invalid.get("worker")).toBe(`${project}: unsupported role field model`);
  expect(invalid.diagnostics).toHaveLength(1);
  writeFileSync(project, "---\nname: worker\nenabled: false\nmodel: ignored-disabled-profile\n---");
  const disabled = loadRoles(directory, directory, true);
  expect([...disabled.roles.keys()]).toEqual(["other"]);
  expect(disabled.invalid.size).toBe(0);
  expect(disabled.diagnostics).toEqual([]);
  writeFileSync(project, "---\nname: worker\n---\nfixed project");
  expect(loadRoles(directory, directory, true).roles.get("worker")?.body).toBe("fixed project");
});

test("role file and directory read failures are isolated diagnostics", () => {
  const directory = temporary();
  mkdirSync(join(directory, "agents/unreadable.md"), { recursive: true });
  writeFileSync(join(directory, "agents/valid.md"), "valid instructions");
  writeFileSync(join(directory, "agents/broken.md"), "---\nname: [invalid\n---\nbody");
  mkdirSync(join(directory, ".pi"));
  writeFileSync(join(directory, ".pi/agents"), "not a directory");
  const discovery = loadRoles(directory, directory, true);
  expect([...discovery.roles.keys()]).toEqual(["valid"]);
  expect(discovery.invalid.get("unreadable")).toContain("unreadable.md:");
  expect(discovery.invalid.get("broken")).toContain("broken.md:");
  expect(discovery.diagnostics).toHaveLength(3);
  expect(discovery.diagnostics.every(message => !message.includes("\n"))).toBe(true);
  expect(discovery.diagnostics.some(message => message.includes(".pi/agents:"))).toBe(true);
});

for (const delivered of [false, true]) test(`v2 migration preserves native files and report identity, delivered=${delivered}`, async () => {
  const f = fixture();
  const ack = await f.service.invoke("old task", { subagent: spec });
  f.factory.children[0].result.resolve({ status: "completed", text: "OLD V2 FINAL" });
  await tick();
  if (delivered) { commit(f.parent, f.service.beforeSettle()); f.service.postCommit(); }
  const snapshot = f.service.snapshot();
  await f.service.shutdown();
  const nativeBytes = readFileSync(snapshot.subagents[ack.agentId].sessionFile);
  const v2 = { version: 2, rootKey: f.key,
    subagents: Object.fromEntries(Object.entries(snapshot.subagents).map(([id, record]) => [id, { ...record, pendingChildren: [], unprocessedReports: [] }])),
    runs: Object.fromEntries(Object.entries(snapshot.runs).map(([id, { parentRunId: _parent, receiverRunId: _receiver, phase: _phase, receiptEntryId: _receipt, processedBy: _processed, ...run }]) => [id, run])) };
  writeFileSync(join(f.store.directory, "registry.json"), JSON.stringify(v2));
  const migrated = new Coordinator(new SubagentStore(f.directory, f.key), f.factory);
  migrated.attach(f.binding, f.factory);
  expect(migrated.store.state.version).toBe(3);
  expect(migrated.records[0].id).toBe(ack.agentId);
  const run = migrated.store.state.runs[ack.runId];
  expect(run).toMatchObject({ parentRunId: null, receiverRunId: null, phase: "terminal", delivered, outcome: { text: "OLD V2 FINAL" } });
  expect(readFileSync(migrated.records[0].sessionFile)).toEqual(nativeBytes);
  expect(migrated.beforeSettle()?.entries.length ?? 0).toBe(delivered ? 0 : 1);
  await migrated.shutdown();
});

for (const field of ["pendingChildren", "unprocessedReports"]) test(`v2 nonempty ${field} is never silently discarded`, async () => {
  const f = fixture();
  const ack = await f.service.invoke("old task", { subagent: spec });
  await f.service.shutdown();
  const record = f.service.records[0];
  const state = { version: 2, rootKey: f.key, subagents: { [ack.agentId]: { ...record, pendingChildren: [], unprocessedReports: [], [field]: ["unknown-obligation"] } }, runs: f.store.state.runs };
  const bytes = JSON.stringify(state);
  const file = join(f.store.directory, "registry.json");
  writeFileSync(file, bytes);
  expect(() => new SubagentStore(f.directory, f.key)).toThrow("Cannot migrate v2 obligations");
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(existsSync(join(f.store.directory, "owner.lock"))).toBe(false);
});

for (const invalid of ["cycle", "missing parent", "wrong receiver", "wrong initiator", "missing receipt", "wrong consumption", "false successful parent", "phase mismatch"] as const) test(`v3 rejects ${invalid} without replacing saved state`, async () => {
  const f = fixture();
  const parent = await f.service.invoke("parent", { subagent: spec });
  const child = await f.service.invoke("child", { subagent: spec }, parent);
  await f.service.shutdown();
  const state = f.service.snapshot();
  if (invalid === "cycle") state.subagents[parent.agentId].parentId = child.agentId;
  if (invalid === "missing parent") state.subagents[child.agentId].parentId = "missing";
  if (invalid === "wrong receiver") state.runs[child.runId].receiverRunId = child.runId;
  if (invalid === "wrong initiator") state.runs[child.runId].parentRunId = null;
  if (invalid === "missing receipt") state.runs[child.runId].delivered = true;
  if (invalid === "wrong consumption") state.runs[child.runId].processedBy = { runId: child.runId, assistantEntryId: "fake" };
  if (invalid === "false successful parent") state.runs[parent.runId].outcome = { status: "completed", text: "must not accept" };
  if (invalid === "phase mismatch") state.runs[parent.runId].phase = "waiting";
  const file = join(f.store.directory, "registry.json");
  const bytes = JSON.stringify(state);
  writeFileSync(file, bytes);
  expect(() => new SubagentStore(f.directory, f.key)).toThrow();
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(existsSync(join(f.store.directory, "owner.lock"))).toBe(false);
});

test("durability faults cancel already armed compaction wakeups and observer unsubscribe is final", async () => {
  const f = fixture();
  let changes = 0;
  const unsubscribe = f.service.subscribe(() => { changes++; });
  await f.service.invoke("task", { subagent: spec });
  expect(changes).toBeGreaterThan(0);
  unsubscribe();
  const previous = changes;
  f.factory.children[0].result.resolve({ status: "completed", text: "saved pending report" });
  await tick();
  expect(changes).toBe(previous);
  f.service.afterCompaction();
  expect((f.service as any).mailbox().idleRetry).toBeDefined();
  expect(() => (f.service as any).fail(new Error("injected durability fault"))).toThrow("durability fault");
  expect((f.service as any).mailbox().idleRetry).toBeUndefined();
  f.setIdle(true);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(f.sent).toHaveLength(0);
  await f.service.shutdown();
});
