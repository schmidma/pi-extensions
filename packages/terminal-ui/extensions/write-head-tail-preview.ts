import type {
	ExtensionAPI,
	Theme,
	WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import {
	createWriteTool,
	getLanguageFromPath,
	highlightCode,
	keyHint,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const PREVIEW_LINES_PER_END = 5;

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;
	return lines.slice(0, end);
}

function renderContent(
	args: Partial<WriteToolInput>,
	expanded: boolean,
	theme: Theme,
): string {
	const content = typeof args.content === "string" ? args.content : "";
	if (!content) return "";

	const path = typeof args.path === "string" ? args.path : undefined;
	const language = path ? getLanguageFromPath(path) : undefined;
	const rawLines = trimTrailingEmptyLines(
		content.replaceAll("\t", "  ").split("\n"),
	);
	const renderedLines = language
		? trimTrailingEmptyLines(
				highlightCode(content.replaceAll("\t", "  "), language),
			)
		: rawLines.map((line) => theme.fg("toolOutput", line));

	const lineCount = renderedLines.length;
	if (expanded || lineCount <= PREVIEW_LINES_PER_END * 2) {
		return renderedLines.join("\n");
	}

	const omitted = lineCount - PREVIEW_LINES_PER_END * 2;
	const omittedLine = theme.fg(
		"muted",
		`… (${omitted} lines omitted, ${keyHint("app.tools.expand", "to expand")})`,
	);
	return [
		...renderedLines.slice(0, PREVIEW_LINES_PER_END),
		omittedLine,
		...renderedLines.slice(-PREVIEW_LINES_PER_END),
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	const originalWrite = createWriteTool(process.cwd());

	pi.registerTool({
		name: "write",
		label: "write",
		description: originalWrite.description,
		promptSnippet: originalWrite.promptSnippet,
		promptGuidelines: originalWrite.promptGuidelines,
		parameters: originalWrite.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalWrite.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			const path = typeof args.path === "string" ? args.path : "[invalid path]";
			let text =
				theme.fg("toolTitle", theme.bold("write ")) + theme.fg("accent", path);
			const preview = renderContent(args, context.expanded, theme);
			if (preview) text += `\n\n${preview}`;
			return new Text(text, 0, 0);
		},
	});
}
