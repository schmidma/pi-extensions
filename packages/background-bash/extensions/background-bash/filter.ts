import { Worker } from "node:worker_threads";

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const regex = new RegExp(workerData.pattern);
  parentPort.postMessage({ text: workerData.text.split('\\n').filter(line => regex.test(line)).join('\\n') });
} catch (error) { parentPort.postMessage({ error: String(error) }); }
`;

/** One worker at a time, including termination, with a bounded backlog across reloads/sessions. */
class FilterQueue {
  private pending = 0;
  private tail: Promise<void> = Promise.resolve();
  run(text: string, pattern: string, signal?: AbortSignal): Promise<string> {
    if (this.pending >= 16) return Promise.reject(new Error("Too many pending output filters; retry after existing reads finish"));
    this.pending++;
    const result = this.tail.then(() => this.evaluate(text, pattern, signal));
    this.tail = result.then(() => {}, () => {}).finally(() => { this.pending--; });
    return result;
  }
  private async evaluate(text: string, pattern: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error("Output read aborted");
    const worker = new Worker(workerSource, { eval: true, workerData: { text, pattern }, execArgv: [] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    try {
      return await new Promise<string>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Output filter exceeded its 500ms limit; cursor unchanged")), 500);
        abort = () => reject(new Error("Output read aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        worker.once("message", result => result.error ? reject(new Error(result.error)) : resolve(result.text));
        worker.once("error", reject);
        worker.once("exit", code => reject(new Error(`Output filter worker exited unexpectedly (${code})`)));
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // Do not start another worker until the old one is really gone, including on timeout.
      await worker.terminate();
    }
  }
}
const key = Symbol.for("pi-extensions.background-bash.filters.v1");
const globals = globalThis as typeof globalThis & { [key]?: FilterQueue };
const filters = globals[key] ??= new FilterQueue();
export const filterOutput = (text: string, pattern: string, signal?: AbortSignal) => filters.run(text, pattern, signal);
