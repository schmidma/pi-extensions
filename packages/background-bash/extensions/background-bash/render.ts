import { stripVTControlCharacters } from "node:util";
import { createBashToolDefinition, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Snapshot } from "./runtime.ts";
type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type Result = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
type Phase = "running" | "success" | "failure" | "cancelled";
// Use the public renderer contract, like the host: each invocation begins with
// an empty state object, without depending on the native renderer's internals.
const native = createBashToolDefinition(process.cwd()) as ToolRenderers;
type BashArgs = { command: string; timeout?: number };
const headingDecorator = Symbol.for("pi-extensions.tool-heading-decorator");

function clean(text: string) {
  return stripVTControlCharacters(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .replace(/[^\S\n ]/g, " ").replace(/[\x00-\x08\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\ufff9-\ufffb]/g, "");
}
function duration(snapshot: Snapshot) {
  if (snapshot.status === "unavailable") return "duration unknown";
  const seconds = Math.max(0, ((snapshot.endedAt ?? Date.now()) - snapshot.startedAt) / 1000);
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}
function status(snapshot: Snapshot) {
  if (snapshot.status === "running" && snapshot.termination) return `stopping (${snapshot.termination})`;
  return snapshot.status === "exited" ? `exit ${snapshot.exitCode ?? snapshot.signal ?? "unknown"}` : snapshot.status;
}
export function summary(snapshot: Snapshot) { return `${snapshot.id} | ${status(snapshot)} | ${duration(snapshot)}`; }

function phase(snapshot: Snapshot): Phase {
  if (snapshot.status === "running") return "running";
  if (["aborted", "killed", "unavailable"].includes(snapshot.status)) return "cancelled";
  return snapshot.status === "exited" && snapshot.exitCode === 0 ? "success" : "failure";
}
function processResult(snapshot: Snapshot, args: BashArgs): Result {
  let text = snapshot.output;
  const append = (message: string) => { text += `${text ? "\n\n" : ""}${message}`; };
  if (snapshot.status === "exited") {
    text ||= "(no output)";
    if (snapshot.exitCode !== 0) append(snapshot.exitCode == null
      ? "Command terminated without an exit code" : `Command exited with code ${snapshot.exitCode}`);
  } else if (snapshot.status === "aborted" || snapshot.status === "killed") append("Command aborted");
  else if (snapshot.status === "timeout") append(`Command timed out after ${args.timeout} seconds`);
  else if (snapshot.status === "unavailable") append("No live process or saved completion in this branch (unavailable).");
  if (snapshot.error) append(snapshot.error);
  return { content: [{ type: "text", text }], details: snapshot.truncated ? { fullOutputPath: snapshot.logPath } : undefined };
}

// Pi has no public clock-origin/disposal hook. Keep its native renderers' clocks
// disabled and let the process runtime own redraws. Only the live timing line
// needs composition here; final timing is rendered by Pi using durationMs.
function elapsed(snapshot: Snapshot) {
  const seconds = Math.max(0, (Date.now() - snapshot.startedAt) / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const total = Math.floor(seconds), minutes = Math.floor(total / 60);
  return minutes < 60 ? `${minutes}m ${total % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ${total % 60}s`;
}

/** Pi's default Box composition, with process-owned shell state. The host's
 * default shell cannot stay pending after the tool acknowledgement. Command,
 * output, visual preview/expansion, warnings and final timing remain native. */
export function card(
  args: BashArgs, theme: Theme, context: ToolRenderContext,
  lookup: () => Snapshot | undefined,
): Component {
  return {
    invalidate() {},
    render(width) {
      if (width <= 0) return [];
      const snapshot = lookup();
      const ownedPhase = snapshot && phase(snapshot);
      const isPartial = snapshot ? ownedPhase === "running" : context.isPartial;
      const isError = snapshot ? ownedPhase === "failure" || ownedPhase === "cancelled" : context.isError;
      const effective = { ...context, args, state: {}, lastComponent: undefined, executionStarted: false,
        isPartial, isError, durationMs: snapshot
          ? snapshot.endedAt === undefined || snapshot.status === "unavailable" ? undefined : Math.max(0, snapshot.endedAt - snapshot.startedAt)
          : context.durationMs };
      const box = new Box(context.outputPad ?? 1, 1,
        text => theme.bg(isPartial ? "toolPendingBg" : isError ? "toolErrorBg" : "toolSuccessBg", text));
      let heading = native.renderCall!(args, theme, effective);
      const decorate = (context as ToolRenderContext & { [headingDecorator]?: (heading: Component, phase: () => Phase | undefined) => Component })[headingDecorator];
      if (decorate) heading = decorate(heading, () => ownedPhase);
      box.addChild(heading);
      const result = snapshot ? processResult(snapshot, args) : context.state.result as Result | undefined;
      if (result) {
        box.addChild(native.renderResult!(result, { expanded: context.expanded, isPartial }, theme, effective));
        if (snapshot?.status === "running") box.addChild(new Text(`\n${theme.fg("muted", `Elapsed ${elapsed(snapshot)}`)}`, 0, 0));
      }
      return box.render(width);
    },
  };
}

export function saveResult(result: Result, context: ToolRenderContext): Component {
  context.state.result = result;
  return new Container();
}

export function completionCard(snapshot: Snapshot, expanded: boolean, theme: Theme, outputPad = 1): Component {
  return {
    invalidate() {},
    render(width) {
      if (width <= 0) return [];
      const ownedPhase = phase(snapshot);
      const cancelled = ownedPhase === "cancelled";
      const succeeded = ownedPhase === "success";
      const marker = theme.fg(succeeded ? "success" : cancelled ? "dim" : "error", succeeded ? "✓" : cancelled ? "-" : "×");
      const command = clean(snapshot.command);
      const resultStatus = cancelled ? `cancelled (${status(snapshot)})` : status(snapshot);
      const box = new Box(outputPad, 1, text => theme.bg(succeeded ? "toolSuccessBg" : "toolErrorBg", text));
      box.addChild({
        invalidate() {},
        render(innerWidth) {
          // Truncation inserts ANSI resets even for plain text. Strip those before
          // styling so the ellipsis cannot reset the heading or its enclosing background.
          const preview = stripVTControlCharacters(truncateToWidth(command.replace(/\s+/g, " ").trim(), Math.max(0, Math.min(72, innerWidth - 4))));
          const detail = stripVTControlCharacters(truncateToWidth(`${clean(resultStatus)} · ${duration(snapshot)} · completion delivered`, innerWidth));
          return [truncateToWidth(`${marker} ${theme.fg("toolTitle", theme.bold(`$ ${preview}`))}`, innerWidth, ""),
            theme.fg("muted", detail)];
        },
      });
      if (expanded) {
        box.addChild(new Text(`\n${theme.fg("toolTitle", theme.bold(`$ ${command}`))}`, 0, 0));
        box.addChild(new Text(theme.fg("muted", clean(`Task ${snapshot.id} · Log: ${snapshot.logPath}${snapshot.truncated ? " (truncated)" : ""}`)), 0, 0));
        box.addChild(new Text(theme.fg("toolOutput", clean(snapshot.output).split("\n").slice(-30).join("\n") || "(no output)"), 0, 0));
        if (snapshot.error) box.addChild(new Text(theme.fg("error", clean(snapshot.error)), 0, 0));
      }
      return box.render(width).map(line => truncateToWidth(line, width, ""));
    },
  };
}
