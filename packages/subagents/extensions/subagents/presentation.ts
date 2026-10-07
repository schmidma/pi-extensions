import { rgbColor, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { DisplayStatus } from "./tree.ts";
import type { RunRecord } from "./state.ts";

/** Metadata is terminal text, never terminal markup. Keep prose newlines separately. */
export const metadataText = (value: string): string => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
export const proseText = (value: string): string => value.replace(/\r\n/g, "\n")
  .replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");
export const stringField = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
export const objectFields = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const shortId = (value: string): string => metadataText(value).slice(0, 10);
export const statusColor = (status: DisplayStatus): ThemeColor => status === "running" ? "accent" : status === "waiting" ? "warning" : status === "finished" ? "success" : status === "error" ? "error" : "muted";
export const statusMark: Record<DisplayStatus, string> = { running: "●", waiting: "◷", finished: "✓", error: "✗", aborted: "⊘", interrupted: "!" };

/** Logical wall time: open runs include waiting, terminal durations never use the clock. */
export function runElapsed(run: Readonly<RunRecord> | undefined, now = Date.now()): string | undefined {
  if (!run || typeof run.startedAt !== "string") return undefined;
  const start = Date.parse(run.startedAt);
  const end = run.phase === "terminal" ? (typeof run.endedAt === "string" ? Date.parse(run.endedAt) : NaN) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || (run.phase === "terminal" && end < start)) return undefined;
  const elapsed = Math.max(0, end - start);
  return Number.isFinite(elapsed) ? `${(elapsed / 1000).toFixed(1)}s` : undefined;
}

/** System may leave panels transparent. Keep a light/dark-aware visual surface. */
export function panelBackground(theme: Theme, text: string, token: "toolPendingBg" | "selectedBg" = "toolPendingBg"): string {
  if (/\x1b\[(?:48;|4[0-7]m|10[0-7]m)/.test(theme.getBgAnsi(token))) return theme.bg(token, text);
  const shade = theme.appearance === "light" ? (token === "selectedBg" ? 220 : 232) : (token === "selectedBg" ? 48 : 36);
  return theme.style(text, { bg: rgbColor(shade, shade, shade) });
}

/** A one-line native card slot that cannot turn a long partial argument into a wall. */
export function compactLine(value: () => string): Component {
  return { render: width => width > 0 ? [truncateToWidth(value(), width)] : [], invalidate() {} };
}
export function statusText(theme: Theme, status: DisplayStatus, marker = statusMark[status]): string {
  return theme.fg(statusColor(status), `${marker} ${status}`);
}
