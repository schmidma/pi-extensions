import { basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	getCapabilities,
	hyperlink,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	dynamicTitleGap,
	leftWidthBudget,
	titleWidthBudget,
} from "./minimal-statusline/layout.ts";
import { sanitizeSingleLine } from "./shared/terminal-text.ts";

type Segment = {
	priority: number;
	text: string;
};

type PiLensSeverity = "error" | "warning" | "info" | "hint";

type PiLensDiagnosticsSnapshot = {
	v: 1;
	source: "pi-lens";
	seq: number;
	files: ReadonlyArray<{
		path: string;
		diagnostics: ReadonlyArray<{ severity: PiLensSeverity }>;
		truncated?: boolean;
	}>;
};

type PiLensFilesTouched = {
	v: 1;
	source: "pi-lens";
	paths: ReadonlyArray<string>;
};

type PiLensFileSummary = {
	errors: number;
	warnings: number;
	truncated: boolean;
};

type PullRequest = {
	number: number;
	url: string;
};

const SEPARATOR = " · ";
const PI_LENS_DIAGNOSTICS_EVENT = "pilens:diagnostics";
const PI_LENS_FILES_TOUCHED_EVENT = "pilens:files:touched";
const PI_LENS_SEVERITIES = new Set<PiLensSeverity>([
	"error",
	"warning",
	"info",
	"hint",
]);

const ANSI_STYLES = {
	gray: "90",
	red: "1;31",
	green: "1;32",
	yellow: "1;33",
	blue: "1;34",
	purple: "1;35",
	cyan: "1;36",
} as const;

type AnsiStyle = keyof typeof ANSI_STYLES;

const THINKING_STYLES = {
	off: "gray",
	minimal: "cyan",
	low: "blue",
	medium: "green",
	high: "yellow",
	xhigh: "purple",
	max: "red",
} as const satisfies Record<string, AnsiStyle>;

function applyStyle(style: AnsiStyle, text: string): string {
	return `\x1b[${ANSI_STYLES[style]}m${text}\x1b[0m`;
}

function sanitizeSessionTitle(title: string | undefined): string | undefined {
	return title ? sanitizeSingleLine(title) || undefined : undefined;
}

function isPiLensDiagnosticsSnapshot(
	value: unknown,
): value is PiLensDiagnosticsSnapshot {
	if (!value || typeof value !== "object") return false;
	const snapshot = value as PiLensDiagnosticsSnapshot;
	return (
		snapshot.v === 1 &&
		snapshot.source === "pi-lens" &&
		Number.isFinite(snapshot.seq) &&
		Array.isArray(snapshot.files) &&
		snapshot.files.every(
			(file) =>
				typeof file?.path === "string" &&
				Array.isArray(file.diagnostics) &&
				file.diagnostics.every(
					(diagnostic) =>
						diagnostic !== null &&
						typeof diagnostic === "object" &&
						PI_LENS_SEVERITIES.has(diagnostic.severity),
				),
		)
	);
}

function isPiLensFilesTouched(value: unknown): value is PiLensFilesTouched {
	if (!value || typeof value !== "object") return false;
	const event = value as PiLensFilesTouched;
	return (
		event.v === 1 &&
		event.source === "pi-lens" &&
		Array.isArray(event.paths) &&
		event.paths.every((path) => typeof path === "string")
	);
}

type PiLensStatus = {
	diagnostics: Map<string, PiLensFileSummary>;
	pendingPaths: Set<string>;
	hasSnapshot: boolean;
	sequence: number;
};

function createPiLensStatus(): PiLensStatus {
	return {
		diagnostics: new Map(),
		pendingPaths: new Set(),
		hasSnapshot: false,
		sequence: -1,
	};
}

function resetPiLensStatus(status: PiLensStatus): void {
	status.diagnostics.clear();
	status.pendingPaths.clear();
	status.hasSnapshot = false;
	status.sequence = -1;
}

function acceptPiLensDiagnostics(
	status: PiLensStatus,
	value: unknown,
): boolean {
	if (!isPiLensDiagnosticsSnapshot(value) || value.seq <= status.sequence) {
		return false;
	}

	status.sequence = value.seq;
	status.hasSnapshot = true;
	for (const file of value.files) {
		const errors = file.diagnostics.filter(
			(diagnostic) => diagnostic.severity === "error",
		).length;
		const warnings = file.diagnostics.filter(
			(diagnostic) => diagnostic.severity === "warning",
		).length;
		status.diagnostics.set(file.path, {
			errors,
			warnings,
			truncated: file.truncated === true,
		});
		status.pendingPaths.delete(file.path);
	}
	return true;
}

function acceptPiLensTouched(status: PiLensStatus, value: unknown): boolean {
	if (!isPiLensFilesTouched(value)) return false;
	for (const path of value.paths) status.pendingPaths.add(path);
	return true;
}

function renderPiLensStatus(
	status: PiLensStatus,
	lspStatus: string | undefined,
): string {
	const identity = applyStyle("cyan", "󰍉");
	if (lspStatus?.includes("Failed")) {
		return `${identity} ${applyStyle("red", "󰅙")}`;
	}
	if (status.pendingPaths.size > 0) {
		return `${identity} ${applyStyle("yellow", "󰔟")}`;
	}

	let errors = 0;
	let warnings = 0;
	let truncated = false;
	for (const summary of status.diagnostics.values()) {
		errors += summary.errors;
		warnings += summary.warnings;
		truncated ||= summary.truncated;
	}

	const parts = [identity];
	if (errors > 0) parts.push(applyStyle("red", `${errors}`));
	if (warnings > 0) parts.push(applyStyle("yellow", `${warnings}`));
	if (truncated) parts.push(applyStyle("gray", ""));
	else if (status.hasSnapshot && errors === 0 && warnings === 0) {
		parts.push(applyStyle("green", ""));
	}
	return parts.join(" ");
}

function subscribePiLens(
	pi: ExtensionAPI,
	status: PiLensStatus,
	requestRender: () => void,
): () => void {
	const unsubscribeDiagnostics = pi.events.on(
		PI_LENS_DIAGNOSTICS_EVENT,
		(value) => {
			if (acceptPiLensDiagnostics(status, value)) requestRender();
		},
	);
	const unsubscribeTouched = pi.events.on(
		PI_LENS_FILES_TOUCHED_EVENT,
		(value) => {
			if (acceptPiLensTouched(status, value)) requestRender();
		},
	);
	return () => {
		unsubscribeDiagnostics();
		unsubscribeTouched();
	};
}

function openPullRequest(value: unknown): PullRequest | undefined {
	if (!value || typeof value !== "object") return undefined;

	const pullRequest = value as {
		number?: unknown;
		state?: unknown;
		url?: unknown;
	};
	return typeof pullRequest.number === "number" &&
		pullRequest.state === "OPEN" &&
		typeof pullRequest.url === "string"
		? { number: pullRequest.number, url: pullRequest.url }
		: undefined;
}

function fitSegments(
	segments: Segment[],
	width: number,
	separator: string,
): string {
	const shown = [...segments];
	const render = () => shown.map((segment) => segment.text).join(separator);

	while (shown.length > 1 && visibleWidth(render()) > width) {
		let leastImportant = 0;
		for (let index = 1; index < shown.length; index++) {
			const candidate = shown[index];
			const current = shown[leastImportant];
			if (candidate && current && candidate.priority < current.priority) {
				leastImportant = index;
			}
		}
		shown.splice(leastImportant, 1);
	}

	return truncateToWidth(render(), width, "");
}

function buildModelSegments(
	modelId: string | undefined,
	reasoning: boolean,
	thinkingLevel: keyof typeof THINKING_STYLES | undefined,
): Segment[] {
	const segments: Segment[] = [
		{
			priority: 90,
			text: applyStyle("cyan", `󰚩 ${modelId ?? "no model"}`),
		},
	];
	if (reasoning) {
		const level = thinkingLevel ?? "off";
		segments.push({
			priority: 60,
			text: applyStyle(THINKING_STYLES[level], `󰧑 ${level}`),
		});
	}
	return segments;
}

function buildExtensionSegments(
	statuses: ReadonlyMap<string, string>,
): Segment[] {
	const segments: Segment[] = [];
	if (statuses.has("openai-fast-mode")) {
		segments.push({ priority: 85, text: applyStyle("yellow", " fast") });
	}

	const laterInboxCount = statuses.get("later-inbox");
	if (laterInboxCount && laterInboxCount !== "0") {
		segments.push({
			priority: 55,
			text: applyStyle("gray", `󰅐 ${laterInboxCount}`),
		});
	}
	return segments;
}

function buildProjectSegments(
	cwd: string,
	branch: string | null,
	pullRequest: PullRequest | undefined,
): Segment[] {
	const project = basename(cwd) || cwd;
	const segments: Segment[] = [
		{ priority: 80, text: applyStyle("cyan", ` ${project}`) },
	];
	if (branch) {
		segments.push({
			priority: 70,
			text: applyStyle("purple", ` ${branch}`),
		});
	}
	if (pullRequest) {
		const text = applyStyle("purple", ` #${pullRequest.number}`);
		segments.push({
			priority: 68,
			text: getCapabilities().hyperlinks
				? hyperlink(text, pullRequest.url)
				: text,
		});
	}
	return segments;
}

function buildContextSegment(percent: number | null | undefined): Segment {
	const label =
		percent === null || percent === undefined ? "?" : percent.toFixed(0);
	let style: AnsiStyle = "green";
	if (percent !== null && percent !== undefined) {
		if (percent > 90) style = "red";
		else if (percent > 70) style = "yellow";
	}
	return {
		priority: 100,
		text: applyStyle(style, `󰍛 ${label}${label === "?" ? "" : "%"}`),
	};
}

export function renderStatusline(
	width: number,
	input: {
		modelId: string | undefined;
		reasoning: boolean;
		thinkingLevel: keyof typeof THINKING_STYLES | undefined;
		cwd: string;
		branch: string | null;
		pullRequest: PullRequest | undefined;
		extensionStatuses: ReadonlyMap<string, string>;
		piLensStatus: PiLensStatus;
		contextPercent: number | null | undefined;
		sessionName: string | undefined;
	},
): string[] {
	const segments = [
		...buildModelSegments(input.modelId, input.reasoning, input.thinkingLevel),
		...buildExtensionSegments(input.extensionStatuses),
		...buildProjectSegments(input.cwd, input.branch, input.pullRequest),
		{
			priority: 64,
			text: renderPiLensStatus(
				input.piLensStatus,
				input.extensionStatuses.get("pi-lens-lsp"),
			),
		},
		buildContextSegment(input.contextPercent),
	];
	const leftPadding = width > 0 ? " " : "";
	const contentWidth = Math.max(0, width - leftPadding.length);
	const separator = applyStyle("gray", SEPARATOR);
	const sessionName = sanitizeSessionTitle(input.sessionName);
	const titleMaxWidth = titleWidthBudget(width, contentWidth);
	const title =
		sessionName && titleMaxWidth > 0
			? truncateToWidth(sessionName, titleMaxWidth, "…")
			: "";
	const titleWidth = visibleWidth(title);
	const leftBudget = leftWidthBudget(contentWidth, titleWidth);
	const left = fitSegments(segments, leftBudget, separator);
	if (!title) return [leftPadding + left];

	const gap = " ".repeat(
		dynamicTitleGap(contentWidth, visibleWidth(left), titleWidth),
	);
	return [leftPadding + left + gap + applyStyle("cyan", title)];
}

type StatuslineRuntime = {
	piLensStatus: PiLensStatus;
	pullRequest: PullRequest | undefined;
	pullRequestRequestId: number;
	requestFooterRender: (() => void) | undefined;
};

function createStatuslineRuntime(): StatuslineRuntime {
	return {
		piLensStatus: createPiLensStatus(),
		pullRequest: undefined,
		pullRequestRequestId: 0,
		requestFooterRender: undefined,
	};
}

function refreshPullRequest(
	pi: ExtensionAPI,
	runtime: StatuslineRuntime,
	cwd: string,
): void {
	const requestId = ++runtime.pullRequestRequestId;
	void pi
		.exec("gh", ["pr", "view", "--json", "number,state,url"], {
			cwd,
			timeout: 5_000,
		})
		.then((result) => {
			if (requestId !== runtime.pullRequestRequestId) return;
			try {
				runtime.pullRequest =
					result.code === 0
						? openPullRequest(JSON.parse(result.stdout) as unknown)
						: undefined;
			} catch {
				runtime.pullRequest = undefined;
			}
			runtime.requestFooterRender?.();
		})
		.catch(() => {
			if (requestId !== runtime.pullRequestRequestId) return;
			runtime.pullRequest = undefined;
			runtime.requestFooterRender?.();
		});
}

function subscribeStatusEvents(
	pi: ExtensionAPI,
	runtime: StatuslineRuntime,
): () => void {
	return subscribePiLens(pi, runtime.piLensStatus, () =>
		runtime.requestFooterRender?.(),
	);
}

function stopStatusline(
	runtime: StatuslineRuntime,
	unsubscribeStatusEvents: () => void,
): void {
	runtime.pullRequestRequestId++;
	runtime.pullRequest = undefined;
	runtime.requestFooterRender = undefined;
	unsubscribeStatusEvents();
}

function startStatuslineSession(
	pi: ExtensionAPI,
	runtime: StatuslineRuntime,
	ctx: ExtensionContext,
): void {
	if (ctx.mode !== "tui") return;

	resetPiLensStatus(runtime.piLensStatus);
	runtime.pullRequest = undefined;
	refreshPullRequest(pi, runtime, ctx.cwd);
	ctx.ui.setFooter((tui, _theme, footerData) => {
		const handleBranchChange = () => {
			tui.requestRender();
			refreshPullRequest(pi, runtime, ctx.cwd);
		};
		const unsubscribeBranch = footerData.onBranchChange(handleBranchChange);
		runtime.requestFooterRender = () => tui.requestRender();

		return {
			invalidate() {},
			dispose() {
				runtime.requestFooterRender = undefined;
				unsubscribeBranch();
			},
			render(width: number): string[] {
				return renderStatusline(width, {
					modelId: ctx.model?.id,
					reasoning: ctx.model?.reasoning === true,
					thinkingLevel: ctx.thinkingLevel,
					cwd: ctx.cwd,
					branch: footerData.getGitBranch(),
					pullRequest: runtime.pullRequest,
					extensionStatuses: footerData.getExtensionStatuses(),
					piLensStatus: runtime.piLensStatus,
					contextPercent: ctx.getContextUsage()?.percent,
					sessionName: pi.getSessionName(),
				});
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	const runtime = createStatuslineRuntime();
	const unsubscribeStatusEvents = subscribeStatusEvents(pi, runtime);
	pi.on("session_shutdown", () =>
		stopStatusline(runtime, unsubscribeStatusEvents),
	);
	pi.on("session_start", (_event, ctx) =>
		startStatuslineSession(pi, runtime, ctx),
	);
}
