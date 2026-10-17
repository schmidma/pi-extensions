// Test-only host mapping. Do not let Bun's auto-install cache choose a different Pi version.
import { mock } from "bun:test";
import { findPiHost, resolveHostPackage } from "../../../tests/pi-host.mjs";

const host = findPiHost("PI_SUBAGENTS_HOST");
const paths = new Map<string, string>();
for (const name of ["pi-coding-agent", "pi-tui", "pi-ai", "pi-agent-core"]) {
  const specifier = `@earendil-works/${name}`;
  const { manifest, entry } = resolveHostPackage(host, specifier);
  paths.set(specifier, entry!);
  console.log(`[subagents tests] ${specifier}@${manifest.version} (${entry})`);
}
paths.set("typebox", resolveHostPackage(host, "typebox").entry!);
// Module aliases point at real installed exports, not simulated UI components.
for (const [specifier, entry] of [...paths].reverse()) {
  const actual = await import(entry);
  mock.module(specifier, () => actual);
}
