import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DefaultPackageManager, DefaultResourceLoader, ModelRuntime, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { childSettings, ROOT_EXTENSION_PATH } from "../extensions/subagents/child-settings.ts";
import { childProvider } from "../extensions/subagents/child-provider.ts";
import { NativeChildFactory, type ChildHooks, type ChildRuntime } from "../extensions/subagents/runner.ts";
import { exactModel } from "../extensions/subagents/configuration.ts";
import type { RunRecord, SubagentRecord } from "../extensions/subagents/state.ts";
import { processServices } from "../extensions/subagents/coordinator.ts";

const directories: string[] = [];
const children: ChildRuntime[] = [];
const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => { throw new Error("Network forbidden in inheritance tests"); }) as typeof fetch; });
afterAll(() => { globalThis.fetch = originalFetch; });
afterEach(async () => {
  for (const child of children.splice(0)) await child.shutdown();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temp() { const path = mkdtempSync(join(tmpdir(), "pi-child-inheritance-")); directories.push(path); return path; }
function put(path: string, content: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function json(path: string, value: unknown) { put(path, JSON.stringify(value)); }
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost };
const toolSource = (name: string) => `import { Type } from "typebox";
export default pi => { pi.appendEntry; pi.registerTool({ name: ${JSON.stringify(name)}, label: "Fixture", description: "Inherited fixture", parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  renderCall: () => ({ render: () => ["inherited renderer"], invalidate() {} }) });
  pi.on("session_start", () => pi.appendEntry(${JSON.stringify(name + "-start")}, {})); };`;
async function fixture(global: object = {}, project: object = {}) {
  const directory = temp(), agentDir = join(directory, "agent"), cwd = join(directory, "project");
  json(join(agentDir, "settings.json"), { retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "idle", ...global });
  json(join(cwd, ".pi/settings.json"), project);
  const calls: any[] = [];
  const config = { api: "inheritance-fixture", baseUrl: "https://root.invalid", apiKey: "not-a-credential", headers: { "root-header": "root" },
    models: [{ id: "model", name: "Offline", reasoning: false, input: ["text" as const], cost, contextWindow: 1000000, maxTokens: 10000 }],
    streamSimple(model: any, context: any, options: any) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "offline answer" }], api: model.api,
        provider: model.provider, model: model.id, stopReason: "stop", usage, timestamp: Date.now() };
      queueMicrotask(async () => {
        try {
          const payload = await options?.onPayload?.({ fixture: true }, model);
          calls.push({ model, context, options, payload });
          stream.push({ type: "done", reason: "stop", message });
        } catch (error) {
          stream.push({ type: "error", reason: "error", error: { ...message, content: [], stopReason: "error", errorMessage: String(error) } });
        } finally { stream.end(); }
      });
      return stream;
    } };
  const root = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  root.registerProvider("fixture", config);
  const model = root.getPhysicalModel("fixture", "model")!;
  const models = [{ model }];
  const factory = new NativeChildFactory(agentDir, root, selection => exactModel(models, selection), models);
  const record: SubagentRecord = { id: "s-inherit", parentId: "root", name: "Inheritance", cwd, projectTrusted: true,
    model: "fixture/model", requestedThinking: "off", effectiveThinking: "off", sessionId: "", sessionFile: "", generation: 1 };
  async function create(overrides: Partial<SubagentRecord> = {}, hooks?: ChildHooks, resume = false) {
    Object.assign(record, overrides);
    const child = await factory.create(record, join(directory, "children"), resume, hooks);
    children.push(child); return child;
  }
  return { directory, agentDir, cwd, root, config, model, models, factory, record, calls, create };
}
function session(child: ChildRuntime): AgentSession { return (child as any).session; }
function run(child: ChildRuntime, prompt = "offline task") {
  return child.run({ id: "i-inherit", agentId: "s-inherit", parentId: "root", parentRunId: null, receiverRunId: null,
    phase: "running", generation: 1, prompt, boundary: child.boundary, startedAt: new Date().toISOString(), delivered: false } satisfies RunRecord);
}

for (const trusted of [true, false]) test(`normal global/project extension, skill and settings inheritance; trusted=${trusted}`, async () => {
  const f = await fixture({ defaultTools: ["-bash", "+grep"] }, { defaultTools: ["+ls"] });
  put(join(f.agentDir, "extensions/global.ts"), toolSource("global_tool"));
  const initialized = join(f.directory, "project-initialized");
  put(join(f.cwd, ".pi/extensions/project.ts"), `import { writeFileSync } from "node:fs";\n${toolSource("project_tool").replace("export default pi => {", `export default pi => { writeFileSync(${JSON.stringify(initialized)}, "initialized");`)}`);
  put(join(f.cwd, ".pi/skills/project/SKILL.md"), "---\nname: project\ndescription: project-skill-description\n---\nProject skill");
  const globalBytes = readFileSync(join(f.agentDir, "settings.json"), "utf8"), projectBytes = readFileSync(join(f.cwd, ".pi/settings.json"), "utf8");
  let child = await f.create({ projectTrusted: trusted });
  for (const mode of ["fresh", "warm", "cold"] as const) {
    if (mode === "cold") { await child.shutdown(); child = await f.create({}, undefined, true); }
    const s = session(child);
    expect(existsSync(initialized)).toBe(trusted);
    expect(s.getActiveToolNames().sort()).toEqual(["read", "edit", "write", "grep", "global_tool", ...(trusted ? ["ls", "project_tool"] : [])].sort());
    expect(s.sessionManager.getEntries().some((entry: any) => entry.customType === "project_tool-start")).toBe(trusted);
    expect(child.source.resolveToolRenderers?.("global_tool")?.renderCall).toBeFunction();
    expect((await run(child, mode)).status).toBe("completed");
    expect(JSON.stringify(f.calls.at(-1).context).includes("project-skill-description")).toBe(trusted);
    expect(s.settingsManager.getCacheWarmingMode()).toBe("off");
    s.settingsManager.setDefaultProvider("private-write");
    await s.settingsManager.flush();
    await s.resourceLoader.reload();
    expect(s.settingsManager.getCacheWarmingMode()).toBe("off");
  }
  expect(readFileSync(join(f.agentDir, "settings.json"), "utf8")).toBe(globalBytes);
  expect(readFileSync(join(f.cwd, ".pi/settings.json"), "utf8")).toBe(projectBytes);
});

for (const scope of ["global", "project"] as const)
for (const route of ["string-package", "object-package", "top-level", "autoload", "symlink-package", "symlink-top-level", "symlink-autoload"] as const) test(`root entry excluded before native extension loading: ${scope}/${route}`, async () => {
  const f = await fixture();
  const settingsDirectory = scope === "global" ? f.agentDir : join(f.cwd, ".pi");
  const packageRoot = join(f.directory, "package");
  const alias = join(packageRoot, "alias.ts");
  json(join(packageRoot, "package.json"), { pi: { extensions: [route.startsWith("symlink") ? "alias.ts" : ROOT_EXTENSION_PATH, "safe.ts"] } });
  symlinkSync(ROOT_EXTENSION_PATH, alias);
  put(join(packageRoot, "safe.ts"), toolSource("package_safe"));
  let settings: object;
  if (route === "top-level") settings = { extensions: [ROOT_EXTENSION_PATH] };
  else if (route === "symlink-top-level") settings = { extensions: [alias] };
  else if (route === "autoload" || route === "symlink-autoload") {
    mkdirSync(join(settingsDirectory, "extensions"), { recursive: true });
    symlinkSync(route === "autoload" ? dirname(ROOT_EXTENSION_PATH) : ROOT_EXTENSION_PATH, join(settingsDirectory, "extensions", route === "autoload" ? "subagents" : "alias.ts"));
    settings = {};
  } else settings = { packages: [route === "object-package" ? { source: packageRoot, skills: [], extensions: ["*"] } : packageRoot] };
  json(join(settingsDirectory, "settings.json"), settings);
  const before = readFileSync(join(settingsDirectory, "settings.json"), "utf8");
  const privateSettings = await childSettings(f.cwd, f.agentDir, true);
  const resolved = await new DefaultPackageManager({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: privateSettings }).resolve();
  expect(resolved.extensions.filter(resource => resource.enabled).map(resource => resource.path)).not.toContain(ROOT_EXTENSION_PATH);
  expect(resolved.extensions.find(resource => resource.path === alias)?.enabled ?? false).toBe(false);
  const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: privateSettings });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  expect(loader.getExtensions().extensions.every(extension => !extension.tools.has("spawn_subagent"))).toBe(true);
  const roots = processServices().size;
  const child = await f.create();
  expect(processServices().size).toBe(roots);
  expect(session(child).extensionRunner.getRegisteredCommands().some(command => command.name === "subagents")).toBe(false);
  expect(readFileSync(join(settingsDirectory, "settings.json"), "utf8")).toBe(before);
});

for (const scope of ["global", "project"] as const)
for (const target of ["direct", "symlink"] as const)
for (const pathForm of ["absolute", "relative", "tilde"] as const)
for (const object of [false, true]) test(`file package root factory never loads: ${scope}/${target}/${pathForm}/${object ? "object" : "string"}`, async () => {
  const f = await fixture();
  const base = scope === "global" ? f.agentDir : join(f.cwd, ".pi");
  const alias = join(base, "root-file.ts");
  symlinkSync(ROOT_EXTENSION_PATH, alias);
  const file = target === "direct" ? ROOT_EXTENSION_PATH : alias;
  const source = pathForm === "absolute" ? file : pathForm === "relative" ? `./${relative(base, file)}` : `~/${relative(homedir(), file)}`;
  const initialized = join(f.directory, "initialized");
  const safeFactory = (name: string) => `import { appendFileSync } from "node:fs"; export default () => appendFileSync(${JSON.stringify(initialized)}, "${name}\\n");`;
  const unrelated = join(base, "unrelated.ts");
  put(unrelated, safeFactory("file"));
  const pack = join(base, "resources");
  json(join(pack, "package.json"), { pi: { extensions: [ROOT_EXTENSION_PATH, "safe.ts"], skills: ["skill"] } });
  put(join(pack, "safe.ts"), safeFactory("directory"));
  put(join(pack, "skill/SKILL.md"), "---\nname: retained\ndescription: retained-directory-skill\n---\nPreserved skill");
  const directoryPackage = { source: "./resources", extensions: ["*"], skills: ["skill"], prompts: [] };
  json(join(base, "settings.json"), { packages: [object ? { source, extensions: [] } : source, "./unrelated.ts", directoryPackage] });
  // The same raw relative source in the other scope can name an unrelated file.
  // Removing a source by spelling across both scopes would incorrectly drop it.
  const otherBase = scope === "global" ? join(f.cwd, ".pi") : f.agentDir;
  const other = join(otherBase, "root-file.ts");
  put(other, safeFactory("other-scope"));
  json(join(otherBase, "settings.json"), { packages: ["./root-file.ts"] });
  const bytes = [base, otherBase].map(path => readFileSync(join(path, "settings.json"), "utf8"));
  const privateSettings = await childSettings(f.cwd, f.agentDir, true);
  const scoped = scope === "global" ? privateSettings.getGlobalSettings() : privateSettings.getProjectSettings();
  expect(scoped.packages!.map(entry => typeof entry === "string" ? entry : entry.source)).toEqual(["./unrelated.ts", "./resources"]);
  expect(scoped.packages![1]).toMatchObject({ ...directoryPackage, extensions: expect.arrayContaining(["*"]) });
  const manager = new DefaultPackageManager({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: privateSettings });
  expect((await manager.resolve()).extensions.filter(resource => resource.enabled).map(resource => resource.path).sort())
    .toEqual([unrelated, join(pack, "safe.ts"), other].sort());
  expect(existsSync(initialized)).toBe(false); // Discovery ran no factories.
  const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: privateSettings });
  for (let reload = 0; reload < 2; reload++) {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    // No extensionsOverride/tool filtering: these are the factories the native
    // loader actually initialized, not a filtered active-tool view.
    expect(loader.getExtensions().extensions.map(extension => extension.path).sort()).toEqual([unrelated, join(pack, "safe.ts"), other].sort());
    expect(readFileSync(initialized, "utf8").trim().split("\n").sort())
      .toEqual(Array.from({ length: reload + 1 }, () => ["file", "directory", "other-scope"]).flat().sort());
    expect(loader.getSkills().skills.some(skill => skill.description === "retained-directory-skill")).toBe(true);
  }
  expect([base, otherBase].map(path => readFileSync(join(path, "settings.json"), "utf8"))).toEqual(bytes);
});

for (const filter of [[], ["first.ts"], ["!second.ts"], ["+first.ts"], undefined] as const) test(`package filters and autoload remain native: ${JSON.stringify(filter)}`, async () => {
  const f = await fixture();
  const pack = join(f.directory, "filtered");
  json(join(pack, "package.json"), { pi: { extensions: ["first.ts", "second.ts"] } });
  put(join(pack, "first.ts"), toolSource("first")); put(join(pack, "second.ts"), toolSource("second"));
  json(join(f.agentDir, "settings.json"), { packages: [{ source: pack, extensions: filter, skills: [], prompts: ["one.md"] }] });
  const child = await f.create();
  const expected = filter === undefined || filter[0] === "+first.ts" ? ["first", "second"] : filter.length ? ["first"] : [];
  expect(session(child).getActiveToolNames().filter(name => ["first", "second"].includes(name)).sort()).toEqual(expected);
  const entry = session(child).settingsManager.getGlobalSettings().packages![0] as any;
  expect(entry.skills).toEqual([]); expect(entry.prompts).toEqual(["one.md"]);
  json(join(f.cwd, ".pi/settings.json"), { packages: [{ source: pack, autoload: false, extensions: ["-first.ts", "+second.ts"] }] });
  const delta = await f.create();
  expect(session(delta).getActiveToolNames()).not.toContain("first");
  expect(session(delta).getActiveToolNames()).toContain("second");
});

const dynamicSource = `import { Type } from "typebox";
export default pi => {
 const tool = (name, exposure = "direct") => ({ name, label: name, description: name, exposure, parameters: Type.Object({}),
   execute: async () => ({ content: [{type: "text", text: name}], details: {} }) });
 for (const exposure of ["direct", "model-only", "codemode", "deferred", "hidden"]) pi.registerTool(tool("exposure_" + exposure, exposure));
 pi.registerTool(tool("web_search", "deferred"));
 pi.registerTool(tool("ask_user_question", "model-only"));
 pi.registerTool({ ...tool("web_enable", "model-only"), execute: async () => {
   pi.setActiveTools([...pi.getActiveTools(), "web_search", "ask_user_question", "exposure_hidden"]);
   pi.registerTool(tool("ask_user_question"));
   return { content: [{type: "text", text: "enabled"}], details: { enabled: true } };
 } });
 pi.on("session_start", (_event, ctx) => {
   if (ctx.sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "web_enable"))
     pi.setActiveTools([...pi.getActiveTools(), "web_search", "ask_user_question"]);
 });
};`;
test("native exposure, dynamic enable/history restoration and permanent parent-only question exclusion", async () => {
  const f = await fixture({ defaultTools: [] });
  put(join(f.agentDir, "extensions/dynamic.ts"), dynamicSource);
  let child = await f.create();
  let s = session(child);
  expect(s.getActiveToolNames().sort()).toEqual(["exposure_direct", "exposure_model-only", "web_enable"].sort());
  const context = s.extensionRunner.createToolContext("enable", undefined);
  expect(context.tools.map(tool => tool.name).sort()).toEqual(["exposure_direct", "exposure_codemode", "exposure_deferred", "web_search"].sort());
  expect((await context.executeTool("ask_user_question", {})).isError).toBe(true);
  const enabled = await s.extensionRunner.getToolDefinition("web_enable")!.execute("enable", {}, undefined, undefined, context);
  expect(s.getActiveToolNames()).toContain("web_search");
  expect(s.getActiveToolNames()).not.toContain("ask_user_question");
  expect(s.getActiveToolNames()).not.toContain("exposure_hidden");
  expect(s.getAllTools().some(tool => tool.name === "ask_user_question")).toBe(false);
  expect((await s.extensionRunner.createToolContext("late", undefined).executeTool("ask_user_question", {})).isError).toBe(true);
  s.sessionManager.appendMessage({ role: "toolResult", toolCallId: "enable", toolName: "web_enable", ...enabled, isError: false, timestamp: Date.now() });
  expect((await run(child)).status).toBe("completed");
  await child.shutdown();
  child = await f.create({}, undefined, true); s = session(child);
  expect(s.getActiveToolNames()).toContain("web_search");
  expect(s.getActiveToolNames()).not.toContain("ask_user_question");
});

const conflictSource = `export default pi => {
  const conflict = () => pi.registerProvider("fixture", { api: "inheritance-fixture", baseUrl: "https://child.invalid", headers: { "child-only": "bad" },
    streamSimple: () => { throw new Error("Child callback must never dispatch"); } });
  conflict(); pi.on("session_start", conflict);
  pi.registerProvider("extra", { api: "extra", apiKey: "offline", baseUrl: "https://extra.invalid", models: [{ id: "extra", name: "extra", reasoning: false,
    input: ["text"], cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:100000,maxTokens:1000 }], streamSimple() { throw new Error("unused auxiliary"); } });
};`;
test("each child owns providers; root callbacks and headers replace startup merges while extra providers stay out of delegation scope", async () => {
  const f = await fixture();
  put(join(f.agentDir, "extensions/providers.ts"), conflictSource);
  const first = await f.create(), second = await f.create();
  const a = session(first).extensionRunner.createContext(), b = session(second).extensionRunner.createContext();
  expect(a.modelRegistry).not.toBe(b.modelRegistry);
  expect(a.modelRegistry.getRegisteredProviderConfig("fixture")).toEqual(f.config);
  expect(a.modelRegistry.getRegisteredProviderConfig("fixture")?.streamSimple).toBe(f.config.streamSimple);
  expect(a.modelRegistry.getRegisteredProviderConfig("fixture")?.headers).toEqual({ "root-header": "root" });
  expect(a.modelRegistry.find("extra", "extra")).toBeDefined();
  expect(a.scopedModels).toEqual(f.models);
  expect(() => exactModel(f.factory.models!, "extra/extra")).toThrow("eligible");
  a.modelRegistry.registerProvider("fixture", { headers: { "late": "bad" } });
  expect(b.modelRegistry.getRegisteredProviderConfig("fixture")).toEqual(f.config);
  expect(f.root.getRegisteredProviderConfig("fixture")).toEqual(f.config);
  const failure = await run(first);
  expect(failure.status).toBe("error"); expect(failure.diagnostic).toContain("primary model configuration diverged");
  expect(f.calls).toHaveLength(0);
  expect((await run(second)).status).toBe("completed"); expect(f.calls).toHaveLength(1);
  expect(f.calls[0].model.baseUrl).toBe("https://root.invalid");
});

test("root native provider identity survives conflicting inherited legacy registrations", async () => {
  const f = await fixture();
  const native = f.root.getProvider("fixture")!;
  f.root.registerNativeProvider(native);
  put(join(f.agentDir, "extensions/providers.ts"), conflictSource);
  const child = await f.create();
  const registry = session(child).extensionRunner.createContext().modelRegistry;
  expect(registry.getRegisteredNativeProvider("fixture")).toBe(native);
  expect(registry.getRegisteredProviderConfig("fixture")).toBeUndefined();
  expect((await run(child)).status).toBe("completed"); expect(f.calls).toHaveLength(1);
  expect(f.root.getRegisteredNativeProvider("fixture")).toBe(native);
});

for (const event of ["before_agent_start", "context", "context_with_system", "before_provider_request"] as const) test(`late provider changes in inherited ${event} fail closed before provider dispatch`, async () => {
  const f = await fixture();
  put(join(f.agentDir, "extensions/late.ts"), `export default pi => pi.on(${JSON.stringify(event)}, () => { pi.registerProvider("fixture", { headers: { late: "bad" } }); });`);
  const child = await f.create();
  const result = await run(child);
  expect(result.status).toBe("error"); expect(result.text).toBe("");
  expect(result.diagnostic).toContain("primary model configuration diverged"); expect(f.calls).toHaveLength(0);
  expect(f.root.getRegisteredProviderConfig("fixture")).toEqual(f.config);
});

test("root built-in provider override is removed even without an explicit root registration", async () => {
  const f = await fixture();
  const selected = f.root.getModels().find(model => model.provider === "openai")!;
  expect(selected).toBeDefined(); expect(f.root.getRegisteredProviderConfig("openai")).toBeUndefined();
  const child = await childProvider(f.root, f.agentDir, selected);
  child.runtime.registerProvider("openai", { baseUrl: "https://wrong.invalid", headers: { wrong: "bad" } });
  const fakeSession = { model: child.runtime.getModel("openai", selected.id), agent: { state: { model: selected } } } as any;
  Object.defineProperty(fakeSession, "model", { get: () => fakeSession.agent.state.model });
  child.restore(fakeSession);
  expect(child.runtime.getRegisteredProviderConfig("openai")).toBeUndefined();
  expect(child.runtime.getPhysicalModel("openai", selected.id)).toEqual(selected);
  child.check(fakeSession.model);
});

for (const mode of ["compatible-payload", "changed-selection", "changed-callback"] as const) test(`inherited primary request behavior: ${mode}`, async () => {
  const f = await fixture();
  put(join(f.agentDir, "extensions/request.ts"), mode === "compatible-payload"
    ? `export default pi => pi.on("before_provider_request", event => ({ ...event.payload, inherited: true }));`
    : mode === "changed-selection"
      ? `export default pi => { pi.registerProvider("extra", { ...${JSON.stringify(f.config)}, streamSimple() { throw new Error("wrong selection"); } });
          pi.on("before_agent_start", async (_event, ctx) => { await pi.setModel(ctx.modelRegistry.find("extra", "model")); }); };`
      : `export default pi => pi.on("before_agent_start", () => pi.registerProvider("fixture", { api: "inheritance-fixture", streamSimple() { throw new Error("wrong callback"); } }));`);
  let processed = 0;
  const report = { id: "report", content: "canonical report" };
  const hooks: ChildHooks = { register() {}, beforeSettle: () => [], postCommit() {}, processed() { processed++; },
    prepare(messages) { return { messages: [...messages, { role: "user", content: report.content, timestamp: 1 }], reports: [report] }; } };
  const child = await f.create({}, hooks);
  const outcome = await run(child);
  if (mode === "compatible-payload") {
    expect(outcome.status).toBe("completed"); expect(f.calls[0].payload).toEqual({ fixture: true, inherited: true }); expect(processed).toBe(1);
  } else {
    expect(outcome.status).toBe("error"); expect(outcome.diagnostic).toContain("primary model configuration diverged");
    expect(f.calls).toHaveLength(0); expect(processed).toBe(0);
  }
});

for (const mode of ["throw", "switch-model"] as const) test(`failed inherited startup cleans session resources and preserves the root: ${mode}`, async () => {
  const f = await fixture();
  const closed = join(f.directory, "shutdown");
  put(join(f.agentDir, "extensions/startup.ts"), `import { writeFileSync } from "node:fs";
    export default pi => {
      pi.registerProvider("extra", { ...${JSON.stringify(f.config)}, streamSimple() { throw new Error("unused"); } });
      pi.on("session_start", async (_event, ctx) => {
        ${mode === "throw" ? 'throw new Error("startup failed");' : 'await pi.setModel(ctx.modelRegistry.find("extra", "model"));'}
      });
      pi.on("session_shutdown", () => writeFileSync(${JSON.stringify(closed)}, "closed"));
    };`);
  await expect(f.create()).rejects.toThrow(mode === "throw" ? "startup failed" : "primary model configuration diverged");
  expect(readFileSync(closed, "utf8")).toBe("closed");
  expect(f.root.getRegisteredProviderConfig("extra")).toBeUndefined();
  expect(f.root.getRegisteredProviderConfig("fixture")).toEqual(f.config);
  expect(f.calls).toHaveLength(0);
});

const installedWeb = join(homedir(), ".pi/agent/npm/node_modules/pi-web-access");
test.skipIf(!existsSync(join(installedWeb, "package.json")))("installed pi-web-access dynamic activation and cold restoration, offline disposable settings", async () => {
  const f = await fixture({ packages: [join(dirname(ROOT_EXTENSION_PATH), "../.."), installedWeb] });
  json(join(f.agentDir, "web-search.json"), { toolActivation: "dynamic" });
  put(join(f.agentDir, "extensions/safe.ts"), toolSource("safe_actual_inheritance"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  let child: ChildRuntime | undefined;
  try {
    child = await f.create();
    let s = session(child);
    expect(s.resourceLoader.getExtensions().errors).toEqual([]);
    expect(s.getActiveToolNames()).toContain("web_enable");
    expect(s.getActiveToolNames()).not.toContain("web_search");
    const result = await s.extensionRunner.getToolDefinition("web_enable")!.execute("enable-web", {}, undefined, undefined, s.extensionRunner.createToolContext("enable-web", undefined));
    expect(result.isError).not.toBe(true);
    for (const name of ["web_search", "source_check", "fetch_content", "get_search_content"]) {
      expect(s.getActiveToolNames()).toContain(name);
      expect(s.getAllTools().find(tool => tool.name === name)?.parameters).toBeDefined();
    }
    expect(s.getActiveToolNames()).toContain("safe_actual_inheritance");
    expect((await run(child)).status).toBe("completed"); // Fake model only, records the new tool declarations.
    await child.shutdown();
    child = await f.create({}, undefined, true); s = session(child);
    expect(s.getActiveToolNames()).toContain("web_search");
    expect(s.getActiveToolNames()).toContain("fetch_content");
    expect(s.getActiveToolNames()).not.toContain("ask_user_question");
  } finally {
    await child?.shutdown();
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
  }
}, 20000);
