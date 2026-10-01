import { sanitizeSingleLine } from "../shared/terminal-text.ts";

const IMAGE_PROMPT_LABEL = "Image prompt";
const DEFAULT_TERMINAL_WIDTH = 80;
// Pi's Loader adds one left and right margin around content, then prefixes the
// default one-cell spinner and a separating space.
const STATUS_ROW_OVERHEAD_COLUMNS = 4;

export function workingMessageSource(prompt: string): string {
	return sanitizeSingleLine(prompt) || IMAGE_PROMPT_LABEL;
}

export function workingMessageEllipsis(
	shadeInactiveText: (text: string) => string,
): string {
	return shadeInactiveText("…");
}

export function workingMessageWidth(
	terminalColumns: number | undefined,
): number {
	const columns =
		typeof terminalColumns === "number" &&
		Number.isFinite(terminalColumns) &&
		terminalColumns > 0
			? Math.floor(terminalColumns)
			: DEFAULT_TERMINAL_WIDTH;
	return Math.max(1, columns - STATUS_ROW_OVERHEAD_COLUMNS);
}
