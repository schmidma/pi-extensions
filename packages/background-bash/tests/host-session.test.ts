import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createAgentSession, createCodemodeExtension, CustomMessageComponent, DefaultResourceLoader,
  initTheme, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { findPiHost, resolveHostPackage } from "../../../tests/pi-host.mjs";
import { ENTRY_TYPE, MESSAGE_TYPE } from "../extensions/background-bash/runtime.ts";
const host = findPiHost("PI_BACKGROUND_BASH_HOST");
const { createAssistantMessageEventStream } = await import(resolveHostPackage(host, "@earendil-works/pi-ai").entry!);
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
beforeAll(() => initTheme("dark", false));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const directory = mkdtempSync("/var/tmp/pi-background-bash-host-");
  const stateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = directory;
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false },
    cacheWarming: "off", defaultTools: ["+codemode"] });
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
  let planned: { name: string; arguments: Record<string, unknown> }[] = [];
  let sequence = 0;
  const requests: any[] = [], events: any[] = [], displayed: string[] = [], results: any[] = [];
  let hold: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const gates: ReturnType<typeof deferred>[] = [];
  runtime.registerProvider("background-fixture", {
    api: "background-fixture", baseUrl: "https://fixture.invalid", apiKey: "fixture",
    models: [{ id: "local", name: "Local fixture", reasoning: false, input: ["text"], cost: zero.cost, contextWindow: 1000000, maxTokens: 10000 }],
    streamSimple(model: any, context: any) {
      requests.push(structuredClone(context.messages));
      const calls = planned;
      planned = [];
      const gate = !calls.length ? hold : undefined;
      if (gate) { hold = undefined; gate.entered.resolve(); }
      const content = calls.map(call => ({ type: "toolCall", id: `host-${++sequence}`, ...call }));
      const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: zero, stopReason: content.length ? "toolUse" : "stop", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, stopReason: "pending" } });
      const finish = () => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); };
      if (gate) void gate.release.promise.then(finish); else finish();
      return stream;
    },
  });
  await runtime.getAvailable();
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [resolve(import.meta.dir, "..")], extensionFactories: [createCodemodeExtension({ mode: "on" })] });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const manager = SessionManager.inMemory(directory);
  const finalized = deferred<any>(), delivered = deferred<any>();
  const append = manager.appendCustomEntry.bind(manager);
  manager.appendCustomEntry = (type: string, data: any) => {
    const id = append(type, data);
    if (type === ENTRY_TYPE) finalized.resolve(data);
    return id;
  };
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime,
    model: runtime.getModel("background-fixture", "local"), settingsManager: settings, resourceLoader: loader, sessionManager: manager });
  await session.bindExtensions({ mode: "print", onError: error => { throw new Error(error.error); } });
  session.subscribe(event => {
    events.push(event);
    if (event.type === "tool_execution_end") results.push(event);
    if (event.type === "message_start" && event.message.role === "custom" && event.message.customType === MESSAGE_TYPE) {
      // Use the same delivery event and real component as the interactive transcript, not sendMessage().
      const component = new CustomMessageComponent(event.message, session.extensionRunner!.getMessageRenderer(MESSAGE_TYPE));
      displayed.push(stripVTControlCharacters(component.render(120).join("\n")));
      delivered.resolve(event.message);
    }
  });
  cleanups.push(async () => {
    for (const gate of gates) gate.resolve();
    await session.abort();
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    if (stateHome === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = stateHome;
    rmSync(directory, { recursive: true, force: true });
  });
  return { session, manager, directory, requests, events, displayed, results, finalized, delivered,
    holdFollowup() { hold = { entered: deferred(), release: deferred() }; gates.push(hold.release); return hold; },
    invoke(calls: typeof planned) { planned = calls; return session.prompt("Run local fixture tools"); } };
}

test("actual codemode receives structured bash and companion values, including nonzero exits", async () => {
  const f = await fixture();
  const code = `
const fg = await tools.bash({command: "printf structured; exit 7"});
const large = await tools.bash(${JSON.stringify({ command: "head -c 70000 /dev/zero | tr '\\0' x" })});
const bg = await tools.bash({command: "sleep 30", background: true});
const tasks = await tools.bash_tasks({});
const output = await tools.bash_output({id: bg.task_id});
const killed = await tools.bash_kill({id: bg.task_id});
return JSON.stringify({fg, large: {length: large.output.length, truncated: large.truncated}, bg, tasks, output, killed});`;
  await f.invoke([{ name: "codemode", arguments: { code } }]);
  const result = f.results.find(event => event.toolName === "codemode");
  expect(result.isError).toBe(false);
  const text = result.result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
  const data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  expect(data.fg).toMatchObject({ output: "structured", exit_code: 7, truncated: false });
  expect(typeof data.fg.wall_time_seconds).toBe("number");
  expect(data.large).toEqual({ length: 70000, truncated: false });
  expect(typeof data.bg.task_id).toBe("string");
  expect(data.bg.exit_code).toBeUndefined();
  expect(data.tasks.tasks.find((task: any) => task.task_id === data.bg.task_id)).toMatchObject({ state: "running", command: "sleep 30" });
  expect(data.output).toMatchObject({ task_id: data.bg.task_id, state: "running", output: "", unread_bytes: 0, truncated: false });
  expect(data.killed).toMatchObject({ task_id: data.bg.task_id, state: "killed", reason: "killed by agent", outcome: "killed" });
  expect(f.results.find(event => event.toolName === "bash" && event.result.structuredContent?.exit_code === 7).isError).toBe(true);
  expect(f.displayed).toEqual([]);
});

test("codemode rejects a foreground timeout even when the shell traps TERM and exits zero", async () => {
  const f = await fixture();
  const args = { command: "trap 'exit 0' TERM; sleep 30", timeout: .1 };
  await f.invoke([{ name: "codemode", arguments: { code: `await tools.bash(${JSON.stringify(args)}); return "unexpected success";` } }]);
  const bash = f.results.find(event => event.toolName === "bash");
  expect(bash.isError).toBe(true);
  expect(bash.result.details).toMatchObject({ status: "timeout", exitCode: 0 });
  expect(bash.result.structuredContent).toBeUndefined();
  const script = f.results.find(event => event.toolName === "codemode");
  expect(script.isError).toBe(true);
  const text = script.result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
  expect(text).toContain("timeout");
  expect(text).not.toContain("unexpected success");
});

test("real queued completions are not displayed until consumption; idle completion automatically starts a turn", async () => {
  for (const busy of [true, false]) {
    const f = await fixture();
    const gate = busy ? f.holdFollowup() : undefined;
    const path = join(f.directory, "release");
    const command = `while [ ! -f '${path}' ]; do sleep .01; done; printf completed`;
    const run = f.invoke([{ name: "bash", arguments: { command, background: true, timeout: 5 } }]);
    if (gate) await gate.entered.promise; else await run;
    const requestsBefore = f.requests.length;
    writeFileSync(path, "release");
    await f.finalized.promise;
    if (busy) {
      expect(f.displayed).toEqual([]);
      expect(f.session.messages.some((message: any) => message.customType === MESSAGE_TYPE)).toBe(false);
      expect(f.manager.getBranch().some((entry: any) => entry.type === "custom_message" && entry.customType === MESSAGE_TYPE)).toBe(false);
      gate!.release.resolve();
    }
    await f.delivered.promise;
    await run;
    await f.session.waitForIdle();
    expect(f.displayed).toHaveLength(1);
    expect(f.displayed[0]).toContain("completion delivered");
    expect(f.displayed[0]).not.toContain("completed"); // No duplicated output block while collapsed.
    expect(f.requests.length).toBeGreaterThan(requestsBefore);
    expect(JSON.stringify(f.requests.at(-1))).toContain("Background bash task completed");
    expect(f.events.filter(event => event.type === "message_end" && event.message.customType === MESSAGE_TYPE)).toHaveLength(1);
    expect(f.manager.getBranch().filter((entry: any) => entry.type === "custom_message" && entry.customType === MESSAGE_TYPE)).toHaveLength(1);
  }
});
