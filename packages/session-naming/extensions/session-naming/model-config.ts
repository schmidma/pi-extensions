import { readFileSync } from "node:fs";

export interface ModelConfig {
	provider?: string;
	model?: string;
}

export function parseModelConfig(value: unknown): ModelConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected a JSON object");
	}
	const config = value as Record<string, unknown>;
	if (Object.keys(config).some((key) => key !== "provider" && key !== "model")) {
		throw new Error("Unknown configuration field");
	}
	if (config.provider === undefined && config.model === undefined) return {};
	if (typeof config.provider !== "string" || !config.provider.trim() ||
		typeof config.model !== "string" || !config.model.trim()) {
		throw new Error("provider and model must be paired nonempty strings");
	}
	return { provider: config.provider, model: config.model };
}

export function loadModelConfig(path: string): ModelConfig {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Cannot read ${path}: ${String(error)}`);
	}
	try {
		return parseModelConfig(JSON.parse(text));
	} catch (error) {
		throw new Error(`Invalid ${path}: ${String(error)}`);
	}
}
