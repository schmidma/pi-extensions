interface RetitleMessage {
	role?: string;
	content?: unknown;
	summary?: string;
}

function textParts(content: unknown): string[] {
	if (typeof content === "string") return content.trim() ? [content] : [];
	if (!Array.isArray(content)) return [];

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
			parts.push(block.text);
		}
	}
	return parts;
}

/** Serialize only conversation text from Pi's current compaction-aware projection. */
export function buildRetitleContext(
	messages: readonly RetitleMessage[],
): string | undefined {
	const sections: string[] = [];
	for (const message of messages) {
		if (message.role === "compactionSummary" || message.role === "branchSummary") {
			if (typeof message.summary === "string" && message.summary.trim()) {
				sections.push(`${message.role === "compactionSummary" ? "COMPACTION" : "BRANCH"} SUMMARY: ${message.summary}`);
			}
			continue;
		}
		if (message.role !== "user" && message.role !== "assistant") continue;
		const parts = textParts(message.content);
		if (parts.length) sections.push(`${message.role.toUpperCase()}: ${parts.join("\n")}`);
	}
	return sections.length ? sections.join("\n\n") : undefined;
}
