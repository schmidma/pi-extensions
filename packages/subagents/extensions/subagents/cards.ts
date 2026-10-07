import { getMarkdownTheme, type ExtensionAPI, type MessageRenderer, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { REPORT_TYPE, type RunRecord, type SubagentRecord } from "./state.ts";
import { compactLine, metadataText, objectFields, panelBackground, proseText, runElapsed, shortId, statusColor, statusMark, stringField } from "./presentation.ts";
import type { DisplayStatus } from "./tree.ts";

export type RecordLookup = (id: string) => SubagentRecord | undefined;
export type RunLookup = (id: string) => Readonly<RunRecord> | undefined;
const noLookup: RecordLookup = () => undefined;
const noRunLookup: RunLookup = () => undefined;
const cardBox = (theme: Parameters<MessageRenderer>[2]) => new Box(1, 1, text => panelBackground(theme, text));
const labels = { spawn_subagent: "Spawn subagent", resume_subagent: "Resume subagent", steer_subagent: "Steer subagent" };
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.flatMap(block => {
    const fields = objectFields(block);
    return fields.type === "text" && typeof fields.text === "string" ? [fields.text] : [];
  }).join("\n") : "";
}

/** Rendering only: lookup is synchronous and must never activate a model runtime. */
export function delegationRenderers(name: string, lookup: RecordLookup = noLookup): ToolRenderers | undefined {
  if (!Object.hasOwn(labels, name)) return undefined;
  const label = labels[name as keyof typeof labels];
  const steer = name === "steer_subagent";
  return {
    renderShell: "self",
    renderCall(rawArgs, theme, context) {
      const args = objectFields(rawArgs);
      // One shell owns both slots, including native padding. A concrete fallback
      // keeps System's transparent panels visible without imposing a dark theme.
      const card = cardBox(theme);
      const resultBody = new Container();
      context.state.subagentResultBody = resultBody;
      // Result rendering shares state with this call slot. Resolve at draw time so an
      // acknowledgement also names historical resume calls with no live registry.
      card.addChild(compactLine(() => {
        const info = objectFields(context.state.subagentCard);
        const id = stringField(info.agent_id) ?? stringField(args.agent_id);
        const needsName = !stringField(info.name) && !stringField(args.name);
        const needsMetadata = !steer && !context.expanded &&
          ((!stringField(info.model) && !stringField(args.model)) || !stringField(info.effectiveThinking));
        const saved = id && (needsName || needsMetadata) ? lookup(id) : undefined;
        const title = stringField(info.name) ?? stringField(args.name) ?? saved?.name ?? id ?? "...";
        const identity = id && title !== id ? ` [${shortId(id)}]` : "";
        let line = theme.fg("toolTitle", theme.bold(`${label}:`) + ` ${metadataText(title)}`) + theme.fg("dim", identity);
        if (!steer && !context.expanded) {
          const model = stringField(info.model) ?? stringField(args.model) ?? saved?.model;
          const thinking = stringField(info.effectiveThinking) ?? saved?.effectiveThinking ?? stringField(args.thinking);
          if (model || thinking) line += theme.fg("muted", ` · ${[model, thinking ? `thinking: ${thinking}` : undefined]
            .filter(Boolean).map(value => metadataText(value!)).join(" · ")}`);
        }
        return line;
      }));
      if (!steer && context.expanded) card.addChild({
        render(width) {
          const info = objectFields(context.state.subagentCard);
          const id = stringField(info.agent_id) ?? stringField(args.agent_id);
          const needsMetadata = (!stringField(info.model) && !stringField(args.model)) ||
            (!stringField(info.requestedThinking) && !stringField(args.thinking)) || !stringField(info.effectiveThinking);
          const saved = id && needsMetadata ? lookup(id) : undefined;
          const model = stringField(info.model) ?? stringField(args.model) ?? saved?.model;
          const requested = stringField(info.requestedThinking) ?? stringField(args.thinking) ?? saved?.requestedThinking;
          const effective = stringField(info.effectiveThinking) ?? saved?.effectiveThinking;
          const thinking = effective && requested && effective !== requested ? `${effective} (requested ${requested})` : effective ?? requested;
          if (!model && !thinking) return [];
          return compactLine(() => theme.fg("muted", [model, thinking ? `thinking: ${thinking}` : undefined]
            .filter(Boolean).map(value => metadataText(value!)).join(" · "))).render(width);
        }, invalidate() {},
      });
      if (context.expanded) {
        const body = stringField(args[steer ? "message" : "prompt"]);
        if (body) {
          card.addChild(new Text(theme.fg("muted", steer ? "Guidance:" : "Task:"), 0, 0));
          card.addChild(new Text(proseText(body), 0, 0));
        }
        if (stringField(args.role)) card.addChild(new Text(theme.fg("dim", `Role: ${metadataText(args.role as string)}`), 0, 0));
      }
      card.addChild(resultBody);
      return { render: width => width <= 0 ? [] : card.render(Math.max(3, width)).map(line => truncateToWidth(line, width)),
        invalidate: () => card.invalidate() };
    },
    renderResult(result, options, theme, context) {
      const body = context.state.subagentResultBody as Container | undefined;
      body?.clear();
      const show = (component?: import("@earendil-works/pi-tui").Component) => {
        if (component) body?.addChild(component);
        return { render: () => [], invalidate() {} };
      };
      const output = proseText(contentText(result.content));
      const details = objectFields(result.details);
      if (!context.isError && !options.isPartial) context.state.subagentCard = details;
      if (context.isError) {
        const error = output || "Subagent tool failed without an error message.";
        if (options.expanded) return show(new Text(theme.fg("error", error), 0, 0));
        return show(compactLine(() => theme.fg("error", `Error: ${metadataText(error).trim()}`)));
      }
      if (options.isPartial) return show();
      // Unknown/historical results must not be reclassified as a successful acceptance.
      const accepted = stringField(details.agent_id) && (steer || stringField(details.run_id));
      if (!accepted) return show(options.expanded ? new Text(output || "[No tool output]", 0, 0)
        : compactLine(() => theme.fg("muted", metadataText(output || "[No tool output]"))));
      const card = new Container();
      if (options.expanded) {
        const id = stringField(details.agent_id), run = stringField(details.run_id);
        card.addChild(new Text(theme.fg("dim", [`agent_id: ${metadataText(id!)}`, ...(run ? [`run_id: ${metadataText(run)}`] : [])].join("\n")), 0, 0));
      }
      return show(card);
    },
  };
}

const outcomeStatus = (value: unknown): DisplayStatus | undefined => value === "completed" ? "finished"
  : typeof value === "string" && ["finished", "error", "aborted", "interrupted"].includes(value) ? value as DisplayStatus : undefined;

/** Exact logical run only, never the agent's latest resumed generation or tool timing. */
function elapsedSeconds(runId: string | undefined, agentIds: string[], lookup: RunLookup): string | undefined {
  if (!runId) return undefined;
  const run = lookup(runId);
  if (!run || run.id !== runId || run.phase !== "terminal" || !stringField(run.agentId) || agentIds.some(id => run.agentId !== id)
    || typeof run.startedAt !== "string" || typeof run.endedAt !== "string") return undefined;
  return runElapsed(run);
}

export function reportRenderer(lookup: RecordLookup = noLookup, lookupRun: RunLookup = noRunLookup): MessageRenderer {
  return (message, { expanded }, theme) => {
    const original = contentText(message.content);
    const full = proseText(original || "[No final assistant text in this run.]");
    const details = objectFields(message.details);
    const first = original.split(/\r?\n/, 1)[0];
    const heading = /^Subagent (.+) - (completed|finished|error|aborted|interrupted)$/.exec(first);
    const agentIds = [stringField(details.agentId), stringField(details.agent_id), stringField(details.specialistId),
      stringField(/^agent_id: ([^\r\n]+)\r?$/m.exec(original)?.[1])].filter((id): id is string => !!id);
    const id = agentIds[0];
    const runIds = [stringField(details.runId), stringField(details.deliveryId), stringField(details.invocationId),
      stringField(/^run_id: ([^\r\n]+)\r?$/m.exec(original)?.[1])].filter((value): value is string => !!value);
    const runId = runIds.every(value => value === runIds[0]) ? runIds[0] : undefined;
    const name = stringField(details.name) ?? heading?.[1] ?? (id ? lookup(id)?.name : undefined);
    const status = outcomeStatus(details.outcome) ?? outcomeStatus(objectFields(details.outcome).status) ?? outcomeStatus(heading?.[2]);
    const card = cardBox(theme);
    // Hydration can precede session_start attachment. Resolve duration at draw time
    // so an initially unavailable read-only registry does not freeze missing timing.
    card.addChild(compactLine(() => {
      const elapsed = elapsedSeconds(runId, agentIds, lookupRun);
      return (status ? theme.fg(statusColor(status), `${statusMark[status]} `) : "")
        + theme.fg("customMessageLabel", theme.bold(name ? metadataText(name) : "Subagent report"))
        + (id ? theme.fg("dim", ` [${shortId(id)}]`) : "")
        + (status && status !== "finished" ? ` · ${theme.fg(statusColor(status), status)}` : "")
        + (elapsed ? theme.fg("muted", ` · ${elapsed}`) : "");
    }));
    // CustomMessageComponent delegates its entire shell to this renderer. Box owns
    // the padding once; expanded Markdown retains every original report line.
    if (expanded) card.addChild(new Markdown(full, 0, 0, getMarkdownTheme(), { color: text => theme.fg("customMessageText", text) }));
    return { render: width => width <= 0 ? [] : card.render(Math.max(3, width)).map(line => truncateToWidth(line, width)),
      invalidate: () => card.invalidate() };
  };
}

export function registerReportRenderer(pi: ExtensionAPI, lookup: RecordLookup, lookupRun: RunLookup = noRunLookup): void {
  pi.registerMessageRenderer(REPORT_TYPE, reportRenderer(lookup, lookupRun));
}
