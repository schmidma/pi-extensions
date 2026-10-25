import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync, writeSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { filterOutput } from "./filter.ts";

export const TAIL_BYTES = 50 * 1024;
const LOG_BYTES = 16 * 1024 * 1024;
export const ENTRY_TYPE = "background-bash:snapshot:v1";
export const MESSAGE_TYPE = "background-bash:completion:v1";
const activeLogsKey = Symbol.for("pi-extensions.background-bash.active-logs.v1");
const logGlobals = globalThis as typeof globalThis & { [activeLogsKey]?: Set<string> };
const activeLogs = logGlobals[activeLogsKey] ??= new Set<string>();
export type KillOutcome = "killed" | "finished" | "gone" | "cleared" | "stuck" | "leftover-stuck";
export type Status = "running" | "exited" | "killed" | "timeout" | "aborted" | "failed" | "unavailable";
export interface Snapshot {
  version: 1; id: string; toolCallId: string; command: string; startedAt: number;
  endedAt?: number; status: Status; exitCode?: number | null; signal?: string | null;
  background: boolean; output: string; bytes: number; logBytes: number; logPath: string;
  truncated: boolean; error?: string; termination?: "killed" | "timeout" | "aborted";
}
export interface StartOptions {
  toolCallId: string; command: string; displayCommand?: string; cwd: string; shell: string; shellArgs: string[];
  env?: NodeJS.ProcessEnv; timeout?: number; background?: boolean; waitFor?: string;
  signal?: AbortSignal; autoPromoteMs?: number;
}
interface Binding {
  persist(snapshot: Snapshot): void;
  notify(snapshot: Snapshot): void;
}

/** Private, capped disk logs plus a small rolling tail. No queued write buffers. */
class Output {
  private fd: number;
  private tail = Buffer.alloc(0);
  bytes = 0;
  stored = 0;
  error?: string;
  constructor(readonly path: string, private cap: number) {
    this.fd = openSync(path, "wx", 0o600);
    activeLogs.add(path);
  }
  append(data: Buffer) {
    this.bytes += data.length;
    this.tail = Buffer.concat([this.tail, data.subarray(-TAIL_BYTES)]).subarray(-TAIL_BYTES);
    if (this.fd < 0 || this.stored >= this.cap) return;
    try {
      const part = data.subarray(0, this.cap - this.stored);
      let offset = 0;
      while (offset < part.length) offset += writeSync(this.fd, part, offset, part.length - offset);
      this.stored += offset;
    } catch (error) {
      this.error = `Log write failed: ${String(error)}`;
      this.close();
    }
  }
  text() { return this.tail.toString("utf8").split("\n").slice(-2000).join("\n"); }
  close() {
    if (this.fd < 0) return;
    try { closeSync(this.fd); } catch (error) { this.error = `Log close failed: ${String(error)}`; }
    this.fd = -1;
    activeLogs.delete(this.path);
  }
}

export class Job {
  readonly id = randomUUID().slice(0, 8);
  readonly startedAt = Date.now();
  readonly output: Output;
  readonly done: Promise<Snapshot>;
  readonly result: Promise<Snapshot>;
  child?: ChildProcess;
  background = false;
  status: Status = "running";
  endedAt?: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  error?: string;
  persisted = false;
  queued = false;
  suppressNotification = false;
  cursor = 0;
  killOutcome?: KillOutcome;
  killedBy: "killed by agent" | "killed by user" = "killed by agent";
  readQueue: Promise<void> = Promise.resolve();
  private groupId?: number;
  private stopPromise?: Promise<Snapshot>;
  private resultResolved = false;
  private resolveDone!: (snapshot: Snapshot) => void;
  private resolveResult!: (snapshot: Snapshot) => void;
  private deadline?: ReturnType<typeof setTimeout>;
  private promotion?: ReturnType<typeof setTimeout>;
  private drain?: ReturnType<typeof setTimeout>;
  private cleaning = false;
  private removeAbort = () => {};
  private matchTail = "";
  private settled = false;
  private termination?: "killed" | "timeout" | "aborted";
  private exited = false;

  constructor(readonly options: StartOptions, private runtime: Runtime) {
    this.output = new Output(join(runtime.directory, `${this.startedAt}-${process.pid}-${randomUUID()}.log`), runtime.logCap);
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.result = new Promise(resolve => { this.resolveResult = resolve; });
  }
  get completed() { return this.settled; }
  snapshot(): Snapshot {
    const output = this.output.text();
    return { version: 1, id: this.id, toolCallId: this.options.toolCallId, command: (this.options.displayCommand ?? this.options.command).slice(0, 8192),
      startedAt: this.startedAt, endedAt: this.endedAt, status: this.status, exitCode: this.exitCode,
      signal: this.exitSignal, background: this.background, termination: this.termination, output, bytes: this.output.bytes,
      logBytes: this.output.stored, logPath: this.output.path,
      truncated: Buffer.byteLength(output) < this.output.bytes, error: this.error ?? this.output.error };
  }
  start() {
    const opts = this.options;
    try {
      this.child = spawn(opts.shell, [...opts.shellArgs, opts.command], {
        cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
      });
      this.groupId = this.child.pid;
      if (this.groupId) this.runtime.trackGroup(this);
      const onData = (data: Buffer, decoded: string) => {
        if (this.settled) return;
        this.output.append(data);
        if (opts.waitFor && !this.background) {
          const text = this.matchTail + decoded;
          if (text.includes(opts.waitFor)) this.promote();
          const overlap = opts.waitFor.length - 1;
          this.matchTail = overlap > 0 ? text.slice(-overlap) : "";
        }
      };
      for (const stream of [this.child.stdout!, this.child.stderr!]) {
        const decoder = new StringDecoder("utf8");
        stream.on("data", (data: Buffer) => onData(data, decoder.write(data)));
      }
      this.child.on("error", error => { this.error = String(error); this.finish("failed"); });
      this.child.on("exit", (code, signal) => {
        this.exited = true;
        clearTimeout(this.deadline);
        clearTimeout(this.promotion);
        this.endedAt = Date.now();
        this.exitCode = code;
        this.exitSignal = signal;
        // A descendant may inherit pipes. Never wait indefinitely for 'close'.
        this.drain = setTimeout(() => this.finish(), 150);
      });
      this.child.on("close", () => this.finish());
      if (opts.timeout !== undefined) this.deadline = setTimeout(() => this.stop("timeout"), opts.timeout * 1000);
      if (opts.background) this.promote();
      else if (opts.timeout === undefined && !/^\s*sleep(?:\s|$)/.test(opts.displayCommand ?? opts.command)) {
        this.promotion = setTimeout(() => this.promote(), opts.autoPromoteMs ?? 120_000);
      }
      const abort = () => { if (!this.background) this.stop("aborted"); };
      opts.signal?.addEventListener("abort", abort, { once: true });
      this.removeAbort = () => opts.signal?.removeEventListener("abort", abort);
      if (opts.signal?.aborted) abort();
    } catch (error) { this.error = String(error); this.finish("failed"); }
  }
  promote() {
    if (this.settled || this.exited || this.background || this.termination || this.status !== "running") return false;
    this.background = true;
    clearTimeout(this.promotion);
    this.removeAbort();
    this.matchTail = "";
    this.release();
    return true;
  }
  private release() {
    if (this.resultResolved) return;
    this.resultResolved = true;
    this.resolveResult(this.snapshot());
  }
  /** ESRCH permanently relinquishes this pgid. Never reacquire a potentially recycled id. */
  probeGroup(): boolean {
    if (this.groupId === undefined) return false;
    try { process.kill(-this.groupId, 0); return true; }
    catch (error: any) {
      if (error.code === "ESRCH") this.releaseGroup();
      else this.error = `Process group probe failed: ${String(error)}`;
      return error.code !== "ESRCH";
    }
  }
  private releaseGroup() {
    this.groupId = undefined;
    this.runtime.releaseGroup(this);
  }
  private signal(signal: NodeJS.Signals) {
    if (!this.probeGroup()) return;
    try { process.kill(-this.groupId!, signal); } catch (error: any) {
      if (error.code === "ESRCH") this.releaseGroup();
      else this.error = `Process group signal failed: ${String(error)}`;
    }
  }
  stop(reason: "killed" | "timeout" | "aborted" = "killed"): Promise<Snapshot> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.cleanGroup(reason).finally(() => { this.stopPromise = undefined; });
    return this.stopPromise;
  }
  private async waitGroupGone(ms: number) {
    const until = Date.now() + ms;
    while (this.probeGroup() && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, until - Date.now()))));
    }
    return !this.probeGroup();
  }
  private async cleanGroup(reason: "killed" | "timeout" | "aborted") {
    // Result finalization and group ownership have different lifetimes. Leftover cleanup
    // never revises a saved shell result or delivers a second completion.
    const ended = this.settled;
    if (!ended) this.termination = reason;
    clearTimeout(this.deadline);
    clearTimeout(this.promotion);
    if (!this.probeGroup()) {
      this.killOutcome = ended ? "finished" : "gone";
      this.finish();
      return this.snapshot();
    }
    this.cleaning = true;
    this.signal("SIGTERM");
    let gone = await this.waitGroupGone(this.runtime.killGraceMs);
    if (!gone) {
      this.signal("SIGKILL");
      gone = await this.waitGroupGone(1000);
    }
    this.cleaning = false;
    this.killOutcome = ended ? (gone ? "cleared" : "leftover-stuck") : (gone ? "killed" : "stuck");
    if (gone || this.exited) this.finish();
    // A group still present after SIGKILL remains owned. Report it, rather than
    // claiming termination; the monitor will irrevocably retire it when empty.
    return this.snapshot();
  }
  private finish(status?: Status) {
    if (this.settled) return;
    // A killed group is not finished until escalation has cleaned its descendants.
    if (this.cleaning) return;
    this.settled = true;
    if (status) this.status = status;
    else if (this.status === "running") this.status = this.termination ?? "exited";
    this.endedAt ??= Date.now();
    clearTimeout(this.deadline);
    clearTimeout(this.promotion);
    clearTimeout(this.drain);
    this.removeAbort();
    this.child?.stdout?.destroy();
    this.child?.stderr?.destroy();
    this.output.close();
    this.probeGroup();
    this.release();
    const snapshot = this.snapshot();
    this.runtime.finished(this);
    this.resolveDone(snapshot);
  }
}

export class Runtime {
  readonly jobs = new Map<string, Job>();
  readonly directory: string;
  readonly logCap: number;
  private binding?: Binding;
  private invalidators = new Map<string, () => void>();
  private animation?: ReturnType<typeof setInterval>;
  private ownedGroups = new Set<Job>();
  private groupMonitor?: ReturnType<typeof setInterval>;
  private closed = false;
  lastError?: string;
  constructor(directory = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-background-bash"), logCap = LOG_BYTES, readonly killGraceMs = 3000) {
    this.directory = directory;
    this.logCap = logCap;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
      throw new Error(`Unsafe background bash log directory: ${directory}`);
    }
    chmodSync(directory, 0o700);
    this.prune();
  }
  bind(binding: Binding) {
    this.binding = binding;
    for (const job of this.jobs.values()) if (job.completed) this.flush(job);
  }
  unbind() {
    this.binding = undefined;
    this.invalidators.clear();
    clearInterval(this.animation);
    this.animation = undefined;
  }
  watch(toolCallId: string, invalidate: () => void) {
    if (!this.binding || this.closed) return;
    const job = this.jobs.get(toolCallId);
    if (!job || job.completed) return;
    this.invalidators.set(toolCallId, invalidate);
    this.animate();
  }
  private animate() {
    if (this.animation || !this.binding || ![...this.jobs.values()].some(j => !j.completed)) return;
    this.animation = setInterval(() => {
      for (const [id, invalidate] of this.invalidators) {
        if (!this.jobs.has(id)) continue;
        try { invalidate(); } catch { this.invalidators.delete(id); }
      }
    }, 100);
    this.animation.unref?.();
  }
  trackGroup(job: Job) {
    this.ownedGroups.add(job);
    this.groupMonitor ??= setInterval(() => {
      for (const owned of this.ownedGroups) owned.probeGroup();
    }, 1000);
    this.groupMonitor.unref?.();
  }
  releaseGroup(job: Job) {
    this.ownedGroups.delete(job);
    if (!this.ownedGroups.size) {
      clearInterval(this.groupMonitor);
      this.groupMonitor = undefined;
    }
  }
  start(options: StartOptions) {
    if (this.closed) throw new Error("Background bash session is closed");
    if (process.platform === "win32") throw new Error("Background bash requires POSIX process groups");
    if (options.signal?.aborted) throw new Error("Command aborted before spawn");
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > 2_147_483_647)) {
      throw new Error("timeout must be positive and at most 2147483.647 seconds");
    }
    if (options.waitFor !== undefined && (!options.waitFor.length || options.waitFor.length > 4096)) throw new Error("waitFor must contain 1-4096 characters");
    if (this.jobs.has(options.toolCallId)) throw new Error("Duplicate bash tool call id");
    const job = new Job(options, this);
    this.jobs.set(options.toolCallId, job);
    job.start();
    this.animate();
    return job;
  }
  finished(job: Job) {
    const invalidate = this.invalidators.get(job.options.toolCallId);
    this.invalidators.delete(job.options.toolCallId);
    try { invalidate?.(); } catch { /* A discarded transcript is not a process failure. */ }
    if (![...this.jobs.values()].some(j => !j.completed)) {
      clearInterval(this.animation);
      this.animation = undefined;
    }
    this.flush(job);
    try { this.prune(job.output.path); } catch (error) { this.lastError = `Log retention failed: ${String(error)}`; }
  }
  private flush(job: Job) {
    if (!this.binding) return;
    try {
      const snapshot = job.snapshot();
      if (!job.persisted) { this.binding.persist(snapshot); job.persisted = true; }
      if (job.background && !job.suppressNotification && !job.queued) {
        this.binding.notify(snapshot);
        job.queued = true;
      }
    } catch (error) { this.lastError = String(error); }
  }
  async shutdown() {
    this.closed = true;
    for (const job of this.jobs.values()) job.suppressNotification = true;
    await Promise.all([...this.jobs.values()].map(job => job.stop()));
    clearInterval(this.groupMonitor);
    this.groupMonitor = undefined;
    this.unbind();
  }
  find(id: string) {
    const job = [...this.jobs.values()].find(j => j.id === id);
    if (!job) throw new Error(`Unknown task: ${id}`);
    return job;
  }
  structuredOutput(job: Job) {
    const limit = 1024 * 1024;
    const stored = job.output.stored;
    const capped = stored < job.output.bytes;
    const truncated = capped || stored > limit;
    const fd = openSync(job.output.path, "r");
    const read = (offset: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const count = readSync(fd, buffer, 0, length, offset);
      return buffer.subarray(0, count).toString("utf8");
    };
    try {
      if (!truncated) return { output: read(0, stored), truncated: false };
      const marker = "\n[... output omitted ...]\n";
      const half = Math.floor((limit - Buffer.byteLength(marker)) / 2);
      const head = read(0, Math.min(half, stored));
      const tail = capped ? job.output.text() : read(Math.max(0, stored - half), Math.min(half, stored));
      return { output: head + marker + tail, truncated: true, full_output_path: job.output.path };
    } finally { closeSync(fd); }
  }
  read(job: Job, latest = false, filter?: string, signal?: AbortSignal) {
    // Serialize each cursor transaction, including worker evaluation. Errors never consume output.
    const result = job.readQueue.then(() => this.readChunk(job, latest, filter, signal));
    job.readQueue = result.then(() => {}, () => {});
    return result;
  }
  private async readChunk(job: Job, latest: boolean, filter?: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("Output read aborted");
    if (filter && filter.length > 512) throw new Error("filter is limited to 512 characters");
    const available = job.output.stored;
    const offset = latest ? Math.max(job.cursor, available - TAIL_BYTES) : job.cursor;
    const buffer = Buffer.alloc(Math.min(TAIL_BYTES, available - offset));
    const fd = openSync(job.output.path, "r");
    let count: number;
    try { count = readSync(fd, buffer, 0, buffer.length, offset); } finally { closeSync(fd); }
    let newlines = 0;
    for (let i = 0; i < count; i++) {
      if (!latest && buffer[i] === 10 && ++newlines === 2000) { count = i + 1; break; }
    }
    const cursor = offset + count;
    const skipped = offset > job.cursor;
    let text = buffer.subarray(0, count).toString("utf8");
    // Once the disk cap is reached, retain access to fresh output through the rolling tail.
    if (job.output.bytes > available && (latest || count === 0)) {
      text = `[Log capped; recent tail follows, possibly overlapping]\n${job.output.text()}`;
    }
    if (filter) text = await filterOutput(text, filter, signal);
    if (signal?.aborted) throw new Error("Output read aborted");
    job.cursor = cursor;
    const lines = text.split("\n");
    return { text: latest ? lines.slice(-2000).join("\n") : text, remaining: job.output.stored - cursor,
      truncated: skipped || cursor < available || job.output.bytes > available || (latest && lines.length > 2000) };
  }
  private prune(protectedPath?: string) {
    // Preserve every active writer across reloads/runtimes and other live Pi processes.
    // Our own completed logs participate in retention even during a long-running session.
    const files = readdirSync(this.directory).filter(name => /^\d+-\d+-[0-9a-f-]{36}\.log$/.test(name))
      .filter(name => {
        if (join(this.directory, name) === protectedPath || activeLogs.has(join(this.directory, name))) return false;
        const pid = Number(name.split("-")[1]);
        if (pid === process.pid) return true;
        try { process.kill(pid, 0); return false; }
        catch (error: any) { return error.code === "ESRCH"; }
      })
      .map(name => ({ path: join(this.directory, name), time: Number(name.split("-")[0]) }))
      .sort((a, b) => b.time - a.time);
    for (const [index, file] of files.entries()) {
      // Keep the just-completed log available for its pending structured tool result.
      if (index < (protectedPath ? 99 : 100) && file.time > Date.now() - 7 * 86400_000) continue;
      try { if (lstatSync(file.path).isFile()) unlinkSync(file.path); }
      catch (error: any) { if (error.code !== "ENOENT") throw error; }
    }
  }
}

export function snapshotFrom(value: unknown): Snapshot | undefined {
  const s = value as Snapshot | undefined;
  return s?.version === 1 && typeof s.toolCallId === "string" && typeof s.id === "string"
    && typeof s.output === "string" && typeof s.command === "string" && typeof s.startedAt === "number" ? s : undefined;
}
