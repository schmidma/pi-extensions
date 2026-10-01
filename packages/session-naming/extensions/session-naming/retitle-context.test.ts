import { describe, expect, test } from "bun:test";
import { buildRetitleContext } from "./retitle-context.ts";
import { titleRequest } from "./title-request.ts";

function message(role: "user" | "assistant", text: string) {
	return { role, content: [{ type: "text", text }] };
}

describe("current conversation retitle context", () => {
	test("preserves every supplied message in order, including middle and end of long multiline dialogue", () => {
		const messages = [message("user", `Original request\n${"a".repeat(3_000)}`)];
		for (let index = 0; index < 20; index += 1) {
			messages.push(message(index % 2 === 0 ? "assistant" : "user", `message-${index}\n${"x".repeat(1_000)}\nend-${index}`));
		}
		messages.push(message("user", "Yes, do that"));
		const context = buildRetitleContext(messages)!;
		expect(context.length).toBeGreaterThan(8_000);
		expect(context).toContain(`Original request\n${"a".repeat(3_000)}`);
		for (let index = 0; index < 20; index += 1) {
			expect(context).toContain(`message-${index}\n${"x".repeat(1_000)}\nend-${index}`);
		}
		expect(context.indexOf("end-0")).toBeLessThan(context.indexOf("message-10"));
		expect(context).toContain("USER: Yes, do that");
	});

	test("takes only user and assistant text, including mixed assistant blocks", () => {
		const context = buildRetitleContext([
			{ role: "system", content: "hidden system" },
			message("user", "Discuss migration"),
			{
				role: "assistant",
				...{ provider: "secret-provider" },
				content: [
					{ type: "thinking", thinking: "hidden reasoning" },
					{ type: "text", text: "First reply" },
					{ type: "toolCall", name: "bash", arguments: { command: "secret command" } },
					{ type: "image", data: "secret-base64" },
					{ type: "text", text: "Second reply" },
				],
			},
			{ role: "toolResult", content: [{ type: "text", text: "secret result" }] },
			{ role: "custom", content: "secret custom" },
			{ role: "bashExecution", ...{ command: "secret bash", output: "secret output" } },
			{ role: "assistant", content: "String reply" },
		]);
		expect(context).toBe("USER: Discuss migration\n\nASSISTANT: First reply\nSecond reply\n\nASSISTANT: String reply");
	});

	test("keeps projected compaction and branch summaries in supplied order", () => {
		const context = buildRetitleContext([
			{ role: "compactionSummary", summary: "first\nsummary" },
			message("user", "Kept request"),
			{ role: "branchSummary", summary: "branch summary" },
			message("assistant", "Continue on branch"),
		]);
		expect(context).toBe("COMPACTION SUMMARY: first\nsummary\n\nUSER: Kept request\n\nBRANCH SUMMARY: branch summary\n\nASSISTANT: Continue on branch");
	});

	test("skips image-only, tool-only, blank, and nonconversation messages", () => {
		expect(buildRetitleContext([
			{ role: "user", content: [{ type: "image", data: "base64" }] },
			{ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "toolCall", name: "bash" }] },
			{ role: "toolResult", content: "result" },
			{ role: "user", content: "  " },
			{ role: "compactionSummary", summary: " " },
		])).toBeUndefined();
		expect(buildRetitleContext([])).toBeUndefined();
		expect(buildRetitleContext([message("user", "hello"), { role: "user", content: [{ type: "image", data: "base64" }] }])).toBe("USER: hello");
	});
});

describe("request serialization", () => {
	test("does not clip retitle context a second time, but keeps automatic prompt bound", () => {
		const history = buildRetitleContext([message("user", "first"), message("assistant", "middle".repeat(2_000)), message("user", "final unique marker")])!;
		const request = titleRequest(history, "retitle");
		expect(request).toContain("current compaction-aware conversation context");
		expect(request).toContain(JSON.stringify(history));
		expect(JSON.parse(request.slice(request.indexOf("\n") + 1))).toBe(history);
		expect(request).toContain("final unique marker");
		const automatic = titleRequest("x".repeat(3_000), "automatic");
		expect(JSON.parse(automatic.slice(automatic.indexOf("\n") + 1)).length).toBe(2_400);
	});
});
