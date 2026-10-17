// Test-only resolution of the Pi selected on PATH; never use a cached/local host.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const hostName = "@earendil-works/pi-coding-agent";
const manifestAt = (directory) => JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));

export function findPiHost(overrideVariable) {
  let host = process.env[overrideVariable];
  if (!host) {
    const executable = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
    let directory = dirname(executable);
    while (true) {
      if (existsSync(join(directory, "package.json")) && manifestAt(directory).name === hostName) {
        host = directory;
        break;
      }
      if (directory === dirname(directory)) break;
      directory = dirname(directory);
    }
    if (!host) {
      // Managed installs use a launcher outside the package. Match its active release,
      // not an older npm installation that may still exist elsewhere on the machine.
      const installRoot = process.env.PI_MANAGED_INSTALL_ROOT ?? join(dirname(executable), "..", "install");
      const version = readFileSync(join(installRoot, "current-version"), "utf8").trim();
      if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) throw new Error("Invalid managed Pi version");
      host = join(installRoot, "releases", version, "node_modules", hostName);
    }
  }
  host = realpathSync(host);
  if (manifestAt(host).name !== hostName) throw new Error(`Not a Pi host package: ${host}`);
  return host;
}

export function resolveHostPackage(host, specifier) {
  const directory = specifier === hostName ? host : createRequire(join(host, "package.json"))
    .resolve.paths(specifier).map(root => join(root, specifier)).find(path => existsSync(join(path, "package.json")));
  if (!directory) throw new Error(`Cannot resolve ${specifier} from Pi host ${host}`);
  const manifest = manifestAt(directory);
  if (manifest.name !== specifier) throw new Error(`Not a ${specifier} package: ${directory}`);
  const entry = manifest.exports?.["."]?.import ?? manifest.main;
  const types = manifest.exports?.["."]?.types ?? manifest.types;
  return { directory: realpathSync(directory), manifest,
    entry: entry ? join(directory, entry) : undefined,
    types: types ? join(directory, types) : undefined };
}
