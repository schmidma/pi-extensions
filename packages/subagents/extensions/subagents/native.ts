import {
  AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, BashExecutionComponent,
  CustomMessageComponent, CompactionSummaryMessageComponent, BranchSummaryMessageComponent,
  createBashToolDefinition, createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createPowerShellToolDefinition,
  type MessageRenderer, type ToolRenderers, type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { reportRenderer } from "./cards.ts";
import { REPORT_TYPE } from "./state.ts";

/** Uses only public definition factories, never executes their tools. */
export function builtInRenderers(cwd: string): (name: string) => ToolRenderers | undefined {
  const factories = {
    bash: createBashToolDefinition, read: createReadToolDefinition, edit: createEditToolDefinition,
    write: createWriteToolDefinition, find: createFindToolDefinition, grep: createGrepToolDefinition,
    ls: createLsToolDefinition, powershell: createPowerShellToolDefinition,
  };
  const cache = new Map<string, ToolRenderers>();
  return name => {
    if (!Object.hasOwn(factories, name)) return undefined;
    const factory = factories[name as keyof typeof factories];
    if (!cache.has(name)) {
      const { renderCall, renderResult, renderShell } = factory(cwd);
      // Public factories keep their individual argument schemas. ToolExecutionComponent
      // accepts the erased ToolRenderers contract and supplies the matching native args.
      cache.set(name, { renderCall, renderResult, renderShell } as ToolRenderers);
    }
    return cache.get(name);
  };
}

function textContent(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content.map(block => block.type === "text" ? block.text : "[Image omitted in preview]").join("\n");
}

export function nativeMessage(message: AgentMessage, ui: TUI, hideThinking: boolean, renderer?: MessageRenderer): Component | undefined {
  switch (message.role) {
    case "user": return new UserMessageComponent(textContent(message.content));
    case "assistant": return new AssistantMessageComponent(message, hideThinking);
    case "bashExecution": {
      const component = new BashExecutionComponent(message.command, ui, message.excludeFromContext);
      component.appendOutput(message.output);
      // Persisted shell messages retain only this flag, as in Pi's own hydration path.
      const truncation = message.truncated ? { truncated: true } as TruncationResult : undefined;
      component.setComplete(message.exitCode, message.cancelled, truncation, message.fullOutputPath);
      return component;
    }
    case "custom":
      if (!message.display) return undefined;
      return new CustomMessageComponent({ ...message, content: textContent(message.content) },
        renderer ?? (message.customType === REPORT_TYPE ? reportRenderer() : undefined));
    case "compactionSummary": return new CompactionSummaryMessageComponent(message);
    case "branchSummary": return new BranchSummaryMessageComponent(message);
    case "system": case "toolResult": return undefined;
    default: return new Text("[Unsupported message role omitted in preview]", 0, 0);
  }
}

export function nativeTool(name: string, id: string, args: unknown, renderers: ToolRenderers | undefined, ui: TUI, cwd: string): ToolExecutionComponent {
  return new ToolExecutionComponent(name, id, args, { showImages: false }, renderers, ui, cwd);
}

/** Image protocols are not line-safe. Reject an entire rendered row before viewport clipping. */
export function safeTextLines(lines: string[]): string[] {
  if (/(?:\x1b[P_]|\x1b\]1337;|[\u0090\u009f]|\u009d1337;)/.test(lines.join("\n"))) {
    return ["[Image/control output omitted in preview]"];
  }
  // Native user rows carry shell integration prompt markers. A preview must not
  // create a second terminal command zone inside the active main transcript.
  return lines.map(line => line.replace(/\x1b\]133;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ""));
}
