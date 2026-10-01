import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	workingMessageEllipsis,
	workingMessageSource,
	workingMessageWidth,
} from "./working-message.ts";

function workingMessage(prompt: string, ellipsis: string): string {
	return truncateToWidth(
		workingMessageSource(prompt),
		workingMessageWidth(process.stdout.columns),
		ellipsis,
	);
}

export default function workingPromptExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWorkingMessage();
	});

	pi.on("before_agent_start", (event, ctx) => {
		const ellipsis = workingMessageEllipsis((text) =>
			ctx.ui.theme.fg("muted", text),
		);
		ctx.ui.setWorkingMessage(workingMessage(event.prompt, ellipsis));
	});

	pi.on("agent_settled", (_event, ctx) => {
		ctx.ui.setWorkingMessage();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setWorkingMessage();
	});
}
