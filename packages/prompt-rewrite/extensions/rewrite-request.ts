import type { UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadModelConfig } from "./model-config.ts";

export type RewriteResult =
	| { status: "success"; text: string }
	| { status: "cancelled" }
	| { status: "error"; message: string };

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function cancelled(signal: AbortSignal, error: unknown): boolean {
	return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

// Capture the current model once, but prepare anew for every shortcut invocation.
export function prepareRewrite(ctx: ExtensionContext, configPath: string, original: string, systemPrompt: string) {
	const current = ctx.model;
	const config = loadModelConfig(configPath);
	const override = config.provider !== undefined && config.model !== undefined;
	const distinct = override && current !== undefined &&
		(current.provider !== config.provider || current.id !== config.model);
	const fallback = config.fallbackToCurrentModel === true && distinct;
	const configured = override ? ctx.modelRegistry.find(config.provider!, config.model!) : current;
	const initial = configured ?? (fallback ? current : undefined);
	if (!initial) {
		throw new Error(override ? `Configured rewrite model unavailable: ${config.provider}/${config.model}` : "No rewrite model available");
	}
	const message: UserMessage = {
		role: "user",
		content: [{ type: "text", text: original }],
		timestamp: Date.now(),
	};
	return {
		model: initial,
		async run(signal: AbortSignal): Promise<RewriteResult> {
			const request = async (model: typeof initial): Promise<RewriteResult> => {
				if (signal.aborted) return { status: "cancelled" };
				const response = await ctx.modelRegistry.streamSimple(
					model,
					{ systemPrompt, messages: [message] },
					{ reasoning: "low", signal },
				).result();
				if (signal.aborted || response.stopReason === "aborted") return { status: "cancelled" };
				if (response.stopReason !== "stop") {
					throw new Error(`Model stopped before completing (${response.stopReason})`);
				}
				const text = response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
				if (!text.trim()) throw new Error("Model returned an empty rewrite");
				return { status: "success", text };
			};
			try {
				return await request(initial);
			} catch (initialError) {
				if (cancelled(signal, initialError)) return { status: "cancelled" };
				// An unavailable override already selected current; do not retry it.
				if (!fallback || !configured || !current) {
					return { status: "error", message: errorMessage(initialError) };
				}
				try {
					return await request(current);
				} catch (fallbackError) {
					if (cancelled(signal, fallbackError)) return { status: "cancelled" };
					return { status: "error", message: `Configured model failed (${errorMessage(initialError)}); fallback failed (${errorMessage(fallbackError)})` };
				}
			}
		},
	};
}
