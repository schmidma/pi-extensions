import { describe, expect, test } from "bun:test";
import {
	dynamicTitleGap,
	leftWidthBudget,
	titleWidthBudget,
} from "./layout.ts";

describe("statusline title layout", () => {
	test("hides the title at narrow terminal widths", () => {
		expect(titleWidthBudget(59, 58)).toBe(0);
		expect(titleWidthBudget(20, 19)).toBe(0);
	});

	test("caps the title at forty percent of usable width", () => {
		expect(titleWidthBudget(100, 99)).toBe(39);
		expect(titleWidthBudget(80, 79)).toBe(31);
	});

	test("reserves a minimum gap without exceeding available width", () => {
		const contentWidth = 99;
		const titleWidth = 30;
		const leftBudget = leftWidthBudget(contentWidth, titleWidth);
		expect(leftBudget).toBe(67);
		expect(leftBudget + 2 + titleWidth).toBe(contentWidth);
	});

	test("expands whitespace to right-align a short title", () => {
		expect(dynamicTitleGap(99, 50, 20)).toBe(29);
		expect(dynamicTitleGap(99, 77, 20)).toBe(2);
	});

	test("does not reserve title space when there is no title", () => {
		expect(leftWidthBudget(79, 0)).toBe(79);
	});
});
