import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	SESSION_NAMING_STATE_TYPE,
	SessionNamingController,
	type GenerationOutcome,
	type PersistedOwnership,
} from "./core.ts";
import { generateWithTitleModel } from "./generate-title.ts";
import { buildRetitleContext } from "./retitle-context.ts";

function describeRetitle(result: GenerationOutcome): {
	message: string;
	type: "info" | "warning";
} {
	if (result.status === "applied") {
		return { message: `Session retitled: ${result.title}`, type: "info" };
	}
	if (result.status === "no-prompt") {
		return { message: "Nothing to title yet", type: "warning" };
	}
	if (result.status === "cancelled") {
		return {
			message: "Retitle cancelled by a newer session change",
			type: "warning",
		};
	}
	return { message: "Could not create a session title", type: "warning" };
}

export default function sessionNamingExtension(pi: ExtensionAPI): void {
	let controller: SessionNamingController | undefined;

	const stopRuntime = () => {
		controller?.shutdown();
		controller = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		stopRuntime();
		controller = new SessionNamingController({
			getSessionName: () => pi.getSessionName(),
			setSessionName: (name) => pi.setSessionName(name),
			appendOwnership: (marker: PersistedOwnership) =>
				pi.appendEntry(SESSION_NAMING_STATE_TYPE, marker),
			generateTitle: (input, signal, mode) =>
				generateWithTitleModel(ctx, input, signal, mode, join(getAgentDir(), "session-naming.json")),
		});
		controller.restore(ctx.sessionManager.getEntries());
	});

	pi.on("before_agent_start", (event) => {
		controller?.handlePrompt(event.prompt);
	});

	pi.on("session_info_changed", (event) => {
		controller?.handleSessionInfoChanged(event.name);
	});

	pi.on("session_shutdown", () => {
		stopRuntime();
	});

	pi.registerCommand("retitle", {
		description: "Regenerate the session title using the configured or current model",
		handler: async (_args, ctx) => {
			if (!controller) {
				ctx.ui.notify("Session naming is not ready", "warning");
				return;
			}
			const context = buildRetitleContext(ctx.sessionManager.buildSessionProjection().messages);
			const result = await controller.retitle(context);
			const notification = describeRetitle(result);
			ctx.ui.notify(notification.message, notification.type);
		},
	});
}
