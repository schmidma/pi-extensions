import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Runtime, TAIL_BYTES, type Snapshot, type StartOptions } from "../extensions/background-bash/runtime.ts";

const directories: string[] = [];
const runtimes: Runtime[] = [];
function runtime(cap?: number) {
  const directory = mkdtempSync("/var/tmp/pi-background-bash-test-");
  directories.push(directory);
  const rt = new Runtime(directory, cap, 100);
  runtimes.push(rt);
  const events: string[] = [];
  const notifications: Snapshot[] = [];
  rt.bind({ persist: s => events.push(`persist:${s.id}`), notify: s => { events.push(`notify:${s.id}`); notifications.push(s); } });
  return { rt, directory, events, notifications };
}
let sequence = 0;
function start(rt: Runtime, command: string, extra: Partial<StartOptions> = {}) {
  return rt.start({ toolCallId: `call-${++sequence}`, command, cwd: rt.directory, shell: "/bin/bash", shellArgs: ["-c"], ...extra });
}
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(rt => rt.shutdown()));
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("foreground output and exit, background acknowledgement and exactly-once ordered completion", async () => {
  const { rt, events, notifications } = runtime();
  const fg = start(rt, "printf foreground; exit 7");
  expect(await fg.result).toMatchObject({ status: "exited", exitCode: 7, output: "foreground", background: false });
  expect(notifications).toHaveLength(0);
  const bg = start(rt, "printf start; sleep .12; printf finish", { background: true });
  const ack = await bg.result;
  expect(ack.status).toBe("running");
  expect(ack.endedAt).toBeUndefined();
  const final = await bg.done;
  expect(final).toMatchObject({ status: "exited", exitCode: 0, output: "startfinish" });
  expect(final.endedAt! - final.startedAt).toBeGreaterThan(100);
  expect(ack.status).toBe("running"); // The tool result is an immutable acknowledgement.
  expect(events.slice(-2)).toEqual([`persist:${bg.id}`, `notify:${bg.id}`]);
  rt.bind({ persist: () => { throw Error("duplicate persistence"); }, notify: () => { throw Error("duplicate notification"); } });
  expect(rt.lastError).toBeUndefined();
  expect(notifications).toHaveLength(1);
});

test("manual and waitFor promotions preserve the original timeout and clean descendants", async () => {
  const { rt } = runtime();
  for (const mode of ["manual", "waitFor"]) {
    const pidFile = join(rt.directory, `${mode}.pid`);
    const job = start(rt, `trap '' TERM; (trap '' TERM; while :; do sleep 1; done) & echo $! > '${pidFile}'; printf ready; wait`,
      { timeout: .18, ...(mode === "waitFor" ? { waitFor: "ready" } : {}) });
    if (mode === "manual") job.promote();
    expect((await job.result).status).toBe("running");
    const final = await job.done;
    expect(final.status).toBe("timeout");
    expect(final.endedAt! - final.startedAt).toBeLessThan(1200);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try {
      // Linux may retain an adopted zombie briefly; it is no longer an executing process.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      expect(stat.split(") ")[1][0]).toBe("Z");
    } catch (error: any) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
  }
});

test("foreground abort kills, background abort is detached, and an already aborted call never spawns", async () => {
  const { rt } = runtime();
  const controller = new AbortController();
  const fg = start(rt, "sleep 10", { signal: controller.signal });
  controller.abort();
  expect(fg.snapshot()).toMatchObject({ status: "running", termination: "aborted" });
  expect((await fg.result).status).toBe("aborted");
  expect(() => start(rt, "touch must-not-exist", { signal: controller.signal })).toThrow("before spawn");
  const other = new AbortController();
  const bg = start(rt, "sleep .08; printf survived", { signal: other.signal });
  bg.promote();
  other.abort();
  expect((await bg.done).output).toBe("survived");
});

test("automatic promotion excludes explicit timeouts and sleep commands", async () => {
  const { rt } = runtime();
  const bg = start(rt, "printf auto; sleep .15", { autoPromoteMs: 20 });
  expect((await bg.result).background).toBe(true);
  const timeout = start(rt, "printf timeout; sleep .08", { timeout: 1, autoPromoteMs: 10 });
  const sleeping = start(rt, " sleep .08", { autoPromoteMs: 10 });
  expect((await timeout.result).background).toBe(false);
  expect((await sleeping.result).background).toBe(false);
  await bg.done;
});

test("reload unbinds old invalidators, defers delivery until fresh binding, and shutdown suppresses notifications", async () => {
  const { rt, notifications } = runtime();
  const job = start(rt, "sleep .15; printf reloaded", { background: true });
  let oldInvalidations = 0;
  rt.watch(job.options.toolCallId, () => oldInvalidations++);
  rt.unbind();
  await job.done;
  expect(oldInvalidations).toBe(0);
  expect(notifications).toHaveLength(0);
  const events: string[] = [];
  rt.bind({ persist: () => events.push("persist"), notify: () => events.push("notify") });
  expect(events).toEqual(["persist", "notify"]);
  rt.bind({ persist: () => events.push("duplicate"), notify: () => events.push("duplicate") });
  expect(events).toHaveLength(2);
  const running = start(rt, "sleep 10", { background: true });
  await rt.shutdown();
  expect((await running.done).status).toBe("killed");
  expect(events).toEqual(["persist", "notify", "duplicate"]); // The replacement binding persists the newly killed job.
});

test("bounded tails, private capped logs, incremental reads, and inherited pipes cannot hang", async () => {
  const { rt, directory } = runtime(4096);
  const job = start(rt, "head -c 100000 /dev/zero | tr '\\0' x; printf '\\nlast-line'");
  const final = await job.done;
  expect(Buffer.byteLength(final.output)).toBeLessThanOrEqual(TAIL_BYTES + 2);
  expect(final.output.endsWith("last-line")).toBe(true);
  expect(final.bytes).toBeGreaterThan(100000);
  expect(statSync(final.logPath).size).toBe(4096);
  expect(statSync(final.logPath).mode & 0o777).toBe(0o600);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect((await rt.read(job)).remaining).toBe(0);
  expect((await rt.read(job, true)).text).toContain("last-line");
  const { rt: full } = runtime();
  const lines = start(full, "seq 1 3000");
  await lines.done;
  expect((await full.read(lines)).text).toBe(Array.from({ length: 2000 }, (_, i) => `${i + 1}\n`).join(""));
  expect((await full.read(lines)).text.startsWith("2001\n")).toBe(true);
  const large = start(full, "printf START; head -c 1200000 /dev/zero | tr '\\0' x; printf END");
  await large.done;
  const structured = full.structuredOutput(large);
  expect(structured.truncated).toBe(true);
  expect(structured.full_output_path).toBe(large.output.path);
  expect(Buffer.byteLength(structured.output)).toBeLessThanOrEqual(1024 * 1024);
  expect(structured.output.startsWith("START")).toBe(true);
  expect(structured.output.endsWith("END")).toBe(true);
  const inherited = start(rt, "sleep 2 & printf parent-exited");
  const snap = await inherited.done;
  expect(snap.output).toBe("parent-exited");
  expect(Date.now() - snap.startedAt).toBeLessThan(1000);
  await inherited.stop();
});

test("pathological regex is terminated off-thread without blocking Pi or consuming output", async () => {
  const { rt } = runtime();
  const job = start(rt, `printf '${"a".repeat(40)}!\\nready\\n'`);
  await job.done;
  let beats = 0;
  const heartbeat = setInterval(() => beats++, 20);
  const started = Date.now();
  try { await expect(rt.read(job, false, "(a+)+$")).rejects.toThrow("500ms limit"); }
  finally { clearInterval(heartbeat); }
  expect(Date.now() - started).toBeLessThan(2000);
  expect(beats).toBeGreaterThan(5);
  expect(job.cursor).toBe(0);
  await expect(rt.read(job, false, "[")).rejects.toThrow();
  expect(job.cursor).toBe(0);
  expect((await rt.read(job, false, "^ready$")).text).toBe("ready");
  expect(job.cursor).toBe(job.output.stored);
});

function expectGone(pid: number) {
  try { expect(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0]).toBe("Z"); }
  catch (error: any) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
}
test("explicit kill and shutdown clean owned descendants after shell completion, without changing its result", async () => {
  for (const shutdown of [false, true]) {
    const { rt, notifications, events } = runtime();
    const job = start(rt, "sleep 30 & echo $!", { background: true });
    const final = await job.done;
    const pid = Number(final.output.trim());
    expect(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0]).not.toBe("Z");
    const before = [...events];
    if (shutdown) await rt.shutdown(); else await job.stop();
    expectGone(pid);
    expect(job.snapshot()).toEqual(final);
    expect(events).toEqual(before);
    expect(notifications).toHaveLength(1);
    expect(["cleared", "leftover-stuck"]).toContain(job.killOutcome); // A zombie may keep the pgid present until adopted/reaped.
  }
});

test("once an empty group is observed its recycled number is never probed or signalled again", async () => {
  const { rt } = runtime();
  const job = start(rt, "true");
  await job.done;
  expect(job.probeGroup()).toBe(false);
  const kill = process.kill;
  const calls: unknown[] = [];
  process.kill = ((pid: number, signal: any) => {
    if (pid === -job.child!.pid!) { calls.push(signal); return true; }
    return kill(pid, signal);
  }) as typeof process.kill;
  try { await job.stop(); await rt.shutdown(); }
  finally { process.kill = kill; }
  expect(calls).toEqual([]);
});

test("unmatched single-character waitFor keeps bounded memory; literal matches span output chunks", async () => {
  const { rt } = runtime();
  const unmatched = start(rt, "head -c 2000000 /dev/zero | tr '\\0' x", { waitFor: "!" });
  expect((await unmatched.done).background).toBe(false);
  // The memory bound, not output size, is the regression contract here.
  expect((unmatched as any).matchTail.length).toBeLessThanOrEqual(1);
  const matched = start(rt, "printf re; sleep .03; printf ady; sleep .1", { waitFor: "ready" });
  expect((await matched.result).background).toBe(true);
  await matched.done;
  const unicode = start(rt, "printf '\\342'; sleep .03; printf '\\234\\223'; sleep .1", { waitFor: "✓" });
  expect((await unicode.result).background).toBe(true);
  await unicode.done;
});

test("retention bounds same-process completed logs without unlinking active writers", async () => {
  const { rt, directory } = runtime();
  const active = start(rt, "sleep 10", { background: true });
  for (let i = 0; i < 105; i++) writeFileSync(join(directory, `${Date.now() - 100000 + i}-${process.pid}-${randomUUID()}.log`), "old");
  const completion = start(rt, "printf done");
  await completion.done; // Retention also runs without constructing another runtime.
  expect(readdirSync(directory)).toHaveLength(101); // 100 completed plus the live writer.
  expect(statSync(active.output.path).isFile()).toBe(true);
  await active.stop();
  expect(readdirSync(directory)).toHaveLength(100);
});

test("spawn errors settle safely, invalid input allocates no logs, and stale logs are retained boundedly", async () => {
  const { rt, directory } = runtime();
  const before = readdirSync(directory).length;
  expect(() => start(rt, "true", { timeout: -1 })).toThrow("timeout");
  expect(readdirSync(directory)).toHaveLength(before);
  const failed = start(rt, "true", { shell: "/missing/pi-background-bash-shell" });
  expect((await failed.done).status).toBe("failed");
  const old = join(directory, `1-2147483647-00000000-0000-0000-0000-000000000000.log`);
  writeFileSync(old, "old");
  const other = new Runtime(directory);
  runtimes.push(other);
  expect(readdirSync(directory)).not.toContain(old.split("/").at(-1)!);
});
