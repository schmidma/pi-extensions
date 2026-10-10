import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ENTRY_TYPE = "tool-replay.handle";
const HANDLE_PATTERN = "^r[1-9a-z][0-9a-z]*$";
const handlePattern = new RegExp(HANDLE_PATTERN);

interface ReplayHandle {
  version: 1;
  handle: string;
  assistantEntryId: string;
  callIndex: number;
  cwd: string;
}

function handleNumber(handle: unknown): bigint | undefined {
  if (typeof handle !== "string" || handlePattern.exec(handle)?.[0] !== handle) return undefined;
  let number = 0n;
  for (const digit of handle.slice(1)) number = number * 36n + BigInt(parseInt(digit, 36));
  return number;
}

function isReplayHandle(data: unknown): data is ReplayHandle {
  if (!data || typeof data !== "object") return false;
  const record = data as ReplayHandle;
  return record.version === 1 && handleNumber(record.handle) !== undefined &&
    typeof record.assistantEntryId === "string" && Number.isSafeInteger(record.callIndex) &&
    record.callIndex >= 0 && typeof record.cwd === "string";
}

const marker = (handle: string) => ({ type: "text" as const, text: `[Replay handle: ${handle}]` });

export default function toolReplay(pi: ExtensionAPI) {
  const handles = new Map<string, ReplayHandle>();
  const calls = new Map<string, { assistantEntryId: string; callIndex: number }>();
  const branchIds = new Set<string>();
  let nextHandle = 1n;
  let indexedLeafId: string | null = null;
  let sessionId: string | undefined;

  function reserve(entry: SessionEntry) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) return;
    const number = handleNumber((entry.data as Partial<ReplayHandle> | undefined)?.handle);
    if (number !== undefined && number >= nextHandle) nextHandle = number + 1n;
  }

  function index(entry: SessionEntry) {
    branchIds.add(entry.id);
    reserve(entry);
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE && isReplayHandle(entry.data)) {
      handles.set(entry.data.handle, entry.data);
    }
    if (entry.type !== "message" || entry.message.role !== "assistant") return;
    entry.message.content.forEach((block, callIndex) => {
      if (block.type === "toolCall") calls.set(block.id, { assistantEntryId: entry.id, callIndex });
    });
  }

  function rebuild(ctx: ExtensionContext) {
    handles.clear();
    calls.clear();
    branchIds.clear();
    nextHandle = 1n;
    // Reserve abandoned-branch handles too: a handle must never change meaning after /tree.
    for (const entry of ctx.sessionManager.getEntries()) reserve(entry);
    for (const entry of ctx.sessionManager.getBranch()) index(entry);
    indexedLeafId = ctx.sessionManager.getLeafId();
    sessionId = ctx.sessionManager.getSessionId();
  }

  function sync(ctx: ExtensionContext) {
    if (sessionId !== ctx.sessionManager.getSessionId()) return rebuild(ctx);
    // Usually only the latest assistant/result entries need indexing, not the whole session.
    const tail: SessionEntry[] = [];
    let entry = ctx.sessionManager.getLeafEntry();
    while (entry && entry.id !== indexedLeafId) {
      tail.push(entry);
      entry = entry.parentId ? ctx.sessionManager.getEntry(entry.parentId) : undefined;
    }
    if (indexedLeafId !== null && !entry) return rebuild(ctx);
    for (const item of tail.reverse()) index(item);
    indexedLeafId = ctx.sessionManager.getLeafId();
  }

  pi.on("session_start", (_event, ctx) => rebuild(ctx));
  pi.on("session_tree", (_event, ctx) => rebuild(ctx));

  pi.on("tool_result", (event, ctx) => {
    if (event.parentToolCallId !== undefined || event.toolName === "replay_tool") return;
    const tool = pi.getAllTools().find(tool => tool.name === event.toolName);
    if (!tool || tool.exposure === "hidden" || tool.exposure === "model-only") return;
    sync(ctx);
    const reference = calls.get(event.toolCallId);
    if (!reference) return;
    const entry = ctx.sessionManager.getEntry(reference.assistantEntryId);
    if (entry?.type !== "message" || entry.message.role !== "assistant") return;
    const call = entry.message.content[reference.callIndex];
    if (call?.type !== "toolCall" || call.name !== event.toolName) return;

    const record: ReplayHandle = {
      version: 1, handle: `r${(nextHandle++).toString(36)}`, ...reference, cwd: ctx.cwd,
    };
    // Allocate and persist synchronously, including when sibling tools finish concurrently.
    pi.appendEntry(ENTRY_TYPE, record);
    handles.set(record.handle, record);
    return {
      content: [...event.content, marker(record.handle)],
      details: event.details,
      structuredContent: event.structuredContent,
    };
  });

  pi.registerTool({
    name: "replay_tool",
    label: "Replay tool",
    exposure: "model-only",
    description: "Execute a previous tool call AGAIN using its [Replay handle: rX] and original arguments, not cached results. Side effects happen again. Uses CURRENT tool availability, argument validation, permission/hooks, and environment. Handles are session/branch-local; hidden and model-only tools cannot be replayed.",
    parameters: Type.Object({ handle: Type.String({ pattern: HANDLE_PATTERN, description: "Replay handle from a previous tool result, e.g. r1" }) }),
    async execute(_toolCallId, { handle }, signal, onUpdate, ctx) {
      if (handleNumber(handle) === undefined) throw new Error("Malformed replay handle");
      sync(ctx);
      const record = handles.get(handle);
      if (!record) throw new Error(`Unknown or off-branch replay handle: ${handle}`);
      if (record.cwd !== ctx.cwd) throw new Error(`Working directory changed for replay handle: ${handle}`);
      if (!branchIds.has(record.assistantEntryId)) throw new Error(`Off-branch replay source: ${handle}`);
      const entry = ctx.sessionManager.getEntry(record.assistantEntryId);
      if (entry?.type !== "message" || entry.message.role !== "assistant") throw new Error(`Missing replay source: ${handle}`);
      const call = entry.message.content[record.callIndex];
      if (call?.type !== "toolCall") throw new Error(`Missing replay tool call: ${handle}`);
      if (call.name === "replay_tool") throw new Error("Cannot replay replay_tool");
      if (!ctx.tools.some(tool => tool.name === call.name)) throw new Error(`Replay target unavailable or not callable: ${call.name}`);

      const { result, isError } = await ctx.executeTool(call.name, structuredClone(call.arguments), {
        signal,
        onUpdate: onUpdate ? update => {
          const { usage: _usage, ...partial } = update;
          onUpdate(partial);
        } : undefined,
      });
      // Pi automatically aggregates nested usage onto our result. Do not count it twice.
      const { usage: _usage, ...replayed } = result;
      return { ...replayed, isError, content: [...result.content, marker(handle)] };
    },
  });
}
