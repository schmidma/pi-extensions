import { mock } from "bun:test";
import { findPiHost, resolveHostPackage } from "../../../tests/pi-host.mjs";
const host = findPiHost("PI_BACKGROUND_BASH_HOST");
for (const specifier of ["typebox", "@earendil-works/pi-tui", "@earendil-works/pi-coding-agent"]) {
  const { entry } = resolveHostPackage(host, specifier);
  const actual = await import(entry!);
  mock.module(specifier, () => actual);
}
