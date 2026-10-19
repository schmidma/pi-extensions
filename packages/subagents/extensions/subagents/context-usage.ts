import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateTokens, getLatestCompactionEntry,
  type ContextUsage, type SessionEntry, type SessionProjection } from "@earendil-works/pi-coding-agent";

export function formatContextUsage(usage: ContextUsage | undefined): string {
  const percent = usage?.percent;
  return typeof percent === "number" && Number.isFinite(percent) ? `${percent.toFixed(1)}%` : "?%";
}

/** Old live services and unavailable history must remain inspectable. */
export function readContextUsage<T extends unknown[]>(source: { getContextUsage?(...args: T): ContextUsage | undefined }, ...args: T): ContextUsage | undefined {
  try { return source.getContextUsage?.(...args); } catch { return undefined; }
}

function validUsage(message: AgentMessage): boolean {
  return message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error" &&
    !!message.usage && calculateContextTokens(message.usage) > 0;
}

/** Read-only equivalent of native usage estimation, using public projection/token APIs.
 * A saved physical child has no historical context-window snapshot; its caller
 * supplies only the currently available exact model's window, never the root's.
 */
export function projectedContextUsage(projection: SessionProjection, branch: SessionEntry[], contextWindow: number | undefined): ContextUsage | undefined {
  if (!contextWindow || contextWindow <= 0) return undefined;
  const positions = new Map(branch.map((entry, index) => [entry.id, index]));
  const compaction = getLatestCompactionEntry(branch);
  const projected = projection.entries.flatMap(entry => entry.messages.map(message => ({ message, position: positions.get(entry.sourceEntry.id) ?? -1 })));
  if (compaction && !projected.some(({ message, position }) => validUsage(message) && position > positions.get(compaction.id)!)) {
    return { tokens: null, contextWindow, percent: null };
  }
  const lastUsage = projected.findLastIndex(({ message }) => validUsage(message));
  const invalidating = branch.findLastIndex(entry => entry.type === "context_edit" || entry.type === "compaction");
  let tokens: number;
  if (lastUsage >= 0 && projected[lastUsage].position > invalidating) {
    const message = projected[lastUsage].message;
    tokens = message.role === "assistant" ? calculateContextTokens(message.usage) : 0;
    for (const { message } of projected.slice(lastUsage + 1)) tokens += estimateTokens(message);
  } else {
    const system = getCurrentSystemMessage(projection.messages);
    tokens = system ? estimateTokens(system) : 0;
    for (const message of projection.messages) if (message.role !== "system") tokens += estimateTokens(message);
  }
  return { tokens, contextWindow, percent: tokens / contextWindow * 100 };
}
