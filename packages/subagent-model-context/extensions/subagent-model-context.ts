import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTEXT_TAG = "subagent_model_options";

export function formatScopedModelContext(
	models: ReadonlyArray<{
		model: { provider: string; id: string };
		thinkingLevel?: string;
	}>,
): string | undefined {
	if (models.length === 0) return undefined;

	const lines = models.map(({ model, thinkingLevel }) => {
		const level = thinkingLevel ? ` (scope preference: ${thinkingLevel})` : "";
		return `- ${model.provider}/${model.id}${level}`;
	});

	return [
		`<${CONTEXT_TAG}>`,
		"Currently selectable subagent models in this session:",
		...lines,
		"This roster indicates availability only, not a fixed quality ordering. Select the model and reasoning effort independently for the task.",
		`</${CONTEXT_TAG}>`,
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		if (!pi.getActiveTools().includes("Agent")) return;
		if (event.systemPrompt.includes(`<${CONTEXT_TAG}>`)) return;

		const context = formatScopedModelContext(ctx.scopedModels);
		if (!context) return;

		return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
	});
}
