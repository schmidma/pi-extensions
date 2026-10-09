import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, AgentSession, type ExtensionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import subagents from "../extensions/subagents/index.ts";
import { SubagentOverview } from "../extensions/subagents/overview.ts";
import { NativeChildFactory, CHILD_TOOLS } from "../extensions/subagents/runner.ts";
import { eligibleModels, exactModel, mirrorModelRuntime, ModelConfiguration } from "../extensions/subagents/configuration.ts";
import { REPORT_TYPE, TERMINAL_TYPE, type RunRecord, type SubagentRecord } from "../extensions/subagents/state.ts";
import { Coordinator, processServices, shutdownLegacyService } from "../extensions/subagents/coordinator.ts";
import { SubagentStore, rootIdentity } from "../extensions/subagents/store.ts";
import { acknowledgedRuns, relevantTree, RELEVANT_ACK_TYPE } from "../extensions/subagents/relevance.ts";

const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => { throw new Error("Network access is forbidden in native delegation tests"); }) as typeof fetch; });
afterAll(() => { globalThis.fetch = originalFetch; });
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), "pi-native-child-")); directories.push(directory); return directory; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
interface Request {
  context: TranscriptContext;
  endpoint: string;
  finish(text: string, stopReason?: "stop" | "length" | "error" | "aborted" | "toolUse", blocks?: AssistantMessage["content"], diagnostic?: string, requestUsage?: AssistantMessage["usage"]): void;
}
function provider() {
  const ready: Request[] = [];
  const waiting: ((request: Request) => void)[] = [];
  let calls = 0;
  const config = { api: "fixture-api", baseUrl: "https://fixture.invalid", apiKey: "fixture-not-a-real-credential", models: [{ id: "model", name: "Fixture", reasoning: false,
    input: ["text" as const], cost: usage.cost, contextWindow: 1000000, maxTokens: 10000 }],
    streamSimple(model: any, context: TranscriptContext, options: any) {
      calls++;
      const stream = createAssistantMessageEventStream();
      let finished = false;
      const request: Request = { context, endpoint: model.baseUrl, finish(text, stopReason = "stop", blocks, diagnostic, requestUsage = usage) {
        if (finished) return;
        finished = true;
        const message: AssistantMessage = { role: "assistant", content: blocks ?? (text ? [{ type: "text", text }] : []), timestamp: Date.now(),
          api: model.api, provider: model.provider, model: model.id, stopReason, usage: requestUsage,
          ...(stopReason === "error" || stopReason === "aborted" ? { errorMessage: diagnostic ?? `${stopReason} fixture` } : {}) };
        stream.push({ type: "start", partial: { ...message, stopReason: "pending" } });
        if (stopReason === "error" || stopReason === "aborted") stream.push({ type: "error", reason: stopReason, error: message });
        else stream.push({ type: "done", reason: stopReason, message });
        stream.end();
      } };
      options?.signal?.addEventListener("abort", () => request.finish("", "aborted"), { once: true });
      if (options?.signal?.aborted) request.finish("", "aborted");
      const waiter = waiting.shift();
      if (waiter) waiter(request); else ready.push(request);
      return stream;
    } };
  return { config, next: () => ready.length ? Promise.resolve(ready.shift()!) : new Promise<Request>(resolve => waiting.push(resolve)), calls: () => calls };
}
async function setup() {
  const directory = temporary();
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }));
  const fake = provider();
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("fixture", fake.config);
  await runtime.getAvailable();
  const model = runtime.getModel("fixture", "model")!;
  const factory = new NativeChildFactory(directory, runtime, selection => {
    if (selection !== "fixture/model") throw new Error("wrong model"); return model;
  });
  const record: SubagentRecord = { id: "s-fixture", parentId: "root", role: { name: "worker", description: "Worker", body: "saved-role-body", promptMode: "append", source: "worker.md" },
    name: "Native", cwd: directory, projectTrusted: false, model: "fixture/model", requestedThinking: "high", effectiveThinking: "high",
    sessionId: "", sessionFile: "", generation: 1 };
  return { directory, fake, runtime, model, factory, record };
}
function taskRun(boundary: string | null, prompt: string, id = "i-test"): RunRecord {
  return { id, agentId: "s-fixture", parentId: "root", parentRunId: null, receiverRunId: null, phase: "running", generation: 1, prompt, boundary, startedAt: new Date().toISOString(), delivered: false };
}

test("native SDK child inherits global extensions, native default tools, parent trust, skills, and durable cold context", async () => {
  const f = await setup();
  mkdirSync(join(f.directory, "extensions"));
  writeFileSync(join(f.directory, "extensions/inherited.ts"), 'export default pi => { pi.on("session_start", () => pi.appendEntry("inherited-start", {})); };');
  mkdirSync(join(f.directory, ".pi"));
  writeFileSync(join(f.directory, ".pi/APPEND_SYSTEM.md"), "untrusted-project-secret");
  writeFileSync(join(f.directory, "AGENTS.md"), "native-global-instructions");
  mkdirSync(join(f.directory, "skills/example"), { recursive: true });
  writeFileSync(join(f.directory, "skills/example/SKILL.md"), "---\nname: example\ndescription: Fixture skill\n---\nSkill content");
  const child = await f.factory.create(f.record, join(f.directory, "children"), false);
  expect(f.record.effectiveThinking).toBe("off");
  expect((child as any).session.sessionManager.getEntries().some((entry: any) => entry.customType === "inherited-start")).toBe(true);
  let run = child.run(taskRun(child.boundary, "/literal-template"));
  const first = await f.fake.next();
  const serialized = JSON.stringify(first.context);
  expect(serialized).toContain("saved-role-body");
  expect(serialized).toContain("native-global-instructions");
  expect(serialized).toContain("Fixture skill");
  expect(serialized).not.toContain("untrusted-project-secret");
  const tools = first.context.messages.flatMap(message => message.role === "system" ? message.toolsAdded ?? [] : []).map(tool => tool.name);
  expect(tools.sort()).toEqual([...CHILD_TOOLS].sort());
  first.finish("Which file?");
  expect(await run).toEqual({ status: "completed", text: "Which file?", diagnostic: undefined });
  child.marker("i-test", { status: "completed", text: "Which file?" });
  const sessionId = f.record.sessionId;
  await child.shutdown();
  const resumed = await f.factory.create(f.record, join(f.directory, "children"), true);
  expect(f.record.sessionId).toBe(sessionId);
  run = resumed.run(taskRun(resumed.boundary, "file.ts", "i-resume"));
  const second = await f.fake.next();
  expect(JSON.stringify(second.context.messages)).toContain("Which file?");
  expect(JSON.stringify(second.context.messages)).toContain("file.ts");
  second.finish("Only this run's report");
  expect((await run).text).toBe("Only this run's report");
  expect(resumed.source.resolveToolRenderers?.("read")?.renderCall).toBeFunction();
  await resumed.shutdown();
  const ordinary = SessionManager.create(f.directory, join(f.directory, "sessions", "root-group"));
  ordinary.appendMessage({ role: "user", content: "ordinary visible session", timestamp: 1 });
  const previousDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.directory;
  try {
    const sessions = await SessionManager.listAll();
    expect(sessions.some(session => session.path === ordinary.getSessionFile())).toBe(true);
    expect(sessions.some(session => session.path === f.record.sessionFile)).toBe(false);
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDirectory;
  }
});

test("throwing inherited shutdown handlers still dispose native child resources exactly once", async () => {
  const f = await setup();
  mkdirSync(join(f.directory, "extensions"));
  const trace = join(f.directory, "shutdown-trace");
  writeFileSync(join(f.directory, "extensions/shutdown.ts"), `
    import { appendFileSync } from "node:fs";
    export default pi => {
      let timer;
      pi.on("session_start", () => { timer = setInterval(() => {}, 60000); timer.unref(); });
      pi.on("session_shutdown", () => { appendFileSync(${JSON.stringify(trace)}, "first\\n"); throw new Error("inherited shutdown failure"); });
      pi.on("session_shutdown", () => { clearInterval(timer); appendFileSync(${JSON.stringify(trace)}, "timer disposed\\n"); });
      pi.on("session_shutdown", () => { appendFileSync(${JSON.stringify(trace)}, "last\\n"); throw new Error("later shutdown failure"); });
    }
  `);
  const child = await f.factory.create(f.record, join(f.directory, "children"), false);
  const session = (child as any).session as AgentSession;
  const disposeSession = spyOn(session, "dispose"), disposeSource = spyOn(child.source as any, "dispose");
  const run = child.run(taskRun(child.boundary, "active"));
  await bounded(f.fake.next());
  try {
    const shutdown = child.shutdown();
    expect(child.shutdown()).toBe(shutdown);
    const error = await bounded(shutdown.catch(error => error));
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((error: Error) => error.message)).toEqual(["inherited shutdown failure", "later shutdown failure"]);
    expect(readFileSync(trace, "utf8")).toBe("first\ntimer disposed\nlast\n");
    expect((await bounded(run)).status).toBe("aborted");
    expect(disposeSource).toHaveBeenCalledTimes(1);
    expect(disposeSession).toHaveBeenCalledTimes(1);
    expect(() => child.source.subscribe(() => {})).toThrow("disposed");
    expect(child.shutdown()).toBe(shutdown);
    await expect(child.shutdown()).rejects.toThrow("inherited shutdown failure");
    expect(disposeSession).toHaveBeenCalledTimes(1);
    expect(readFileSync(trace, "utf8")).toBe("first\ntimer disposed\nlast\n");
    // Shutdown may finish waiting runs after disposal: marker storage remains usable.
    child.marker("i-test", { status: "interrupted", text: "" });
    expect(readFileSync(f.record.sessionFile, "utf8")).toContain(TERMINAL_TYPE);
    expect(f.fake.calls()).toBe(1);
  } finally { disposeSource.mockRestore(); disposeSession.mockRestore(); }
});

test("shutdown error routing stays fail-closed for normal events and resets after emit itself rejects", async () => {
  const f = await setup();
  const order: string[] = [];
  const child = await f.factory.create(f.record, join(f.directory, "children"), false, {
    register: pi => {
      pi.on("before_agent_start", () => { throw new Error("normal execution failure"); });
      pi.on("before_agent_start", () => { order.push("unreachable normal handler"); });
      pi.on("session_shutdown", () => { order.push("first"); throw new Error("shutdown handler failure"); });
      pi.on("session_shutdown", () => { order.push("later cleanup"); });
    },
    beforeSettle: () => [], postCommit: () => {}, prepare: messages => ({ messages, reports: [] }), processed: () => {},
  });
  const session = (child as any).session as AgentSession;
  const outcome = await bounded(child.run(taskRun(child.boundary, "must fail before provider")));
  expect(outcome.status).toBe("error"); expect(outcome.diagnostic).toContain("normal execution failure");
  expect(order).toEqual([]); expect(f.fake.calls()).toBe(0);
  const emit = session.extensionRunner.emit.bind(session.extensionRunner);
  const emitting = spyOn(session.extensionRunner, "emit").mockImplementation(async (event: any) => {
    const result = await emit(event);
    if (event.type === "session_shutdown") throw new Error("shutdown dispatch failed");
    return result;
  });
  const source = spyOn(child.source as any, "dispose"), dispose = spyOn(session, "dispose");
  try {
    const error = await child.shutdown().catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((error: Error) => error.message)).toEqual(["shutdown handler failure", "shutdown dispatch failed"]);
    expect(order).toEqual(["first", "later cleanup"]);
    expect(source).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1);
    // The public error boundary must throw again outside the owned shutdown emission.
    expect(() => session.extensionRunner.emitError({ extensionPath: "fixture", event: "session_shutdown", error: "outside owned shutdown" })).toThrow("outside owned shutdown");
  } finally { emitting.mockRestore(); source.mockRestore(); dispose.mockRestore(); }
});

test("failed native startup retains its original error and runs every shutdown cleanup handler", async () => {
  const f = await setup();
  const order: string[] = [];
  const resource = { dispose: () => { order.push("resource disposed"); } };
  const cleanup = spyOn(resource, "dispose"), dispose = spyOn(AgentSession.prototype, "dispose");
  try {
    const error = await f.factory.create(f.record, join(f.directory, "children"), false, {
      register: pi => {
        pi.on("session_start", () => { order.push("startup"); throw new Error("original startup failure"); });
        pi.on("session_start", () => { order.push("unreachable startup handler"); });
        pi.on("session_shutdown", () => { order.push("first shutdown"); throw new Error("startup cleanup failure"); });
        pi.on("session_shutdown", () => { resource.dispose(); });
        pi.on("session_shutdown", () => { order.push("last shutdown"); throw new Error("later startup cleanup failure"); });
      },
      beforeSettle: () => [], postCommit: () => {}, prepare: messages => ({ messages, reports: [] }), processed: () => {},
    }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((error: Error) => error.message)).toEqual(["original startup failure", "startup cleanup failure", "later startup cleanup failure"]);
    expect(order).toEqual(["startup", "first shutdown", "resource disposed", "last shutdown"]);
    expect(cleanup).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1);
    expect(f.fake.calls()).toBe(0);
  } finally { cleanup.mockRestore(); dispose.mockRestore(); }
});

test("native cleanup attempts every owned step after abort and disposal failures", async () => {
  const f = await setup();
  const child = await f.factory.create(f.record, join(f.directory, "children"), false);
  const session = (child as any).session as AgentSession;
  const errors = [new Error("abort failed"), new Error("source disposal failed"), new Error("session disposal failed")];
  const abort = spyOn(session, "abort").mockRejectedValue(errors[0]);
  const disposeSource = (child.source as any).dispose.bind(child.source), disposeSession = session.dispose.bind(session);
  const source = spyOn(child.source as any, "dispose").mockImplementation(() => { disposeSource(); throw errors[1]; });
  const sessionDispose = spyOn(session, "dispose").mockImplementation(() => { disposeSession(); throw errors[2]; });
  try {
    const error = await child.shutdown().catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual(errors);
    expect(source).toHaveBeenCalledTimes(1); expect(sessionDispose).toHaveBeenCalledTimes(1);
    expect(f.fake.calls()).toBe(0);
  } finally { abort.mockRestore(); source.mockRestore(); sessionDispose.mockRestore(); }
});

test("native failed stop reason, aborted and empty final responses never reuse old assistant text", async () => {
  const f = await setup();
  const child = await f.factory.create(f.record, join(f.directory, "children"), false);
  let run = child.run(taskRun(child.boundary, "first"));
  (await f.fake.next()).finish("old output");
  expect((await run).text).toBe("old output");
  run = child.run(taskRun(child.boundary, "failure"));
  (await f.fake.next()).finish("failure only", "error");
  const failed = await run;
  expect(failed.status).toBe("error");
  expect(failed.text).toBe("failure only");
  run = child.run(taskRun(child.boundary, "empty"));
  (await f.fake.next()).finish("");
  expect((await run).text).toBe("");
  run = child.run(taskRun(child.boundary, "abort"));
  await f.fake.next();
  await child.shutdown();
  const aborted = await run;
  expect(aborted.status).toBe("aborted");
  expect(aborted.text).toBe("");
});

for (const mode of ["success", "failure", "cancelled"] as const) test(`native threshold maintenance ${mode} preserves the completed canonical report`, async () => {
  const f = await setup();
  writeFileSync(join(f.directory, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: true, keepRecentTokens: 0 }, cacheWarming: "off" }));
  const child = await f.factory.create(f.record, join(f.directory, "children"), false);
  const session = (child as any).session as AgentSession;
  const reasons: string[] = [];
  session.subscribe(event => { if (event.type === "compaction_start") reasons.push(event.reason); });
  try {
    const run = child.run(taskRun(child.boundary, "input ".repeat(100)));
    (await f.fake.next()).finish("REAL COMPLETE FINAL REPORT", "stop", undefined, undefined,
      { ...usage, input: 999000, output: 10, totalTokens: 999010 });
    const summary = await bounded(f.fake.next());
    if (mode === "cancelled") session.abortCompaction();
    else summary.finish(mode === "success" ? "summary" : "", mode === "success" ? "stop" : "error", undefined, "summary failed");
    const outcome = await bounded(run);
    expect(reasons).toEqual(["threshold"]);
    expect(f.fake.calls()).toBe(2);
    expect(session.sessionManager.buildSessionProjection().messages.some(message => message.role === "assistant" &&
      message.content.some(block => block.type === "text" && block.text === "REAL COMPLETE FINAL REPORT"))).toBe(true);
    expect(outcome.status).toBe("completed");
    expect(outcome.text).toBe("REAL COMPLETE FINAL REPORT");
    if (mode !== "success") expect(outcome.diagnostic).toContain(mode === "failure" ? "summary failed" : "cancelled");
  } finally { await child.shutdown(); }
});

test("native length recovery failure cannot publish an abandoned answer", async () => {
  const f = await setup();
  writeFileSync(join(f.directory, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: true, keepRecentTokens: 0 }, cacheWarming: "off" }));
  const child = await f.factory.create(f.record, join(f.directory, "children"), false);
  const run = child.run(taskRun(child.boundary, "recover this input ".repeat(100)));
  (await f.fake.next()).finish("TRUNCATED ABANDONED ANSWER", "length");
  (await f.fake.next()).finish("", "error");
  const outcome = await run;
  expect(outcome.status).toBe("error");
  expect(outcome.text).toBe("");
  expect(outcome.diagnostic).toContain("recovery failed");
  await child.shutdown();
});

for (const mode of ["success", "cancelled", "twice-truncated"] as const) test(`native length recovery ${mode} respects canonical run output`, async () => {
  const f = await setup();
  writeFileSync(join(f.directory, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: true, keepRecentTokens: 0 }, cacheWarming: "off" }));
  const child = await f.factory.create(f.record, join(f.directory, "children"), false);
  const run = child.run(taskRun(child.boundary, "recover this input ".repeat(100)));
  (await f.fake.next()).finish("ABANDONED", "length");
  const summary = await f.fake.next();
  if (mode === "cancelled") await child.shutdown();
  else {
    summary.finish("Recovered input summary");
    const retry = await f.fake.next();
    expect(JSON.stringify(retry.context.messages)).not.toContain("ABANDONED");
    retry.finish(mode === "success" ? "FINAL RECOVERED ANSWER" : "STILL INCOMPLETE", mode === "success" ? "stop" : "length");
  }
  const outcome = await run;
  expect(outcome.status).toBe(mode === "success" ? "completed" : mode === "cancelled" ? "aborted" : "error");
  expect(outcome.text).toBe(mode === "success" ? "FINAL RECOVERED ANSWER" : "");
  await child.shutdown();
});

for (const mode of ["success", "failure", "cancelled"] as const) test(`native transient retry ${mode} never reuses previous run prose`, async () => {
  const f = await setup();
  writeFileSync(join(f.directory, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 }, compaction: { enabled: false }, cacheWarming: "off" }));
  const child = await f.factory.create(f.record, join(f.directory, "children"), false);
  let run = child.run(taskRun(child.boundary, "old run"));
  (await f.fake.next()).finish("OLD ANSWER");
  await run;
  run = child.run(taskRun(child.boundary, "new run"));
  (await f.fake.next()).finish("RETRY ABANDONED", "error", undefined, "503 overloaded");
  const retry = await f.fake.next();
  if (mode === "cancelled") await child.shutdown();
  else retry.finish(mode === "success" ? "NEW ANSWER" : "", mode === "success" ? "stop" : "error", undefined, "503 still overloaded");
  const outcome = await run;
  expect(outcome.status).toBe(mode === "success" ? "completed" : mode === "cancelled" ? "aborted" : "error");
  expect(outcome.text).toBe(mode === "success" ? "NEW ANSWER" : "");
  if (mode === "failure") expect(outcome.diagnostic).toContain("503 still overloaded");
  await child.shutdown();
});

test("terminal length without recovery is incomplete, not successful", async () => {
  const f = await setup();
  const child = await f.factory.create(f.record, join(f.directory, "children"), false);
  const run = child.run(taskRun(child.boundary, "task"));
  (await f.fake.next()).finish("incomplete", "length");
  expect((await run).status).toBe("error");
  await child.shutdown();
});

test("child cache warming stays off after resource loading and warm/cold resume", async () => {
  const f = await setup();
  writeFileSync(join(f.directory, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "idle" }));
  const child = await f.factory.create(f.record, join(f.directory, "children"), false);
  expect((child as any).session.settingsManager.getCacheWarmingMode()).toBe("off");
  let run = child.run(taskRun(child.boundary, "one"));
  (await f.fake.next()).finish("done");
  await run;
  run = child.run(taskRun(child.boundary, "two"));
  (await f.fake.next()).finish("done again");
  await run;
  expect((child as any).session.settingsManager.getCacheWarmingMode()).toBe("off");
  expect((child as any).session.cacheWarmingStatus).toEqual({ state: "inactive", reason: "cache warming disabled" });
  expect((child as any).session._cacheWarmer.run).toBeUndefined();
  expect(JSON.parse(readFileSync(join(f.directory, "settings.json"), "utf8")).cacheWarming).toBe("idle");
  await child.shutdown();
  const resumed = await f.factory.create(f.record, join(f.directory, "children"), true);
  expect((resumed as any).session.settingsManager.getCacheWarmingMode()).toBe("off");
  run = resumed.run(taskRun(resumed.boundary, "three"));
  (await f.fake.next()).finish("cold result");
  await run;
  expect((resumed as any).session.cacheWarmingStatus).toEqual({ state: "inactive", reason: "cache warming disabled" });
  expect((resumed as any).session._cacheWarmer.run).toBeUndefined();
  expect(f.fake.calls()).toBe(3);
  await resumed.shutdown();
});

test("native steering continues this run and terminal steering cannot leak to resume", async () => {
  const f = await setup();
  const child = await f.factory.create(f.record, join(f.directory, "children"), false);
  const run = child.run(taskRun(child.boundary, "task"));
  const first = await f.fake.next();
  child.steer("steer this run");
  first.finish("provisional chatter");
  const next = await f.fake.next();
  expect(JSON.stringify(next.context.messages)).toContain("steer this run");
  next.finish("final report only");
  expect((await run).text).toBe("final report only");
  expect(child.steer("late")).toBe(false);
  await child.shutdown();
});

test("native steering accepted during prompt preflight remains in the same run", async () => {
  const f = await setup();
  const child = await f.factory.create(f.record, join(f.directory, "children"), false);
  const run = child.run(taskRun(child.boundary, "task"));
  child.steer("early guidance");
  const first = await f.fake.next();
  expect(JSON.stringify(first.context.messages)).toContain("early guidance");
  first.finish("guided report");
  expect((await run).text).toBe("guided report");
  await child.shutdown();
});

test("separate runtime mirrors public provider config and executable roster equals scope selection", async () => {
  const f = await setup();
  const registry = new ModelRegistry(f.runtime);
  const ctx = { modelRegistry: registry, scopedModels: [{ model: f.model, thinkingLevel: "high" }] } as Pick<ExtensionContext, "modelRegistry" | "scopedModels">;
  const mirrored = await mirrorModelRuntime(ctx, f.directory);
  expect(mirrored).not.toBe(f.runtime);
  expect(mirrored.getRegisteredProviderConfig("fixture")?.streamSimple).toBe(f.fake.config.streamSimple);
  const eligible = eligibleModels(ctx, mirrored);
  expect(eligible.map(entry => `${entry.model.provider}/${entry.model.id}`)).toEqual(["fixture/model"]);
  expect(eligible[0].thinkingLevel).toBe("high");
  expect(exactModel(eligible, "fixture/model").id).toBe("model");
  expect(() => exactModel(eligible, "model")).toThrow("exact");
  expect(eligibleModels({ ...ctx, scopedModels: [] }, mirrored).some(entry => entry.model.provider === "fixture")).toBe(true);
  expect(eligibleModels({ ...ctx, scopedModels: [{ model: { ...f.model, provider: "unmirrored", id: "virtual" } }] }, mirrored)).toEqual([]);
  const nativeProvider = f.runtime.getProvider("fixture")!;
  f.runtime.registerNativeProvider(nativeProvider);
  const mirroredNative = await mirrorModelRuntime(ctx, f.directory);
  expect(mirroredNative.getRegisteredNativeProvider("fixture")).toBe(nativeProvider);
  expect(mirroredNative.getPhysicalModel("fixture", "model")).toBeDefined();
});

test("provider generations keep active endpoints stable and reopen warm subagents with history", async () => {
  const f = await setup();
  const ctx = { modelRegistry: new ModelRegistry(f.runtime), scopedModels: [{ model: f.model }] };
  const configuration = new ModelConfiguration(f.directory);
  const first = await configuration.resolve(ctx);
  const factory = (view: typeof first) => new NativeChildFactory(f.directory, view.runtime, selection => exactModel(view.models, selection));
  const root = SessionManager.create(f.directory, join(f.directory, "root"));
  root.appendMessage({ role: "user", content: "root", timestamp: 1 });
  const service = new Coordinator(new SubagentStore(f.directory, rootIdentity(root)), factory(first));
  const binding = { manager: root, idle: () => false, pending: () => false, send: () => {}, error: (error: unknown) => { throw error; } };
  service.attach(binding, factory(first));
  try {
    const ack = await service.invoke("first", { subagent: f.record });
    const old = service.runtime(ack.agentId)!;
    const request = await f.fake.next();
    expect(request.endpoint).toBe("https://fixture.invalid");
    // Re-register while the old child still owns an active request.
    ctx.modelRegistry.registerProvider("fixture", { ...f.fake.config, baseUrl: "https://new-endpoint.invalid" });
    const second = await configuration.resolve(ctx);
    expect(second.runtime).not.toBe(first.runtime);
    expect(second.runtime.getRegisteredProviderConfig("fixture")?.streamSimple).toBe(f.fake.config.streamSimple);
    service.attach(binding, factory(second));
    request.finish("preserved old history");
    await tick();
    const savedId = service.records[0].sessionId;
    const resumed = await service.invoke("continue with new configuration", { resume: ack.agentId });
    expect(resumed.agentId).toBe(ack.agentId);
    expect(service.records[0].sessionId).toBe(savedId);
    expect(service.runtime(ack.agentId)).not.toBe(old);
    const next = await f.fake.next();
    expect(next.endpoint).toBe("https://new-endpoint.invalid");
    expect(JSON.stringify(next.context.messages)).toContain("preserved old history");
    next.finish("new generation answer");
    await tick();
    expect(first.runtime.getPhysicalModel("fixture", "model")?.baseUrl).toBe("https://fixture.invalid");
    expect((await configuration.resolve(ctx)).runtime).toBe(second.runtime);
  } finally { await service.shutdown(); }
});

test("model generations follow new providers, unregister, scope and catalogue changes", async () => {
  const f = await setup();
  const ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels"> = { modelRegistry: new ModelRegistry(f.runtime), scopedModels: [] };
  const configuration = new ModelConfiguration(f.directory);
  const first = await configuration.resolve(ctx);
  const other = provider();
  ctx.modelRegistry.registerProvider("new-provider", { ...other.config, baseUrl: "https://other.invalid" });
  let view = await configuration.resolve(ctx);
  expect(view.runtime).not.toBe(first.runtime);
  const child = await new NativeChildFactory(f.directory, view.runtime, selection => exactModel(view.models, selection))
    .create({ ...f.record, model: "new-provider/model" }, join(f.directory, "new-child"), false);
  const run = child.run(taskRun(child.boundary, "new provider request"));
  const request = await other.next();
  expect(request.endpoint).toBe("https://other.invalid");
  request.finish("new provider answer");
  expect((await run).status).toBe("completed");
  await child.shutdown();
  ctx.scopedModels = [{ model: f.model, thinkingLevel: "low" }];
  view = await configuration.resolve(ctx);
  expect(view.models.map(entry => entry.model.provider)).toEqual(["fixture"]);
  expect(view.models[0].thinkingLevel).toBe("low");
  expect(() => exactModel(view.models, "new-provider/model")).toThrow("eligible");
  ctx.modelRegistry.unregisterProvider("fixture");
  view = await configuration.resolve(ctx);
  expect(view.models).toHaveLength(0);
  expect(view.runtime.getRegisteredProviderConfig("fixture")).toBeUndefined();
  ctx.scopedModels = [];
  ctx.modelRegistry.registerProvider("new-provider", { ...other.config, models: [{ ...other.config.models[0], id: "replacement" }], baseUrl: "https://catalogue.invalid" });
  view = await configuration.resolve(ctx);
  expect(() => exactModel(view.models, "new-provider/model")).toThrow("eligible");
  const replacement = await new NativeChildFactory(f.directory, view.runtime, selection => exactModel(view.models, selection))
    .create({ ...f.record, model: "new-provider/replacement" }, join(f.directory, "replacement-child"), false);
  const result = replacement.run(taskRun(replacement.boundary, "replacement request"));
  const latest = await other.next();
  expect(latest.endpoint).toBe("https://catalogue.invalid");
  latest.finish("replacement answer");
  expect((await result).status).toBe("completed");
  await replacement.shutdown();
});

test("registration changes during async mirror creation cannot publish a mixed generation", async () => {
  const f = await setup();
  const ctx = { modelRegistry: new ModelRegistry(f.runtime), scopedModels: [{ model: f.model }] };
  const configuration = new ModelConfiguration(f.directory);
  const entered = deferred<void>(), release = deferred<void>();
  const create = ModelRuntime.create.bind(ModelRuntime);
  let calls = 0;
  const spy = spyOn(ModelRuntime, "create").mockImplementation(async options => {
    const runtime = await create(options);
    if (++calls === 1) { entered.resolve(); await release.promise; }
    return runtime;
  });
  try {
    const pending = configuration.resolve(ctx);
    await entered.promise;
    ctx.modelRegistry.registerProvider("fixture", { ...f.fake.config, baseUrl: "https://raced.invalid" });
    release.resolve();
    const view = await pending;
    expect(calls).toBe(2);
    const child = await new NativeChildFactory(f.directory, view.runtime, selection => exactModel(view.models, selection))
      .create(f.record, join(f.directory, "raced-child"), false);
    const run = child.run(taskRun(child.boundary, "race"));
    const request = await f.fake.next();
    expect(request.endpoint).toBe("https://raced.invalid");
    request.finish("coherent");
    expect((await run).status).toBe("completed");
    await child.shutdown();
  } finally { release.resolve(); spy.mockRestore(); }
});

test("shutdown during native prompt preflight cannot start a late provider request", async () => {
  const f = await setup();
  const child = await f.factory.create(f.record, join(f.directory, "children"), false);
  const run = child.run(taskRun(child.boundary, "cancel before request"));
  await child.shutdown();
  const outcome = await run;
  expect(["error", "aborted", "interrupted"]).toContain(outcome.status);
  expect(f.fake.calls()).toBe(0);
});

async function rootFixture(before: ((pi: ExtensionAPI) => void)[] = [], after: ((pi: ExtensionAPI) => void)[] = [], compaction?: { enabled: boolean; keepRecentTokens?: number }) {
  const f = await setup();
  if (compaction) writeFileSync(join(f.directory, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction, cacheWarming: "off" }));
  mkdirSync(join(f.directory, "agents"));
  writeFileSync(join(f.directory, "agents/worker.md"), "---\nname: worker\ndescription: Worker\nprompt_mode: append\nallowed_subagents: all\n---\nsaved-role-body");
  const settings = SettingsManager.create(f.directory, f.directory, { projectTrusted: false });
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.directory;
  const loader = new DefaultResourceLoader({ cwd: f.directory, agentDir: f.directory, settingsManager: settings,
    noExtensions: true, extensionFactories: [...before, subagents, ...after] });
  await loader.reload();
  const manager = SessionManager.create(f.directory, join(f.directory, "root"));
  const { session } = await createAgentSession({ cwd: f.directory, agentDir: f.directory, modelRuntime: f.runtime, model: f.model,
    scopedModels: [{ model: f.model, thinkingLevel: "high" }], resourceLoader: loader, settingsManager: settings, sessionManager: manager });
  await session.bindExtensions({ mode: "print", onError: error => { throw new Error(error.error); } });
  const cleanup = async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  };
  return { ...f, session, manager, cleanup };
}
const agentCall = { type: "toolCall" as const, id: "delegate", name: "spawn_subagent", arguments: { name: "Review child task", prompt: "child task", role: "worker", model: "fixture/model", thinking: "high" } };
function acknowledgement(session: AgentSession) {
  const result = session.messages.find(message => message.role === "toolResult" && message.toolName === "spawn_subagent");
  if (!result || result.role !== "toolResult" || result.isError) throw new Error(`No successful delegation acknowledgement: ${JSON.stringify(result)}`);
  const details = result.details as { agent_id: string; run_id: string };
  return { agentId: details.agent_id, runId: details.run_id };
}

async function delegate(f: Awaited<ReturnType<typeof rootFixture>>, count = 1) {
  const rootRun = f.session.prompt("delegate");
  (await f.fake.next()).finish("", "toolUse", Array.from({ length: count }, (_, index) => ({ ...agentCall, id: `delegate-${index}` })));
  const requests = await Promise.all(Array.from({ length: count + 1 }, () => f.fake.next()));
  const children = requests.filter(request => JSON.stringify(request.context.messages).includes("saved-role-body"));
  const parent = requests.find(request => !children.includes(request))!;
  return { rootRun, children, parent };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Native operation stalled")), 2000); })]); }
  finally { clearTimeout(timer!); }
}

function terminatingTool(pi: ExtensionAPI) {
  pi.registerTool({ name: "terminate_fixture", label: "Terminate", description: "End this fixture tool batch", parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "completed terminating tool" }], details: undefined, terminate: true }) });
}

test("native coordinator waits for every child shutdown before releasing the writer lock after failure", async () => {
  const f = await setup();
  const manager = SessionManager.create(f.directory, join(f.directory, "root"));
  manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
  const key = rootIdentity(manager), store = new SubagentStore(f.directory, key);
  const service = new Coordinator(store, f.factory);
  service.attach({ manager, idle: () => false, pending: () => false, send: () => {}, error: error => { throw error; } }, f.factory);
  mkdirSync(join(f.directory, "extensions"));
  const extension = join(f.directory, "extensions/shutdown.ts");
  writeFileSync(extension, 'export default pi => { pi.on("session_shutdown", () => { throw new Error("first child shutdown failed"); }); };');
  const first = await service.invoke("first", { subagent: f.record });
  await bounded(f.fake.next());
  rmSync(extension);
  const second = await service.invoke("second", { subagent: f.record });
  await bounded(f.fake.next());
  const a = service.runtime(first.agentId)!, b = service.runtime(second.agentId)!;
  const session = (b as any).session as AgentSession;
  const entered = deferred<void>(), gate = deferred<void>();
  const emit = session.extensionRunner.emit.bind(session.extensionRunner);
  const slow = spyOn(session.extensionRunner, "emit").mockImplementation(async (event: any) => {
    if (event.type === "session_shutdown") { entered.resolve(); await gate.promise; }
    return emit(event);
  });
  const aDispose = spyOn((a as any).session, "dispose"), bDispose = spyOn(session, "dispose");
  let notified = false;
  service.subscribe(() => { if (!service.runtime(first.agentId) && !service.runtime(second.agentId)) notified = true; });
  const shutdown = service.shutdown(), observed = shutdown.catch(error => error);
  try {
    await bounded(entered.promise); await tick();
    expect(aDispose).toHaveBeenCalledTimes(1); expect(bDispose).not.toHaveBeenCalled();
    expect(existsSync(join(store.directory, "owner.lock"))).toBe(true);
    expect(() => new SubagentStore(f.directory, key)).toThrow("live or unverifiable writer");
    gate.resolve();
    expect(String(await bounded(observed))).toContain("first child shutdown failed");
    expect(bDispose).toHaveBeenCalledTimes(1);
    expect(notified).toBe(true);
    expect(service.shutdown()).toBe(shutdown);
    expect(service.runtime(first.agentId)).toBeUndefined(); expect(service.runtime(second.agentId)).toBeUndefined();
    expect(existsSync(join(store.directory, "owner.lock"))).toBe(false);
    const reopened = new SubagentStore(f.directory, key);
    expect(reopened.state.runs[first.runId].outcome?.status).toBe("interrupted");
    expect(reopened.state.runs[second.runId].outcome?.status).toBe("interrupted");
    reopened.close();
    expect(f.fake.calls()).toBe(2);
  } finally { gate.resolve(); await observed; slow.mockRestore(); aDispose.mockRestore(); bDispose.mockRestore(); }
});

test("native idle release disposes all eligible children after inherited failures without stopping waiting or active runs", async () => {
  const f = await setup();
  const manager = SessionManager.create(f.directory, join(f.directory, "root"));
  manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
  const service = new Coordinator(new SubagentStore(f.directory, rootIdentity(manager)), f.factory);
  service.attach({ manager, idle: () => false, pending: () => false, send: () => {}, error: error => { throw error; } }, f.factory);
  mkdirSync(join(f.directory, "extensions"));
  writeFileSync(join(f.directory, "extensions/shutdown.ts"), 'export default pi => { pi.on("session_shutdown", () => { throw new Error("idle inherited shutdown failed"); }); };');
  const first = await service.invoke("first", { subagent: f.record });
  (await bounded(f.fake.next())).finish("first done"); await tick();
  const second = await service.invoke("second", { subagent: f.record });
  (await bounded(f.fake.next())).finish("second done"); await tick();
  const waiting = await service.invoke("waiting", { subagent: f.record });
  const waitingRequest = await bounded(f.fake.next());
  const active = await service.invoke("active", { subagent: f.record }, waiting);
  await bounded(f.fake.next());
  waitingRequest.finish("provisional"); await tick();
  const a = service.runtime(first.agentId)!, b = service.runtime(second.agentId)!, c = service.runtime(waiting.agentId)!, d = service.runtime(active.agentId)!;
  const disposals = [a, b, c, d].map(child => spyOn((child as any).session, "dispose"));
  try {
    await expect(service.releaseIdle()).rejects.toThrow("idle inherited shutdown failed");
    expect(disposals[0]).toHaveBeenCalledTimes(1); expect(disposals[1]).toHaveBeenCalledTimes(1);
    expect(disposals[2]).not.toHaveBeenCalled(); expect(disposals[3]).not.toHaveBeenCalled();
    expect(() => a.source.subscribe(() => {})).toThrow("disposed");
    expect(() => b.source.subscribe(() => {})).toThrow("disposed");
    expect(service.store.state.runs[waiting.runId].phase).toBe("waiting");
    expect(service.runtime(waiting.agentId)).toBe(c); expect(service.runtime(active.agentId)).toBe(d);
    expect(c.idle).toBe(true); expect(d.idle).toBe(false);
    expect(f.fake.calls()).toBe(4);
  } finally {
    await expect(bounded(service.shutdown())).rejects.toThrow("idle inherited shutdown failed");
    disposals.forEach(spy => spy.mockRestore());
  }
  const reopened = new SubagentStore(f.directory, rootIdentity(manager));
  expect(reopened.state.runs[waiting.runId].outcome?.status).toBe("interrupted");
  expect(reopened.state.runs[active.runId].outcome?.status).toBe("interrupted");
  reopened.close();
});

test("root switch after inherited shutdown failure removes its service and permits switching back", async () => {
  const f = await rootFixture();
  const replacements: AgentSession[] = [];
  try {
    mkdirSync(join(f.directory, "extensions"));
    writeFileSync(join(f.directory, "extensions/shutdown.ts"), 'export default pi => { pi.on("session_shutdown", () => { throw new Error("switch child shutdown failed"); }); };');
    const { rootRun, parent } = await delegate(f);
    parent.finish("Root yielded"); await bounded(rootRun);
    const key = rootIdentity(f.manager), services = processServices(), previous = services.get(key)!;
    const calls = f.fake.calls();
    await expect(f.session.extensionRunner.emit({ type: "session_shutdown", reason: "switch" })).rejects.toThrow("switch child shutdown failed");
    expect(services.has(key)).toBe(false);
    expect(existsSync(join(previous.store.directory, "owner.lock"))).toBe(false);
    const open = async (manager: SessionManager) => {
      const settings = SettingsManager.create(f.directory, f.directory, { projectTrusted: false });
      const loader = new DefaultResourceLoader({ cwd: f.directory, agentDir: f.directory, settingsManager: settings,
        noExtensions: true, extensionFactories: [subagents] });
      await loader.reload();
      const { session } = await createAgentSession({ cwd: f.directory, agentDir: f.directory, modelRuntime: f.runtime, model: f.model,
        scopedModels: [{ model: f.model, thinkingLevel: "high" }], resourceLoader: loader, settingsManager: settings, sessionManager: manager });
      replacements.push(session);
      await session.bindExtensions({ mode: "print", onError: error => { throw new Error(error.error); } });
      return session;
    };
    const other = SessionManager.create(f.directory, join(f.directory, "other-root"));
    other.appendMessage({ role: "user", content: "other root", timestamp: 1 });
    const away = await open(other);
    expect(services.has(rootIdentity(other))).toBe(true);
    await away.extensionRunner.emit({ type: "session_shutdown", reason: "switch" });
    expect(services.has(rootIdentity(other))).toBe(false);
    const back = await open(SessionManager.open(f.manager.getSessionFile()!));
    const current = services.get(key)!;
    expect(current).toBeDefined(); expect(current).not.toBe(previous);
    current.store.save();
    expect(Object.values(current.store.state.runs).every(run => run.outcome?.status === "interrupted")).toBe(true);
    expect(f.fake.calls()).toBe(calls);
    await back.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(services.has(key)).toBe(false);
  } finally {
    for (const session of replacements) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    await f.cleanup();
  }
});

test("root cleanup attempts every opaque legacy service after current shutdown failure", async () => {
  const f = await rootFixture();
  const keys = [1, 2].map(version => Symbol.for(`local.pi-subagents.services.v${version}`));
  const globals = globalThis as any, saved = keys.map(key => globals[key]);
  try {
    const { rootRun, parent } = await delegate(f);
    parent.finish("root yielded"); await bounded(rootRun);
    const key = rootIdentity(f.manager), services = processServices(), current = services.get(key)!;
    const child = current.runtime(current.records[0].id)!;
    const close = child.shutdown.bind(child);
    child.shutdown = async () => { await close(); throw new Error("current cleanup failure"); };
    const attempts: number[] = [];
    const opaque = (index: number) => new Proxy({ shutdown: async () => { attempts.push(index); if (!index) throw new Error("legacy cleanup failure"); } }, {
      get(target, field) { if (field !== "shutdown") throw new Error(`Interpreted old live field ${String(field)}`); return target.shutdown; },
    });
    const failed = new Map([[key, opaque(0)]]), successful = new Map([[key, opaque(1)]]);
    globals[keys[0]] = failed; globals[keys[1]] = successful;
    const error = await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "switch" }).catch(error => error);
    expect(String(error)).toContain("current cleanup failure"); expect(String(error)).toContain("legacy cleanup failure");
    expect(attempts).toEqual([0, 1]);
    expect(services.has(key)).toBe(false);
    expect(successful.size).toBe(0); expect(failed.size).toBe(1);
    expect(() => processServices()).toThrow("process restart");
    const reopened = new SubagentStore(f.directory, key); reopened.close();
    await expect(shutdownLegacyService(key)).rejects.toThrow("legacy cleanup failure");
    expect(attempts).toEqual([0, 1, 0]);
  } finally {
    keys.forEach((key, index) => { if (saved[index] === undefined) delete globals[key]; else globals[key] = saved[index]; });
    await f.cleanup();
  }
});

test("native boundary append failure retains the outcome for disk-based recovery", async () => {
  const f = await rootFixture();
  let closed = false;
  try {
    const { rootRun, children, parent } = await delegate(f);
    const ack = acknowledgement(f.session);
    const key = rootIdentity(f.manager);
    const service = processServices().get(key)!;
    children[0].finish("durable report despite root write failure");
    await tick();
    const persist = (f.manager as any)._persist.bind(f.manager);
    (f.manager as any)._persist = (entry: any) => {
      if (entry.type === "custom_message" && entry.customType === REPORT_TYPE) throw new Error("injected native root append failure");
      return persist(entry);
    };
    const result = rootRun.catch(error => error);
    parent.finish("yield");
    await bounded(result);
    expect(f.manager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toBe(true);
    expect(readFileSync(f.manager.getSessionFile()!, "utf8").trim().split("\n").map(line => JSON.parse(line))
      .filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(0);
    expect(service.store.state.runs[ack.runId].delivered).toBe(false);
    expect(JSON.parse(readFileSync(join(service.store.directory, "registry.json"), "utf8")).runs[ack.runId].delivered).toBe(false);
    await f.cleanup();
    closed = true;
    const recovered = new Coordinator(new SubagentStore(f.directory, key), f.factory);
    recovered.attach({ manager: SessionManager.open(f.manager.getSessionFile()!), idle: () => false, pending: () => false, send: () => {}, error: error => { throw error; } }, f.factory);
    expect(recovered.beforeSettle()?.entries[0].content).toContain("durable report despite root write failure");
    expect(f.fake.calls()).toBe(3);
    await recovered.shutdown();
  } finally { if (!closed) await f.cleanup(); }
}, 10000);

test("public live provider re-registration changes the next warm subagent request endpoint", async () => {
  let api!: ExtensionAPI;
  const f = await rootFixture([pi => { api = pi; }]);
  try {
    const { rootRun, children, parent } = await delegate(f);
    const ack = acknowledgement(f.session);
    const service = processServices().get(rootIdentity(f.manager))!;
    const old = service.runtime(ack.agentId)!;
    const nativeId = service.records[0].sessionId;
    children[0].finish("question from first generation");
    await tick();
    api.registerProvider("fixture", { ...f.fake.config, baseUrl: "https://live-replacement.invalid" });
    parent.finish("", "toolUse", [{ type: "toolCall", id: "resume-child", name: "resume_subagent", arguments: { agent_id: ack.agentId, prompt: "answer to question" } }]);
    const requests = [await bounded(f.fake.next()), await bounded(f.fake.next())];
    const child = requests.find(request => JSON.stringify(request.context.messages).includes("saved-role-body"))!;
    const root = requests.find(request => request !== child)!;
    expect(child.endpoint).toBe("https://live-replacement.invalid");
    expect(JSON.stringify(child.context.messages)).toContain("question from first generation");
    expect(service.records[0].sessionId).toBe(nativeId);
    expect(service.runtime(ack.agentId)).not.toBe(old);
    child.finish("answer from replacement generation");
    await tick();
    root.finish("yield for reports");
    const reports = await bounded(f.fake.next());
    expect(JSON.stringify(reports.context.messages)).toContain("answer from replacement generation");
    reports.finish("processed reports");
    await bounded(rootRun);
    expect(f.manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(2);
  } finally { await f.cleanup(); }
}, 10000);

for (const reload of [false, true]) test(`native settled dispatcher delivers concurrent reports exactly once, reload=${reload}`, async () => {
  let complete: (() => Promise<void>) | undefined;
  let reloadOnce: (() => Promise<void>) | undefined;
  const f = await rootFixture([pi => pi.on("agent_settled", async () => { const run = complete; complete = undefined; await run?.(); })],
    [pi => pi.on("agent_settled", async () => { const run = reloadOnce; reloadOnce = undefined; await run?.(); })]);
  try {
    const { rootRun, children, parent } = await delegate(f, 2);
    expect(children).toHaveLength(2);
    complete = async () => { children.forEach((child, index) => child.finish(`concurrent report ${index}`)); await tick(); };
    if (reload) reloadOnce = () => f.session.reload();
    parent.finish("yield");
    (await bounded(f.fake.next())).finish("processed first");
    (await bounded(f.fake.next())).finish("processed second");
    await bounded(rootRun);
    await tick();
    const receipts = f.manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE);
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map(entry => (entry as any).details.deliveryId)).size).toBe(2);
    expect(f.fake.calls()).toBe(6);
  } finally { await f.cleanup(); }
}, 10000);

for (const mode of ["success", "success-reload", "failure", "cancelled"] as const) test(`manual compaction ${mode} wakes pending report without another prompt`, async () => {
  const success = mode === "success" || mode === "success-reload";
  const delayed = deferred<void>();
  const entered = deferred<void>();
  const f = await rootFixture([], [pi => pi.on("session_compact", async () => { entered.resolve(); await delayed.promise; })]);
  try {
    const { rootRun, children, parent } = await delegate(f);
    parent.finish("yield");
    await rootRun;
    f.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 0 } });
    const compact = f.session.compact().then(() => undefined, error => error);
    const summary = await bounded(f.fake.next());
    children[0].finish(`report during ${mode}`);
    await tick();
    expect(f.manager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toBe(false);
    if (mode === "cancelled") f.session.abortCompaction();
    else summary.finish(success ? "Summary" : "", success ? "stop" : "error");
    if (success) {
      await entered.promise;
      await new Promise(resolve => setTimeout(resolve, 35)); // Later extension handlers can outlive setImmediate.
      expect(f.session.isIdle).toBe(false);
      expect(f.fake.calls()).toBe(4);
      if (mode === "success-reload") {
        await f.session.reload();
        await new Promise(resolve => setTimeout(resolve, 35));
        expect(f.fake.calls()).toBe(4);
      }
      delayed.resolve();
    }
    await compact;
    const wake = await bounded(f.fake.next());
    expect(JSON.stringify(wake.context.messages)).toContain(`report during ${mode}`);
    wake.finish("processed");
    await f.session.waitForIdle();
    await tick();
    expect(f.manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(1);
  } finally { delayed.resolve(); await f.cleanup(); }
}, 10000);

for (const response of ["Main yields while child works", ""]) test(`real extension retains running child through ${response ? "text" : "empty"} root yield and actual reload, then delivers one full idle report`, async () => {
  const f = await rootFixture();
  try {
    const rootRun = f.session.prompt("delegate");
    (await f.fake.next()).finish("", "toolUse", [agentCall]);
    const a = await f.fake.next(), b = await f.fake.next();
    const childRequest = JSON.stringify(a.context.messages).includes("saved-role-body") ? a : b;
    const parentRequest = childRequest === a ? b : a;
    parentRequest.finish(response);
    await bounded(rootRun);
    const ack = acknowledgement(f.session);
    const service = processServices().get(rootIdentity(f.manager))!;
    const child = service.runtime(ack.agentId);
    expect(child).toBeDefined();
    expect(child!.idle).toBe(false);
    expect(f.session.isIdle).toBe(true);
    expect(service.store.state.runs[ack.runId]).toMatchObject({ phase: "running", delivered: false });
    expect(service.store.state.runs[ack.runId].outcome).toBeUndefined();
    expect(service.records[0].currentRun).toBe(ack.runId);
    expect(f.fake.calls()).toBe(3); // Yield does not launch a request just to wait.
    await f.session.reload();
    expect(processServices().get(rootIdentity(f.manager))).toBe(service);
    expect(service.runtime(ack.agentId)).toBe(child);
    expect(f.session.isIdle).toBe(true);
    expect(f.fake.calls()).toBe(3);
    const full = "untruncated child report\n".repeat(12000);
    childRequest.finish(full);
    const wake = await bounded(f.fake.next());
    expect(f.fake.calls()).toBe(4); // The child report alone automatically wakes its parent.
    expect(JSON.stringify(wake.context.messages)).toContain(full.replaceAll("\n", "\\n"));
    wake.finish("Main processed report");
    await f.session.waitForIdle();
    await tick();
    const receipts = f.manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE);
    expect(receipts).toHaveLength(1);
    expect(service.store.state.runs[ack.runId].delivered).toBe(true);
    expect(service.store.state.runs[ack.runId].outcome).toMatchObject({ status: "completed", text: full });
    expect(Object.keys(service.store.state.runs)).toEqual([ack.runId]);
    expect((receipts[0] as any).details.runId).toBe(ack.runId);
    expect(f.session.isIdle).toBe(true);
    expect(f.session.getLastAssistantText()).toBe("Main processed report");
    expect(f.fake.calls()).toBe(4); // No duplicate delivery or waiting request after processing.
  } finally { await f.cleanup(); }
}, 20000);

test("native root compaction may summarize earlier reports before the main request without reinjection", async () => {
  const reports = ["FIRST FULL REPORT: cache invalidation is required. " + "a".repeat(6000),
    "SECOND FULL REPORT: retry only idempotent operations. " + "b".repeat(6000)];
  const summary = "Subagent findings: cache invalidation is required; retry only idempotent operations. Main should apply both recommendations.";
  const cuts: string[] = [];
  const f = await rootFixture([pi => pi.on("session_before_compact", event => {
    const p = event.preparation;
    cuts.push(p.firstKeptEntryId);
    expect(event.reason).toBe("threshold");
    expect(JSON.stringify([...p.messagesToSummarize, ...p.turnPrefixMessages])).toContain(reports[0]);
    return { compaction: { summary, firstKeptEntryId: p.firstKeptEntryId, tokensBefore: p.tokensBefore } };
  })], [], { enabled: true, keepRecentTokens: 1 });
  try {
    const { rootRun, children, parent } = await delegate(f, 2);
    children.forEach((child, index) => child.finish(reports[index]));
    await tick();
    parent.finish("boundary", "stop", undefined, undefined, { ...usage, input: 999000, output: 10, totalTokens: 999010 });
    const receiving = await bounded(f.fake.next());
    expect(cuts).toHaveLength(1);
    const receipts = f.manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE);
    expect(receipts).toHaveLength(2);
    expect(cuts[0]).toBe(receipts[1].id); // Use the SDK-selected cut, not a forced boundary.
    for (const messages of [f.manager.buildSessionProjection().messages, receiving.context.messages]) {
      const text = JSON.stringify(messages);
      expect(text).not.toContain(reports[0]);
      expect(text).toContain(reports[1]);
      expect(text).toContain(summary);
    }
    receiving.finish("Apply cache invalidation and restrict retries to idempotent operations.");
    await bounded(rootRun);
    await tick();
    expect(f.fake.calls()).toBe(5); // Two child calls and three main calls; no auxiliary or acknowledgement request.
    const service = processServices().get(rootIdentity(f.manager))!;
    const disk = SessionManager.open(f.manager.getSessionFile()!);
    const diskReceipts = disk.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE);
    expect(diskReceipts).toHaveLength(2);
    const saved = JSON.parse(readFileSync(join(service.store.directory, "registry.json"), "utf8"));
    expect(saved.version).toBe(3);
    for (const [index, report] of reports.entries()) {
      const receipt = diskReceipts[index];
      if (receipt.type !== "custom_message") throw new Error("expected native receipt");
      expect(receipt.content).toContain(report);
      expect(receipt.details).not.toHaveProperty("rootProcessingVersion");
      const runId = (receipt.details as any).runId;
      expect(diskReceipts.filter(entry => entry.type === "custom_message" && (entry.details as any).runId === runId)).toHaveLength(1);
      const run = saved.runs[runId];
      expect(run.delivered).toBe(true);
      expect(run.receiptEntryId).toBe(receipt.id);
      expect(run.outcome.text).toBe(report);
      expect(service.store.state.runs[runId].outcome?.text).toBe(report);
      const child = SessionManager.open(saved.subagents[run.agentId].sessionFile);
      const originals = child.getEntries().filter(entry => entry.type === "message" && entry.message.role === "assistant" &&
        entry.message.content.some(block => block.type === "text" && block.text === report));
      expect(originals).toHaveLength(1);
    }
    expect(disk.getEntries().filter(entry => entry.type === "custom" && entry.customType === "subagents.root-reports-processed.v1")).toHaveLength(0);
    expect(f.session.getLastAssistantText()).toBe("Apply cache invalidation and restrict retries to idempotent operations.");
  } finally { await f.cleanup(); }
}, 10000);

test("busy main batches full reports at the next tool boundary before settlement and native steering", async () => {
  const entered = deferred<void>(), release = deferred<void>();
  let complete: (() => Promise<void>) | undefined;
  let settlements = 0;
  const f = await rootFixture([pi => {
    pi.on("tool_call", async event => {
      if (event.toolCallId !== "held-read") return;
      entered.resolve(); await release.promise;
    });
    pi.on("turn_end", async event => {
      const action = complete; complete = undefined;
      if (!action) return;
      await action();
      return { entries: [...event.entries, { type: "custom", customType: "other-boundary-entry", data: {} }] };
    });
    pi.on("agent_before_settle", () => { settlements++; });
  }]);
  try {
    const { rootRun, children, parent } = await delegate(f, 2);
    const service = processServices().get(rootIdentity(f.manager))!;
    const reports = children.map((_, index) => `FULL BUSY REPORT ${index}\n${"untruncated content\n".repeat(12000)}`);
    const flush = spyOn(service as any, "flushRootReceipt");
    complete = async () => {
      children.forEach((child, index) => child.finish(reports[index]));
      await tick();
      expect(Object.values(service.store.state.runs).every(run => run.outcome && !run.delivered)).toBe(true);
    };
    parent.finish("", "toolUse", [{ type: "toolCall", id: "held-read", name: "read", arguments: { path: join(f.directory, "settings.json") } }]);
    await bounded(entered.promise);
    await f.session.steer("NATIVE USER STEERING");
    expect(f.fake.calls()).toBe(4);
    release.resolve();
    const receiving = await bounded(f.fake.next());
    expect(settlements).toBe(0);
    expect(flush).toHaveBeenCalledTimes(1);
    const state = JSON.parse(readFileSync(join(service.store.directory, "registry.json"), "utf8"));
    for (const report of reports) {
      const messages = receiving.context.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes(JSON.stringify(report).slice(1, -1)));
      expect(messages).toHaveLength(1);
    }
    expect(Object.values(state.runs).every((run: any) => run.delivered && run.receiptEntryId)).toBe(true);
    const disk = SessionManager.open(f.manager.getSessionFile()!);
    expect(disk.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(2);
    expect(disk.getEntries().filter(entry => entry.type === "custom" && entry.customType === "other-boundary-entry")).toHaveLength(1);
    const serialized = receiving.context.messages.map(message => JSON.stringify(message));
    expect(serialized.findIndex(message => message.includes("FULL BUSY REPORT 1"))).toBeLessThan(serialized.findIndex(message => message.includes("NATIVE USER STEERING")));
    receiving.finish("", "toolUse", [{ type: "toolCall", id: "more-work", name: "read", arguments: { path: join(f.directory, "settings.json") } }]);
    const final = await bounded(f.fake.next());
    expect(settlements).toBe(0);
    final.finish("main finished after more work");
    await bounded(rootRun);
    expect(settlements).toBe(1);
    expect(f.fake.calls()).toBe(6);
    expect(f.manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(2);
    flush.mockRestore();
  } finally { release.resolve(); await f.cleanup(); }
}, 10000);

for (const ending of ["stop", "toolUse", "terminate"] as const) test(`report finishing in a later turn_end handler survives ${ending} without duplicate continuation`, async () => {
  let complete: (() => Promise<void>) | undefined;
  let settlements = 0;
  const f = await rootFixture([terminatingTool, pi => {
    pi.on("agent_before_settle", () => { settlements++; });
  }], [pi => pi.on("turn_end", async () => {
    const action = complete; complete = undefined; await action?.();
  })]);
  try {
    const { rootRun, children, parent } = await delegate(f);
    complete = async () => { children[0].finish("LATE FULL REPORT"); await tick(); };
    if (ending === "stop") parent.finish("provisional final");
    else parent.finish("", "toolUse", [{ type: "toolCall", id: "ending-tool", name: ending === "terminate" ? "terminate_fixture" : "read", arguments: ending === "terminate" ? {} : { path: join(f.directory, "settings.json") } }]);
    let receiving = await bounded(f.fake.next());
    if (ending === "toolUse") {
      expect(JSON.stringify(receiving.context)).not.toContain("LATE FULL REPORT");
      expect(settlements).toBe(0);
      receiving.finish("next safe boundary");
      receiving = await bounded(f.fake.next());
    } else expect(settlements).toBe(1);
    expect(JSON.stringify(receiving.context)).toContain("LATE FULL REPORT");
    receiving.finish("processed late report");
    await bounded(rootRun);
    expect(f.fake.calls()).toBe(ending === "toolUse" ? 5 : 4);
    expect(f.manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(1);
  } finally { await f.cleanup(); }
}, 10000);

for (const ready of [false, true]) test(`terminating tool batch continues only for ready reports: ${ready}`, async () => {
  let settlements = 0;
  const f = await rootFixture([terminatingTool, pi => {
    pi.on("agent_before_settle", () => { settlements++; });
  }]);
  try {
    const { rootRun, children, parent } = await delegate(f);
    if (ready) { children[0].finish("READY TERMINAL REPORT"); await tick(); }
    parent.finish("", "toolUse", [{ type: "toolCall", id: "terminating-tool", name: "terminate_fixture", arguments: {} }]);
    if (ready) {
      const receiving = await bounded(f.fake.next());
      expect(settlements).toBe(0);
      expect(JSON.stringify(receiving.context)).toContain("READY TERMINAL REPORT");
      receiving.finish("processed");
    }
    await bounded(rootRun);
    expect(f.fake.calls()).toBe(ready ? 4 : 3);
    expect(settlements).toBe(1);
  } finally { await f.cleanup(); }
}, 10000);

for (const stop of ["error", "aborted", "length", "abort-tools"] as const) test(`native child turn boundary never reserves reports for ${stop}`, async () => {
  const f = await setup();
  let api!: ExtensionAPI;
  let reservations = 0;
  const child = await f.factory.create(f.record, join(f.directory, "children"), false, {
    register: pi => { api = pi; }, beforeSettle: () => { reservations++; return []; }, postCommit: () => {},
    prepare: messages => ({ messages, reports: [] }), processed: () => {},
  });
  const boundaries: { reservations: number; entries: number; continued: boolean; stop: string | false; aborted: boolean | undefined }[] = [];
  api.on("turn_end", (event, ctx) => {
    boundaries.push({ reservations, entries: event.entries.length, continued: event.continue,
      stop: event.message.role === "assistant" && event.message.stopReason, aborted: ctx.signal?.aborted });
  });
  const session = (child as any).session as AgentSession;
  if (stop === "abort-tools") session.subscribe(event => { if (event.type === "tool_execution_start") session.agent.abort(); });
  try {
    const run = child.run(taskRun(child.boundary, "failed turn must not reserve"));
    const request = await bounded(f.fake.next());
    if (stop === "abort-tools") request.finish("", "toolUse", [{ type: "toolCall", id: "abort-read", name: "read", arguments: { path: join(f.directory, "settings.json") } }]);
    else request.finish("incomplete", stop);
    await bounded(run);
    expect(boundaries.length).toBeGreaterThan(0);
    for (const boundary of boundaries) expect(boundary).toMatchObject({ reservations: 0, entries: 0, continued: false });
    expect(boundaries[0].stop).toBe(stop === "abort-tools" ? "toolUse" : stop);
    if (stop === "abort-tools") expect(boundaries[0].aborted).toBe(true);
    expect(f.fake.calls()).toBe(1);
  } finally { await child.shutdown(); }
});

for (const stop of ["error", "aborted", "length", "abort-tools"] as const) test(`native root turn boundary does not call the outbox reservation helper for ${stop}`, async () => {
  let service: Coordinator | undefined;
  let reservations = 0;
  const boundaries: { reservations: number; entries: number; continued: boolean; stop: string | false; aborted: boolean | undefined }[] = [];
  const f = await rootFixture([], [pi => pi.on("turn_end", (event, ctx) => {
    if (!service) return;
    boundaries.push({ reservations, entries: event.entries.length, continued: event.continue,
      stop: event.message.role === "assistant" && event.message.stopReason, aborted: ctx.signal?.aborted });
  })]);
  try {
    const delegated = await delegate(f);
    service = processServices().get(rootIdentity(f.manager))!;
    const reserve = service.beforeSettle.bind(service);
    service.beforeSettle = () => { reservations++; return reserve(); };
    if (stop === "abort-tools") {
      f.session.subscribe(event => { if (event.type === "tool_execution_start") f.session.agent.abort(); });
      delegated.parent.finish("", "toolUse", [{ type: "toolCall", id: "abort-read", name: "read", arguments: { path: join(f.directory, "settings.json") } }]);
    } else delegated.parent.finish("incomplete", stop);
    await bounded(delegated.rootRun);
    expect(boundaries.length).toBeGreaterThan(0);
    for (const boundary of boundaries) expect(boundary).toMatchObject({ reservations: 0, entries: 0, continued: false });
    expect(boundaries[0].stop).toBe(stop === "abort-tools" ? "toolUse" : stop);
    if (stop === "abort-tools") expect(boundaries[0].aborted).toBe(true);
    expect(f.fake.calls()).toBe(3);
  } finally { await f.cleanup(); }
}, 10000);

test("real busy parent receives report through committed boundary continuation, not queued send receipt", async () => {
  const f = await rootFixture();
  try {
    const rootRun = f.session.prompt("delegate");
    (await f.fake.next()).finish("", "toolUse", [agentCall]);
    const a = await f.fake.next(), b = await f.fake.next();
    const childRequest = JSON.stringify(a.context.messages).includes("saved-role-body") ? a : b;
    const parentRequest = childRequest === a ? b : a;
    childRequest.finish("busy final question?");
    await tick();
    const ack = acknowledgement(f.session);
    const service = processServices().get(rootIdentity(f.manager))!;
    expect(service.store.state.runs[ack.runId].delivered).toBe(false);
    parentRequest.finish("", "toolUse", [{ type: "toolCall", id: "busy-read", name: "read", arguments: { path: join(f.directory, "settings.json") } }]);
    const continued = await f.fake.next();
    expect(service.store.state.runs[ack.runId].delivered).toBe(true);
    expect(JSON.stringify(continued.context.messages)).toContain("busy final question?");
    continued.finish("Processed");
    await rootRun;
    expect(service.store.state.runs[ack.runId].delivered).toBe(true);
    expect(f.manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(1);
  } finally { await f.cleanup(); }
}, 20000);

for (const mode of ["no-files", "unselected", "append", "replace"] as const) test(`named spawn, warm and cold resume retain native history and optional role: ${mode}`, async () => {
  const f = await rootFixture();
  const selected = mode === "append" || mode === "replace";
  if (mode === "no-files") rmSync(join(f.directory, "agents"), { recursive: true });
  else writeFileSync(join(f.directory, "agents/worker.md"), `---\nname: worker\nprompt_mode: ${selected ? mode : "append"}\nallowed_subagents: all\n---\nsaved-role-body`);
  writeFileSync(join(f.directory, "AGENTS.md"), "native-base-instructions-for-child");
  const isChild = (request: Request) => JSON.stringify(request.context.messages).includes("Return your full final report, question, or blocker as ordinary assistant prose to your immediate parent");
  const pair = async () => {
    const requests = [await bounded(f.fake.next()), await bounded(f.fake.next())];
    expect(requests.filter(isChild)).toHaveLength(1);
    return { child: requests.find(isChild)!, parent: requests.find(request => !isChild(request))! };
  };
  try {
    const rootRun = f.session.prompt("delegate the named task");
    const first = await f.fake.next();
    expect(JSON.stringify(first.context)).not.toContain("general-purpose");
    first.finish("", "toolUse", [{ ...agentCall, arguments: { name: "Review authentication", prompt: "child task", model: "fixture/model", thinking: "high", ...(selected ? { role: "worker" } : {}) } }]);
    let { child, parent } = await pair();
    const context = JSON.stringify(child.context.messages);
    expect(context.match(/<subagent_coordination>/g)).toHaveLength(1);
    for (const request of [first, child]) {
      const supplied = JSON.stringify(request.context.messages);
      for (const guidance of [
        "without the parent's conversation history",
        "including relevant decisions and constraints not available in referenced files",
        "Include the objective, relevant findings or ruled-out approaches, scope, and expected output",
        "keep the brief proportional to the task",
        "State whether the task is read-only or may modify files",
        "Do not predict or present a pending subagent's findings",
        "While a delegated investigation is pending, leave that investigation to the subagent",
        "Do not repeat its searches or evidence gathering",
        "When verification is needed, check specific returned findings rather than restarting the investigation",
        "Deliberate independent cross-checks are a separate, explicit choice",
        "While subagents work, do genuinely independent work if any remains",
        "If your next useful step depends on their reports, end your current turn without a substantive final answer",
        "an empty response is permitted",
        "This applies to the main agent as well as subagents",
        "Yielding is not completing the user's task or conversation: unfinished subagents continue",
        "their reports automatically start another turn for you without a user prompt",
        "Do not sleep, poll, or make dummy tool calls to wait for subagents",
      ]) expect(supplied).toContain(guidance);
    }
    expect(context).toContain("child task");
    if (selected) expect(context).toContain("saved-role-body");
    else {
      expect(context).not.toContain("saved-role-body");
      expect(context).toContain("native-base-instructions-for-child");
    }
    const tools = child.context.messages.flatMap(message => message.role === "system" ? message.toolsAdded ?? [] : []).map(tool => tool.name);
    expect(tools.sort()).toEqual([...CHILD_TOOLS, "spawn_subagent", "resume_subagent", "steer_subagent"].sort());
    const ack = acknowledgement(f.session);
    const result = f.session.messages.find(message => message.role === "toolResult" && message.toolName === "spawn_subagent")!;
    const assertAcknowledgement = (toolName: string, toolCallId: string, request: Request) => {
      const results = f.session.messages.filter(message => message.role === "toolResult" && message.toolName === toolName && message.toolCallId === toolCallId);
      expect(results).toHaveLength(1);
      expect(JSON.stringify(results[0])).toContain("Subagent Review authentication accepted. Its report will arrive automatically.");
      expect(JSON.stringify(results[0])).toContain("If blocked on this report, end your turn; do not sleep or poll.");
      const supplied = request.context.messages.filter(message => message.role === "toolResult" && message.toolCallId === toolCallId);
      expect(supplied).toHaveLength(1);
      expect(JSON.stringify(supplied[0])).toContain("If blocked on this report, end your turn; do not sleep or poll.");
    };
    assertAcknowledgement("spawn_subagent", "delegate", parent);
    const details = (result as any).details;
    expect(details).toMatchObject({ name: "Review authentication", agent_id: ack.agentId, run_id: ack.runId, model: "fixture/model", requestedThinking: "high", effectiveThinking: "off" });
    expect(details).not.toHaveProperty("description");
    expect(details).not.toHaveProperty("agentId");
    const service = processServices().get(rootIdentity(f.manager))!;
    const record = service.records[0];
    const nativeId = record.sessionId, path = record.sessionFile;
    if (selected) expect(record.role?.promptMode).toBe(mode);
    else expect(record).not.toHaveProperty("role");
    child.finish("Which file should I review?");
    await tick();
    // Editing a template after spawn must not affect saved instructions on resume.
    if (mode !== "no-files") writeFileSync(join(f.directory, "agents/worker.md"), "---\nname: worker\n---\nchanged-role-body");
    parent.finish("", "toolUse", [{ type: "toolCall", id: "warm", name: "resume_subagent", arguments: { agent_id: ack.agentId, prompt: "review auth.ts" } }]);
    ({ child, parent } = await pair());
    assertAcknowledgement("resume_subagent", "warm", parent);
    const warm = JSON.stringify(child.context.messages);
    expect(warm).toContain("Which file should I review?");
    expect(warm).toContain("review auth.ts");
    expect(warm).not.toContain("changed-role-body");
    expect(warm.includes("saved-role-body")).toBe(selected);
    expect(record.sessionId).toBe(nativeId);
    child.finish("Warm review report");
    await tick();
    parent.finish("yield for reports");
    const reports = await bounded(f.fake.next());
    expect(JSON.stringify(reports.context.messages)).toContain("Subagent Review authentication - completed");
    reports.finish("reports processed");
    await bounded(rootRun);
    expect(service.runtime(ack.agentId)).toBeUndefined();
    const coldRun = f.session.prompt("continue that same review");
    (await bounded(f.fake.next())).finish("", "toolUse", [{ type: "toolCall", id: "cold", name: "resume_subagent", arguments: { agent_id: ack.agentId, prompt: "review another file" } }]);
    ({ child, parent } = await pair());
    assertAcknowledgement("resume_subagent", "cold", parent);
    const cold = JSON.stringify(child.context.messages);
    expect(cold).toContain("Warm review report");
    expect(cold).not.toContain("changed-role-body");
    expect(cold.includes("saved-role-body")).toBe(selected);
    expect(record.sessionId).toBe(nativeId);
    expect(record.sessionFile).toBe(path);
    expect(record.name).toBe("Review authentication");
    child.finish("Cold review report");
    await tick();
    parent.finish("yield again");
    (await bounded(f.fake.next())).finish("last report processed");
    await bounded(coldRun);
    const receipts = f.manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE);
    expect(receipts).toHaveLength(3);
    expect(new Set(receipts.map(entry => (entry as any).details.deliveryId)).size).toBe(3);
    const nativeEntries = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const markers = nativeEntries.filter(entry => entry.type === "custom" && entry.customType === TERMINAL_TYPE);
    expect(markers).toHaveLength(3);
    expect(markers.every(entry => typeof entry.data.runId === "string" && !("invocationId" in entry.data))).toBe(true);
  } finally { await f.cleanup(); }
}, 15000);

// Construct the historical registry layout only; do not rewrite native transcripts.
test("v1 migration cold resume retains native conversation, name and saved role instructions", async () => {
  const f = await setup();
  const root = SessionManager.create(f.directory, join(f.directory, "root"));
  root.appendMessage({ role: "user", content: "root", timestamp: 1 });
  const key = rootIdentity(root);
  const binding = { manager: root, idle: () => false, pending: () => false, send: () => {}, error: (error: unknown) => { throw error; } };
  const original = new Coordinator(new SubagentStore(f.directory, key), f.factory);
  original.attach(binding, f.factory);
  const ack = await original.invoke("old task", { subagent: { ...f.record, name: "Saved review" } });
  (await bounded(f.fake.next())).finish("Original canonical native answer");
  await tick();
  const drafts = original.beforeSettle();
  for (const draft of drafts?.entries ?? []) root.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
  original.postCommit();
  await original.shutdown();
  const saved = original.records[0];
  const childBytes = readFileSync(saved.sessionFile, "utf8");
  const rootBytes = readFileSync(root.getSessionFile()!, "utf8");
  const { name, currentRun, role, ...rest } = saved;
  const runs = Object.fromEntries(Object.entries(original.store.state.runs).map(([id, run]) => {
    const { agentId, ...rest } = run;
    return [id, { ...rest, specialistId: agentId }];
  }));
  writeFileSync(join(original.store.directory, "registry.json"), JSON.stringify({ version: 1, rootKey: key,
    specialists: { [saved.id]: { ...rest, pendingChildren: [], unprocessedReports: [], description: name, currentInvocation: currentRun, role: { ...role, allowedSubagents: "all" } } }, invocations: runs }));
  const migrated = new Coordinator(new SubagentStore(f.directory, key), f.factory);
  migrated.attach(binding, f.factory);
  try {
    expect(migrated.beforeSettle()).toBeUndefined();
    expect(readFileSync(saved.sessionFile, "utf8")).toBe(childBytes);
    expect(readFileSync(root.getSessionFile()!, "utf8")).toBe(rootBytes);
    const resumed = await migrated.invoke("new task", { resume: ack.agentId });
    const request = await bounded(f.fake.next());
    expect(JSON.stringify(request.context.messages)).toContain("Original canonical native answer");
    expect(JSON.stringify(request.context.messages)).toContain("saved-role-body");
    expect(resumed.name).toBe("Saved review");
    expect(resumed.agentId).toBe(ack.agentId);
    expect(resumed.runId).not.toBe(ack.runId);
    expect(migrated.records[0].sessionId).toBe(saved.sessionId);
    expect(migrated.records[0].sessionFile).toBe(saved.sessionFile);
    request.finish("New run report only");
    await tick();
    expect(migrated.beforeSettle()?.entries[0].content).toEndWith("New run report only");
  } finally { await migrated.shutdown(); }
});

for (const cold of [false, true]) test(`/subagents selects the second duplicate name and opens its read-only ${cold ? "cold" : "live"} native session`, async () => {
  const f = await rootFixture();
  initTheme("dark", false);
  try {
    f.manager.appendMessage({ role: "user", content: "saved root", timestamp: 1 });
    const runner = f.session.extensionRunner!;
    const ctx = { ...runner.createContext(), isIdle: () => false };
    const spawn = runner.getToolDefinition("spawn_subagent")!;
    const first = await spawn.execute("first", { name: "Review authentication", prompt: "FIRST SESSION ONLY", model: "fixture/model", thinking: "high" }, undefined, undefined, ctx);
    const second = await spawn.execute("second", { name: "Review authentication", prompt: "SECOND SESSION ONLY", model: "fixture/model", thinking: "high", role: "worker" }, undefined, undefined, ctx);
    const requests = [await bounded(f.fake.next()), await bounded(f.fake.next())];
    const service = processServices().get(rootIdentity(f.manager))!;
    const records = service.records;
    expect((first.details as any).agent_id).toBe(records[0].id);
    expect((second.details as any).agent_id).toBe(records[1].id);
    expect(records[0].sessionId).not.toBe(records[1].sessionId);
    const selectedSession = { id: records[1].sessionId, file: records[1].sessionFile };
    if (cold) {
      requests.forEach(request => request.finish("finished native session"));
      await tick();
      await service.releaseIdle();
      expect(service.runtime(records[1].id)).toBeUndefined();
    }
    const calls = f.fake.calls();
    let output = "", overlays = 0, selected: string | undefined;
    const inline = new SubagentOverview(service, { requestRender() {}, terminal: { rows: 80 } } as any,
      { fg: (_token: string, text: string) => text, bold: (text: string) => text, getBgAnsi: () => "", style: (text: string) => text } as any,
      { keys: new KeybindingsManager(TUI_KEYBINDINGS) as any, inspect: id => { selected = id; }, leave() {} });
    inline.focused = true;
    const treeOutput = inline.render(240).join("\n");
    inline.handleInput("\x1b[B"); expect(inline.getSelectedAgentId()).toBe(records[1].id); inline.handleInput("\r");
    inline.dispose();
    const ui = {
      ...ctx.ui,
      custom: async (factory: Function) => {
        let result: string | undefined;
        const view = factory({ requestRender() {}, terminal: { rows: 80 } }, { fg: (_token: string, text: string) => text, bold: (text: string) => text, getBgAnsi: () => "", style: (text: string) => text },
          new KeybindingsManager(TUI_KEYBINDINGS), (value: string | undefined) => { result = value; });
        try {
          const rendered = view.render(240).join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
          overlays++; output = rendered;
          view.handleInput("\x0f");
          view.handleInput("\x14");
          view.handleInput("\x1b[H");
          view.render(240);
          view.handleInput("\x1b");
          return result;
        } finally { view.dispose(); }
      },
    };
    await runner.getCommand("subagents")!.handler(selected!, { ...ctx, mode: "tui", ui } as any);
    expect(overlays).toBe(1);
    for (const record of records) expect(treeOutput).toContain(`[${record.id.slice(0, 10)}]`);
    expect(treeOutput).toContain("fixture/model · thinking: off");
    expect(output).toContain(`Subagent Review authentication (${records[1].id})`);
    expect(output).toContain("read-only");
    expect(output).toContain("SECOND SESSION ONLY");
    expect(output).not.toContain("FIRST SESSION ONLY");
    await tick();
    expect(f.fake.calls()).toBe(calls);
    expect(records[1].sessionId).toBe(selectedSession.id);
    expect(records[1].sessionFile).toBe(selectedSession.file);
  } finally { await f.cleanup(); }
});

for (const version of [1, 2, 3, 4]) for (const reason of ["quit", "switch"] as const) test(`v${version} live upgrade requires restart and ${reason} closes the opaque legacy service`, async () => {
  const legacyKey = Symbol.for(`local.pi-subagents.services.v${version}`);
  const globals = globalThis as any;
  const previousLegacy = globals[legacyKey];
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const f = await rootFixture();
  let old: Coordinator | undefined;
  try {
    f.manager.appendMessage({ role: "user", content: "saved root", timestamp: 1 });
    const key = rootIdentity(f.manager);
    const services = processServices();
    expect(services.has(key)).toBe(false);
    old = new Coordinator(new SubagentStore(f.directory, key), f.factory);
    old.attach({ manager: f.manager, idle: () => false, pending: () => false, send: () => {}, error: error => { throw error; } }, f.factory);
    const ack = await old.invoke("legacy active request", { subagent: f.record });
    await bounded(f.fake.next());
    const child = old.runtime(ack.agentId)!;
    const lockPath = join(old.store.directory, "owner.lock");
    const registryPath = join(old.store.directory, "registry.json");
    // A historical registry must not be read/migrated while its old owner is live.
    const historical = JSON.stringify({ version, mustNotBeInterpreted: true });
    writeFileSync(registryPath, historical);
    const lock = readFileSync(lockPath, "utf8");
    const acquire = spyOn(SubagentStore.prototype as any, "acquire");
    let shutdowns = 0;
    const opaque = new Proxy({ shutdown: async () => { shutdowns++; await old!.shutdown(); } }, {
      get(target, field) { if (field !== "shutdown") throw new Error(`Interpreted old live field ${String(field)}`); return target.shutdown; },
    });
    const legacy = new Map([[key, opaque]]);
    globals[legacyKey] = legacy;
    try {
      expect(() => processServices()).toThrow("process restart");
      // Reload loads the new interface against the saved root; activation must fail
      // before a second store/coordinator can acquire the old owner's lock.
      await expect(f.session.reload()).rejects.toThrow("process restart");
      expect(acquire).not.toHaveBeenCalled();
      expect(services.has(key)).toBe(false);
      expect(legacy.get(key)).toBe(opaque);
      expect(shutdowns).toBe(0);
      expect(child.idle).toBe(false);
      expect(readFileSync(lockPath, "utf8")).toBe(lock);
      expect(readFileSync(registryPath, "utf8")).toBe(historical);
      expect(f.fake.calls()).toBe(1);
      await f.session.extensionRunner!.emit({ type: "session_shutdown", reason });
      expect(shutdowns).toBe(1);
      expect(legacy.size).toBe(0);
      expect(child.idle).toBe(true);
      expect(old.runtime(ack.agentId)).toBeUndefined();
      expect(old.store.state.runs[ack.runId].outcome?.status).toBe("interrupted");
      expect(existsSync(lockPath)).toBe(false);
      const reopened = new SubagentStore(f.directory, key);
      reopened.close();
      expect(existsSync(lockPath)).toBe(false);
      await tick();
      expect(f.fake.calls()).toBe(1);
    } finally { acquire.mockRestore(); }
  } finally {
    try { await old?.shutdown(); }
    finally {
      if (previousLegacy === undefined) delete globals[legacyKey]; else globals[legacyKey] = previousLegacy;
      try { await f.cleanup(); }
      finally { if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir; }
    }
  }
});

test("real model tools reject invalid spawn inputs, resume overrides and the old schema without Agent alias", async () => {
  const f = await rootFixture();
  writeFileSync(join(f.directory, "agents/disabled.md"), "---\nname: disabled\nenabled: false\n---\nNever selected");
  const valid = { name: "Review authentication", prompt: "task", model: "fixture/model", thinking: "high" };
  const invalid: { name: string; args: Record<string, unknown>; diagnostic: string }[] = [];
  for (const field of ["name", "model", "thinking"]) {
    const args: Record<string, unknown> = { ...valid }; delete args[field];
    invalid.push({ name: "spawn_subagent", args, diagnostic: field });
  }
  for (const name of ["", "   ", "Review\nsecret", "Review\u0000secret", "Review\u200bsecret", "x".repeat(81)])
    invalid.push({ name: "spawn_subagent", args: { ...valid, name }, diagnostic: "name" });
  invalid.push({ name: "spawn_subagent", args: { ...valid, model: "model" }, diagnostic: "exact" });
  invalid.push({ name: "spawn_subagent", args: { ...valid, thinking: "automatic" }, diagnostic: "thinking" });
  for (const role of ["unknown", "disabled"]) invalid.push({ name: "spawn_subagent", args: { ...valid, role }, diagnostic: "Unknown or disabled role" });
  for (const [field, value] of Object.entries({ name: "Override", model: "fixture/model", thinking: "off", role: "worker" }))
    invalid.push({ name: "resume_subagent", args: { agent_id: "s-missing", prompt: "continue", [field]: value }, diagnostic: field });
  invalid.push({ name: "resume_subagent", args: { specialist_id: "s-old", prompt: "continue" }, diagnostic: "agent_id" });
  invalid.push({ name: "resume_subagent", args: { resume: "s-old", prompt: "continue" }, diagnostic: "agent_id" });
  try {
    expect(f.session.extensionRunner!.getToolDefinition("Agent")).toBeUndefined();
    const rootRun = f.session.prompt("exercise invalid delegation inputs");
    const first = await bounded(f.fake.next());
    const advertised = first.context.messages.flatMap(message => message.role === "system" ? message.toolsAdded ?? [] : []).map(tool => tool.name);
    expect(advertised).toContain("spawn_subagent");
    expect(advertised).not.toContain("Agent");
    first.finish("", "toolUse", invalid.map((entry, index) => ({ type: "toolCall", id: `invalid-${index}`, name: entry.name, arguments: entry.args })));
    const next = await bounded(f.fake.next());
    const results = f.session.messages.filter(message => message.role === "toolResult");
    expect(results).toHaveLength(invalid.length);
    results.forEach((result, index) => {
      expect(result.role === "toolResult" && result.isError).toBe(true);
      expect(JSON.stringify(result).toLowerCase()).toContain(invalid[index].diagnostic.toLowerCase());
    });
    next.finish("invalid inputs rejected");
    await bounded(rootRun);
    const service = processServices().get(rootIdentity(f.manager));
    expect(service?.records ?? []).toHaveLength(0);
    expect(f.fake.calls()).toBe(2);
  } finally { await f.cleanup(); }
});

for (const malformed of [false, true]) test(`invalid unselected role is isolated across native spawn, resume and reload; malformed YAML=${malformed}`, async () => {
  const f = await rootFixture();
  const brokenPath = join(f.directory, "agents/broken.md");
  const invalid = (name: string) => malformed ? `---\nname: ${name}\ndescription: [unfinished\n---\ninvalid-body` : `---\nname: ${name}\nmodel: forbidden\n---\ninvalid-body`;
  writeFileSync(brokenPath, invalid("broken"));
  writeFileSync(join(f.directory, "AGENTS.md"), "native-base-for-role-isolation");
  const warnings: string[] = [];
  let runner = f.session.extensionRunner!;
  runner.setUIContext({ ...runner.getUIContext(), notify: (message, type) => { if (type === "warning") warnings.push(message); } }, "print");
  const call = (tool: string, args: Record<string, unknown>) => runner.getToolDefinition(tool)!.execute("isolation", args, undefined, undefined,
    { ...runner.createContext(), isIdle: () => false });
  try {
    for (let turn = 0; turn < 3; turn++) {
      const rootRun = f.session.prompt("advertise the safe role roster");
      const request = await bounded(f.fake.next());
      const roster = JSON.stringify(request.context.messages).match(/<subagent_roles>[\s\S]*?<\/subagent_roles>/)?.[0];
      expect(roster).toBeDefined();
      expect(roster).toContain("worker:");
      expect(roster).not.toContain("broken");
      request.finish("ready");
      await bounded(rootRun);
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(brokenPath);
    expect(warnings[0]).not.toContain("\n");
    const args = { name: "Independent task", prompt: "native role-free task", model: "fixture/model", thinking: "high" };
    const spawn = await call("spawn_subagent", args);
    const plainAck = spawn.details as any;
    const plainRequest = await bounded(f.fake.next());
    const plainContext = JSON.stringify(plainRequest.context.messages);
    expect(plainContext).toContain("native-base-for-role-isolation");
    expect(plainContext).toContain("native role-free task");
    expect(plainContext).toContain("Return your full final report");
    expect(plainContext).not.toContain("saved-role-body");
    expect(plainContext).not.toContain("invalid-body");
    plainRequest.finish("role-free saved answer");
    await tick();
    const service = processServices().get(rootIdentity(f.manager))!;
    const plain = service.records.find(record => record.id === plainAck.agent_id)!;
    const plainSession = plain.sessionId;
    const runCount = Object.keys(service.store.state.runs).length;
    await expect(call("spawn_subagent", { ...args, role: "broken" })).rejects.toThrow(brokenPath);
    expect(Object.keys(service.store.state.runs)).toHaveLength(runCount);
    expect(service.records).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    const withRole = await call("spawn_subagent", { ...args, name: "Saved template task", role: "worker" });
    const roleAck = withRole.details as any;
    const roleRequest = await bounded(f.fake.next());
    expect(JSON.stringify(roleRequest.context.messages)).toContain("saved-role-body");
    roleRequest.finish("saved template answer");
    await tick();
    const selected = service.records.find(record => record.id === roleAck.agent_id)!;
    const selectedSession = selected.sessionId;
    const acknowledge = () => {
      for (const draft of service.beforeSettle()?.entries ?? []) f.manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
      service.postCommit();
    };
    acknowledge();
    writeFileSync(join(f.directory, "agents/worker.md"), invalid("worker"));
    await f.session.reload();
    runner = f.session.extensionRunner!;
    expect(processServices().get(rootIdentity(f.manager))).toBe(service);
    // Reload/core attach and resume do not discover or warn about current profiles.
    expect(warnings).toHaveLength(1);
    await call("resume_subagent", { agent_id: plainAck.agent_id, prompt: "continue role-free" });
    const plainResume = await bounded(f.fake.next());
    const resumedContext = JSON.stringify(plainResume.context.messages);
    expect(resumedContext).toContain("role-free saved answer");
    expect(resumedContext).not.toContain("saved-role-body");
    expect(resumedContext).not.toContain("invalid-body");
    expect(plain.sessionId).toBe(plainSession);
    expect(plain.role).toBeUndefined();
    plainResume.finish("role-free resumed answer");
    await tick();
    await call("resume_subagent", { agent_id: roleAck.agent_id, prompt: "continue from saved template" });
    const roleResume = await bounded(f.fake.next());
    const savedContext = JSON.stringify(roleResume.context.messages);
    expect(savedContext).toContain("saved template answer");
    expect(savedContext).toContain("saved-role-body");
    expect(savedContext).not.toContain("invalid-body");
    expect(selected.sessionId).toBe(selectedSession);
    expect(selected.role?.body).toBe("saved-role-body");
    roleResume.finish("saved template resumed answer");
    await tick();
    acknowledge();
    expect(Object.values(service.store.state.runs).every(run => run.delivered)).toBe(true);
    expect(warnings).toHaveLength(1);
  } finally { await f.cleanup(); }
});

function spawnCall(name: string, prompt = `${name} task`) {
  return { type: "toolCall" as const, id: `spawn-${name}`, name: "spawn_subagent", arguments: { name, prompt, model: "fixture/model", thinking: "high" } };
}
function hasUser(request: Request, text: string): boolean {
  return request.context.messages.some(message => message.role === "user" &&
    (typeof message.content === "string" ? message.content === text : message.content.some(block => block.type === "text" && block.text === text)));
}
async function splitNested(f: Awaited<ReturnType<typeof rootFixture>>, name: string) {
  const requests = [await bounded(f.fake.next()), await bounded(f.fake.next())];
  const child = requests.find(request => hasUser(request, `${name} task`));
  expect(child).toBeDefined();
  return { child: child!, parent: requests.find(request => request !== child)! };
}
async function waitingTree(configure?: (f: Awaited<ReturnType<typeof rootFixture>>) => void) {
  const f = await rootFixture();
  configure?.(f);
  const delegated = await delegate(f);
  const owner = acknowledgement(f.session);
  delegated.children[0].finish("", "toolUse", [spawnCall("Leaf")]);
  const nested = await splitNested(f, "Leaf");
  const service = processServices().get(rootIdentity(f.manager))!;
  const leaf = service.records.find(record => record.name === "Leaf")!;
  nested.parent.finish("PROVISIONAL PARENT - DO NOT PUBLISH");
  await tick();
  delegated.parent.finish("main yields");
  await bounded(delegated.rootRun);
  expect(service.store.state.runs[owner.runId].phase).toBe("waiting");
  expect(service.store.state.runs[owner.runId].outcome).toBeUndefined();
  return { ...f, service, owner, leaf, request: nested.child };
}

test("two native children hold one parent run through provisional answers and automatic cycles until both reports are processed", async () => {
  const f = await waitingTree();
  try {
    const owner = f.service.records.find(record => record.id === f.owner.agentId)!;
    const ownerRun = f.service.store.state.runs[f.owner.runId];
    const parentSession = (f.service.runtime(owner.id) as any).session as AgentSession;
    const reports = (manager: SessionManager) => manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE);
    const terminals = () => SessionManager.open(owner.sessionFile).getEntries().filter(entry => entry.type === "custom" && entry.customType === TERMINAL_TYPE);
    const assertWaiting = async (calls: number) => {
      await tick(); await tick();
      expect(f.fake.calls()).toBe(calls); // No unsolicited main-model request or extra native cycle.
      expect(owner.currentRun).toBe(f.owner.runId);
      expect(ownerRun.phase).toBe("waiting");
      expect(ownerRun.outcome).toBeUndefined();
      expect(ownerRun.endedAt).toBeUndefined();
      expect(terminals()).toHaveLength(0);
      expect(reports(f.manager)).toHaveLength(0);
      expect(reports(SessionManager.open(f.manager.getSessionFile()!))).toHaveLength(0);
      expect(f.session.messages.some(message => message.role === "custom" && message.customType === REPORT_TYPE)).toBe(false);
      expect(f.service.beforeSettle()?.entries ?? []).toHaveLength(0);
    };
    await assertWaiting(f.fake.calls());

    f.service.steer(owner.id, "spawn a second same-model child");
    const spawning = await bounded(f.fake.next());
    spawning.finish("", "toolUse", [spawnCall("SecondLeaf")]);
    const second = await splitNested(f, "SecondLeaf");
    const secondRecord = f.service.records.find(record => record.name === "SecondLeaf")!;
    const secondRun = f.service.store.state.runs[secondRecord.currentRun!];
    const firstRun = f.service.store.state.runs[f.leaf.currentRun!];
    second.parent.finish("SECOND PRIVATE PROVISIONAL PARENT");
    await assertWaiting(f.fake.calls());
    expect(secondRun.outcome).toBeUndefined();

    f.request.finish("FIRST CHILD FULL REPORT");
    const firstReceiving = await bounded(f.fake.next());
    expect(JSON.stringify(firstReceiving.context)).toContain("FIRST CHILD FULL REPORT");
    firstReceiving.finish("CANONICAL FIRST-CHILD ANSWER - STILL WAITING FOR SECOND");
    await tick();
    await assertWaiting(f.fake.calls());
    expect(firstRun.delivered).toBe(true);
    expect(firstRun.receiptEntryId).toBeDefined();
    expect(firstRun.processedBy?.runId).toBe(f.owner.runId);
    const registry = JSON.parse(readFileSync(join(f.service.store.directory, "registry.json"), "utf8"));
    expect(registry.runs[firstRun.id].processedBy).toEqual(firstRun.processedBy);
    const parentDisk = SessionManager.open(owner.sessionFile);
    const canonical = parentDisk.getEntry(firstRun.processedBy!.assistantEntryId);
    expect(canonical?.type === "message" && canonical.message.role === "assistant" && canonical.message.stopReason).toBe("stop");
    expect(JSON.stringify(canonical)).toContain("CANONICAL FIRST-CHILD ANSWER - STILL WAITING FOR SECOND");
    expect(reports(parentDisk)).toHaveLength(1);
    expect(secondRecord.currentRun).toBe(secondRun.id);
    expect(secondRun.outcome).toBeUndefined();

    f.service.steer(owner.id, "continue waiting without resuming");
    (await bounded(f.fake.next())).finish("THIRD PRIVATE PROVISIONAL PARENT");
    await assertWaiting(f.fake.calls());
    expect(secondRun.outcome).toBeUndefined();
    expect(JSON.stringify(SessionManager.open(owner.sessionFile).getEntries())).toContain("SECOND PRIVATE PROVISIONAL PARENT");

    second.child.finish("SECOND CHILD FULL REPORT");
    const finalReceiving = await bounded(f.fake.next());
    expect(JSON.stringify(finalReceiving.context)).toContain("FIRST CHILD FULL REPORT");
    expect(JSON.stringify(finalReceiving.context)).toContain("SECOND CHILD FULL REPORT");
    expect(owner.currentRun).toBe(f.owner.runId);
    expect(ownerRun.outcome).toBeUndefined();
    expect(reports(f.manager)).toHaveLength(0);
    expect(secondRun.processedBy).toBeUndefined();
    const finalText = `FULL FINAL REVISED PARENT REPORT\n${"both child results synthesized\n".repeat(100)}`;
    finalReceiving.finish(finalText);
    const root = await bounded(f.fake.next());
    expect(secondRun.processedBy?.runId).toBe(f.owner.runId);
    expect(ownerRun.outcome).toMatchObject({ status: "completed", text: finalText });
    expect(ownerRun.phase).toBe("terminal");
    expect(JSON.stringify(root.context)).toContain(finalText.replaceAll("\n", "\\n"));
    for (const privateText of ["PROVISIONAL PARENT - DO NOT PUBLISH", "SECOND PRIVATE PROVISIONAL PARENT", "THIRD PRIVATE PROVISIONAL PARENT", "CANONICAL FIRST-CHILD ANSWER", "FIRST CHILD FULL REPORT", "SECOND CHILD FULL REPORT"]) {
      expect(JSON.stringify(root.context)).not.toContain(privateText);
    }
    root.finish("root processed the single final parent report");
    await bounded(f.session.waitForIdle());
    const calls = f.fake.calls();
    f.service.postCommit(true);
    expect(f.service.beforeSettle()?.entries ?? []).toHaveLength(0);
    f.service.postCommit(true);
    await bounded(f.session.waitForIdle());
    await tick(); await tick();
    expect(f.fake.calls()).toBe(calls);
    expect(Object.values(f.service.store.state.runs).filter(run => run.agentId === owner.id).map(run => run.id)).toEqual([f.owner.runId]); // No explicit resume/new parent run.
    expect(terminals()).toHaveLength(1);
    expect(reports(f.manager)).toHaveLength(1);
    expect(reports(SessionManager.open(f.manager.getSessionFile()!))).toHaveLength(1);
    expect(f.session.messages.filter(message => message.role === "custom" && message.customType === REPORT_TYPE)).toHaveLength(1);
    expect(JSON.stringify(reports(f.manager))).toContain(finalText.replaceAll("\n", "\\n"));
    expect(ownerRun.delivered).toBe(true);
  } finally { await f.cleanup(); }
}, 10000);

test("busy child receives a grandchild report before settlement, processes canonically, and keeps working in the same run", async () => {
  const f = await rootFixture();
  try {
    const delegated = await delegate(f);
    const owner = acknowledgement(f.session);
    delegated.children[0].finish("", "toolUse", [spawnCall("BusyLeaf")]);
    const nested = await splitNested(f, "BusyLeaf");
    const service = processServices().get(rootIdentity(f.manager))!;
    const leaf = service.records.find(record => record.name === "BusyLeaf")!;
    const leafRun = service.store.state.runs[leaf.currentRun!];
    const parentSession = (service.runtime(owner.agentId) as any).session as AgentSession;
    let settlements = 0;
    parentSession.subscribe(event => { if (event.type === "agent_end") settlements++; });
    const full = `PRIVATE GRANDCHILD REPORT\n${"full content\n".repeat(12000)}`;
    nested.child.finish(full);
    await tick();
    expect(leafRun.delivered).toBe(false);
    nested.parent.finish("", "toolUse", [{ type: "toolCall", id: "parent-work", name: "read", arguments: { path: join(f.directory, "settings.json") } }]);
    const receiving = await bounded(f.fake.next());
    expect(settlements).toBe(0);
    expect(JSON.stringify(receiving.context)).toContain(full.replaceAll("\n", "\\n"));
    expect(service.records.find(record => record.id === owner.agentId)!.currentRun).toBe(owner.runId);
    expect(leafRun.delivered).toBe(true);
    expect(leafRun.processedBy).toBeUndefined();
    expect(JSON.parse(readFileSync(join(service.store.directory, "registry.json"), "utf8")).runs[leafRun.id].receiptEntryId).toBe(leafRun.receiptEntryId);
    expect(f.manager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toBe(false);
    receiving.finish("", "toolUse", [{ type: "toolCall", id: "parent-more-work", name: "read", arguments: { path: join(f.directory, "settings.json") } }]);
    const final = await bounded(f.fake.next());
    expect(settlements).toBe(0);
    expect(leafRun.processedBy?.runId).toBe(owner.runId);
    const disk = SessionManager.open(parentSession.sessionFile!);
    const response = disk.getEntry(leafRun.processedBy!.assistantEntryId);
    expect(response?.type === "message" && response.message.role === "assistant" && response.message.stopReason).toBe("toolUse");
    expect(disk.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(1);
    final.finish("PARENT FINAL AFTER MORE WORK");
    await tick();
    delegated.parent.finish("main boundary");
    const root = await bounded(f.fake.next());
    expect(JSON.stringify(root.context)).toContain("PARENT FINAL AFTER MORE WORK");
    expect(JSON.stringify(root.context)).not.toContain("PRIVATE GRANDCHILD REPORT");
    root.finish("main processed");
    await bounded(delegated.rootRun);
    expect(f.fake.calls()).toBe(8);
    expect(f.manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(1);
  } finally { await f.cleanup(); }
}, 10000);

for (const failure of ["error", "aborted", "abort-tools"] as const) test(`busy child ${failure} leaves ready reports unreserved until explicit resume`, async () => {
  const f = await rootFixture();
  try {
    const delegated = await delegate(f);
    const owner = acknowledgement(f.session);
    delegated.children[0].finish("", "toolUse", [spawnCall("FailureLeaf")]);
    const nested = await splitNested(f, "FailureLeaf");
    const service = processServices().get(rootIdentity(f.manager))!;
    const leaf = service.records.find(record => record.name === "FailureLeaf")!;
    const leafRun = service.store.state.runs[leaf.currentRun!];
    const parentSession = (service.runtime(owner.agentId) as any).session as AgentSession;
    nested.child.finish("READY BACKLOG BEFORE PARENT FAILURE");
    await tick();
    if (failure === "abort-tools") {
      parentSession.subscribe(event => { if (event.type === "tool_execution_start") parentSession.agent.abort(); });
      nested.parent.finish("", "toolUse", [{ type: "toolCall", id: "aborted-parent-read", name: "read", arguments: { path: join(f.directory, "settings.json") } }]);
    } else nested.parent.finish("FAILED PARENT", failure);
    await tick();
    expect(failure === "abort-tools" ? ["error", "aborted"] : [failure]).toContain(service.store.state.runs[owner.runId].outcome?.status);
    expect(leafRun.delivered).toBe(false);
    expect(leafRun.processedBy).toBeUndefined();
    expect(parentSession.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(0);
    delegated.parent.finish("root boundary for failure");
    const root = await bounded(f.fake.next());
    expect(JSON.stringify(root.context)).not.toContain("READY BACKLOG BEFORE PARENT FAILURE");
    root.finish("root acknowledges failed child");
    await bounded(delegated.rootRun);
    const calls = f.fake.calls();
    await tick(); await tick();
    expect(f.fake.calls()).toBe(calls);
    const resumed = await service.invoke("explicitly process ready backlog", { resume: owner.agentId });
    const receiving = await bounded(f.fake.next());
    expect(resumed.runId).not.toBe(owner.runId);
    expect(leafRun.receiverRunId).toBe(resumed.runId);
    expect(leafRun.delivered).toBe(true);
    expect(leafRun.processedBy).toBeUndefined();
    expect(JSON.stringify(receiving.context)).toContain("READY BACKLOG BEFORE PARENT FAILURE");
    receiving.finish("RESUMED PARENT SUCCESS");
    (await bounded(f.fake.next())).finish("root acknowledges resumed child");
    await bounded(f.session.waitForIdle());
    expect(leafRun.processedBy?.runId).toBe(resumed.runId);
  } finally { await f.cleanup(); }
}, 10000);

test("busy child receipt fsync failure stops before the receiving provider request", async () => {
  const f = await rootFixture();
  try {
    const delegated = await delegate(f);
    const owner = acknowledgement(f.session);
    delegated.children[0].finish("", "toolUse", [spawnCall("FlushLeaf")]);
    const nested = await splitNested(f, "FlushLeaf");
    const service = processServices().get(rootIdentity(f.manager))!;
    const leaf = service.records.find(record => record.name === "FlushLeaf")!;
    const leafRun = service.store.state.runs[leaf.currentRun!];
    nested.child.finish("FULL REPORT BEFORE FAILED FSYNC");
    await tick();
    const parentSession = (service.runtime(owner.agentId) as any).session as AgentSession;
    const finished = deferred<void>();
    parentSession.subscribe(event => { if (event.type === "agent_settled") finished.resolve(); });
    (service as any).flushRootReceipt = () => { throw new Error("injected busy receiver fsync failure"); };
    const calls = f.fake.calls();
    nested.parent.finish("", "toolUse", [{ type: "toolCall", id: "safe-read", name: "read", arguments: { path: join(f.directory, "settings.json") } }]);
    await bounded(finished.promise);
    expect(f.fake.calls()).toBe(calls);
    expect(leafRun.delivered).toBe(false);
    expect(leafRun.processedBy).toBeUndefined();
    expect(SessionManager.open(parentSession.sessionFile!).getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(service.store.directory, "registry.json"), "utf8")).runs[leafRun.id].delivered).toBe(false);
    delegated.parent.finish("main stops after durability fault");
    await bounded(delegated.rootRun.catch(() => undefined));
  } finally { await f.cleanup(); }
}, 10000);

test("three native levels wait without polling, survive main yield/reload, and report only to immediate parents", async () => {
  const f = await waitingTree();
  const phases: string[] = [];
  const unsubscribe = f.service.subscribe(() => { phases.push(f.service.snapshot().runs[f.owner.runId].phase); });
  try {
    const parentRuntime = f.service.runtime(f.owner.agentId);
    const leafRuntime = f.service.runtime(f.leaf.id);
    const calls = f.fake.calls();
    await tick(); await tick();
    expect(f.fake.calls()).toBe(calls);
    await f.session.reload();
    expect(processServices().get(rootIdentity(f.manager))).toBe(f.service);
    expect(f.service.runtime(f.owner.agentId)).toBe(parentRuntime);
    expect(f.service.runtime(f.leaf.id)).toBe(leafRuntime);
    f.request.finish("", "toolUse", [spawnCall("Deep")]);
    const deep = await splitNested(f, "Deep");
    const deepest = f.service.records.find(record => record.name === "Deep")!;
    deep.parent.finish("PROVISIONAL LEAF");
    await tick();
    expect(f.service.store.state.runs[f.leaf.currentRun!].phase).toBe("waiting");
    expect(f.manager.getEntries().filter(entry => entry.type === "custom_message")).toHaveLength(0);
    deep.child.finish("DEEP FULL REPORT");
    const leafWake = await bounded(f.fake.next());
    expect(JSON.stringify(leafWake.context)).toContain("DEEP FULL REPORT");
    expect(f.service.store.state.runs[f.owner.runId].outcome).toBeUndefined();
    leafWake.finish("LEAF SYNTHESIS");
    const parentWake = await bounded(f.fake.next());
    expect(JSON.stringify(parentWake.context)).toContain("LEAF SYNTHESIS");
    expect(JSON.stringify(parentWake.context)).not.toContain("DEEP FULL REPORT");
    const leafRun = Object.values(f.service.store.state.runs).find(run => run.agentId === f.leaf.id)!;
    expect(leafRun.delivered).toBe(true);
    expect(leafRun.processedBy).toBeUndefined();
    parentWake.finish("PARENT FINAL SYNTHESIS");
    const rootWake = await bounded(f.fake.next());
    expect(JSON.stringify(rootWake.context)).toContain("PARENT FINAL SYNTHESIS");
    expect(JSON.stringify(rootWake.context)).not.toContain("LEAF SYNTHESIS");
    expect(JSON.stringify(rootWake.context)).not.toContain("PROVISIONAL PARENT");
    rootWake.finish("main processed");
    await bounded(f.session.waitForIdle());
    await tick();
    expect(leafRun.processedBy?.runId).toBe(f.owner.runId);
    const deepRun = Object.values(f.service.store.state.runs).find(run => run.agentId === deepest.id)!;
    expect(deepRun.processedBy?.runId).toBe(leafRun.id);
    expect(f.service.store.state.runs[f.owner.runId].phase).toBe("terminal");
    expect(phases).toContain("running");
    expect(phases).toContain("terminal");
    const copy = f.service.snapshot();
    copy.subagents[f.owner.agentId].name = "not live";
    expect(f.service.records.find(record => record.id === f.owner.agentId)!.name).not.toBe("not live");
    expect(f.manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(1);
  } finally { unsubscribe(); await f.cleanup(); }
}, 10000);

test("enabled global and trusted project tools reach all native levels without a second root service", async () => {
  const f = await rootFixture();
  f.session.settingsManager.setProjectTrusted(true);
  const source = (name: string) => `import { Type } from "typebox"; export default pi => pi.registerTool({ name: "${name}", label: "Inherited", description: "Inherited", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) });`;
  mkdirSync(join(f.directory, "extensions"));
  mkdirSync(join(f.directory, ".pi/extensions"), { recursive: true });
  writeFileSync(join(f.directory, "extensions/global.ts"), source("inherited_global"));
  writeFileSync(join(f.directory, ".pi/extensions/project.ts"), source("inherited_project"));
  writeFileSync(join(f.directory, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false },
    packages: [new URL("../", import.meta.url).pathname] }));
  try {
    const delegated = await delegate(f);
    const service = processServices().get(rootIdentity(f.manager))!;
    const rootCount = processServices().size;
    const names = (request: Request) => request.context.messages.flatMap(message => message.role === "system" ? message.toolsAdded ?? [] : []).map(tool => tool.name);
    for (const tool of ["inherited_global", "inherited_project", "spawn_subagent", "resume_subagent", "steer_subagent"]) expect(names(delegated.children[0])).toContain(tool);
    delegated.children[0].finish("", "toolUse", [spawnCall("InheritedLeaf")]);
    const leaf = await splitNested(f, "InheritedLeaf");
    for (const tool of ["inherited_global", "inherited_project", "spawn_subagent", "resume_subagent", "steer_subagent"]) expect(names(leaf.child)).toContain(tool);
    leaf.child.finish("", "toolUse", [spawnCall("InheritedDeep")]);
    const deep = await splitNested(f, "InheritedDeep");
    for (const tool of ["inherited_global", "inherited_project", "spawn_subagent", "resume_subagent", "steer_subagent"]) expect(names(deep.child)).toContain(tool);
    expect(processServices().size).toBe(rootCount);
    expect(service.records).toHaveLength(3);
    deep.parent.finish("wait for deep"); leaf.parent.finish("wait for leaf"); delegated.parent.finish("wait for owner");
    await bounded(delegated.rootRun);
    deep.child.finish("deep report");
    (await bounded(f.fake.next())).finish("leaf report");
    (await bounded(f.fake.next())).finish("owner report");
    (await bounded(f.fake.next())).finish("root consumed");
    await f.session.waitForIdle();
  } finally { await f.cleanup(); }
}, 10000);

test("inherited late provider divergence reports a child error without consuming a descendant report", async () => {
  const f = await waitingTree(f => {
    mkdirSync(join(f.directory, "extensions"));
    writeFileSync(join(f.directory, "extensions/diverge.ts"), `export default pi => pi.on("context", event => {
      if (JSON.stringify(event.messages).includes("GUARD LEAF REPORT")) pi.registerProvider("fixture", { headers: { late: "forbidden" } });
    });`);
  });
  try {
    f.request.finish("GUARD LEAF REPORT");
    const wake = await bounded(f.fake.next());
    const ownerRun = f.service.store.state.runs[f.owner.runId];
    expect(ownerRun.outcome?.status).toBe("error");
    expect(ownerRun.outcome?.diagnostic).toContain("primary model configuration diverged");
    const leafRun = Object.values(f.service.store.state.runs).find(run => run.agentId === f.leaf.id)!;
    expect(leafRun.processedBy).toBeUndefined();
    expect(JSON.stringify(wake.context)).toContain("primary model configuration diverged");
    expect(JSON.stringify(wake.context)).not.toContain("PROVISIONAL PARENT");
    wake.finish("handled owned child error");
    await f.session.waitForIdle();
    expect(f.runtime.getRegisteredProviderConfig("fixture")?.headers).toBeUndefined();
  } finally { await f.cleanup(); }
}, 10000);

test("waiting steering wakes the same logical run, rejects resume and does not publish provisional prose", async () => {
  const f = await waitingTree();
  try {
    await expect(f.service.invoke("wrong", { resume: f.owner.agentId })).rejects.toThrow("steer_subagent");
    f.service.steer(f.owner.agentId, "WAITING GUIDANCE");
    const guided = await bounded(f.fake.next());
    expect(JSON.stringify(guided.context)).toContain("WAITING GUIDANCE");
    expect(f.service.records.find(record => record.id === f.owner.agentId)!.currentRun).toBe(f.owner.runId);
    guided.finish("STILL PROVISIONAL");
    await tick();
    const count = f.fake.calls();
    await tick();
    expect(f.fake.calls()).toBe(count);
    expect(f.service.store.state.runs[f.owner.runId].phase).toBe("waiting");
    f.request.finish("leaf report");
    (await bounded(f.fake.next())).finish("final after guidance and report");
    const root = await bounded(f.fake.next());
    expect(JSON.stringify(root.context)).not.toContain("STILL PROVISIONAL");
    root.finish("done");
    await bounded(f.session.waitForIdle());
  } finally { await f.cleanup(); }
}, 10000);

for (const failure of ["error", "aborted"] as const) for (const cold of [false, true]) test(`parent ${failure} retains descendants and explicit resume adopts ongoing work/backlog; cold=${cold}`, async () => {
  const f = await waitingTree();
  try {
    f.service.steer(f.owner.agentId, "trigger failure");
    (await bounded(f.fake.next())).finish("PARENT FAILURE", failure);
    const root = await bounded(f.fake.next());
    expect(JSON.stringify(root.context)).toContain(f.leaf.id);
    expect(JSON.stringify(root.context)).not.toContain("PROVISIONAL PARENT");
    root.finish("failure received");
    await bounded(f.session.waitForIdle());
    expect(f.service.runtime(f.leaf.id)).toBeDefined();
    const old = f.service.store.state.runs[f.owner.runId];
    expect(old.outcome?.status).toBe(failure);
    expect(f.service.store.state.runs[f.leaf.currentRun!].receiverRunId).toBe(old.id);
    if (cold) {
      expect(f.service.runtime(f.owner.agentId)).toBeUndefined();
      f.request.finish("BACKLOG LEAF REPORT");
      await tick();
      expect(f.fake.calls()).toBe(7);
    }
    const resumed = await f.service.invoke("EXPLICIT RESUME TASK", { resume: f.owner.agentId });
    expect(resumed.runId).not.toBe(old.id);
    const leafRun = Object.values(f.service.store.state.runs).find(run => run.agentId === f.leaf.id)!;
    expect(leafRun.parentRunId).toBe(old.id);
    expect(leafRun.receiverRunId).toBe(resumed.runId);
    const resumedRequest = await bounded(f.fake.next());
    expect(JSON.stringify(resumedRequest.context)).toContain("EXPLICIT RESUME TASK");
    if (cold) expect(JSON.stringify(resumedRequest.context)).toContain("BACKLOG LEAF REPORT");
    else {
      resumedRequest.finish("resume waiting");
      await tick();
      f.request.finish("ONGOING LEAF REPORT");
    }
    const finalRequest = cold ? resumedRequest : await bounded(f.fake.next());
    finalRequest.finish("RESUMED FINAL");
    (await bounded(f.fake.next())).finish("main received final");
    await bounded(f.session.waitForIdle());
    expect(leafRun.processedBy?.runId).toBe(resumed.runId);
    expect(old.outcome?.text).toBe("PARENT FAILURE");
  } finally { await f.cleanup(); }
}, 10000);

test("receipt without a successful subsequent assistant is not consumption; toolUse success is consumption", async () => {
  const f = await waitingTree();
  try {
    f.request.finish("REPORT MUST BE PROCESSED");
    const failed = await bounded(f.fake.next());
    const leafRun = Object.values(f.service.store.state.runs).find(run => run.agentId === f.leaf.id)!;
    expect(leafRun.delivered).toBe(true);
    expect(leafRun.receiptEntryId).toBeString();
    expect(leafRun.processedBy).toBeUndefined();
    failed.finish("", "error");
    (await bounded(f.fake.next())).finish("main saw failure");
    await bounded(f.session.waitForIdle());
    expect(leafRun.processedBy).toBeUndefined();
    const resumed = await f.service.invoke("process backlog", { resume: f.owner.agentId });
    const request = await bounded(f.fake.next());
    expect(JSON.stringify(request.context)).toContain("REPORT MUST BE PROCESSED");
    request.finish("", "toolUse", [{ type: "toolCall", id: "read-missing", name: "read", arguments: { path: join(f.directory, "missing") } }]);
    const next = await bounded(f.fake.next());
    expect(leafRun.processedBy?.runId).toBe(resumed.runId);
    const native = SessionManager.open(f.service.records.find(record => record.id === f.owner.agentId)!.sessionFile);
    const response = native.getEntry(leafRun.processedBy!.assistantEntryId);
    expect(response?.type === "message" && response.message.role === "assistant" && response.message.stopReason).toBe("toolUse");
    expect(native.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(1);
    next.finish("CANONICAL FINAL");
    (await bounded(f.fake.next())).finish("main received");
    await bounded(f.session.waitForIdle());
  } finally { await f.cleanup(); }
}, 10000);

test("compaction removes unprocessed durable report but the next native request restores full content without a second receipt", async () => {
  const f = await waitingTree();
  try {
    f.request.finish("FULL REPORT AFTER COMPACTION");
    const request = await bounded(f.fake.next());
    request.finish("", "error");
    (await bounded(f.fake.next())).finish("main received error");
    await bounded(f.session.waitForIdle());
    const record = f.service.records.find(record => record.id === f.owner.agentId)!;
    const native = SessionManager.open(record.sessionFile);
    const leafRun = Object.values(f.service.store.state.runs).find(run => run.agentId === f.leaf.id)!;
    expect(leafRun.processedBy).toBeUndefined();
    native.appendCompaction("summary deliberately omits report", native.getLeafId()!, 1000);
    expect(JSON.stringify(native.buildSessionProjection().messages)).not.toContain("FULL REPORT AFTER COMPACTION");
    const resumed = await f.service.invoke("continue", { resume: f.owner.agentId });
    const restored = await bounded(f.fake.next());
    expect(JSON.stringify(restored.context)).toContain("FULL REPORT AFTER COMPACTION");
    restored.finish("processed restored report");
    (await bounded(f.fake.next())).finish("main received");
    await bounded(f.session.waitForIdle());
    expect(leafRun.processedBy?.runId).toBe(resumed.runId);
    expect(SessionManager.open(record.sessionFile).getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(1);
  } finally { await f.cleanup(); }
}, 10000);

test("direct-child ownership rejects grandchildren, siblings, ancestors, forged IDs and stale actors before reservation", async () => {
  const f = await waitingTree();
  try {
    const before = Object.keys(f.service.store.state.runs).length;
    for (const id of [f.leaf.id, "s-forged"]) {
      expect(() => f.service.steer(id, "illegal")).toThrow("direct");
      await expect(f.service.invoke("illegal", { resume: id })).rejects.toThrow("direct");
    }
    const leafActor = { agentId: f.leaf.id, runId: f.leaf.currentRun! };
    expect(() => f.service.steer(f.owner.agentId, "ancestor", leafActor)).toThrow("direct");
    expect(() => f.service.steer(f.owner.agentId, "self", f.owner)).toThrow("direct");
    await expect(f.service.invoke("stale", { subagent: { ...f.record, name: "must not reserve" } }, { ...f.owner, runId: "old" })).rejects.toThrow("current run");
    expect(Object.keys(f.service.store.state.runs)).toHaveLength(before);
    // Exercise the same owner check through the native tool bridge, not only the service API.
    f.request.finish("", "toolUse", [{ type: "toolCall", id: "ancestor-control", name: "steer_subagent", arguments: { agent_id: f.owner.agentId, message: "illegal" } }]);
    const rejected = await bounded(f.fake.next());
    expect(JSON.stringify(rejected.context)).toContain("only your own direct children");
    rejected.finish("leaf done");
    (await bounded(f.fake.next())).finish("parent done");
    (await bounded(f.fake.next())).finish("main done");
    await bounded(f.session.waitForIdle());
  } finally { await f.cleanup(); }
}, 10000);

test("shutdown interrupts a waiting parent and active descendant without a native prompt deadlock", async () => {
  const f = await waitingTree();
  await bounded(f.cleanup());
  const state = f.service.snapshot();
  expect(Object.values(state.runs).every(run => run.phase === "terminal" && run.outcome?.status === "interrupted")).toBe(true);
  expect(Object.values(state.subagents).every(record => !record.currentRun)).toBe(true);
  const calls = f.fake.calls();
  const recovered = new Coordinator(new SubagentStore(f.directory, state.rootKey), f.factory);
  expect(f.fake.calls()).toBe(calls);
  expect(Object.values(recovered.store.state.runs).every(run => run.outcome?.status === "interrupted")).toBe(true);
  await recovered.shutdown();
}, 10000);

test("parallel native branches and siblings have independent obligations and recipient mailboxes", async () => {
  const f = await rootFixture();
  try {
    const rootRun = f.session.prompt("parallel branches");
    (await bounded(f.fake.next())).finish("", "toolUse", [spawnCall("A"), spawnCall("B")]);
    const first = [await bounded(f.fake.next()), await bounded(f.fake.next()), await bounded(f.fake.next())];
    const a = first.find(request => hasUser(request, "A task"))!;
    const b = first.find(request => hasUser(request, "B task"))!;
    const root = first.find(request => request !== a && request !== b)!;
    const service = processServices().get(rootIdentity(f.manager))!;
    a.finish("", "toolUse", [spawnCall("A1"), spawnCall("A2")]);
    b.finish("", "toolUse", [spawnCall("B1"), spawnCall("B2")]);
    const second = await Promise.all(Array.from({ length: 6 }, () => bounded(f.fake.next())));
    const leaves = ["A1", "A2", "B1", "B2"].map(name => ({ name, request: second.find(request => hasUser(request, `${name} task`))! }));
    for (const parent of second.filter(request => !leaves.some(leaf => leaf.request === request))) parent.finish("provisional branch");
    await tick();
    const A = service.records.find(record => record.name === "A")!;
    const B = service.records.find(record => record.name === "B")!;
    expect(() => service.owned(B.id, { agentId: A.id, runId: A.currentRun! })).toThrow("direct");
    for (const leaf of leaves) leaf.request.finish(`${leaf.name} PRIVATE REPORT`);
    const wakes = [await bounded(f.fake.next()), await bounded(f.fake.next())];
    for (let wake of wakes) {
      const name = hasUser(wake, "A task") ? "A" : "B";
      const other = name === "A" ? "B" : "A";
      // A sibling may finish just after this cycle's reservation. Its outbox is
      // injected at the next native boundary, not by starting a concurrent native prompt.
      if (!JSON.stringify(wake.context).includes(`${name}2 PRIVATE REPORT`)) {
        wake.finish("first report received; provisional");
        wake = await bounded(f.fake.next());
      }
      const context = JSON.stringify(wake.context);
      expect(context).toContain(`${name}1 PRIVATE REPORT`);
      expect(context).toContain(`${name}2 PRIVATE REPORT`);
      expect(context).not.toContain(`${other}1 PRIVATE REPORT`);
      wake.finish(`${name} BRANCH FINAL`);
    }
    await tick();
    root.finish("yield now");
    const summary = await bounded(f.fake.next());
    const context = JSON.stringify(summary.context);
    expect(context).toContain("A BRANCH FINAL");
    expect(context).toContain("B BRANCH FINAL");
    expect(context).not.toContain("PRIVATE REPORT");
    summary.finish("main processed both");
    await bounded(rootRun);
    expect(Object.values(service.store.state.runs).filter(run => run.processedBy)).toHaveLength(4);
    expect(f.manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(2);
  } finally { await f.cleanup(); }
}, 10000);

for (const failure of ["processing flush", "processing save", "receiver flush"] as const) test(`nested ${failure} failure stops before side effects and recovery never automatically replays`, async () => {
  const f = await waitingTree();
  let closed = false;
  try {
    const originalSave = f.service.store.save.bind(f.service.store);
    const parentRun = f.service.store.state.runs[f.owner.runId];
    const path = join(f.directory, "must-not-execute");
    if (failure === "receiver flush") (f.service as any).flushRootReceipt = () => { throw new Error("injected receiver flush"); };
    f.request.finish("DURABLE NESTED REPORT");
    if (failure !== "receiver flush") {
      const request = await bounded(f.fake.next());
      if (failure === "processing flush") (f.service as any).flushProcessing = () => { throw new Error("injected processing flush"); };
      else f.service.store.save = () => {
        if (Object.values(f.service.store.state.runs).some(run => run.processedBy)) throw new Error("injected processing save");
        originalSave();
      };
      request.finish("", "toolUse", [{ type: "toolCall", id: "side-effect", name: "write", arguments: { path, content: "must not write" } }]);
    }
    await tick(); await tick();
    expect(parentRun.outcome).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    const calls = f.fake.calls();
    await bounded(f.cleanup()); closed = true;
    const recovered = new Coordinator(new SubagentStore(f.directory, f.service.store.rootKey), f.factory);
    expect(f.fake.calls()).toBe(calls);
    expect(existsSync(path)).toBe(false);
    expect(recovered.store.state.runs[f.owner.runId].outcome?.status).toBe("interrupted");
    const children = Object.values(recovered.store.state.runs).filter(run => run.parentId === f.owner.agentId);
    expect(children).toHaveLength(1);
    expect(children[0].outcome?.text).toBe("DURABLE NESTED REPORT");
    expect(children[0].processedBy).toBeUndefined();
    recovered.attach({ manager: f.manager, idle: () => false, pending: () => false, send: () => {}, error: () => {} }, f.factory);
    const drafts = recovered.beforeSettle();
    expect(drafts?.entries).toHaveLength(1);
    expect(drafts?.entries[0].details).toMatchObject({ agentId: f.owner.agentId });
    await recovered.shutdown();
  } finally { if (!closed) await f.cleanup(); }
}, 10000);

test("actual cold registry recovery preserves deep histories and interrupted backlogs until explicit parent resume", async () => {
  const f = await waitingTree();
  let closed = false;
  try {
    const registry = join(f.service.store.directory, "registry.json");
    const before = readFileSync(registry, "utf8");
    const transcripts = f.service.records.map(record => ({ file: record.sessionFile, bytes: readFileSync(record.sessionFile, "utf8") }));
    const rootKey = f.service.store.rootKey;
    const leafRunId = f.leaf.currentRun!;
    const leafSessionId = f.leaf.sessionId;
    await f.cleanup(); closed = true;
    // Recreate the files left by a process disappearing before shutdown markers.
    writeFileSync(registry, before);
    for (const transcript of transcripts) writeFileSync(transcript.file, transcript.bytes);
    const factory = new NativeChildFactory(f.directory, f.runtime, selection => exactModel([{ model: f.model }], selection), [{ model: f.model }]);
    const recovered = new Coordinator(new SubagentStore(f.directory, rootKey), factory);
    const calls = f.fake.calls();
    recovered.attach({ manager: f.manager, idle: () => false, pending: () => false, send: () => {}, error: error => { throw error; } }, factory);
    expect(Object.values(recovered.store.state.runs).every(run => run.outcome?.status === "interrupted")).toBe(true);
    expect(recovered.beforeSettle()?.entries).toHaveLength(1);
    expect(f.fake.calls()).toBe(calls);
    const resumed = await recovered.invoke("RESUME PARENT EXPLICITLY", { resume: f.owner.agentId });
    const request = await bounded(f.fake.next());
    expect(JSON.stringify(request.context)).toContain(f.leaf.id);
    expect(JSON.stringify(request.context)).toContain("interrupted");
    expect(recovered.store.state.runs[leafRunId].receiverRunId).toBe(resumed.runId);
    request.finish("", "toolUse", [{ type: "toolCall", id: "resume-leaf", name: "resume_subagent", arguments: { agent_id: f.leaf.id, prompt: "COLD LEAF RESUME" } }]);
    const requests = [await bounded(f.fake.next()), await bounded(f.fake.next())];
    const leafRequest = requests.find(request => hasUser(request, "COLD LEAF RESUME"))!;
    const parentRequest = requests.find(request => request !== leafRequest)!;
    expect(leafRequest).toBeDefined();
    expect(JSON.stringify(leafRequest.context)).toContain("Leaf task");
    expect(recovered.records.find(record => record.id === f.leaf.id)!.sessionId).toBe(leafSessionId);
    parentRequest.finish("waiting again");
    await tick();
    leafRequest.finish("COLD LEAF COMPLETE");
    (await bounded(f.fake.next())).finish("COLD PARENT COMPLETE");
    await tick();
    expect(recovered.store.state.runs[resumed.runId].outcome?.text).toBe("COLD PARENT COMPLETE");
    expect(Object.values(recovered.store.state.runs).filter(run => run.agentId === f.leaf.id)).toHaveLength(2);
    await recovered.shutdown();
  } finally { if (!closed) await f.cleanup(); }
}, 10000);

test("native settled steering queues safely until the previous prompt promise has resolved", async () => {
  const f = await waitingTree();
  try {
    const native = (f.service.runtime(f.owner.agentId) as any).session as AgentSession;
    const original = native.prompt.bind(native);
    let active = 0, maximum = 0;
    native.prompt = async (...args) => {
      active++; maximum = Math.max(maximum, active);
      try { await original(...args); } finally { active--; }
    };
    const unsubscribe = native.subscribe(event => {
      if (event.type !== "agent_settled") return;
      unsubscribe();
      f.service.steer(f.owner.agentId, "GUIDANCE DURING SETTLED DISPATCH");
    });
    f.service.steer(f.owner.agentId, "first wake");
    (await bounded(f.fake.next())).finish("still provisional");
    const second = await bounded(f.fake.next());
    expect(JSON.stringify(second.context)).toContain("GUIDANCE DURING SETTLED DISPATCH");
    expect(f.service.records.find(record => record.id === f.owner.agentId)!.currentRun).toBe(f.owner.runId);
    second.finish("waiting again");
    await tick();
    expect(f.service.store.state.runs[f.owner.runId].phase).toBe("waiting");
    f.request.finish("leaf done");
    (await bounded(f.fake.next())).finish("parent finally done");
    (await bounded(f.fake.next())).finish("main done");
    await bounded(f.session.waitForIdle());
    expect(maximum).toBe(1);
  } finally { await f.cleanup(); }
}, 10000);

test("current main model roster and optional role context reach deeper children without changing active provider generation", async () => {
  const f = await waitingTree();
  try {
    const previousRuntime = f.service.runtime(f.owner.agentId);
    f.runtime.registerProvider("other", { ...f.fake.config, baseUrl: "https://other-fixture.invalid" });
    await f.runtime.getAvailable();
    f.session.setScopedModels([{ model: f.model }, { model: f.runtime.getModel("other", "model")! }]);
    const update = f.session.prompt("refresh delegation catalogue");
    (await bounded(f.fake.next())).finish("catalogue refreshed");
    await bounded(update);
    f.service.steer(f.owner.agentId, "use the other available model");
    const request = await bounded(f.fake.next());
    expect(request.endpoint).toBe("https://fixture.invalid");
    expect(JSON.stringify(request.context)).toContain("other/model");
    const call = spawnCall("OtherChild");
    request.finish("", "toolUse", [{ ...call, arguments: { ...call.arguments, model: "other/model", role: "worker" } }]);
    const pair = await splitNested(f, "OtherChild");
    expect(pair.child.endpoint).toBe("https://other-fixture.invalid");
    const context = JSON.stringify(pair.child.context);
    expect(context).toContain("saved-role-body");
    expect(context).toContain("fixture/model");
    expect(context).toContain("other/model");
    expect(context).toContain("resume_subagent");
    expect(f.service.runtime(f.owner.agentId)).toBe(previousRuntime);
    pair.parent.finish("waiting on both");
    await tick();
    pair.child.finish("other model result");
    const firstReport = await bounded(f.fake.next());
    expect(firstReport.endpoint).toBe("https://fixture.invalid");
    firstReport.finish("one child remains");
    await tick();
    f.request.finish("original model result");
    (await bounded(f.fake.next())).finish("combined final");
    (await bounded(f.fake.next())).finish("main done");
    await bounded(f.session.waitForIdle());
  } finally { await f.cleanup(); }
}, 10000);

test("a request-local transform that removes a report cannot consume it or cause a waiting request loop", async () => {
  const f = await waitingTree();
  try {
    const native = (f.service.runtime(f.owner.agentId) as any).session as AgentSession;
    const transform = native.agent.transformContext;
    native.agent.transformContext = async (messages, signal) => (await transform?.(messages, signal) ?? messages)
      .filter(message => message.role !== "custom" || message.customType !== REPORT_TYPE);
    f.request.finish("MUST NOT BE CONSUMED");
    const request = await bounded(f.fake.next());
    expect(JSON.stringify(request.context)).not.toContain("MUST NOT BE CONSUMED");
    request.finish("not a valid synthesis");
    const root = await bounded(f.fake.next());
    expect(JSON.stringify(root.context)).toContain("explicit resume is required");
    expect(JSON.stringify(root.context)).not.toContain("not a valid synthesis");
    root.finish("main received failure");
    await bounded(f.session.waitForIdle());
    const leafRun = Object.values(f.service.store.state.runs).find(run => run.agentId === f.leaf.id)!;
    expect(leafRun.processedBy).toBeUndefined();
    const calls = f.fake.calls();
    await tick(); await tick();
    expect(f.fake.calls()).toBe(calls);
  } finally { await f.cleanup(); }
}, 10000);

for (const failure of ["reservation", "terminal marker"] as const) test(`nested ${failure} persistence failure cannot start unreserved work or publish success`, async () => {
  const f = await waitingTree();
  let closed = false;
  try {
    if (failure === "reservation") {
      f.service.steer(f.owner.agentId, "delegate again");
      const request = await bounded(f.fake.next());
      const save = f.service.store.save.bind(f.service.store);
      f.service.store.save = () => {
        if (f.service.records.some(record => record.name === "MustNotStart")) throw new Error("injected reservation failure");
        save();
      };
      const calls = f.fake.calls();
      request.finish("", "toolUse", [spawnCall("MustNotStart")]);
      await tick(); await tick();
      expect(f.fake.calls()).toBe(calls);
      expect(f.service.records.find(record => record.name === "MustNotStart")!.sessionFile).toBe("");
    } else {
      const runtime = f.service.runtime(f.owner.agentId)!;
      runtime.marker = () => { throw new Error("injected terminal marker failure"); };
      f.request.finish("leaf done");
      (await bounded(f.fake.next())).finish("MUST NOT PUBLISH SUCCESS");
      await tick(); await tick();
      expect(f.manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(0);
      expect(f.service.store.state.runs[f.owner.runId].outcome).toBeUndefined();
    }
    await bounded(f.cleanup()); closed = true;
    const calls = f.fake.calls();
    const recovered = new Coordinator(new SubagentStore(f.directory, f.service.store.rootKey), f.factory);
    expect(recovered.store.state.runs[f.owner.runId].outcome?.status).toBe("interrupted");
    expect(recovered.records.some(record => record.name === "MustNotStart")).toBe(false);
    expect(f.fake.calls()).toBe(calls);
    await recovered.shutdown();
  } finally { if (!closed) await f.cleanup(); }
}, 10000);

test("native parent can warm-resume its completed child without ending its own logical run", async () => {
  const f = await waitingTree();
  try {
    const original = f.service.runtime(f.leaf.id);
    const sessionId = f.leaf.sessionId;
    const firstRunId = f.leaf.currentRun!;
    f.request.finish("FIRST LEAF QUESTION");
    const parent = await bounded(f.fake.next());
    parent.finish("", "toolUse", [{ type: "toolCall", id: "answer-leaf", name: "resume_subagent", arguments: { agent_id: f.leaf.id, prompt: "SECOND LEAF TASK" } }]);
    const requests = [await bounded(f.fake.next()), await bounded(f.fake.next())];
    const resumed = requests.find(request => hasUser(request, "SECOND LEAF TASK"))!;
    const parentNext = requests.find(request => request !== resumed)!;
    expect(resumed).toBeDefined();
    expect(JSON.stringify(resumed.context)).toContain("FIRST LEAF QUESTION");
    expect(f.service.runtime(f.leaf.id)).toBe(original);
    expect(f.leaf.sessionId).toBe(sessionId);
    expect(f.leaf.currentRun).not.toBe(firstRunId);
    expect(f.service.store.state.runs[firstRunId].processedBy?.runId).toBe(f.owner.runId);
    expect(f.service.records.find(record => record.id === f.owner.agentId)!.currentRun).toBe(f.owner.runId);
    parentNext.finish("waiting for resumed child");
    await tick();
    resumed.finish("SECOND LEAF ANSWER");
    (await bounded(f.fake.next())).finish("PARENT FINAL AFTER RESUME");
    const root = await bounded(f.fake.next());
    expect(JSON.stringify(root.context)).not.toContain("FIRST LEAF QUESTION");
    root.finish("main received");
    await bounded(f.session.waitForIdle());
    expect(Object.values(f.service.store.state.runs).filter(run => run.agentId === f.leaf.id && run.processedBy?.runId === f.owner.runId)).toHaveLength(2);
  } finally { await f.cleanup(); }
}, 10000);

const reviewMarkers = (manager: SessionManager) => manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === RELEVANT_ACK_TYPE);
function reviewUI(session: AgentSession) {
  let widget: SubagentOverview | undefined, factory: Function | undefined;
  const ui = { ...session.extensionRunner.createContext().ui, setWidget(_key: string, next: Function | undefined) {
    widget?.dispose(); factory = next;
    widget = next?.({ terminal: { rows: 32 }, requestRender() {} }, { fg: (_token: string, text: string) => text, bold: (text: string) => text });
  } };
  return { ui, get widget() { return widget!; }, recreate() {
    widget = factory!({ terminal: { rows: 32 }, requestRender() {} }, { fg: (_token: string, text: string) => text, bold: (text: string) => text });
  } };
}
const consumeReviewInput = (pi: ExtensionAPI) => pi.on("input", event => event.text.startsWith("review-only") ? { action: "handled" } : undefined);
async function completeReviewDelegation(f: Awaited<ReturnType<typeof rootFixture>>) {
  const delegated = await delegate(f);
  delegated.children[0].finish("FULL REVIEW REPORT"); await tick();
  delegated.parent.finish("yield for report");
  (await bounded(f.fake.next())).finish("report processed");
  await bounded(delegated.rootRun);
  return processServices().get(rootIdentity(f.manager))!;
}

for (const source of ["interactive", "rpc"] as const) test(`native ${source} idle submission persists once, hides Relevant, restores on reload and branch switches without model calls`, async () => {
  const f = await rootFixture([], [consumeReviewInput]);
  const view = reviewUI(f.session);
  try {
    await f.session.bindExtensions({ mode: "tui", uiContext: view.ui });
    const service = await completeReviewDelegation(f);
    expect(reviewMarkers(f.manager)).toHaveLength(0); // terminal + agent_settled is reviewable, not acknowledged
    expect(view.widget.render(160).join("\n")).toContain("Review child task");
    const before = f.manager.getLeafId()!, history = JSON.stringify(service.store.state), calls = f.fake.calls();
    await f.session.prompt("review-only next prompt", { source });
    expect(view.widget.render(160)).toEqual([]);
    expect(reviewMarkers(f.manager)).toHaveLength(1);
    expect(acknowledgedRuns(SessionManager.open(f.manager.getSessionFile()!).getBranch())).toEqual(new Set(Object.keys(service.store.state.runs)));
    expect(readFileSync(f.manager.getSessionFile()!, "utf8").split("\n").filter(line => line.includes(RELEVANT_ACK_TYPE))).toHaveLength(1);
    expect(JSON.stringify(f.manager.buildSessionProjection().messages)).not.toContain(RELEVANT_ACK_TYPE);
    expect(JSON.stringify(service.store.state)).toBe(history); // no outcomes, receipts or registry mutation
    await f.session.prompt("review-only again", { source });
    expect(reviewMarkers(f.manager)).toHaveLength(1); expect(f.fake.calls()).toBe(calls);
    view.recreate(); expect(view.widget.render(160)).toEqual([]); expect(view.widget.hasAgents()).toBe(true);
    await f.session.reload(); expect(view.widget.render(160)).toEqual([]); expect(f.fake.calls()).toBe(calls);
    const marker = f.manager.getLeafId()!;
    f.manager.branch(before); await f.session.extensionRunner.emit({ type: "session_tree", newLeafId: before });
    expect(view.widget.render(160).join("\n")).toContain("Review child task");
    f.manager.branch(marker); await f.session.extensionRunner.emit({ type: "session_tree", newLeafId: marker });
    expect(view.widget.render(160)).toEqual([]);
    const retained = f.manager.appendMessage({ role: "user", content: "retained", timestamp: 3 });
    f.manager.appendCompaction("native summary", retained, 100);
    await f.session.reload();
    expect(view.widget.render(160)).toEqual([]); expect(reviewMarkers(f.manager)).toHaveLength(1);
    expect(acknowledgedRuns(SessionManager.open(f.manager.getSessionFile()!).getBranch()).size).toBe(1);
    expect(JSON.stringify(f.manager.buildSessionProjection().messages)).not.toContain("FULL REVIEW REPORT");
    expect(JSON.stringify(service.store.state)).toBe(history); expect(f.fake.calls()).toBe(calls);
  } finally { await f.cleanup(); }
}, 10000);

test("native saved root reopened headlessly restores acknowledgment before optional UI attachment", async () => {
  const f = await rootFixture([], [consumeReviewInput]);
  let cleaned = false, reopened: AgentSession | undefined;
  let previousDir: string | undefined;
  try {
    const service = await completeReviewDelegation(f);
    const ids = new Set(Object.keys(service.store.state.runs));
    await f.session.prompt("review-only save before restart");
    const file = f.manager.getSessionFile()!, calls = f.fake.calls();
    await f.cleanup(); cleaned = true;
    previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = f.directory;
    const settings = SettingsManager.create(f.directory, f.directory, { projectTrusted: false });
    const loader = new DefaultResourceLoader({ cwd: f.directory, agentDir: f.directory, settingsManager: settings,
      noExtensions: true, extensionFactories: [subagents, consumeReviewInput] });
    await loader.reload();
    const manager = SessionManager.open(file);
    ({ session: reopened } = await createAgentSession({ cwd: f.directory, agentDir: f.directory, modelRuntime: f.runtime, model: f.model,
      scopedModels: [{ model: f.model, thinkingLevel: "high" }], resourceLoader: loader, settingsManager: settings, sessionManager: manager }));
    await reopened.bindExtensions({ mode: "print", onError: error => { throw new Error(error.error); } });
    expect(acknowledgedRuns(manager.getBranch())).toEqual(ids);
    await reopened.prompt("review-only headless no-op", { source: "rpc" });
    expect(reviewMarkers(manager)).toHaveLength(1); expect(f.fake.calls()).toBe(calls);
    const view = reviewUI(reopened);
    await reopened.bindExtensions({ mode: "tui", uiContext: view.ui });
    expect(view.widget.render(160)).toEqual([]); expect(view.widget.hasAgents()).toBe(true);
    expect(f.fake.calls()).toBe(calls);
    expect(processServices().get(rootIdentity(manager))!.store.state.runs[[...ids][0]].outcome?.text).toBe("FULL REVIEW REPORT");
  } finally {
    if (reopened) { await reopened.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); reopened.dispose(); }
    if (!cleaned) await f.cleanup();
    if (cleaned) { if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir; }
  }
}, 10000);

for (const streamingBehavior of ["steer", "followUp"] as const) test(`native busy queued ${streamingBehavior} does not acknowledge on submission or consumption`, async () => {
  const f = await rootFixture();
  try {
    const service = await completeReviewDelegation(f);
    const running = f.session.prompt("review busy main", { source: "extension" });
    const request = await bounded(f.fake.next());
    await f.session.prompt("queued review", { streamingBehavior });
    expect(reviewMarkers(f.manager)).toHaveLength(0);
    request.finish("first main response");
    (await bounded(f.fake.next())).finish("queued input consumed");
    await bounded(running); await bounded(f.session.waitForIdle());
    expect(reviewMarkers(f.manager)).toHaveLength(0);
    expect(relevantTree(service.store.state, new Set()).members.size).toBe(1);
    const waking = f.session.sendCustomMessage({ customType: "review-auto-wake", content: "automatic wake", display: false }, { triggerTurn: true });
    (await bounded(f.fake.next())).finish("automatic response"); await bounded(waking); await bounded(f.session.waitForIdle());
    expect(reviewMarkers(f.manager)).toHaveLength(0);
    const extensionInput = f.session.prompt("extension input", { source: "extension" });
    (await bounded(f.fake.next())).finish("extension response"); await bounded(extensionInput);
    expect(reviewMarkers(f.manager)).toHaveLength(0);
  } finally { await f.cleanup(); }
}, 10000);

test("native idle input with running/waiting descendants, including a failed terminal ancestor, retains Relevant", async () => {
  const f = await waitingTree();
  try {
    expect(f.session.extensionRunner.createContext().isIdle()).toBe(true);
    const waiting = f.session.prompt("idle main, busy descendants");
    (await bounded(f.fake.next())).finish("main yields again"); await bounded(waiting);
    expect(reviewMarkers(f.manager)).toHaveLength(0);
    const ownerSession = (f.service.runtime(f.owner.agentId) as any).session as AgentSession;
    f.service.steer(f.owner.agentId, "fail parent while leaf continues");
    (await bounded(f.fake.next())).finish("failed parent", "error");
    (await bounded(f.fake.next())).finish("root saw parent failure"); await bounded(f.session.waitForIdle());
    await bounded(ownerSession.waitForIdle());
    expect(f.service.store.state.runs[f.owner.runId].phase).toBe("terminal");
    expect(f.service.store.state.runs[f.leaf.currentRun!].phase).toBe("running");
    const prompt = f.session.prompt("failed parent still has active leaf");
    (await bounded(f.fake.next())).finish("main idle"); await bounded(prompt);
    expect(reviewMarkers(f.manager)).toHaveLength(0);
    expect(relevantTree(f.service.store.state, new Set()).members.size).toBe(2);
  } finally { await f.cleanup(); }
}, 10000);

test("native sequential A then B in one main run accumulates; acknowledgment hides both and resumed ID reappears", async () => {
  const f = await rootFixture([], [consumeReviewInput]);
  try {
    const view = reviewUI(f.session); await f.session.bindExtensions({ mode: "tui", uiContext: view.ui });
    const delegated = await delegate(f);
    const service = processServices().get(rootIdentity(f.manager))!;
    const first = acknowledgement(f.session);
    delegated.children[0].finish("A complete"); await tick();
    delegated.parent.finish("", "toolUse", [{ ...agentCall, id: "B-call", arguments: { ...agentCall.arguments, name: "Sequential B" } }]);
    const requests = [await bounded(f.fake.next()), await bounded(f.fake.next())];
    const child = requests.find(request => hasUser(request, "child task"))!;
    const root = requests.find(request => request !== child)!;
    expect(Object.values(service.store.state.runs)).toHaveLength(2);
    expect(view.widget.render(160).join("\n")).toContain("Review child task");
    expect(view.widget.render(160).join("\n")).toContain("Sequential B");
    child.finish("B complete"); await tick(); root.finish("yield");
    (await bounded(f.fake.next())).finish("all reports processed"); await bounded(delegated.rootRun);
    const ids = Object.keys(service.store.state.runs);
    expect(reviewMarkers(f.manager)).toHaveLength(0);
    await f.session.prompt("review-only acknowledge all");
    expect(acknowledgedRuns(f.manager.getBranch())).toEqual(new Set(ids));
    expect(view.widget.render(160)).toEqual([]);
    const next = f.session.prompt("resume", { source: "extension" });
    (await bounded(f.fake.next())).finish("", "toolUse", [{ type: "toolCall", id: "resume-review", name: "resume_subagent", arguments: { agent_id: first.agentId, prompt: "resume task" } }]);
    const resumedRequests = [await bounded(f.fake.next()), await bounded(f.fake.next())];
    const resumed = resumedRequests.find(request => hasUser(request, "resume task"))!;
    const parent = resumedRequests.find(request => request !== resumed)!;
    expect(view.widget.render(160).join("\n")).toContain("Review child task");
    expect(view.widget.render(160).join("\n")).not.toContain("Sequential B");
    resumed.finish("resumed full report"); await tick(); parent.finish("yield");
    (await bounded(f.fake.next())).finish("resumed processed"); await bounded(next);
    expect(reviewMarkers(f.manager)).toHaveLength(1);
    expect(f.manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === REPORT_TYPE)).toHaveLength(3);
  } finally { await f.cleanup(); }
}, 10000);

test("native review save failure keeps the display and prompt usable; fresh acknowledgment does not activate services", async () => {
  const f = await rootFixture([], [consumeReviewInput]);
  const view = reviewUI(f.session);
  try {
    await f.session.bindExtensions({ mode: "tui", uiContext: view.ui });
    const calls = f.fake.calls();
    await f.session.prompt("review-only fresh root");
    expect(f.fake.calls()).toBe(calls); expect(reviewMarkers(f.manager)).toHaveLength(0);
    expect(processServices().size).toBe(0);
    await completeReviewDelegation(f);
    const previous = view.widget.render(160), original = f.manager.appendCustomEntry.bind(f.manager);
    const failure = spyOn(f.manager, "appendCustomEntry").mockImplementation((type, data) => {
      if (type === RELEVANT_ACK_TYPE) throw new Error("injected preference write failure");
      return original(type, data);
    });
    try {
      const calls = f.fake.calls();
      await f.session.prompt("review-only failing save");
      expect(view.widget.render(160)).toEqual(previous);
      expect(reviewMarkers(f.manager)).toHaveLength(0); expect(f.fake.calls()).toBe(calls);
    } finally { failure.mockRestore(); }
    await f.session.prompt("review-only retry save");
    expect(view.widget.render(160)).toEqual([]); expect(reviewMarkers(f.manager)).toHaveLength(1);
  } finally { await f.cleanup(); }
}, 10000);

for (const reason of ["switch", "quit"] as const) test(`root TUI overview appears without command, repeated attach stays single, reload reconstructs and ${reason} cleans before awaiting shutdown`, async () => {
  const f = await rootFixture();
  initTheme("dark", false);
  const widgets = new Map<string, SubagentOverview>();
  const installations: SubagentOverview[] = [];
  const ui = { ...f.session.extensionRunner.createContext().ui, setWidget(key: string, factory: Function | undefined) {
    expect(key).toBe("subagents");
    widgets.get(key)?.dispose(); widgets.delete(key);
    if (factory) {
      const component = factory({ terminal: { rows: 32 }, requestRender() {} }, { fg: (_token: string, value: string) => value, bold: (value: string) => value, getBgAnsi: () => "", style: (value: string) => value });
      widgets.set(key, component); installations.push(component);
    }
  } };
  const release = deferred<void>(), entered = deferred<void>();
  let shutdownSpy: ReturnType<typeof spyOn> | undefined;
  let cleaned = false;
  try {
    await f.session.bindExtensions({ mode: "tui", uiContext: ui });
    expect(widgets.size).toBe(0); // Unsaved fresh session attaches only at delegation.
    const { rootRun, children, parent } = await delegate(f, 2);
    const service = processServices().get(rootIdentity(f.manager))!;
    expect(widgets.size).toBe(1); expect(installations).toHaveLength(1);
    const before = installations[0];
    expect(before.render(160).join("\n").match(/[\u2800-\u28ff]/g)).toHaveLength(2);
    expect(f.session.extensionRunner.getMessageRenderer(REPORT_TYPE)).toBeFunction();
    for (const saved of service.records) {
      expect(service.runtime(saved.id)!.source.resolveToolRenderers!("spawn_subagent")!.renderCall).toBeFunction();
      expect(service.runtime(saved.id)!.source.resolveMessageRenderer!(REPORT_TYPE)).toBeFunction();
    }
    parent.finish("main yields"); await bounded(rootRun);
    const calls = f.fake.calls();
    const subscribe = spyOn(service, "subscribe");
    try {
      await f.session.reload();
      expect(installations).toHaveLength(2); expect(widgets.size).toBe(1);
      expect(before.render(160)).toEqual([]);
      expect(installations[1].render(160).join("\n").match(/[\u2800-\u28ff]/g)).toHaveLength(2);
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(f.fake.calls()).toBe(calls); // Presentation never starts a request.
      expect(service.runtime(service.records[0].id)).toBeDefined();
    } finally { subscribe.mockRestore(); }
    const original = service.shutdown.bind(service);
    shutdownSpy = spyOn(service, "shutdown").mockImplementation(async () => { entered.resolve(); await release.promise; await original(); });
    const stopping = f.session.extensionRunner.emit({ type: "session_shutdown", reason });
    await entered.promise;
    expect(widgets.size).toBe(0); expect(installations[1].render(160)).toEqual([]);
    release.resolve(); await bounded(stopping);
    expect(children).toHaveLength(2);
    await f.cleanup(); cleaned = true;
  } finally { release.resolve(); shutdownSpy?.mockRestore(); if (!cleaned) await f.cleanup(); }
}, 10000);
