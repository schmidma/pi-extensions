import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Marked } from "@earendil-works/pi-tui";

export interface CodeBlock {
	text: string;
	language: string;
}

export interface CodeChoice extends CodeBlock {
	response: number;
}

// Keep our parser independent of any Markdown renderer's global configuration.
export function extractCodeBlocks(markdown: string): CodeBlock[] {
	const parser = new Marked();
	const blocks: CodeBlock[] = [];
	parser.walkTokens(parser.lexer(markdown), (token) => {
		if (token.type === "code") {
			blocks.push({ text: token.text, language: token.lang ?? "" });
		}
	});
	return blocks;
}

export function collectCodeChoices(branch: readonly SessionEntry[], all: boolean): CodeChoice[] {
	const choices: CodeChoice[] = [];
	let response = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const text = entry.message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (!text.trim()) continue;
		response++;
		for (const block of extractCodeBlocks(text)) choices.push({ ...block, response });
		// Latest means latest text-bearing response, not latest response containing code.
		if (!all) break;
	}
	return choices;
}

function safeLabel(text: string, limit: number): string {
	const safe = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
	const chars = Array.from(safe);
	return chars.length <= limit ? safe : `${chars.slice(0, limit - 3).join("")}...`;
}

export function choiceLabel(choice: CodeChoice, index: number, all: boolean): string {
	const language = safeLabel(choice.language.split(/\s/)[0], 24) || "plain text";
	const lines = choice.text === "" ? 0 : choice.text.split("\n").length - Number(choice.text.endsWith("\n"));
	const firstLine = choice.text.split("\n").find((line) => line.trim()) ?? "";
	const preview = safeLabel(firstLine, 72) || "(empty)";
	const source = all ? `response ${choice.response}${choice.response === 1 ? " (latest)" : ""} | ` : "";
	return `${index + 1}. ${source}${language} | ${lines} ${lines === 1 ? "line" : "lines"} | ${preview}`;
}

export async function copyCode(
	args: string,
	ctx: ExtensionContext,
	copy: (text: string) => Promise<void> = copyToClipboard,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("copy-code requires interactive mode", "error");
		return;
	}
	const argument = args.trim();
	if (argument !== "" && argument !== "all") {
		ctx.ui.notify("Usage: /copy-code [all]", "error");
		return;
	}
	try {
		const all = argument === "all";
		const choices = collectCodeChoices(ctx.sessionManager.getBranch(), all);
		if (!choices.length) {
			ctx.ui.notify(all ? "No code blocks in assistant messages on this branch" : "No code blocks in the latest assistant text response", "info");
			return;
		}
		const labels = choices.map((choice, index) => choiceLabel(choice, index, all));
		const selected = await ctx.ui.select(all ? "Copy code block - current branch (newest first)" : "Copy code block - latest response", labels);
		if (selected === undefined) return;
		const index = labels.indexOf(selected);
		if (index < 0) return;
		await copy(choices[index].text);
		ctx.ui.notify("Code block copied to clipboard", "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`copy-code failed: ${safeLabel(message, 200)}`, "error");
	}
}

export default function registerCopyCode(
	pi: ExtensionAPI,
	copy: (text: string) => Promise<void> = copyToClipboard,
) {
	pi.registerCommand("copy-code", {
		description: "Copy a code block from the latest assistant response, or use 'all' for the current branch",
		handler: (args, ctx) => copyCode(args, ctx, copy),
	});
	pi.registerShortcut("ctrl+alt+c", {
		description: "Copy a code block from the latest assistant response",
		handler: (ctx) => copyCode("", ctx, copy),
	});
}
