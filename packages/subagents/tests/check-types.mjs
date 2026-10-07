import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

let host = process.env.PI_SUBAGENTS_HOST;
if (!host) {
  let directory = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
  while (directory !== dirname(directory)) {
    try { if (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") { host = directory; break; } } catch {}
    directory = dirname(directory);
  }
}
if (!host) throw new Error("Set PI_SUBAGENTS_HOST to the installed host package directory");
const paths = {};
for (const name of ["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"]) {
  paths[`@earendil-works/${name}`] = [join(name === "pi-coding-agent" ? host : join(host, "node_modules", "@earendil-works", name), "dist/index.d.ts")];
}
paths.typebox = [join(host, "node_modules/typebox/build/index.d.mts")];
const temp = mkdtempSync(join(tmpdir(), "pi-subagents-types-"));
try {
  const config = join(temp, "tsconfig.json");
  writeFileSync(config, JSON.stringify({ compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
    skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, typeRoots: [join(host, "node_modules/@types")], paths },
    include: [resolve(dirname(fileURLToPath(import.meta.url)), "../extensions/**/*.ts")] }));
  console.log(`Typechecking against ${host}`);
  execFileSync("npx", ["--yes", "--package", "typescript@5.9.3", "tsc", "-p", config], { stdio: "inherit" });
} finally { rmSync(temp, { recursive: true, force: true }); }
