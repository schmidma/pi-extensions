import { describe, expect, test } from "bun:test";
import { sanitizeSingleLine } from "./terminal-text.ts";

describe("terminal text sanitization", () => {
	test("collapses multiline and control text", () => {
		expect(sanitizeSingleLine("first\nsecond\tthird\u0000")).toBe(
			"first second third",
		);
	});

	test("removes CSI styling sequences", () => {
		expect(sanitizeSingleLine("\u001b[31mred\u001b[0m title")).toBe(
			"red title",
		);
	});

	test("removes OSC hyperlinks terminated by BEL or ST", () => {
		expect(
			sanitizeSingleLine(
				"\u001b]8;;https://example.com\u0007click\u001b]8;;\u0007",
			),
		).toBe("click");
		expect(
			sanitizeSingleLine(
				"\u001b]8;;https://example.com\u001b\\click\u001b]8;;\u001b\\",
			),
		).toBe("click");
	});
});
