import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Coordinator, processServices, shutdownLegacyService } from "./coordinator.ts";
import { SubagentStore, readChildEntries, rootIdentity } from "./store.ts";
import { NativeChildFactory } from "./runner.ts";
import { exactModel, loadRoles, ModelConfiguration } from "./configuration.ts";
import { bridgeContext, registerBridge } from "./bridge.ts";
import { CurrentSessionSource } from "./source.ts";
import { TranscriptInspector } from "./inspector.ts";
import { subagentLabel } from "./state.ts";
import { OverviewAttachment } from "./overview.ts";
import { acknowledgedRuns, RELEVANT_ACK_TYPE, type RelevantAcknowledgment } from "./relevance.ts";

export default function subagents(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let source: CurrentSessionSource | undefined;
  let close: (() => void) | undefined;
  let service: Coordinator | undefined;
  let registry: ReturnType<typeof processServices> | undefined;
  let modelConfiguration: ModelConfiguration | undefined;
  let generation = 0;
  const overview = new OverviewAttachment();
  let acknowledged = new Set<string>();
  const restoreAcknowledgment = (ctx: ExtensionContext) => {
    acknowledged = acknowledgedRuns(ctx.sessionManager.getBranch());
    overview.setAcknowledgedRuns(acknowledged);
  };
  const agentDir = getAgentDir();
  const warnedRoles = new Set<string>();
  const discoverRoles = (ctx: ExtensionContext) => {
    const discovery = loadRoles(agentDir, ctx.cwd, ctx.isProjectTrusted());
    for (const diagnostic of discovery.diagnostics) {
      if (warnedRoles.has(diagnostic)) continue;
      warnedRoles.add(diagnostic);
      ctx.ui.notify(`Subagent role unavailable: ${diagnostic}`, "warning");
    }
    return discovery;
  };
  const configuration = async (ctx: ExtensionContext) => {
    const active = generation;
    const { runtime, models } = await (modelConfiguration ??= new ModelConfiguration(agentDir)).resolve(ctx);
    if (active !== generation) throw new Error("Subagent activation was invalidated");
    return { models, factory: new NativeChildFactory(agentDir, runtime, selection => exactModel(models, selection), models) };
  };
  const attach = async (ctx: ExtensionContext) => {
    const active = generation;
    const services = registry = processServices();
    const key = rootIdentity(ctx.sessionManager);
    const config = await configuration(ctx);
    if (active !== generation) throw new Error("Subagent activation was invalidated");
    let current = services.get(key);
    if (!current) {
      current = new Coordinator(new SubagentStore(agentDir, key), config.factory);
      services.set(key, current);
    }
    current.attach({ manager: ctx.sessionManager, idle: () => ctx.isIdle(), pending: () => ctx.hasPendingMessages(),
      send: message => pi.sendMessage(message, { triggerTurn: true }),
      error: error => ctx.ui.notify(`Subagents: ${String(error)}`, "error") }, config.factory);
    service = current;
    overview.attach(ctx, current);
    return { service: current, ...config };
  };

  registerBridge(pi, { actor: () => undefined, resolve: attach, roles: discoverRoles,
    lookup: id => service?.records.find(record => record.id === id),
    lookupRun: id => service?.store.state.runs[id] });
  pi.on("input", (event, ctx) => {
    // Submission, not eventual dequeue/settlement. Busy follow-ups never defer acknowledgment.
    if (!["interactive", "rpc"].includes(event.source) || !ctx.isIdle() || !service || !context) return;
    try { if (rootIdentity(ctx.sessionManager) !== service.store.rootKey) return; } catch { return; }
    const runs = Object.values(service.store.state.runs);
    if (runs.some(run => run.phase !== "terminal") || !runs.some(run => !acknowledged.has(run.id))) return;
    const runIds = runs.map(run => run.id);
    // Native metadata is a display preference, not a report receipt or model message.
    // Keep snapshot, persistence and display update synchronous with reservations.
    try {
      pi.appendEntry(RELEVANT_ACK_TYPE, { version: 1, runIds } satisfies RelevantAcknowledgment);
    } catch (error) {
      try { ctx.ui.notify(`Subagents: could not save review state: ${String(error)}`, "warning"); } catch { /* keep input usable */ }
      return;
    }
    acknowledged = new Set(runIds);
    overview.setAcknowledgedRuns(acknowledged);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const { models, factory } = await configuration(ctx);
    service?.updateFactory(factory);
    return { systemPrompt: bridgeContext(event.systemPrompt, models, discoverRoles(ctx)) };
  });
  pi.on("turn_end", (event, ctx) => {
    if (event.message.role !== "assistant" || !["stop", "toolUse"].includes(event.message.stopReason) || ctx.signal?.aborted) return;
    const result = service?.beforeSettle();
    if (result) return { entries: [...event.entries, ...result.entries], continue: true };
  });
  pi.on("agent_before_settle", event => {
    const result = service?.beforeSettle();
    if (result) return { entries: [...event.entries, ...result.entries], continue: true };
  });
  pi.on("turn_start", () => service?.postCommit());
  pi.on("agent_end", () => service?.postCommit());
  pi.on("agent_settled", async () => { service?.postCommit(true); await service?.releaseIdle(); });

  const resetSource = (ctx: ExtensionContext) => {
    generation++;
    close?.();
    overview.dispose();
    source?.dispose();
    service = undefined;
    context = ctx;
    restoreAcknowledgment(ctx);
    source = new CurrentSessionSource(() => context!);
    source.bind(pi);
    overview.installEditor(ctx, id => { void inspect(ctx, id, true).catch(error => ctx.ui.notify(`Subagents: ${String(error)}`, "error")); });
  };
  pi.on("session_start", async (_event, ctx) => {
    resetSource(ctx);
    // New root files do not exist until their first prompt. Tools attach lazily.
    if (ctx.sessionManager.getSessionFile()) {
      try { rootIdentity(ctx.sessionManager); } catch { return; }
      await attach(ctx);
    }
  });
  pi.on("session_tree", (_event, ctx) => { context = ctx; restoreAcknowledgment(ctx); source?.reset(); });
  pi.on("session_compact", (event, ctx) => {
    context = ctx;
    source?.reset();
    if (event.reason === "manual") service?.afterCompaction();
  });
  pi.on("session_compact_failed", event => { if (event.reason === "manual") service?.postCommit(); });
  pi.on("session_shutdown", async (event, ctx) => {
    generation++;
    modelConfiguration = undefined;
    // Close overlay first: host focus restoration must precede widget disposal.
    close?.();
    overview.dispose();
    source?.dispose();
    source = undefined;
    context = undefined;
    acknowledged = new Set();
    overview.setAcknowledgedRuns(acknowledged);
    service?.detach();
    const previous = service;
    service = undefined;
    if (event.reason !== "reload") {
      const errors: unknown[] = [];
      if (previous) {
        try { await previous.shutdown(); } catch (error) { errors.push(error); }
        finally {
          // Use the registry captured on attachment, even if a legacy restart guard
          // now prevents activation. Never remove a replacement service.
          if (registry?.get(previous.store.rootKey) === previous) registry.delete(previous.store.rootKey);
        }
      }
      // A rejected live upgrade still owns children. Quit/switch must close them using
      // their own shutdown method, without interpreting their old live state.
      let key: string | undefined;
      try { key = rootIdentity(ctx.sessionManager); } catch { /* no saved root */ }
      if (key) {
        try { await shutdownLegacyService(key); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, `Subagents cleanup failed: ${errors.map(String).join("; ")}`);
    }
  });

  // Inspection has one overlay, and never replaces the inline tree or the editor.
  const inspect = async (ctx: ExtensionContext, id: string, returnToTree: boolean) => {
    if (close) return;
    const active = generation;
    let cancelled = false;
    let closeView: (() => void) | undefined;
    const cancel = () => { cancelled = true; closeView?.(); };
    close = cancel;
    let cold: CurrentSessionSource | undefined;
    try {
      const current = processServices().get(rootIdentity(ctx.sessionManager)) ?? (await attach(ctx)).service;
      if (cancelled || active !== generation) return;
      const record = current.records.find(record => record.id === id);
      if (!record) throw new Error(`Unknown subagent ${id}`);
      const live = current.runtime(id);
      if (!live) {
        readChildEntries(record);
        const manager = SessionManager.open(record.sessionFile);
        cold = new CurrentSessionSource(() => ({ sessionManager: manager }));
      }
      // Direct-ID commands always return to the prompt, even if invoked from tree focus.
      if (!returnToTree) overview.returnToEditor();
      await ctx.ui.custom<void>((tui, theme, keys, done) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true; view.dispose(); done();
        };
        const view = new TranscriptInspector(live?.source ?? cold!, tui, theme, keys, record.cwd, finish, undefined,
          `Subagent ${subagentLabel(record)}${record.role ? ` · role: ${record.role.displayName ?? record.role.name}` : ""} (read-only, images disabled)`,
          id => current.records.find(record => record.id === id), id => current.store.state.runs[id]);
        closeView = finish;
        if (cancelled || active !== generation) finish();
        return view;
      }, { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } });
    } finally {
      closeView?.(); cold?.dispose();
      if (close === cancel) close = undefined;
      if (!cancelled && active === generation) {
        if (returnToTree) overview.focus(); else overview.returnToEditor();
      }
    }
  };

  pi.registerCommand("subagents", {
    description: "Focus the inline agent tree or inspect /subagents <stable-id> (read-only)",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/subagents requires the interactive terminal UI.", "warning"); return; }
      if (close) return;
      if (args.trim()) { await inspect(ctx, args.trim(), false); return; }
      const active = generation;
      let cancelled = false;
      const cancel = () => { cancelled = true; };
      close = cancel;
      try {
        const current = processServices().get(rootIdentity(ctx.sessionManager)) ?? (await attach(ctx)).service;
        if (cancelled || active !== generation) return;
        service = current;
        overview.attach(ctx, current);
        if (!overview.focus()) ctx.ui.notify("No focusable subagents. Use /subagents <id> if another custom editor is installed.", "info");
      } finally { if (close === cancel) close = undefined; }
    },
  });

  pi.registerCommand("subagents-preview", {
    description: "Read-only native transcript preview of the current session (no subagents)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/subagents-preview requires the interactive terminal UI.", "warning");
        return;
      }
      if (close) return;
      if (!source) resetSource(ctx);
      context = ctx;
      const active = generation, currentSource = source!;
      let cancelled = false, closeView: (() => void) | undefined;
      const cancel = () => { cancelled = true; closeView?.(); };
      close = cancel;
      // ExtensionAPI does not expose the host's resolved renderers. This preview uses public
      // built-in definitions and native generic fallback; SDK sources can inject exact renderers.
      try {
        await ctx.ui.custom<void>((tui, theme, keys, done) => {
          let finished = false;
          const finish = () => { if (finished) return; finished = true; inspector.dispose(); done(); };
          const inspector = new TranscriptInspector(currentSource, tui, theme, keys, ctx.cwd, finish, undefined, undefined,
            id => service?.records.find(record => record.id === id), id => service?.store.state.runs[id]);
          closeView = finish;
          if (cancelled || active !== generation) finish();
          return inspector;
        }, {
          overlay: true,
          overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
        });
      } finally {
        closeView?.();
        if (close === cancel) close = undefined;
      }
    },
  });
}
