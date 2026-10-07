import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "./state.ts";
import { agentTree, type TreeNode } from "./tree.ts";

export const RELEVANT_ACK_TYPE = "subagents.relevant-ack.v1";
export interface RelevantAcknowledgment { version: 1; runIds: string[] }

/** Restore UI preference from the active native branch, including before compaction. */
export function acknowledgedRuns(branch: readonly SessionEntry[]): Set<string> {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== RELEVANT_ACK_TYPE) continue;
    const data: unknown = entry.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const marker = data as Partial<RelevantAcknowledgment>;
    if (marker.version === 1 && Array.isArray(marker.runIds) && marker.runIds.every(id => typeof id === "string" && id.length > 0)) {
      return new Set(marker.runIds);
    }
  }
  return new Set();
}

/** Unacknowledged work plus contextual ancestors; All remains the full registry tree. */
export function relevantTree(state: SubagentState, acknowledged: ReadonlySet<string>): { nodes: TreeNode[]; members: Set<string> } {
  const members = new Set(Object.values(state.runs).filter(run => !acknowledged.has(run.id)).map(run => run.agentId));
  const included = new Set(members);
  for (const id of members) {
    let parent = state.subagents[id]?.parentId;
    const visited = new Set<string>([id]);
    while (parent && state.subagents[parent] && !visited.has(parent)) {
      visited.add(parent); included.add(parent); parent = state.subagents[parent].parentId;
    }
  }
  return { nodes: agentTree(state).filter(node => included.has(node.record.id)), members };
}
