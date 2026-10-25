import { delimiter, join } from "node:path";
import { getAgentDir, getShellConfig, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { card, completionCard, saveResult, summary } from "./render.ts";
import { ENTRY_TYPE, MESSAGE_TYPE, Runtime, snapshotFrom, type Snapshot } from "./runtime.ts";
import { bashSchema, outputSchema, tasksSchema, killSchema, bashData, stateData, taskData } from "./contracts.ts";

// Versioned, same-process ownership only. Reload replaces bindings, never child processes.
const registryKey = Symbol.for("pi-extensions.background-bash.runtime.v1");
const globals = globalThis as typeof globalThis & { [registryKey]?: Map<string, Runtime> };
const registry = globals[registryKey] ??= new Map<string, Runtime>();
const textResult = (text: string, details?: unknown) => ({ content: [{ type: "text" as const, text }], details });
const tail = (text: string, bytes: number) => Buffer.from(text).subarray(-bytes).toString("utf8");
function resultText(snapshot: Snapshot) {
  const note = snapshot.truncated ? `\n[Output truncated; log: ${snapshot.logPath}${snapshot.bytes > snapshot.logBytes ? " (capped)" : ""}]` : "";
  return `${snapshot.output || "(no output)"}\n\n${summary(snapshot)}${note}${snapshot.error ? `\n${snapshot.error}` : ""}`;
}
function environment(ctx: ExtensionContext, thinkingLevel?: string) {
  const env = { ...process.env };
  const bin = join(getAgentDir(), "bin");
  if (!(env.PATH ?? "").split(delimiter).includes(bin)) env.PATH = [bin, env.PATH].filter(Boolean).join(delimiter);
  for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
  env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
  const file = ctx.sessionManager.getSessionFile();
  if (file) env.PI_SESSION_FILE = file;
  if (ctx.model) { env.PI_PROVIDER = ctx.model.provider; env.PI_MODEL = ctx.model.id; }
  if (thinkingLevel) env.PI_REASONING_LEVEL = thinkingLevel;
  return env;
}

export default function backgroundBash(pi: ExtensionAPI) {
  let runtime: Runtime | undefined;
  let identity: string | undefined;
  let bindingToken = {};
  const restored = new Map<string, Snapshot>();
  const keyFor = (ctx: ExtensionContext) => `${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getSessionFile() ?? "memory"}`;
  const restore = (ctx: ExtensionContext) => {
    restored.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const snapshot = snapshotFrom(entry.data);
      if (snapshot) restored.set(snapshot.toolCallId, snapshot);
    }
  };
  const bind = (ctx: ExtensionContext) => {
    identity = keyFor(ctx);
    runtime = registry.get(identity);
    // Do not create log directories or timers merely by loading the extension.
    restore(ctx);
    const token = bindingToken = {};
    runtime?.bind({
      persist(snapshot) {
        if (token !== bindingToken) return;
        pi.appendEntry(ENTRY_TYPE, snapshot);
        restored.set(snapshot.toolCallId, snapshot);
      },
      notify(snapshot) {
        if (token !== bindingToken) return;
        const compact = { ...snapshot, output: tail(snapshot.output, 8192) };
        pi.sendMessage({ customType: MESSAGE_TYPE, display: true,
          content: `Background bash task completed: ${summary(snapshot)}\nCommand: ${snapshot.command.slice(0, 1024)}\n${compact.output || "(no output)"}\nLog: ${snapshot.logPath}${snapshot.bytes > snapshot.logBytes ? " (capped)" : ""}`,
          details: compact }, { deliverAs: "steer", triggerTurn: true });
      },
    });
  };
  const current = (ctx: ExtensionContext) => {
    if (identity !== keyFor(ctx)) throw new Error("Background bash session is not bound");
    if (!runtime) {
      runtime = new Runtime();
      registry.set(identity, runtime);
      bind(ctx);
    }
    return runtime!;
  };
  pi.on("session_start", (_event, ctx) => bind(ctx));
  pi.on("session_shutdown", async event => {
    if (event.reason === "reload") runtime?.unbind();
    else {
      await runtime?.shutdown();
      if (identity) registry.delete(identity);
    }
    bindingToken = {};
    runtime = undefined;
    identity = undefined;
    restored.clear();
  });
  pi.on("session_tree", async (_event, ctx) => {
    // Navigation has already changed the active branch. Never append old jobs' finals there.
    runtime?.unbind();
    await runtime?.shutdown();
    if (identity) registry.delete(identity);
    bind(ctx);
  });
  pi.registerTool({
    name: "bash", label: "bash", renderShell: "self", outputSchema: bashSchema,
    description: "Execute a bash command in the current working directory. Output is limited to the last 2000 lines or 50KB; disk logs are capped at 16MB. Optional timeout in seconds, with no default deadline. background:true returns a task id immediately. Otherwise commands auto-background after 120 seconds unless timeout is set or the command starts with sleep. waitFor releases the call on a literal output match. Explicit timeouts still apply after backgrounding. Completion arrives automatically; do not poll or sleep to wait for it.",
    promptSnippet: "Execute shell commands, optionally in the background",
    promptGuidelines: ["Use background:true for long-running commands when other work can proceed. Completion is delivered automatically; do not repeatedly poll bash_output to wait.", "You can inspect PI_* environment variables for current model and session details."],
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()),
      background: Type.Optional(Type.Boolean()), waitFor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) }),
    async execute(toolCallId, args, signal, onUpdate, ctx) {
      if (args.background && args.waitFor) throw new Error("Use background or waitFor, not both");
      const settings = pi.getSettings();
      const shell = getShellConfig(SettingsManager.inMemory(settings).getShellPath());
      const command = settings.shellCommandPrefix ? `${settings.shellCommandPrefix}\n${args.command}` : args.command;
      const rt = current(ctx);
      const job = rt.start({ ...args, command, displayCommand: args.command, toolCallId, cwd: ctx.cwd, signal,
        shell: shell.shell, shellArgs: shell.args, env: environment(ctx, ctx.thinkingLevel) });
      onUpdate?.(textResult("", job.snapshot()));
      const snapshot = await job.result;
      if (snapshot.background && snapshot.status === "running") {
        return { ...textResult(`Task ${snapshot.id} is running in the background. Completion will be delivered automatically.\n${snapshot.output || "(no output yet)"}`, snapshot),
          structuredContent: bashData(snapshot, rt.structuredOutput(job)) };
      }
      return { ...textResult(resultText(snapshot), snapshot),
        ...(snapshot.status === "exited" ? { structuredContent: bashData(snapshot, rt.structuredOutput(job)) } : {}),
        isError: snapshot.status !== "exited" || snapshot.exitCode !== 0 };
    },
    renderCall(args, theme, context) {
      const token = bindingToken;
      runtime?.watch(context.toolCallId, context.invalidate);
      const snapshot = runtime?.jobs.get(context.toolCallId)?.snapshot() ?? restored.get(context.toolCallId);
      if (snapshot) context.state.viewSnapshot = snapshot;
      return card(args, theme, context, () => {
        // No retained session context in runtime callbacks, and old cards cannot bind to a new session.
        if (token === bindingToken) {
          const live = runtime?.jobs.get(context.toolCallId);
          if (live) return live.snapshot();
          const saved = restored.get(context.toolCallId);
          if (saved) return saved;
        }
        const fallback = snapshotFrom(context.state.viewSnapshot) ?? snapshotFrom(context.state.snapshot);
        return fallback?.status === "running" ? { ...fallback, status: "unavailable", endedAt: fallback.startedAt } : fallback;
      });
    },
    renderResult(result, _options, _theme, context) {
      context.state.snapshot = snapshotFrom(result.details);
      // The native shell composition lives in the call slot so its background
      // can follow the process, rather than the acknowledgement's core status.
      return saveResult(result, context);
    },
  });
  pi.registerTool({ name: "bash_output", label: "bash output", outputSchema,
    description: "Read one bounded chunk of unread task output. latest:true skips to the newest unread output; filter is a regex applied to this chunk. Reports remaining log bytes. Completion is automatic; do not poll to wait.",
    parameters: Type.Object({ id: Type.String(), latest: Type.Optional(Type.Boolean()), filter: Type.Optional(Type.String()) }),
    async execute(_id, args, signal, _update, ctx) {
      const rt = current(ctx), job = rt.find(args.id);
      const output = await rt.read(job, args.latest, args.filter, signal);
      return { ...textResult(`${output.text || "(no matching unread output)"}\n\n${summary(job.snapshot())}; ${output.remaining} unread log bytes`, job.snapshot()),
        structuredContent: { ...stateData(job), output: output.text, truncated: output.truncated, unread_bytes: output.remaining } };
    },
  });
  pi.registerTool({ name: "bash_tasks", label: "bash tasks", outputSchema: tasksSchema, description: "List this session's bash tasks and their actual process status and runtime.",
    parameters: Type.Object({}), async execute(_id, _args, _signal, _update, ctx) {
      const jobs = [...current(ctx).jobs.values()];
      return { ...textResult(jobs.map(job => { const s = job.snapshot(); return `${summary(s)} | ${s.command.replace(/\s+/g, " ").slice(0, 160)}`; }).join("\n") || "No tasks in this session."),
        structuredContent: { tasks: jobs.map(taskData) } };
    },
  });
  pi.registerTool({ name: "bash_kill", label: "bash kill", outputSchema: killSchema, description: "Stop a task's process group with SIGTERM, then SIGKILL after 3 seconds. Suppresses its automatic completion notification.",
    parameters: Type.Object({ id: Type.String() }), async execute(_id, args, _signal, _update, ctx) {
      const job = current(ctx).find(args.id);
      job.suppressNotification = true;
      const snapshot = await job.stop();
      return { ...textResult(`${resultText(snapshot)}\nGroup cleanup: ${job.killOutcome}`, snapshot),
        structuredContent: { ...taskData(job), outcome: job.killOutcome! } };
    },
  });
  pi.registerShortcut("ctrl+shift+b", { description: "Move all foreground bash calls to background", handler: async (_ctx) => {
    for (const job of runtime?.jobs.values() ?? []) job.promote();
  } });
  pi.registerCommand("bg", { description: "Inspect tasks: /bg [id | kill id]", handler: async (args, ctx) => {
    const [first, second] = args.trim().split(/\s+/);
    const rt = current(ctx);
    try {
      if (first === "kill") {
        const job = rt.find(second);
        job.suppressNotification = true;
        job.killedBy = "killed by user";
        ctx.ui.notify(`${summary(await job.stop())}; group cleanup: ${job.killOutcome}`, "info");
      } else if (first) {
        const s = rt.find(first).snapshot();
        ctx.ui.notify(`${summary(s)}\n${s.command}\nLog: ${s.logPath}\n${tail(s.output, 2048)}`, "info");
      } else ctx.ui.notify([...rt.jobs.values()].map(j => summary(j.snapshot())).join("\n") || "No tasks in this session.", "info");
    } catch (error) { ctx.ui.notify(String(error), "error"); }
  } });
  pi.registerMessageRenderer(MESSAGE_TYPE, (message, { expanded }, theme) => {
    const snapshot = snapshotFrom(message.details);
    return snapshot ? completionCard(snapshot, expanded, theme, pi.getSettings().outputPad === 0 ? 0 : 1) : undefined;
  });
}
