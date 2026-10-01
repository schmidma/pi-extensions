import { describe, expect, test } from "bun:test";
import {
	workingMessageEllipsis,
	workingMessageSource,
	workingMessageWidth,
} from "./working-message.ts";

describe("working-message formatting", () => {
	test("collapses multiline prompts into one safe line", () => {
		expect(workingMessageSource("first line\nsecond\tline")).toBe(
			"first line second line",
		);
		expect(workingMessageSource("\u001b[31mdanger\u001b[0m")).toBe("danger");
		expect(
			workingMessageSource(
				"\u001b]8;;https://example.com\u0007click\u001b]8;;\u0007",
			),
		).toBe("click");
	});

	test("labels prompts that contain no displayable text", () => {
		expect(workingMessageSource("\n\t")).toBe("Image prompt");
	});

	test("reserves both Text margins, the spinner, and its separator", () => {
		expect(workingMessageWidth(120)).toBe(116);
		expect(workingMessageWidth(40.9)).toBe(36);
		expect(workingMessageWidth(120) + 4).toBe(120);
		expect(workingMessageWidth(2)).toBe(1);
		expect(workingMessageWidth(1)).toBe(1);
	});

	test("shades the truncation ellipsis like inactive text", () => {
		expect(workingMessageEllipsis((text) => `<muted>${text}</muted>`)).toBe(
			"<muted>…</muted>",
		);
	});

	test("uses a bounded default for unavailable terminal dimensions", () => {
		expect(workingMessageWidth(undefined)).toBe(76);
		expect(workingMessageWidth(Number.NaN)).toBe(76);
		expect(workingMessageWidth(0)).toBe(76);
	});
});
