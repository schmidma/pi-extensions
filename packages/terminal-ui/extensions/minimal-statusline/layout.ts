export const MIN_TITLE_TERMINAL_WIDTH = 60;
export const MAX_TITLE_WIDTH_RATIO = 0.4;
export const TITLE_GAP = 2;

export function titleWidthBudget(
	terminalWidth: number,
	contentWidth: number,
): number {
	if (terminalWidth < MIN_TITLE_TERMINAL_WIDTH || contentWidth <= 0) return 0;
	return Math.max(0, Math.floor(contentWidth * MAX_TITLE_WIDTH_RATIO));
}

export function leftWidthBudget(
	contentWidth: number,
	titleWidth: number,
): number {
	if (titleWidth <= 0) return Math.max(0, contentWidth);
	return Math.max(0, contentWidth - titleWidth - TITLE_GAP);
}

export function dynamicTitleGap(
	contentWidth: number,
	leftWidth: number,
	titleWidth: number,
): number {
	return Math.max(TITLE_GAP, contentWidth - leftWidth - titleWidth);
}
