import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Exercise the installed host, including its loader, validation, hooks, and nested-call accounting.
let host = process.env.PI_TOOL_REPLAY_HOST;
if (!host) {
  let directory = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
  while (directory !== dirname(directory)) {
    try {
      if (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") {
        host = directory;
        break;
      }
    } catch {}
    directory = dirname(directory);
  }
}
if (!host) throw new Error("Install Pi on PATH or set PI_TOOL_REPLAY_HOST to its package directory");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(join(host, "dist/index.js"));
const { createAssistantMessageEventStream } = await import(join(host, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { Type } = await import(join(host, "node_modules/typebox/build/index.mjs"));
const packagePath = resolve(import.meta.dir, "..");
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const toolUsage = { ...zeroUsage, input: 7, totalTokens: 7 };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

type Call = { name: string; arguments: Record<string, unknown> };
async function fixture(options: { directory?: string; manager?: any; requireExtra?: boolean } = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "pi-tool-replay-"));
  if (!options.directory) cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" });
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
  let planned: Call[] = [];
  let sequence = 0;
  runtime.registerProvider("replay-fixture", {
    api: "replay-fixture", baseUrl: "https://fixture.invalid", apiKey: "fixture",
    models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"], cost: zeroUsage.cost, contextWindow: 1000000, maxTokens: 10000 }],
    streamSimple(model: any) {
      const content: any[] = planned.length ? [{ type: "text", text: "Calling tools" },
        ...planned.map(call => ({ type: "toolCall", id: `call-${++sequence}`, ...call }))] : [];
      planned = [];
      const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: zeroUsage, stopReason: content.length ? "toolUse" : "stop", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, stopReason: "pending" } });
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    },
  });
  await runtime.getAvailable();
  const model = runtime.getModel("replay-fixture", "model");
  const executed: any[] = [], nestedEvents: any[] = [], updates: any[] = [], ended: any[] = [];
  const control = { block: false, mutation: "", abort: false };
  let api: any;
  const definition = (name: string, exposure = "direct") => ({
    name, label: name, description: "Fixture", exposure,
    parameters: Type.Object({ text: Type.String(), nested: Type.Object({ value: Type.Number() }), ...(options.requireExtra ? { extra: Type.String() } : {}) }),
    outputSchema: Type.Object({ text: Type.String() }),
    async execute(_id: string, args: any, signal: AbortSignal, onUpdate: any) {
      executed.push(structuredClone(args));
      if (control.abort) {
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("cancelled fixture");
      }
      if (args.text === "throw") throw new Error("fixture failure");
      onUpdate?.({ content: [{ type: "text", text: "partial" }], details: { partial: true }, usage: toolUsage });
      return { content: [{ type: "text", text: args.text }, { type: "image", mimeType: "image/png", data: "" }],
        details: { nested: args.nested }, structuredContent: { text: args.text }, usage: toolUsage, isError: args.text === "error" };
    },
  });
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [packagePath],
    extensionFactories: [(pi: any) => {
      api = pi;
      pi.registerTool(definition("fixture"));
      pi.registerTool(definition("model_only", "model-only"));
      pi.registerTool(definition("hidden", "hidden"));
      pi.registerTool({ name: "orchestrator", label: "Orchestrator", description: "Fixture", exposure: "model-only", parameters: Type.Object({}),
        execute: async (_id: string, _args: any, signal: AbortSignal, _update: any, ctx: any) =>
          (await ctx.executeTool("fixture", { text: "nested", nested: { value: 1 } }, { signal })).result });
      pi.on("tool_call", (event: any) => {
        if (event.toolName === "fixture" && control.block) return { block: true, reason: "permission denied" };
        if (event.toolName === "fixture" && control.mutation) event.input.text = control.mutation;
      });
      pi.on("tool_result", (event: any) => { if (event.parentToolCallId) nestedEvents.push(event); });
      pi.on("tool_execution_update", (event: any) => updates.push(event));
      pi.on("tool_execution_end", (event: any) => ended.push(event));
    }],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const manager = options.manager ?? SessionManager.create(directory, join(directory, "sessions"));
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model,
    resourceLoader: loader, settingsManager: settings, sessionManager: manager });
  await session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(error.error); } });
  session.agent.toolExecution = "parallel";
  cleanups.push(() => session.dispose());
  async function invoke(calls: Call[]) {
    planned = calls;
    const before = manager.getEntries().length;
    await session.prompt("Run fixture calls");
    return manager.getEntries().slice(before).filter((entry: any) => entry.type === "message" && entry.message.role === "toolResult").map((entry: any) => entry.message);
  }
  const replay = (handle: string) => invoke([{ name: "replay_tool", arguments: { handle } }]).then(results => results[0]);
  return { directory, session, manager, executed, control, api, nestedEvents, updates, ended, invoke, replay };
}
const call = (text: string, value: unknown = 1): Call => ({ name: "fixture", arguments: { text, nested: { value } } });
const handleOf = (result: any) => result.content.at(-1).text.match(/^\[Replay handle: (r[1-9a-z][0-9a-z]*)\]$/)?.[1];
const records = (manager: any) => manager.getEntries().filter((entry: any) => entry.type === "custom" && entry.customType === "tool-replay.handle");
const textOf = (result: any) => result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");

test("replays exact raw arguments and rich results, preserves handles/errors, and counts nested usage once", async () => {
  const f = await fixture();
  const args = call("long original argument ".repeat(200), "2");
  const [original] = await f.invoke([args]);
  const handle = handleOf(original);
  expect(handle).toBe("r1");
  expect(f.ended[0].result.structuredContent).toEqual({ text: args.arguments.text });
  expect(original.details).toEqual({ nested: { value: 2 } });
  const originalCall = f.manager.getEntries().find((entry: any) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((block: any) => block.type === "toolCall"));
  expect(originalCall.message.content[1].arguments).toEqual(args.arguments); // Host validation does not mutate raw history.
  expect(records(f.manager)[0].data.callIndex).toBe(1);
  expect(f.api.getAllTools().find((tool: any) => tool.name === "replay_tool").exposure).toBe("model-only");
  const replayed = await f.replay(handle);
  expect(f.executed).toEqual([{ text: args.arguments.text, nested: { value: 2 } }, { text: args.arguments.text, nested: { value: 2 } }]);
  expect(replayed.content).toEqual(original.content);
  expect(replayed.details).toEqual(original.details);
  expect(f.ended.find(event => event.toolName === "replay_tool").result.structuredContent).toEqual({ text: args.arguments.text });
  expect(replayed.usage.totalTokens).toBe(7);
  expect(replayed.nestedCalls.calls).toHaveLength(1);
  expect(records(f.manager)).toHaveLength(1);
  expect(f.nestedEvents[0].input).toEqual(f.executed[1]);
  const outerUpdate = f.updates.find(event => event.toolName === "replay_tool");
  expect(outerUpdate.partialResult.usage).toBeUndefined();
  for (const text of ["throw", "error"]) {
    const [failed] = await f.invoke([call(text)]);
    expect(failed.isError).toBe(true);
    const repeated = await f.replay(handleOf(failed));
    expect(repeated.isError).toBe(true);
    expect(textOf(repeated)).toBe(textOf(failed));
  }
});

test("current permission hooks, argument hooks, availability, validation, and cancellation still apply", async () => {
  const f = await fixture();
  const [original] = await f.invoke([call("original")]);
  f.control.block = true;
  const blocked = await f.replay("r1");
  expect(blocked.isError).toBe(true);
  expect(textOf(blocked)).toContain("permission denied");
  expect(f.executed).toHaveLength(1);
  f.control.block = false;
  f.control.mutation = "current hook";
  expect(textOf(await f.replay("r1"))).toContain("current hook");
  expect(f.executed.at(-1).text).toBe("current hook");
  f.api.setActiveTools(["replay_tool"]);
  expect(textOf(await f.replay("r1"))).toContain("not callable");
  f.api.setActiveTools(["fixture", "replay_tool"]);
  const reloaded = await fixture({ directory: f.directory, manager: SessionManager.open(f.manager.getSessionFile()), requireExtra: true });
  const invalid = await reloaded.replay(handleOf(original));
  expect(invalid.isError).toBe(true);
  expect(textOf(invalid)).toContain("extra");
  expect(reloaded.executed).toHaveLength(0);
  f.control.abort = true;
  const running = f.replay("r1");
  while (f.executed.length < 3) await new Promise(resolve => setImmediate(resolve));
  await f.session.abort();
  await running;
  expect(f.nestedEvents.at(-1).isError).toBe(true);
});

test("durable branch-local handles survive reopen, compaction, and fork; parallel calls never reuse numbers", async () => {
  const f = await fixture();
  const originals = await f.invoke(Array.from({ length: 36 }, (_, index) => call(`call ${index}`)));
  expect(new Set(originals.map(handleOf)).size).toBe(36);
  expect(originals.map(handleOf)).toContain("rz");
  expect(originals.map(handleOf)).toContain("r10");
  expect(Object.keys(records(f.manager)[0].data).sort()).toEqual(["assistantEntryId", "callIndex", "cwd", "handle", "version"]);
  const keptLeaf = f.manager.getLeafId();
  await f.invoke([call("abandoned")]);
  const abandonedLeaf = f.manager.getLeafId();
  f.manager.branch(keptLeaf);
  await f.session.extensionRunner.emit({ type: "session_tree", newLeafId: keptLeaf, oldLeafId: abandonedLeaf });
  expect((await f.replay("r11")).isError).toBe(true);
  expect(handleOf((await f.invoke([call("new branch")]))[0])).toBe("r12");
  f.manager.appendCompaction("summary", f.manager.getLeafId(), 100);
  const reopened = await fixture({ directory: f.directory, manager: SessionManager.open(f.manager.getSessionFile()) });
  expect(textOf(await reopened.replay("r1"))).toContain("call 0");
  expect((await reopened.replay("r11")).isError).toBe(true);
  const forkFile = reopened.manager.createBranchedSession(reopened.manager.getLeafId());
  const forked = await fixture({ directory: f.directory, manager: SessionManager.open(forkFile) });
  expect(textOf(await forked.replay("r1"))).toContain("call 0");
  expect((await forked.replay("r11")).isError).toBe(true);
});

test("rejects malformed, missing, wrong-cwd, off-branch, and recursive sources; excludes unsupported/nested calls", async () => {
  const f = await fixture();
  await f.invoke([{ name: "model_only", arguments: { text: "model-only", nested: { value: 1 } } },
    { name: "orchestrator", arguments: {} }, { name: "hidden", arguments: { text: "hidden", nested: { value: 1 } } }]);
  expect(records(f.manager)).toHaveLength(0);
  for (const handle of ["r0", "R1", "r01", "r?", "r1\n", "r1"]) expect((await f.replay(handle)).isError).toBe(true);
  await f.invoke([call("source")]);
  const source = records(f.manager)[0].data;
  const inject = (handle: string, changes: any) => f.manager.appendCustomEntry("tool-replay.handle", { ...source, handle, ...changes });
  inject("r2", { assistantEntryId: "missing" });
  inject("r3", { cwd: "/different" });
  inject("r4", { callIndex: 999 });
  const replayEntry = f.manager.getEntries().find((entry: any) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((block: any) => block.name === "replay_tool"));
  inject("r5", { assistantEntryId: replayEntry.id, callIndex: 1 });
  for (const handle of ["r2", "r3", "r4", "r5"]) expect((await f.replay(handle)).isError).toBe(true);
  // Even without a session_tree event, incremental indexing detects ancestry changes.
  const before = f.manager.getEntries().find((entry: any) => entry.type === "message" && entry.message.role === "user").id;
  f.manager.branch(before);
  expect((await f.replay("r1")).isError).toBe(true);
  expect(handleOf((await f.invoke([call("new source")]))[0])).toBe("r6");
});
