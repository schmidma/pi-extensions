import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { findPiHost, resolveHostPackage } from "../../../tests/pi-host.mjs";

const host = findPiHost("PI_SUBAGENTS_HOST");
const paths = {};
for (const name of ["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"]) {
  const specifier = `@earendil-works/${name}`;
  paths[specifier] = [resolveHostPackage(host, specifier).types];
}
paths.typebox = [resolveHostPackage(host, "typebox").types];
const typeRoots = [dirname(resolveHostPackage(host, "@types/node").directory)];
const temp = mkdtempSync(join(tmpdir(), "pi-subagents-types-"));
try {
  const config = join(temp, "tsconfig.json");
  writeFileSync(config, JSON.stringify({ compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
    skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, typeRoots, paths },
    include: [resolve(dirname(fileURLToPath(import.meta.url)), "../extensions/**/*.ts")] }));
  console.log(`Typechecking against ${host}`);
  execFileSync("npx", ["--yes", "--package", "typescript@5.9.3", "tsc", "-p", config], { stdio: "inherit" });
} finally { rmSync(temp, { recursive: true, force: true }); }
