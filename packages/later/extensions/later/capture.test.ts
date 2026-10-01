import assert from "node:assert/strict";
import test from "node:test";
import { parseDirectCapture } from "./capture.ts";

test("parses leading capture scope flags without treating later text as options", () => {
	assert.deepEqual(parseDirectCapture("-s keep this session-only"), {
		scope: "session",
		text: "keep this session-only",
	});
	assert.deepEqual(parseDirectCapture("--project verify --global in prose"), {
		scope: "project",
		text: "verify --global in prose",
	});
	assert.deepEqual(parseDirectCapture("note -g remains text"), {
		text: "note -g remains text",
	});
	assert.deepEqual(parseDirectCapture("  --global  global note  "), {
		scope: "global",
		text: "global note",
	});
});
