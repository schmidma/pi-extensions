import assert from "node:assert/strict";
import test from "node:test";
import { insertLaterReference } from "./selection.ts";

test("renders after inserting a selected reference", () => {
	const events: string[] = [];

	insertLaterReference(
		"later:L-7",
		{ pasteToEditor: (text) => events.push(`paste:${text}`) },
		{ requestRender: () => events.push("render") },
	);

	assert.deepEqual(events, ["paste:later:L-7 ", "render"]);
});
