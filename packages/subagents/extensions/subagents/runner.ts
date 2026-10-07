import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession, type ModelRuntime, type ExtensionAPI, type ExtensionError, type CustomMessageEntryDraft } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EligibleModel } from "./configuration.ts";
import { childSettings } from "./child-settings.ts";
import { childProvider } from "./child-provider.ts";
import type { ParentBinding } from "./delivery.ts";
import { readChildEntries } from "./store.ts";
import { TERMINAL_TYPE, type RunRecord, type Outcome, type SubagentRecord } from "./state.ts";
import { AgentSessionSource, type TranscriptSource } from "./source.ts";

export interface ChildHooks {
  register(pi: ExtensionAPI): void;
  beforeSettle(outcome: "completed" | "aborted" | "error"): CustomMessageEntryDraft[];
  postCommit(): void;
  prepare(messages: AgentMessage[]): { messages: AgentMessage[]; reports: { id: string; content: string }[] };
  processed(reportIds: string[], assistantEntryId: string): void;
}
export interface ChildRuntime {
  readonly source: TranscriptSource;
  readonly idle: boolean;
  readonly boundary: string | null;
  readonly binding?: ParentBinding;
  run(run: RunRecord): Promise<Outcome>;
  continueCycle?(run: RunRecord, entries: CustomMessageEntryDraft[], guidance: string[]): Promise<Outcome>;
  steer(message: string): boolean | void;
  abort?(): void;
  marker(runId: string, outcome: Outcome): void;
  shutdown(): Promise<void>;
}
export interface ChildRuntimeFactory {
  readonly configurationKey?: object;
  readonly agentDir?: string;
  readonly models?: EligibleModel[];
  create(record: SubagentRecord, directory: string, resume: boolean, hooks?: ChildHooks): Promise<ChildRuntime>;
}
// Native defaults are selected by SettingsManager, not an execution allowlist.
export const CHILD_TOOLS = ["read", "bash", "edit", "write"];
export class NativeChildFactory implements ChildRuntimeFactory {
  constructor(readonly agentDir: string, private runtime: ModelRuntime, private model: (selection: string) => Model<any>, readonly models?: EligibleModel[]) {}
  get configurationKey(): object { return this.runtime; }
  async create(record: SubagentRecord, directory: string, resume: boolean, hooks?: ChildHooks): Promise<ChildRuntime> {
    let manager: SessionManager;
    if (resume) {
      readChildEntries(record);
      manager = SessionManager.open(record.sessionFile, directory, record.cwd);
    } else {
      manager = SessionManager.create(record.cwd, directory);
      // Persist the native header so preflight failures also have a native transcript.
      const fd = openSync(manager.getSessionFile()!, "wx", 0o600);
      try { writeFileSync(fd, `${JSON.stringify(manager.getHeader())}\n`); fsyncSync(fd); }
      finally { closeSync(fd); }
      manager = SessionManager.open(manager.getSessionFile()!, directory, record.cwd);
      record.sessionFile = manager.getSessionFile()!;
      record.sessionId = manager.getSessionId();
    }
    const settings = await childSettings(record.cwd, this.agentDir, record.projectTrusted);
    const provider = await childProvider(this.runtime, this.agentDir, this.model(record.model));
    let activity: "completed" | "aborted" | "error" = "completed";
    const loader = new DefaultResourceLoader({
      cwd: record.cwd, agentDir: this.agentDir, settingsManager: settings,
      extensionFactories: [pi => {
        pi.on("before_agent_start", event => {
          const instructions = `${record.role ? `${record.role.body}\n\n` : ""}You are a subagent. Return your full final report, question, or blocker as ordinary assistant prose to your immediate parent.`;
          if (record.role?.promptMode === "replace") event.systemPromptOptions.customPrompt = instructions;
          else event.systemPromptOptions.appendSystemPrompt += `\n\n${instructions}`;
        });
        hooks?.register(pi);
        pi.on("turn_end", (event, ctx) => {
          if (event.message.role !== "assistant" || !["stop", "toolUse"].includes(event.message.stopReason) || ctx.signal?.aborted) return;
          const entries = hooks?.beforeSettle("completed");
          if (entries?.length) return { entries: [...event.entries, ...entries], continue: true };
        });
        pi.on("agent_before_settle", event => {
          activity = event.outcome;
          const entries = hooks?.beforeSettle(event.outcome);
          if (entries?.length) return { entries: [...event.entries, ...entries], continue: true };
        });
        pi.on("turn_start", () => hooks?.postCommit());
        pi.on("agent_end", () => hooks?.postCommit());
      }],
    });
    await loader.reload();
    const { session, modelFallbackMessage } = await createAgentSession({ cwd: record.cwd, agentDir: this.agentDir,
      modelRuntime: provider.runtime, model: this.model(record.model), thinkingLevel: record.requestedThinking,
      scopedModels: this.models, settingsManager: settings, resourceLoader: loader, sessionManager: manager,
      excludeTools: ["ask_user_question"] });
    let shutdownErrors: unknown[] | undefined;
    let bindingStarted = false;
    const onError = (event: ExtensionError) => {
      const error = new Error(event.error);
      // Only the owned shutdown dispatch may continue past failed handlers.
      if (shutdownErrors && event.event === "session_shutdown") shutdownErrors.push(error);
      else throw error;
    };
    const emitShutdown = async (errors: unknown[]) => {
      // Setup may fail before bindExtensions installs the normal error callback.
      const unsubscribe = bindingStarted ? undefined : session.extensionRunner.onError(onError);
      shutdownErrors = errors;
      try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
      finally { shutdownErrors = undefined; unsubscribe?.(); }
    };
    try {
      if (modelFallbackMessage) throw new Error("Native child model selection changed unexpectedly");
      provider.restore(session); // Factory registrations have now been flushed.
      bindingStarted = true;
      await session.bindExtensions({ mode: "print", onError });
      provider.restore(session); // session_start may also register providers.
      record.effectiveThinking = session.thinkingLevel;
      return new NativeChildRuntime(session, () => activity, () => { activity = "completed"; }, emitShutdown, hooks, provider.check);
    } catch (error) {
      const errors: unknown[] = [error];
      try { await emitShutdown(errors); } catch (error) { errors.push(error); }
      try { session.dispose(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      throw new AggregateError(errors, `Child initialization failed: ${errors.map(String).join("; ")}`);
    }
  }
}
class NativeChildRuntime implements ChildRuntime {
  readonly source: AgentSessionSource;
  readonly binding: ParentBinding;
  private disposed = false;
  private prompting?: Promise<void>;
  private acceptingSteering = false;
  constructor(private session: AgentSession, private activity: () => "completed" | "aborted" | "error", private reset: () => void,
    private emitShutdown: (errors: unknown[]) => Promise<void>, hooks?: ChildHooks,
    checkModel: (model: Model<any> | undefined) => void = () => {}) {
    this.source = new AgentSessionSource(session);
    this.binding = { manager: session.sessionManager, idle: () => this.idle, pending: () => session.agent.hasQueuedMessages(),
      send: message => { void session.sendCustomMessage(message); }, error: error => { throw error; } };
    session.subscribe(event => { if (event.type === "agent_settled") this.acceptingSteering = false; });
    const prepare = session.agent.prepareRequest;
    let candidateReports: { id: string; content: string }[] = [];
    let requestedReports: string[] = [];
    session.agent.prepareRequest = async (request, signal) => {
      candidateReports = [];
      requestedReports = [];
      if (this.disposed) throw new Error("Child runtime shut down before request");
      checkModel(session.model);
      checkModel(request.model);
      const prepared = await prepare?.(request, signal);
      checkModel(session.model);
      checkModel(prepared?.model ?? request.model);
      if (this.disposed) throw new Error("Child runtime shut down during request preparation");
      if (!hooks) return prepared ?? undefined;
      const context = prepared?.context ?? request.context;
      const restored = hooks.prepare(context.messages);
      candidateReports = restored.reports;
      return { ...prepared, context: { ...context, messages: restored.messages } };
    };
    // Native context transforms follow prepareRequest. Verify full report content
    // at the public provider boundary rather than confusing projection with input.
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) => {
      // Compaction/summaries share this public function but have separate routing
      // IDs. Auxiliary extension model calls do not pass through it at all.
      if (options?.sessionId !== session.sessionId) return stream(model, context, options);
      requestedReports = [];
      checkModel(session.model);
      checkModel(model); // Context transforms run after prepareRequest.
      requestedReports = candidateReports.filter(report => context.messages.some(message => message.role === "user" &&
        (typeof message.content === "string" ? message.content === report.content : message.content.some(block => block.type === "text" && block.text === report.content))))
        .map(report => report.id);
      const onPayload = options.onPayload;
      return stream(model, context, { ...options, onPayload: async (...args) => {
        try {
          checkModel(session.model);
          const payload = await onPayload?.(...args);
          checkModel(session.model);
          return payload;
        } catch (error) { requestedReports = []; throw error; }
      } });
    };
    // AgentSession subscribes first and persists before this awaited Agent listener.
    // Session.subscribe/message_end itself runs BEFORE persistence, so is unsuitable.
    session.agent.subscribe(event => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      const reports = requestedReports;
      requestedReports = [];
      if (!reports.length || !["stop", "toolUse"].includes(event.message.stopReason)) return;
      const entry = session.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message === event.message);
      if (!entry) throw new Error("Successful assistant response has no persisted entry");
      hooks?.processed(reports, entry.id);
    });
  }
  get idle(): boolean { return this.session.isIdle && !this.prompting; }
  get boundary(): string | null { return this.session.sessionManager.getLeafId(); }
  run(run: RunRecord): Promise<Outcome> { return this.cycle(run.prompt); }
  continueCycle(_run: RunRecord, entries: CustomMessageEntryDraft[], guidance: string[]): Promise<Outcome> {
    return this.cycle(guidance.join("\n\n") || "Process the newly available child reports and continue the same task.", entries);
  }
  private async cycle(prompt: string, drafts: CustomMessageEntryDraft[] = []): Promise<Outcome> {
    if (this.prompting) throw new Error("A native child cycle is already reserved");
    const boundary = this.boundary;
    if (this.disposed) return { status: "interrupted", text: "", diagnostic: "Child runtime is shut down." };
    this.reset();
    this.acceptingSteering = true;
    let failure: unknown;
    let recoveryFailure: { status: "error" | "aborted"; diagnostic: string } | undefined;
    let maintenanceDiagnostic: string | undefined;
    const unsubscribe = this.session.subscribe(event => {
      if (event.type === "compaction_end" && !event.result) {
        if (event.reason === "threshold" && !event.willRetry) maintenanceDiagnostic = event.errorMessage ?? "Threshold compaction cancelled";
        else recoveryFailure = { status: event.aborted ? "aborted" : "error", diagnostic: event.errorMessage ?? "Compaction recovery cancelled" };
      } else if (event.type === "auto_retry_end" && !event.success) {
        recoveryFailure = { status: this.disposed ? "aborted" : "error", diagnostic: event.finalError ?? "Automatic retry failed" };
      } else if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "stop") {
        recoveryFailure = undefined;
        maintenanceDiagnostic = undefined;
      }
    });
    this.prompting = (async () => {
      for (const { type: _type, ...message } of drafts) await this.session.sendCustomMessage(message);
      await this.session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
    })();
    try { await this.prompting; }
    catch (error) { failure = error; }
    finally { unsubscribe(); this.prompting = undefined; this.acceptingSteering = false; }
    const entries = this.session.sessionManager.getEntries();
    const offset = boundary === null ? 0 : entries.findIndex(entry => entry.id === boundary) + 1;
    if (boundary !== null && offset === 0) return { status: "error", text: "", diagnostic: "Run boundary is missing from the native session." };
    const runEntries = new Set(entries.slice(offset).map(entry => entry.id));
    const assistant = this.session.sessionManager.buildSessionProjection().entries
      .filter(entry => runEntries.has(entry.sourceEntry.id)).flatMap(entry => entry.messages)
      .reverse().find(message => message.role === "assistant");
    const incomplete = assistant && !["stop", "error", "aborted"].includes(assistant.stopReason);
    const final = assistant && !incomplete && !recoveryFailure && (!failure || assistant.stopReason === "error" || assistant.stopReason === "aborted") ? assistant : undefined;
    const text = final?.content.filter(block => block.type === "text").map(block => block.text).join("\n") ?? "";
    const status = failure ? "error" : recoveryFailure?.status ?? (assistant?.stopReason === "error" ? "error" : assistant?.stopReason === "aborted" ? "aborted" : assistant?.stopReason === "stop" && maintenanceDiagnostic ? "completed" : this.activity());
    return { status: incomplete || (!assistant && status === "completed") ? "error" : status, text,
      diagnostic: failure ? String(failure) : recoveryFailure?.diagnostic ?? assistant?.errorMessage ??
        (incomplete ? `Incomplete terminal stop reason: ${assistant.stopReason}` : !assistant ? "No canonical assistant response in this run." : maintenanceDiagnostic) };
  }
  steer(message: string): boolean {
    if (this.disposed || !this.acceptingSteering) return false;
    this.session.agent.steer({ role: "user", content: message, timestamp: Date.now() });
    return true;
  }
  abort(): void { this.disposed = true; this.session.agent.abort(); }
  marker(runId: string, outcome: Outcome): void {
    this.session.clearQueue();
    this.session.sessionManager.appendCustomEntry(TERMINAL_TYPE, { runId, outcome });
    const fd = openSync(this.session.sessionFile!, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  private shutdownPromise?: Promise<void>;
  shutdown(): Promise<void> { return this.shutdownPromise ??= this.close(); }
  private async close(): Promise<void> {
    const errors: unknown[] = [];
    // Every owned cleanup must run, even when an extension's error callback throws.
    // Await native work before disposal; a rejected abort is not proof of idleness.
    for (const cleanup of [
      () => this.abort(),
      () => this.session.abort(),
      () => this.prompting?.catch(() => undefined), // cycle() owns prompt failures.
      () => this.session.waitForIdle(),
      () => this.session.clearQueue(),
      () => this.emitShutdown(errors),
      () => this.source.dispose(),
      () => this.session.dispose(),
    ]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, `Child shutdown failed: ${errors.map(String).join("; ")}`);
  }
}
