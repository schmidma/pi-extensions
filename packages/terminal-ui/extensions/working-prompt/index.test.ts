import { expect, test } from "bun:test";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import workingPrompt from "./index.ts";

const base = {
	type: "before_agent_start" as const,
	systemPrompt: "system",
	systemPromptOptions: { cwd: "/tmp", selectedTools: [], hiddenTools: [], toolSnippets: {}, toolGuidelines: {},
		promptGuidelines: [], appendSystemPrompt: "", sections: {}, contextFiles: [], skills: [] },
};

test("user prompts label work; custom triggers and lifecycle boundaries reset stale labels", () => {
	const handlers: Record<string, Function> = {};
	const messages: (string | undefined)[] = [];
	workingPrompt({ on: (name: string, handler: Function) => { handlers[name] = handler; } } as unknown as ExtensionAPI);
	const ctx = { ui: { theme: { fg: (_token: string, text: string) => text },
		setWorkingMessage: (message?: string) => messages.push(message) } } as unknown as ExtensionContext;
	const user: BeforeAgentStartEvent = { ...base, messageType: "user", prompt: "Fix this\nplease" };
	const custom: BeforeAgentStartEvent = { ...base, messageType: "custom",
		message: { role: "custom", customType: "subagent-report", content: "Task finished", display: true, timestamp: 0 } };
	handlers.session_start({}, ctx);
	expect(messages.at(-1)).toBeUndefined();
	handlers.before_agent_start(user, ctx);
	expect(messages.at(-1)).toBe("Fix this please");
	handlers.before_agent_start(custom, ctx);
	expect(messages.at(-1)).toBeUndefined();
	handlers.before_agent_start({ ...user, prompt: "" }, ctx);
	expect(messages.at(-1)).toBe("Image prompt");
	for (const event of ["agent_settled", "session_shutdown"]) {
		handlers.before_agent_start(user, ctx);
		handlers[event]({}, ctx);
		expect(messages.at(-1)).toBeUndefined();
	}
});
