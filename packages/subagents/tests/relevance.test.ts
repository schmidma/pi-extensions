import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { acknowledgedRuns, RELEVANT_ACK_TYPE } from "../extensions/subagents/relevance.ts";

test("native file metadata restores only the active branch and survives compaction without context reinjection", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-relevant-marker-"));
  try {
    const manager = SessionManager.create(directory, directory);
    const root = manager.appendMessage({ role: "user", content: "original task", timestamp: 1 });
    manager.appendCustomEntry(RELEVANT_ACK_TYPE, { version: 1, runIds: ["a", "b"] });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "saved answer" }], api: "fixture", provider: "fixture", model: "fixture",
      timestamp: 2, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const kept = manager.appendMessage({ role: "user", content: "retained question", timestamp: 3 });
    const markedLeaf = manager.getLeafId()!;
    const file = manager.getSessionFile()!;
    expect(readFileSync(file, "utf8")).toContain(RELEVANT_ACK_TYPE);
    expect(acknowledgedRuns(SessionManager.open(file).getBranch())).toEqual(new Set(["a", "b"]));
    expect(JSON.stringify(manager.buildSessionProjection().messages)).not.toContain(RELEVANT_ACK_TYPE);
    manager.branch(root);
    manager.appendCustomEntry(RELEVANT_ACK_TYPE, { version: 1, runIds: ["c"] });
    expect(acknowledgedRuns(manager.getBranch())).toEqual(new Set(["c"]));
    manager.branch(root);
    expect(acknowledgedRuns(manager.getBranch()).size).toBe(0); // abandoned markers are not global history
    manager.branch(markedLeaf);
    manager.appendCompaction("summary", kept, 100);
    expect(manager.buildContextEntries().some(entry => entry.type === "custom" && entry.customType === RELEVANT_ACK_TYPE)).toBe(false);
    expect(acknowledgedRuns(SessionManager.open(file).getBranch())).toEqual(new Set(["a", "b"]));
    expect(JSON.stringify(manager.buildSessionProjection().messages)).not.toContain(RELEVANT_ACK_TYPE);
    expect(manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === RELEVANT_ACK_TYPE)).toHaveLength(2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("latest valid marker wins; unknown versions and malformed entries are ignored safely", () => {
  const manager = SessionManager.inMemory();
  expect(acknowledgedRuns(manager.getBranch()).size).toBe(0);
  manager.appendCustomEntry(RELEVANT_ACK_TYPE, { version: 1, runIds: ["old"] });
  for (const data of [undefined, null, [], "bad", { version: 2, runIds: ["new"] }, { version: 1 }, { version: 1, runIds: ["ok", 4] },
    { version: 1, runIds: [""] }, { version: 1, runIds: "wrong" }]) {
    manager.appendCustomEntry(RELEVANT_ACK_TYPE, data);
    expect(acknowledgedRuns(manager.getBranch())).toEqual(new Set(["old"]));
  }
  manager.appendCustomMessageEntry(RELEVANT_ACK_TYPE, "not metadata", false, { version: 1, runIds: ["wrong"] });
  manager.appendCustomEntry("unrelated", { version: 1, runIds: ["wrong"] });
  expect(acknowledgedRuns(manager.getBranch())).toEqual(new Set(["old"]));
  manager.appendCustomEntry(RELEVANT_ACK_TYPE, { version: 1, runIds: ["latest", "latest"] });
  expect(acknowledgedRuns(manager.getBranch())).toEqual(new Set(["latest"]));
  manager.appendCustomEntry(RELEVANT_ACK_TYPE, { version: 1, runIds: [] });
  expect(acknowledgedRuns(manager.getBranch()).size).toBe(0);
});
