import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

type Settings = ReturnType<SettingsManager["getSettings"]>;

export const ROOT_EXTENSION_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));
function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}
function excludeRoot(settings: Settings, paths: string[]): Settings {
  const exclusions = paths.map(path => `-${path}`);
  const append = (entries: string[] = []) => [...entries.filter(entry => !exclusions.includes(entry)), ...exclusions];
  return { ...settings, extensions: append(settings.extensions),
    packages: settings.packages?.map(entry => {
      const source = typeof entry === "string" ? { source: entry } : entry;
      // [] disables this resource type; exclusion-only filters would enable it.
      return { ...source, extensions: source.extensions?.length === 0 ? [] : append(source.extensions) };
    }) };
}

/** Normal native discovery, with only our root factory excluded before initialization. */
export async function childSettings(cwd: string, agentDir: string, projectTrusted: boolean): Promise<SettingsManager> {
  const original = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const scopes = { global: original.getGlobalSettings(), project: original.getProjectSettings() };
  const paths = new Set([ROOT_EXTENSION_PATH, canonical(ROOT_EXTENSION_PATH)]);
  const settings = SettingsManager.fromStorage({ withLock(scope, fn) {
    const value = excludeRoot(scopes[scope], [...paths]);
    if (scope === "global") value.cacheWarming = "off";
    const updated = fn(JSON.stringify(value));
    if (updated !== undefined) scopes[scope] = JSON.parse(updated);
  } }, { projectTrusted });
  // Public source resolution executes no extension factories. It also finds lexical
  // symlink aliases, including package manifest and auto-discovery entry points.
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  const resolved = await packages.resolve();
  const root = canonical(ROOT_EXTENSION_PATH);
  for (const resource of resolved.extensions) {
    if (canonical(resource.path) === root) paths.add(resource.path);
  }
  // Native file-valued package sources bypass their resource filters. Remove only
  // declarations of our exact entry file, using native source/base resolution;
  // directory packages must remain so their other resources can still load.
  for (const scope of ["global", "project"] as const) {
    scopes[scope].packages = scopes[scope].packages?.filter(entry => {
      const source = typeof entry === "string" ? entry : entry.source;
      const installed = packages.getInstalledPath(source, scope === "global" ? "user" : "project");
      return installed === undefined || canonical(installed) !== root;
    });
  }
  await settings.reload();
  return settings;
}
