import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { findPiHost, resolveHostPackage } from "./pi-host.mjs";

const hostName = "@earendil-works/pi-coding-agent";
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "pi-host-test-"));
  const keys = ["PATH", "PI_MANAGED_INSTALL_ROOT", "PI_TEST_HOST"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  delete process.env.PI_MANAGED_INSTALL_ROOT;
  delete process.env.PI_TEST_HOST;
  const file = (path, content = "", mode = 0o644) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode });
  };
  const pkg = (directory, name, version = "1.1.0") => {
    file(join(directory, "package.json"), JSON.stringify({ name, version, main: "dist/index.js", types: "dist/index.d.ts" }));
    file(join(directory, "dist/index.js"));
    file(join(directory, "dist/index.d.ts"));
    return directory;
  };
  try { run({ root, file, pkg }); }
  finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("managed launchers select the active release via launcher layout or explicit install root, and fail closed", () => fixture(({ root, file, pkg }) => {
  const bin = join(root, "agent/bin");
  const install = join(root, "agent/install");
  file(join(bin, "pi"), "#!/bin/sh\n", 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const current = pkg(join(install, "releases/1.1.0/node_modules", hostName), hostName);
  pkg(join(root, "agent/lib/node_modules", hostName), hostName, "1.0.3");
  file(join(install, "current-version"), "1.1.0\n");
  assert.equal(findPiHost("PI_TEST_HOST"), current);
  const alternate = join(root, "alternate-install");
  const alternateHost = pkg(join(alternate, "releases/1.1.0/node_modules", hostName), hostName);
  file(join(alternate, "current-version"), "1.1.0\n");
  process.env.PI_MANAGED_INSTALL_ROOT = alternate;
  assert.equal(findPiHost("PI_TEST_HOST"), alternateHost);
  file(join(alternate, "current-version"), "../1.0.3\n");
  assert.throws(() => findPiHost("PI_TEST_HOST"), /Invalid managed Pi version/);
  file(join(alternate, "current-version"), "missing-release\n");
  assert.throws(() => findPiHost("PI_TEST_HOST"), /ENOENT/);
  process.env.PI_TEST_HOST = current;
  assert.equal(findPiHost("PI_TEST_HOST"), current);
  process.env.PI_TEST_HOST = pkg(join(root, "not-pi"), "other-package");
  assert.throws(() => findPiHost("PI_TEST_HOST"), /Not a Pi host package/);
}));

test("npm CLI symlinks select their own host even with an unrelated managed-install environment", () => fixture(({ root, file, pkg }) => {
  const host = pkg(join(root, "npm/node_modules", hostName), hostName);
  const cli = join(host, "dist/bundle/cli.js");
  file(cli, "#!/usr/bin/env node\n", 0o755);
  const bin = join(root, "npm/bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(cli, join(bin, "pi"));
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.PI_MANAGED_INSTALL_ROOT = join(root, "missing-managed-install");
  assert.equal(findPiHost("PI_TEST_HOST"), host);
}));

test("host dependency resolution supports hoisting, import/types exports, and nested dependency precedence", () => fixture(({ root, file, pkg }) => {
  const modules = join(root, "release/node_modules");
  const host = pkg(join(modules, hostName), hostName);
  const name = "@earendil-works/pi-ai";
  const hoisted = pkg(join(modules, name), name);
  file(join(hoisted, "package.json"), JSON.stringify({ name, version: "1.1.0", exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } } }));
  assert.equal(resolveHostPackage(host, name).entry, join(hoisted, "dist/index.js"));
  assert.equal(resolveHostPackage(host, name).types, join(hoisted, "dist/index.d.ts"));
  const nested = pkg(join(host, "node_modules", name), name);
  assert.equal(resolveHostPackage(host, name).directory, nested);
  assert.throws(() => resolveHostPackage(host, "missing-pi-test-dependency"), /Cannot resolve/);
}));
