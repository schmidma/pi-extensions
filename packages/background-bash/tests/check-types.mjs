import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPiHost, resolveHostPackage } from "../../../tests/pi-host.mjs";

const host = findPiHost("PI_BACKGROUND_BASH_HOST");
const paths = {};
for (const specifier of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
  paths[specifier] = [resolveHostPackage(host, specifier).types];
}
const typeRoots = [dirname(resolveHostPackage(host, "@types/node").directory)];
const temp = mkdtempSync("/var/tmp/pi-background-bash-types-");
try {
  const config = join(temp, "tsconfig.json");
  writeFileSync(config, JSON.stringify({ compilerOptions: {
    target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
    skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, typeRoots, paths,
  }, include: [resolve(dirname(fileURLToPath(import.meta.url)), "../extensions/**/*.ts")] }));
  console.log(`Typechecking against ${host}`);
  execFileSync("npx", ["--yes", "--package", "typescript@5.9.3", "tsc", "-p", config], { stdio: "inherit" });
} finally { rmSync(temp, { recursive: true, force: true }); }
