import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ModelRuntime, parseFrontmatter, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { RoleSnapshot } from "./state.ts";

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export interface RoleDiscovery {
  roles: Map<string, RoleSnapshot>;
  invalid: Map<string, string>;
  diagnostics: string[];
}
export function loadRoles(agentDir: string, cwd: string, trusted: boolean): RoleDiscovery {
  const roles = new Map<string, RoleSnapshot>();
  const invalid = new Map<string, string>();
  const diagnostics: string[] = [];
  const diagnostic = (source: string, error: unknown) => {
    const message = `${source}: ${(error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0]}`;
    diagnostics.push(message);
    return message;
  };
  for (const directory of [join(agentDir, "agents"), ...(trusted ? [join(cwd, ".pi", "agents")] : [])]) {
    let names: string[];
    try { names = readdirSync(directory).filter(name => name.endsWith(".md")).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostic(directory, error);
      continue;
    }
    for (const name of names) {
      const source = join(directory, name);
      // The filename reserves an identity even if the file cannot be read/parsed.
      let roleName = name.slice(0, -3);
      try {
        const { frontmatter: fm, body } = parseFrontmatter(readFileSync(source, "utf8"));
        if (!fm || typeof fm !== "object" || Array.isArray(fm)) throw new Error("role frontmatter must be an object");
        if (fm.name !== undefined) {
          if (typeof fm.name !== "string" || !fm.name.trim()) throw new Error("invalid role name");
          roleName = fm.name;
        }
        if (fm.enabled !== undefined && typeof fm.enabled !== "boolean") throw new Error("enabled must be boolean");
        if (fm.enabled === false) { roles.delete(roleName); invalid.delete(roleName); continue; }
        for (const field of Object.keys(fm)) {
          if (!["name", "description", "display_name", "enabled", "prompt_mode", "allowed_subagents"].includes(field)) throw new Error(`unsupported role field ${field}`);
        }
        const mode = fm.prompt_mode ?? "append";
        if (mode !== "append" && mode !== "replace") throw new Error("unsupported prompt_mode");
        if (fm.description !== undefined && typeof fm.description !== "string") throw new Error("invalid description");
        if (fm.display_name !== undefined && typeof fm.display_name !== "string") throw new Error("invalid display_name");
        // Legacy allowed_subagents is tolerated as metadata, never an execution policy.
        roles.set(roleName, { name: roleName, displayName: fm.display_name as string | undefined, description: fm.description as string ?? "", body, promptMode: mode, source });
        invalid.delete(roleName);
      } catch (error) {
        // An invalid override shadows the earlier role; it must not select a fallback.
        roles.delete(roleName);
        invalid.set(roleName, diagnostic(source, error));
      }
    }
  }
  return { roles, invalid, diagnostics };
}
export interface EligibleModel { model: Model<any>; thinkingLevel?: ThinkingLevel }
type ModelContext = Pick<ExtensionContext, "modelRegistry" | "scopedModels">;
// Copy data, but preserve callable/provider identities. JSON loses callbacks and
// structuredClone rejects them. Non-plain native providers remain opaque objects.
export function snapshotData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(snapshotData) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotData(item)])) as T;
  }
  return value;
}
export type ProviderSource = Pick<ModelRuntime, "getRegisteredProviderIds" | "getRegisteredNativeProvider" | "getRegisteredProviderConfig">;
export function providerRegistrations(source: ProviderSource) {
  return [...source.getRegisteredProviderIds()].sort().map(id => ({ id,
    native: source.getRegisteredNativeProvider(id), config: snapshotData(source.getRegisteredProviderConfig(id)) }));
}
function modelSnapshot(ctx: ModelContext) {
  return { registrations: providerRegistrations(ctx.modelRegistry), all: snapshotData(ctx.modelRegistry.getAll()),
    available: snapshotData(ctx.modelRegistry.getAvailable()), scope: snapshotData(ctx.scopedModels) };
}
export async function mirrorModelRuntime(source: ProviderSource | Pick<ExtensionContext, "modelRegistry">, agentDir: string,
  providers = providerRegistrations("modelRegistry" in source ? source.modelRegistry : source)): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
  for (const { id, native, config } of providers) {
    if (native) runtime.registerNativeProvider(native);
    if (config) runtime.registerProvider(id, snapshotData(config));
  }
  return runtime;
}
/** A generation owns its runtime; never reconfigure a runtime used by live children. */
export class ModelConfiguration {
  private cached?: { snapshot: ReturnType<typeof modelSnapshot>; runtime: Promise<ModelRuntime> };
  constructor(private agentDir: string) {}
  async resolve(ctx: ModelContext): Promise<{ runtime: ModelRuntime; models: EligibleModel[] }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = modelSnapshot(ctx);
      let cached = this.cached;
      if (!cached || !isDeepStrictEqual(cached.snapshot, snapshot)) {
        cached = { snapshot, runtime: mirrorModelRuntime(ctx, this.agentDir, snapshot.registrations) };
        this.cached = cached;
      }
      let runtime: ModelRuntime;
      try { runtime = await cached.runtime; }
      catch (error) { if (this.cached === cached) this.cached = undefined; throw error; }
      if (!isDeepStrictEqual(snapshot, modelSnapshot(ctx))) continue;
      return { runtime, models: eligibleModels(ctx, runtime) };
    }
    throw new Error("Subagent model configuration changed while mirroring; no stable provider view is available.");
  }
}
/** The advertisement and execution validator deliberately share this exact physical catalogue. */
export function eligibleModels(ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels">, runtime: ModelRuntime): EligibleModel[] {
  const available = ctx.modelRegistry.getAvailable();
  const keys = new Set(available.map(model => `${model.provider}/${model.id}`));
  const candidates: readonly EligibleModel[] = ctx.scopedModels.length ? ctx.scopedModels : available.map(model => ({ model }));
  return candidates.flatMap(candidate => {
    const { provider, id } = candidate.model;
    const model = runtime.getPhysicalModel(provider, id);
    if (!model || !keys.has(`${provider}/${id}`)) return [];
    const current = available.find(entry => entry.provider === provider && entry.id === id);
    if (!isDeepStrictEqual(model, current)) throw new Error(`Cannot mirror current model configuration for ${provider}/${id}`);
    return [{ model, thinkingLevel: candidate.thinkingLevel }];
  });
}
export function exactModel(models: EligibleModel[], selection: string): Model<any> {
  const match = models.find(({ model }) => `${model.provider}/${model.id}` === selection);
  if (!match) throw new Error(`Model ${selection} is not an eligible exact provider/model ID in the current scope.`);
  return match.model;
}
export function delegationContext(models: EligibleModel[], roles: Map<string, RoleSnapshot>): string {
  return ["<subagent_model_options>", "Currently selectable subagent models in this session:",
    ...models.map(({ model, thinkingLevel }) => `- ${model.provider}/${model.id}${thinkingLevel ? ` (scope preference: ${thinkingLevel})` : ""}`),
    "This roster indicates availability only, not a fixed quality ordering. Select the model and reasoning effort independently for the task.",
    "</subagent_model_options>", "<subagent_roles>", "Optional user-authored instruction templates (omit role for native Pi instructions):",
    ...[...roles.values()].map(role => `- ${role.name}: ${role.description}`),
    "</subagent_roles>",
    "<subagent_coordination>",
    "Subagents may delegate in turn, but each agent controls only its own direct children. One full report per run arrives automatically at the immediate parent; do not poll. A subagent with unfinished children may end its response and wait: its provisional answer is withheld until it has processed every child report in a successful response. Subagent questions and blockers are terminal prose reports to the immediate parent; subagents must not ask the user directly.",
    "An acknowledgment confirms acceptance, not findings. Do not predict or present a pending subagent's findings.",
    "While delegated work is running, pursue other useful work rather than repeating the same investigation. Targeted verification of returned findings remains appropriate.",
    "</subagent_coordination>"].join("\n");
}
export function replaceRoster(prompt: string, context: string): string {
  return `${prompt.replace(/<subagent_model_options>[\s\S]*?<\/subagent_model_options>/g, "").replace(/<subagent_roles>[\s\S]*?<\/subagent_roles>/g, "").replace(/<subagent_coordination>[\s\S]*?<\/subagent_coordination>/g, "").trimEnd()}\n\n${context}`;
}
