import { Buffer } from "node:buffer";
import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";

const PROVIDER_ID = "openai-codex";
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const REQUEST_TIMEOUT_MS = 15_000;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

type JsonObject = Record<string, unknown>;

type UsageWindow = {
	usedPercent: number;
	windowSeconds?: number;
	resetAfterSeconds?: number;
	resetAt?: number;
};

type UsageLimit = {
	allowed?: boolean;
	limitReached?: boolean;
	primary?: UsageWindow;
	secondary?: UsageWindow;
};

type UsageGroup = {
	name: string;
	limit: UsageLimit;
};

type UsageSnapshot = {
	plan?: string;
	groups: UsageGroup[];
	credits?: {
		hasCredits?: boolean;
		unlimited?: boolean;
		balance?: string;
	};
	spendControlReached?: boolean;
	resetCredits?: number;
};

function asObject(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
	return values.find((value) => value !== undefined);
}

function parseWindow(value: unknown): UsageWindow | undefined {
	const object = asObject(value);
	if (!object) return undefined;

	const usedPercent = firstDefined(
		asNumber(object.used_percent),
		asNumber(object.usedPercent),
	);
	if (usedPercent === undefined) return undefined;

	const windowMinutes = asNumber(object.window_minutes);
	return {
		usedPercent: Math.min(100, Math.max(0, usedPercent)),
		windowSeconds: firstDefined(
			asNumber(object.limit_window_seconds),
			asNumber(object.window_seconds),
			asNumber(object.windowSeconds),
			windowMinutes !== undefined ? windowMinutes * 60 : undefined,
		),
		resetAfterSeconds: firstDefined(
			asNumber(object.reset_after_seconds),
			asNumber(object.resetAfterSeconds),
		),
		resetAt: firstDefined(
			asNumber(object.reset_at),
			asNumber(object.resets_at),
			asNumber(object.resetAt),
		),
	};
}

function parseLimit(value: unknown): UsageLimit | undefined {
	const object = asObject(value);
	if (!object) return undefined;

	const primary = parseWindow(object.primary_window ?? object.primary);
	const secondary = parseWindow(object.secondary_window ?? object.secondary);
	const allowed = asBoolean(object.allowed);
	const limitReached = firstDefined(
		asBoolean(object.limit_reached),
		asBoolean(object.limitReached),
	);

	if (
		!primary &&
		!secondary &&
		allowed === undefined &&
		limitReached === undefined
	)
		return undefined;
	return { allowed, limitReached, primary, secondary };
}

function humanize(value: string): string {
	if (!/[_-]/.test(value)) return value;
	return value
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseSnapshot(value: unknown): UsageSnapshot {
	const object = asObject(value);
	if (!object)
		throw new Error("The usage service returned an invalid response.");

	const groups: UsageGroup[] = [];
	const mainLimit = parseLimit(object.rate_limit ?? object.rateLimits);
	if (mainLimit) groups.push({ name: "Codex", limit: mainLimit });

	for (const key of [
		"code_review_rate_limit",
		"code_review_rate_limits",
	] as const) {
		const codeReviewLimit = parseLimit(object[key]);
		if (codeReviewLimit) {
			groups.push({ name: "Code review", limit: codeReviewLimit });
			break;
		}
	}

	const additional =
		object.additional_rate_limits ?? object.additionalRateLimits;
	if (Array.isArray(additional)) {
		for (const item of additional) {
			const details = asObject(item);
			const limit = parseLimit(details?.rate_limit ?? details?.rateLimit);
			if (!details || !limit) continue;
			const displayName =
				asString(details.limit_name) ?? asString(details.limitName);
			const meteredFeature = asString(details.metered_feature);
			groups.push({
				name:
					displayName ??
					(meteredFeature ? humanize(meteredFeature) : "Additional limit"),
				limit,
			});
		}
	}

	const creditDetails = asObject(object.credits);
	const spendControl = asObject(object.spend_control ?? object.spendControl);
	const resetCreditDetails = asObject(
		object.rate_limit_reset_credits ?? object.rateLimitResetCredits,
	);

	return {
		plan: asString(object.plan_type ?? object.planType),
		groups,
		credits: creditDetails
			? {
					hasCredits: asBoolean(
						creditDetails.has_credits ?? creditDetails.hasCredits,
					),
					unlimited: asBoolean(creditDetails.unlimited),
					balance: asString(creditDetails.balance),
				}
			: undefined,
		spendControlReached: asBoolean(spendControl?.reached),
		resetCredits: asNumber(
			resetCreditDetails?.available_count ?? resetCreditDetails?.availableCount,
		),
	};
}

function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("invalid token");
		const payload = JSON.parse(
			Buffer.from(parts[1]!, "base64url").toString("utf8"),
		) as JsonObject;
		const auth = asObject(payload[JWT_CLAIM_PATH]);
		const accountId = asString(auth?.chatgpt_account_id);
		if (!accountId) throw new Error("missing account ID");
		return accountId;
	} catch {
		throw new Error(
			"Could not read the ChatGPT account ID from the OpenAI login token. Run /login again.",
		);
	}
}

function usageUrl(baseUrl: string): string {
	let normalized = baseUrl.trim().replace(/\/+$/, "");
	if (/^https:\/\/(chatgpt\.com|chat\.openai\.com)$/i.test(normalized)) {
		normalized += "/backend-api";
	}
	return normalized.includes("/backend-api")
		? `${normalized}/wham/usage`
		: `${normalized}/api/codex/usage`;
}

async function responseError(response: Response): Promise<string> {
	if (response.status === 401 || response.status === 403) {
		return "OpenAI authentication failed. Run /login again.";
	}

	try {
		const body = asObject(await response.json());
		const error = asObject(body?.error);
		const message =
			asString(error?.message) ??
			asString(body?.message) ??
			asString(body?.detail);
		if (message) return message;
	} catch {
		// Use the status fallback below.
	}
	return `Usage request failed (${response.status} ${response.statusText || "HTTP error"}).`;
}

async function fetchUsage(
	ctx: ExtensionCommandContext,
): Promise<UsageSnapshot> {
	const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
	const token = resolved?.auth.apiKey;
	if (!token) {
		throw new Error(
			"No OpenAI Codex login found. Run /login and select OpenAI Codex.",
		);
	}

	const accountId = extractAccountId(token);
	const baseUrl =
		resolved.auth.baseUrl ??
		ctx.modelRegistry.getProvider(PROVIDER_ID)?.baseUrl ??
		DEFAULT_BASE_URL;
	const headers = new Headers();
	for (const [name, value] of Object.entries(resolved.auth.headers ?? {})) {
		if (value !== null) headers.set(name, value);
	}
	headers.set("Accept", "application/json");
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("ChatGPT-Account-Id", accountId);
	headers.set("User-Agent", "pi-usage-extension");
	headers.set("originator", "pi");

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(usageUrl(baseUrl), {
			headers,
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(await responseError(response));
		return parseSnapshot((await response.json()) as unknown);
	} catch (error) {
		if (controller.signal.aborted)
			throw new Error("The usage request timed out.");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function formatPlan(plan: string | undefined): string {
	if (!plan) return "Unknown";
	const known: Record<string, string> = {
		prolite: "Pro Lite",
		self_serve_business_usage_based: "Business (usage based)",
		enterprise_cbp_usage_based: "Enterprise (usage based)",
	};
	return (
		known[plan.toLowerCase()] ??
		humanize(plan).replace(/\b\w/g, (letter) => letter.toUpperCase())
	);
}

function formatWindow(seconds: number | undefined, fallback: string): string {
	if (!seconds || seconds <= 0) return fallback;
	const rounded = Math.round(seconds);
	if (rounded === 86_400) return "Daily";
	if (rounded === 604_800) return "Weekly";
	if (rounded === 2_592_000) return "Monthly";
	if (rounded % 86_400 === 0) {
		const days = rounded / 86_400;
		return `${days} day${days === 1 ? "" : "s"}`;
	}
	if (rounded % 3_600 === 0) {
		const hours = rounded / 3_600;
		return `${hours} hour${hours === 1 ? "" : "s"}`;
	}
	if (rounded % 60 === 0) {
		const minutes = rounded / 60;
		return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	}
	return `${rounded} seconds`;
}

function formatRelativeDuration(milliseconds: number): string {
	if (milliseconds <= 0) return "now";
	const totalMinutes = Math.max(1, Math.round(milliseconds / 60_000));
	const days = Math.floor(totalMinutes / 1_440);
	const hours = Math.floor((totalMinutes % 1_440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
	if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
	return `${minutes}m`;
}

function formatReset(window: UsageWindow, now: number): string | undefined {
	const resetMilliseconds =
		window.resetAt !== undefined
			? window.resetAt * 1_000
			: window.resetAfterSeconds !== undefined
				? now + window.resetAfterSeconds * 1_000
				: undefined;
	if (resetMilliseconds === undefined) return undefined;

	const absolute = new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(resetMilliseconds));
	return `resets ${absolute} (in ${formatRelativeDuration(resetMilliseconds - now)})`;
}

function progressBar(usedPercent: number, width = 12): string {
	const used = Math.min(
		width,
		Math.max(0, Math.round((usedPercent / 100) * width)),
	);
	return "█".repeat(used) + "░".repeat(width - used);
}

function plainText(snapshot: UsageSnapshot, now = Date.now()): string {
	const lines = [`OpenAI Codex Usage — ${formatPlan(snapshot.plan)} plan`];
	if (snapshot.groups.length === 0)
		lines.push("No usage windows were reported.");

	for (const group of snapshot.groups) {
		lines.push(
			"",
			group.name +
				(group.limit.limitReached || group.limit.allowed === false
					? " — limit reached"
					: ""),
		);
		const windows = [
			[group.limit.primary, "Primary"],
			[group.limit.secondary, "Secondary"],
		] as const;
		for (const [window, fallback] of windows) {
			if (!window) continue;
			const left = Math.max(0, 100 - window.usedPercent);
			const reset = formatReset(window, now);
			lines.push(
				`  ${formatWindow(window.windowSeconds, fallback)}  ${progressBar(window.usedPercent)} ${window.usedPercent.toFixed(0)}% used · ${left.toFixed(0)}% left${reset ? ` · ${reset}` : ""}`,
			);
		}
	}

	if (snapshot.credits) {
		const credits = snapshot.credits.unlimited
			? "unlimited"
			: snapshot.credits.hasCredits
				? `balance ${snapshot.credits.balance ?? "available"}`
				: "none";
		lines.push("", `Credits: ${credits}`);
	}
	if (snapshot.resetCredits !== undefined && snapshot.resetCredits > 0) {
		lines.push(`Limit reset credits: ${snapshot.resetCredits}`);
	}
	if (snapshot.spendControlReached) lines.push("Spend control limit reached.");
	return lines.join("\n");
}

async function showUsage(
	snapshot: UsageSnapshot,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(plainText(snapshot), "info");
		return;
	}

	const now = Date.now();
	await ctx.ui.custom((_tui, theme, _keybindings, done) => {
		const container = new Container();
		const border = new DynamicBorder((text: string) =>
			theme.fg("accent", text),
		);
		container.addChild(border);
		container.addChild(
			new Text(theme.fg("accent", theme.bold("OpenAI Codex Usage")), 1, 0),
		);
		container.addChild(
			new Text(theme.fg("muted", `${formatPlan(snapshot.plan)} plan`), 1, 0),
		);

		if (snapshot.groups.length === 0) {
			container.addChild(
				new Text(theme.fg("dim", "No usage windows were reported."), 1, 1),
			);
		}

		for (const group of snapshot.groups) {
			const reached = group.limit.limitReached || group.limit.allowed === false;
			const heading = reached ? `${group.name} — limit reached` : group.name;
			container.addChild(
				new Text(
					theme.fg(reached ? "error" : "text", theme.bold(heading)),
					1,
					1,
				),
			);
			const windows = [
				[group.limit.primary, "Primary"],
				[group.limit.secondary, "Secondary"],
			] as const;
			for (const [window, fallback] of windows) {
				if (!window) continue;
				const used = window.usedPercent;
				const left = Math.max(0, 100 - used);
				const color: "accent" | "warning" | "error" =
					used >= 90 ? "error" : used >= 70 ? "warning" : "accent";
				const reset = formatReset(window, now);
				const line = [
					theme.fg("muted", formatWindow(window.windowSeconds, fallback)),
					theme.fg(color, progressBar(used)),
					theme.fg(color, `${used.toFixed(0)}% used`),
					theme.fg("text", `${left.toFixed(0)}% left`),
					reset ? theme.fg("dim", reset) : undefined,
				]
					.filter((part): part is string => part !== undefined)
					.join("  ·  ");
				container.addChild(new Text(line, 2, 0));
			}
		}

		const notes: string[] = [];
		if (snapshot.credits) {
			const credits = snapshot.credits.unlimited
				? "unlimited"
				: snapshot.credits.hasCredits
					? `balance ${snapshot.credits.balance ?? "available"}`
					: "none";
			notes.push(`Credits: ${credits}`);
		}
		if (snapshot.resetCredits !== undefined && snapshot.resetCredits > 0) {
			notes.push(`Limit reset credits: ${snapshot.resetCredits}`);
		}
		if (snapshot.spendControlReached)
			notes.push("Spend control limit reached.");
		if (notes.length > 0)
			container.addChild(new Text(theme.fg("muted", notes.join("\n")), 1, 1));

		container.addChild(
			new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0),
		);
		container.addChild(border);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (
					matchesKey(data, "enter") ||
					matchesKey(data, "escape") ||
					matchesKey(data, "ctrl+c")
				) {
					done(undefined);
				}
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Show current OpenAI Codex usage limits",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("codex-usage", "Fetching usage…");
			try {
				await showUsage(await fetchUsage(ctx), ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not load usage: ${message}`, "error");
			} finally {
				ctx.ui.setStatus("codex-usage", undefined);
			}
		},
	});
}
