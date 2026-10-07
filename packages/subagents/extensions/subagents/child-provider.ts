import { isDeepStrictEqual } from "node:util";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { mirrorModelRuntime, providerRegistrations, snapshotData } from "./configuration.ts";

/** Per-child registrations; the factory's generation remains immutable. */
export async function childProvider(root: ModelRuntime, agentDir: string, selection: Model<any>) {
  const providers = providerRegistrations(root);
  const selected = snapshotData(selection);
  const registration = providers.find(entry => entry.id === selected.provider);
  const runtime = await mirrorModelRuntime(root, agentDir, providers);
  let failure: Error | undefined;
  const fail = () => { throw failure ??= new Error(`Native child primary model configuration diverged from the root generation: ${selected.provider}/${selected.id}`); };
  const check = (model: Model<any> | undefined) => {
    if (failure || !isDeepStrictEqual(model, selected) ||
      !isDeepStrictEqual(runtime.getPhysicalModel(selected.provider, selected.id), selected) ||
      runtime.getRegisteredNativeProvider(selected.provider) !== registration?.native ||
      !isDeepStrictEqual(runtime.getRegisteredProviderConfig(selected.provider), registration?.config)) fail();
  };
  return { runtime, check,
    restore(session: AgentSession) {
      if (`${session.model?.provider}/${session.model?.id}` !== `${selected.provider}/${selected.id}`) fail();
      // Registration merges defined fields. Unregister first so child-only headers,
      // callbacks and even overrides of an unregistered built-in cannot survive.
      for (const id of new Set([...providers.map(entry => entry.id), selected.provider])) runtime.unregisterProvider(id);
      for (const { id, native, config } of providers) {
        if (native) runtime.registerNativeProvider(native);
        if (config) runtime.registerProvider(id, snapshotData(config));
      }
      session.agent.state.model = snapshotData(selected);
      check(session.model);
    },
  };
}
