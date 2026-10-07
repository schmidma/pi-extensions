// Test-only host mapping. Do not let Bun's auto-install cache choose a different Pi version.
import { mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

let host = process.env.PI_SUBAGENTS_HOST;
if (!host) {
  let directory = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
  while (directory !== dirname(directory)) {
    try {
      const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (pkg.name === "@earendil-works/pi-coding-agent") { host = directory; break; }
    } catch {}
    directory = dirname(directory);
  }
}
if (!host) throw new Error("Set PI_SUBAGENTS_HOST to an installed pi-coding-agent package directory");
const paths = new Map<string, string>();
for (const name of ["pi-coding-agent", "pi-tui", "pi-ai", "pi-agent-core"]) {
  const specifier = `@earendil-works/${name}`;
  const packageDirectory = name === "pi-coding-agent" ? host : join(host, "node_modules", specifier);
  const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  const entry = join(packageDirectory, manifest.exports?.["."]?.import ?? manifest.main);
  paths.set(specifier, entry);
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    try {
      const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (pkg.name === specifier) {
        console.log(`[subagents tests] ${specifier}@${pkg.version} (${entry})`);
        break;
      }
    } catch {}
    directory = dirname(directory);
  }
}
paths.set("typebox", join(host, "node_modules", "typebox", "build", "index.mjs"));
// Module aliases point at real installed exports, not simulated UI components.
for (const [specifier, entry] of [...paths].reverse()) {
  const actual = await import(entry);
  mock.module(specifier, () => actual);
}
