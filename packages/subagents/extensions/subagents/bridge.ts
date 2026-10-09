import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Actor, Coordinator } from "./coordinator.ts";
import { delegationContext, exactModel, replaceRoster, THINKING, type EligibleModel, type RoleDiscovery } from "./configuration.ts";
import { readChildEntries } from "./store.ts";
import { subagentLabel, validateName, type SubagentRecord } from "./state.ts";
import { delegationRenderers, registerReportRenderer, type RunLookup } from "./cards.ts";

export interface BridgeAccess {
  /** Capture/check before any await. This identity is local to this tool call. */
  actor(): Actor | undefined;
  resolve(ctx: ExtensionContext): Promise<{ service: Coordinator; models: EligibleModel[] }>;
  roles(ctx: ExtensionContext): RoleDiscovery;
  lookup?(id: string): SubagentRecord | undefined;
  lookupRun?: RunLookup;
}
function accepted(ack: Awaited<ReturnType<Coordinator["invoke"]>>) {
  const { agentId, runId, name, ...rest } = ack;
  const details = { name, agent_id: agentId, run_id: runId, ...rest };
  return { content: [{ type: "text" as const, text: `Subagent ${ack.name} accepted. Its report will arrive automatically. If blocked on this report, end your turn; do not sleep or poll.\n${JSON.stringify(details)}` }], details };
}
export function registerBridge(pi: ExtensionAPI, access: BridgeAccess): void {
  let presentationService: Coordinator | undefined;
  const lookup = (id: string) => access.lookup?.(id) ?? presentationService?.records.find(record => record.id === id);
  const lookupRun: RunLookup = id => access.lookupRun?.(id) ?? presentationService?.store.state.runs[id];
  registerReportRenderer(pi, lookup, lookupRun);
  pi.registerTool({ name: "spawn_subagent", label: "Spawn subagent", exposure: "model-only",
    ...delegationRenderers("spawn_subagent", lookup),
    description: "Start a named direct subagent asynchronously. Name is a short task/topic, not a role or ID; names may repeat. Starts a fresh conversation without the parent's conversation history. Give a self-contained task, including relevant decisions and constraints not available in referenced files. Include the objective, relevant findings or ruled-out approaches, scope, and expected output; keep the brief proportional to the task. State whether the task is read-only or may modify files. Choose an exact advertised provider/model and explicit thinking independently of the optional role. Role supplies user-authored instructions, not model or tool policy; omit it for native Pi instructions. Returns an acknowledgment, not the completed report.",
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }), prompt: Type.String({ minLength: 1 }),
      model: Type.String({ minLength: 1 }), thinking: Type.Union(THINKING.map(level => Type.Literal(level))), role: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, args, _signal, _update, ctx) {
      const actor = access.actor();
      validateName(args.name);
      const discovery = args.role === undefined ? undefined : access.roles(ctx);
      const diagnostic = args.role === undefined ? undefined : discovery!.invalid.get(args.role);
      if (diagnostic) throw new Error(`Role ${args.role} is unavailable: ${diagnostic}`);
      const role = args.role === undefined ? undefined : discovery!.roles.get(args.role);
      if (args.role !== undefined && !role) throw new Error(`Unknown or disabled role ${args.role}; omit role for native Pi instructions.`);
      const { service, models } = await access.resolve(ctx);
      presentationService = service;
      service.checkActor(actor);
      exactModel(models, args.model);
      if (!THINKING.includes(args.thinking)) throw new Error("Choose an explicit thinking level from the advertised schema.");
      return accepted(await service.invoke(args.prompt, { subagent: { name: args.name, ...(role ? { role } : {}),
        cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), model: args.model,
        requestedThinking: args.thinking as ThinkingLevel, effectiveThinking: args.thinking as ThinkingLevel } }, actor));
    } });
  pi.registerTool({ name: "resume_subagent", label: "Resume subagent", exposure: "model-only",
    ...delegationRenderers("resume_subagent", lookup),
    description: "Continue a finished direct subagent's native session asynchronously. Supply agent_id, not its name. Retains name, native session, optional role, model and thinking; overrides are not supported. Returns an acknowledgment, not the completed report. A waiting run is still open: use steer_subagent instead.",
    parameters: Type.Object({ agent_id: Type.String({ minLength: 1 }), prompt: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    async execute(_id, args, _signal, _update, ctx) {
      const actor = access.actor();
      const { service, models } = await access.resolve(ctx);
      presentationService = service;
      const saved = service.owned(args.agent_id, actor);
      if (saved.projectTrusted && !ctx.isProjectTrusted()) throw new Error(`Cannot resume ${subagentLabel(saved)} from an untrusted parent session. Restore project trust first.`);
      exactModel(models, saved.model);
      readChildEntries(saved);
      return accepted(await service.invoke(args.prompt, { resume: args.agent_id }, actor));
    } });
  pi.registerTool({ name: "steer_subagent", label: "Steer subagent", exposure: "model-only",
    ...delegationRenderers("steer_subagent", lookup),
    description: "Send guidance to an open direct subagent run, including a waiting run. Use agent_id, not its name. For a finished subagent use resume_subagent.",
    parameters: Type.Object({ agent_id: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    async execute(_id, args, _signal, _update, ctx) {
      const actor = access.actor();
      const { service } = await access.resolve(ctx);
      presentationService = service;
      const saved = service.owned(args.agent_id, actor);
      service.steer(args.agent_id, args.message, actor);
      return { content: [{ type: "text", text: `Guidance queued for ${subagentLabel(saved)}.` }], details: { agent_id: args.agent_id, name: saved.name } };
    } });
}
export function bridgeContext(prompt: string, models: EligibleModel[], discovery: RoleDiscovery): string {
  return replaceRoster(prompt, delegationContext(models, discovery.roles));
}
