import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type FastModeConfig = {
	enabled: boolean;
};

const STATUS_KEY = "openai-fast-mode";
const CONFIG_PATH = join(getAgentDir(), "openai-fast-mode.json");

function parseConfig(value: unknown): FastModeConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;

	const config = value as { enabled?: unknown };
	if (typeof config.enabled !== "boolean") return undefined;

	return { enabled: config.enabled };
}

function loadConfig(): FastModeConfig {
	try {
		const config = parseConfig(
			JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown,
		);
		if (config) return config;
	} catch {
		// Keep the extension usable if its optional configuration is missing or invalid.
	}
	return { enabled: false };
}

function saveConfig(config: FastModeConfig): void {
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function isOpenAIRequestModel(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model) return false;
	return (
		(model.provider === "openai" &&
			(model.api === "openai-responses" || model.api === "openai-completions")) ||
		(model.provider === "openai-codex" && model.api === "openai-codex-responses")
	);
}

function updateStatus(config: FastModeConfig, ctx: ExtensionContext): void {
	ctx.ui.setStatus(
		STATUS_KEY,
		config.enabled && isOpenAIRequestModel(ctx)
			? ctx.ui.theme.fg("warning", "⚡ Fast")
			: undefined,
	);
}

function currentStatus(config: FastModeConfig, ctx: ExtensionContext): string {
	if (!config.enabled) return "Fast mode is off.";
	if (!isOpenAIRequestModel(ctx) || !ctx.model)
		return "Fast mode is on, but inactive for the current provider/API.";
	return `Fast mode requests priority for ${ctx.model.provider}/${ctx.model.id}.`;
}

export default function (pi: ExtensionAPI) {
	let config = loadConfig();

	pi.registerCommand("fast", {
		description:
			"Toggle OpenAI Priority processing (on, off, toggle, or status)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "toggle";
			if (action === "status") {
				ctx.ui.notify(currentStatus(config, ctx), "info");
				return;
			}

			let enabled: boolean | undefined;
			if (action === "on") enabled = true;
			else if (action === "off") enabled = false;
			else if (action === "toggle") enabled = !config.enabled;
			else {
				ctx.ui.notify("Usage: /fast [on|off|toggle|status]", "warning");
				return;
			}

			const previousConfig = config;
			config = { ...config, enabled };
			try {
				saveConfig(config);
				updateStatus(config, ctx);
				ctx.ui.notify(currentStatus(config, ctx), "info");
			} catch (error) {
				config = previousConfig;
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not save fast-mode setting: ${message}`, "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		config = loadConfig();
		updateStatus(config, ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(config, ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (
			!config.enabled ||
			!isOpenAIRequestModel(ctx) ||
			!event.payload ||
			typeof event.payload !== "object" ||
			Array.isArray(event.payload)
		)
			return;
		return { ...event.payload, service_tier: "priority" };
	});
}
