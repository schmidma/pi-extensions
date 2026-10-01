import { sanitizeSingleLine } from "../shared/terminal-text.ts";

export { sanitizeSingleLine } from "../shared/terminal-text.ts";

export const SESSION_NAMING_STATE_TYPE = "session-naming-state";
export const LEGACY_SESSION_HUD_STATE_TYPE = "session-hud-state";

export type TitleSource = "model";
export type GenerationMode = "automatic" | "retitle";
export type Ownership = "eligible" | "attempted" | "auto" | "manual";

export interface PersistedOwnership {
	v: 1;
	ownership: "attempted" | "auto" | "manual";
	title: string | null;
}

export interface GenerationOutcome {
	status: "applied" | "cancelled" | "no-prompt" | "failed";
	title?: string;
	source?: TitleSource;
}

export interface SessionEntryLike {
	type?: string;
	name?: string;
	summary?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		content?: unknown;
	};
}

export interface SessionNamingDependencies {
	getSessionName(): string | undefined;
	setSessionName(name: string): void;
	appendOwnership(marker: PersistedOwnership): void;
	generateTitle(
		input: string,
		signal: AbortSignal,
		mode: GenerationMode,
	): Promise<string | undefined>;
}

const MAX_TITLE_LENGTH = 64;

export function normalizeSessionName(
	name: string | undefined,
): string | undefined {
	if (name === undefined) return undefined;
	return sanitizeSingleLine(name) || undefined;
}

export function cleanGeneratedTitle(
	raw: string | undefined,
): string | undefined {
	if (!raw) return undefined;

	let title = raw
		.replace(/```(?:text)?/gi, "")
		.replace(/<\/?(?:title|session[-_ ]?title)>/gi, "")
		.split(/\r?\n/)
		.map((line) => sanitizeSingleLine(line))
		.find(Boolean);
	if (!title) return undefined;

	title = title
		.replace(/^(?:session\s+)?title\s*[:\-–—]\s*/i, "")
		.replace(/^[-*•#]+\s*/, "")
		.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
		.replace(/[.!?,;:|/\\\-–—]+$/g, "")
		.trim();
	title = sanitizeSingleLine(title);

	if (!title) return undefined;
	const wordCount = title.split(/\s+/).length;
	if (wordCount < 3 || wordCount > 8) return undefined;
	if (
		/^(?:untitled|session title|coding task|no title|none|null|n\/a)$/i.test(
			title,
		)
	) {
		return undefined;
	}
	if (/^(?:i (?:cannot|can't)|sorry|unable to)/i.test(title)) return undefined;
	if (title.length > MAX_TITLE_LENGTH) return undefined;
	return title;
}

function parseOwnership(value: unknown): PersistedOwnership | undefined {
	if (!value || typeof value !== "object") return undefined;
	const marker = value as Partial<PersistedOwnership>;
	if (marker.v !== 1) return undefined;
	if (
		marker.ownership !== "attempted" &&
		marker.ownership !== "auto" &&
		marker.ownership !== "manual"
	) {
		return undefined;
	}
	if (marker.title !== null && typeof marker.title !== "string")
		return undefined;
	return {
		v: 1,
		ownership: marker.ownership,
		title:
			marker.title === null
				? null
				: (normalizeSessionName(marker.title) ?? null),
	};
}

export function findLatestOwnership(
	entries: readonly SessionEntryLike[],
): PersistedOwnership | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (
			entry?.type !== "custom" ||
			(entry.customType !== SESSION_NAMING_STATE_TYPE &&
				entry.customType !== LEGACY_SESSION_HUD_STATE_TYPE)
		) {
			continue;
		}
		const marker = parseOwnership(entry.data);
		if (marker) return marker;
	}
	return undefined;
}

function hasSessionInfo(entries: readonly SessionEntryLike[]): boolean {
	return entries.some((entry) => entry.type === "session_info");
}

function initialOwnership(
	currentTitle: string | undefined,
	marker: PersistedOwnership | undefined,
	hasPersistedSessionInfo: boolean,
): Ownership {
	if (!marker) {
		return currentTitle || hasPersistedSessionInfo ? "manual" : "eligible";
	}
	if (
		marker.ownership === "auto" &&
		currentTitle !== undefined &&
		marker.title === currentTitle
	) {
		return "auto";
	}
	if (
		marker.ownership === "attempted" &&
		currentTitle === undefined &&
		marker.title === null
	) {
		return "attempted";
	}
	return "manual";
}

export class SessionNamingController {
	private currentTitle: string | undefined;
	private generating = false;
	private ownership: Ownership = "eligible";
	private ownershipRevision = 0;
	private expectedAutoName: string | undefined;
	private requestId = 0;
	private requestController: AbortController | undefined;
	private stopped = false;

	constructor(private readonly dependencies: SessionNamingDependencies) {
		this.currentTitle = normalizeSessionName(dependencies.getSessionName());
	}

	restore(allEntries: readonly SessionEntryLike[]): void {
		this.cancelGeneration();
		this.stopped = false;
		this.currentTitle = normalizeSessionName(
			this.dependencies.getSessionName(),
		);
		this.ownership = initialOwnership(
			this.currentTitle,
			findLatestOwnership(allEntries),
			hasSessionInfo(allEntries),
		);
		this.ownershipRevision += 1;
	}

	handlePrompt(prompt: string): void {
		if (this.stopped) return;
		const input = sanitizeSingleLine(prompt);
		if (
			input &&
			this.ownership === "eligible" &&
			this.currentTitle === undefined &&
			!this.generating
		) {
			void this.startGeneration(input, false, "automatic");
		}
	}

	handleSessionInfoChanged(name: string | undefined): void {
		if (this.stopped) return;
		const normalized = normalizeSessionName(name);
		if (
			this.expectedAutoName !== undefined &&
			normalized === this.expectedAutoName
		) {
			this.expectedAutoName = undefined;
			this.currentTitle = normalized;
			return;
		}

		this.expectedAutoName = undefined;
		this.currentTitle = normalized;
		this.ownership = "manual";
		this.ownershipRevision += 1;
		this.cancelGeneration();
		this.persist({
			v: 1,
			ownership: "manual",
			title: normalized ?? null,
		});
	}

	async retitle(context?: string): Promise<GenerationOutcome> {
		if (this.stopped) return { status: "cancelled" };
		const input = context?.trim();
		if (!input) return { status: "no-prompt" };
		return this.startGeneration(input, true, "retitle");
	}

	shutdown(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.cancelGeneration();
	}

	private async startGeneration(
		input: string,
		force: boolean,
		mode: GenerationMode,
	): Promise<GenerationOutcome> {
		this.cancelGeneration();
		if (this.stopped) return { status: "cancelled" };

		const cleanInput = input.trim();
		if (!cleanInput) return { status: "no-prompt" };

		const requestId = ++this.requestId;
		const controller = new AbortController();
		this.requestController = controller;
		const startingRevision = this.ownershipRevision;
		const startingTitle = this.currentTitle;
		this.generating = true;

		let title: string | undefined;
		try {
			const generated = await this.dependencies.generateTitle(
				cleanInput,
				controller.signal,
				mode,
			);
			title = cleanGeneratedTitle(generated);
		} catch {
			title = undefined;
		}

		if (
			this.stopped ||
			controller.signal.aborted ||
			requestId !== this.requestId ||
			startingRevision !== this.ownershipRevision ||
			startingTitle !== this.currentTitle ||
			(!force &&
				(this.ownership !== "eligible" || this.currentTitle !== undefined))
		) {
			if (requestId === this.requestId) {
				this.generating = false;
				this.requestController = undefined;
			}
			return { status: "cancelled" };
		}

		if (!title) {
			if (!force) this.recordAutomaticAttempt();
			this.generating = false;
			this.requestController = undefined;
			return { status: "failed" };
		}

		this.expectedAutoName = title;
		try {
			this.dependencies.setSessionName(title);
		} catch {
			this.expectedAutoName = undefined;
			if (!force) this.recordAutomaticAttempt();
			this.generating = false;
			this.requestController = undefined;
			return { status: "failed" };
		}

		this.currentTitle = title;
		this.ownership = "auto";
		this.ownershipRevision += 1;
		this.persist({ v: 1, ownership: "auto", title });
		this.generating = false;
		this.requestController = undefined;
		return { status: "applied", title, source: "model" };
	}

	private recordAutomaticAttempt(): void {
		this.ownership = "attempted";
		this.ownershipRevision += 1;
		this.persist({ v: 1, ownership: "attempted", title: null });
	}

	private cancelGeneration(): void {
		this.requestId += 1;
		this.requestController?.abort();
		this.requestController = undefined;
		this.generating = false;
	}

	private persist(marker: PersistedOwnership): void {
		try {
			this.dependencies.appendOwnership(marker);
		} catch {
			// Persistence failure is safe: a restored unmatched name is treated as manual.
		}
	}
}
