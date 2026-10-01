import type { GenerationMode } from "./core.ts";

const MAX_AUTOMATIC_PROMPT_CHARS = 2_400;

export function titleRequest(input: string, mode: GenerationMode): string {
	if (mode === "automatic") {
		return `Create a session title for this user prompt:\n${JSON.stringify(input.slice(0, MAX_AUTOMATIC_PROMPT_CHARS))}`;
	}
	return `Create a session title representing the overall task in this current compaction-aware conversation context. Account for evolving goals and later decisions without treating a final acknowledgement as the whole task:\n${JSON.stringify(input)}`;
}
