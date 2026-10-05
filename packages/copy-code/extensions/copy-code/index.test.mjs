import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

// Resolve the installed host from PATH, just as Pi does for extension imports.
const executable = process.env.PATH.split(delimiter).map((dir) => join(dir, "pi")).find(existsSync);
assert.ok(executable, "Pi must be installed on PATH");
const hostCli = realpathSync(executable);
const hostRequire = createRequire(hostCli);
const hostEntry = [join(dirname(hostCli), "index.js"), join(dirname(hostCli), "..", "index.js")].find(existsSync);
assert.ok(hostEntry, "Pi's public dist/index.js must be installed");
const { createJiti } = hostRequire("jiti");
const jiti = createJiti(import.meta.url, {
	fsCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": hostEntry,
		"@earendil-works/pi-tui": hostRequire.resolve("@earendil-works/pi-tui"),
	},
});
const { default: register, extractCodeBlocks, collectCodeChoices, choiceLabel, copyCode } = await jiti.import("./index.ts");

const text = (value) => ({ type: "text", text: value });
const assistant = (...content) => ({ type: "message", message: { role: "assistant", content } });
const fenced = (value, language = "") => `\`\`\`${language}\n${value}\n\`\`\``;

function harness(branch, { mode = "tui", select, copy = async () => {} } = {}) {
	const events = [];
	let branchReads = 0;
	let command;
	let shortcut;
	register({
		registerCommand(name, options) {
			assert.equal(name, "copy-code");
			command = options.handler;
		},
		registerShortcut(key, options) {
			assert.equal(key, "ctrl+alt+c");
			shortcut = options.handler;
		},
	}, async (payload) => {
		events.push(["copy", payload]);
		await copy(payload);
	});
	const ctx = {
		mode,
		sessionManager: { getBranch() { branchReads++; return branch; } },
		ui: {
			async select(title, labels) {
				events.push(["select", title, labels]);
				return select ? select(labels) : labels[0];
			},
			notify(message, level) { events.push(["notify", message, level]); },
		},
	};
	return { events, ctx, command: (args = "") => command(args, ctx), shortcut: () => shortcut(ctx), branchReads: () => branchReads };
}

test("extracts backtick, tilde, quote, list, nested and indented code in source order", () => {
	const markdown = [
		fenced("  first  \n\nlast  ", "js"),
		"~~~python\nprint('tilde')\n~~~",
		"> ```sh\n> echo quote\n> ```",
		"- item\n\n  ```ts\n  const list = 1;\n  ```",
		"> - nested\n>\n>   ~~~ruby\n>   puts :nested\n>   ~~~",
		"    indented\n    second",
	].join("\n\n");
	assert.deepEqual(extractCodeBlocks(markdown), [
		{ text: "  first  \n\nlast  ", language: "js" },
		{ text: "print('tilde')", language: "python" },
		{ text: "echo quote", language: "sh" },
		{ text: "const list = 1;", language: "ts" },
		{ text: "puts :nested", language: "ruby" },
		{ text: "indented\nsecond", language: "" },
	]);
});

test("excludes inline code and preserves code-token whitespace, blank lines and empty payloads", () => {
	assert.deepEqual(extractCodeBlocks("Use `inline` and prose."), []);
	assert.deepEqual(extractCodeBlocks(`${fenced("\n \tvalue  \n\n")}\n\n${fenced("")}`), [
		{ text: "\n \tvalue  \n\n", language: "" },
		{ text: "", language: "" },
	]);
});

test("latest skips tool-only, thinking-only and empty assistant text; never extracts other roles", () => {
	const branch = [
		assistant(text(fenced("old"))),
		assistant(text(fenced("latest")), { type: "thinking", thinking: fenced("secret") }),
		assistant({ type: "toolCall", arguments: { code: fenced("call") } }),
		{ type: "message", message: { role: "toolResult", content: [text(fenced("result"))] } },
		assistant({ type: "thinking", thinking: fenced("secret") }),
		assistant(text(""), text(" \n")),
		{ type: "message", message: { role: "user", content: [text(fenced("user"))] } },
		{ type: "custom_message", content: fenced("custom") },
	];
	assert.deepEqual(collectCodeChoices(branch, false), [{ text: "latest", language: "", response: 1 }]);
	assert.deepEqual(collectCodeChoices(branch, true).map((block) => block.text), ["latest", "old"]);
});

test("latest text without code does not fall back; all remains newest-first and source-ordered", () => {
	const branch = [
		assistant(text(fenced("old 1")), text(fenced("old 2"))),
		assistant(text(`${fenced("new 1")}\n\n${fenced("new 2")}`)),
		assistant(text("No code here.")),
	];
	assert.deepEqual(collectCodeChoices(branch, false), []);
	assert.deepEqual(collectCodeChoices(branch, true).map(({ text, response }) => [text, response]), [
		["new 1", 2], ["new 2", 2], ["old 1", 3], ["old 2", 3],
	]);
});

test("labels are numbered, unique, bounded and control-safe, with language, lines, preview and source", () => {
	const choice = { text: `\n\n\u001b[31mhello\u0007\u009b\u202e${"x".repeat(300)}\n`, language: `js\u001b[0m${"y".repeat(100)}`, response: 2 };
	const label = choiceLabel(choice, 0, true);
	assert.match(label, /^1\. response 2 \| /);
	assert.match(label, /\| 3 lines \| \[31mhello/);
	assert.ok(label.length < 150);
	assert.doesNotMatch(label, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
	assert.notEqual(label, choiceLabel(choice, 1, true));
	assert.match(choiceLabel({ text: "", language: "", response: 1 }, 0, false), /plain text \| 0 lines \| \(empty\)/);
	assert.match(choiceLabel({ text: "one", language: "js metadata", response: 1 }, 0, true), /response 1 \(latest\) \| js \| 1 line \| one/);
});

test("command opens picker even for one block, copies exact payload and then notifies", async () => {
	const payload = "\n  keep trailing spaces  \n\n";
	const h = harness([assistant(text(fenced(payload, "ts")))]);
	await h.command();
	assert.deepEqual(h.events.map(([event]) => event), ["select", "copy", "notify"]);
	assert.equal(h.events[1][1], payload);
	assert.equal(h.events[2][2], "info");
	assert.equal(h.branchReads(), 1);
});

test("all picker selects the chosen older block, not every block", async () => {
	const h = harness([assistant(text(fenced("old"))), assistant(text(fenced("new")))], { select: (labels) => labels[1] });
	await h.command(" all ");
	assert.match(h.events[0][2][0], /response 1 \(latest\)/);
	assert.match(h.events[0][2][1], /response 2/);
	assert.deepEqual(h.events[1], ["copy", "old"]);
});

test("shortcut behaves like no-argument command", async () => {
	const branch = [assistant(text(fenced("old"))), assistant(text(fenced("new")))];
	const command = harness(branch);
	const shortcut = harness(branch);
	await command.command();
	await shortcut.shortcut();
	assert.deepEqual(shortcut.events, command.events);
});

test("cancellation never writes clipboard or reports success", async () => {
	const h = harness([assistant(text(fenced("code")))], { select: () => undefined });
	await h.command();
	assert.deepEqual(h.events.map(([event]) => event), ["select"]);
});

test("non-TUI modes and invalid arguments do not read branch, open picker or copy", async () => {
	for (const mode of ["rpc", "print", "json"]) {
		const h = harness([], { mode });
		await h.command();
		await h.shortcut();
		assert.equal(h.branchReads(), 0);
		assert.ok(h.events.every(([event, message, level]) => event === "notify" && message.includes("interactive") && level === "error"));
	}
	for (const args of ["latest", "all extra", "ALL"]) {
		const h = harness([]);
		await h.command(args);
		assert.equal(h.branchReads(), 0);
		assert.deepEqual(h.events, [["notify", "Usage: /copy-code [all]", "error"]]);
	}
});

test("no blocks, including latest prose and empty branch, do not open picker or copy", async () => {
	for (const branch of [[], [assistant(text(fenced("old"))), assistant(text("prose"))]]) {
		const h = harness(branch);
		await h.command();
		assert.equal(h.events.length, 1);
		assert.equal(h.events[0][0], "notify");
		assert.equal(h.events[0][2], "info");
	}
	const h = harness([]);
	await h.command("all");
	assert.match(h.events[0][1], /this branch/);
});

test("success notification waits until clipboard operation completes", async () => {
	let resolve;
	const pending = new Promise((done) => { resolve = done; });
	const h = harness([assistant(text(fenced("code")))], { copy: () => pending });
	const running = h.command();
	await new Promise((done) => setImmediate(done));
	assert.deepEqual(h.events.map(([event]) => event), ["select", "copy"]);
	resolve();
	await running;
	assert.equal(h.events[2][0], "notify");
});

test("clipboard and selector errors are caught and reported without success", async () => {
	for (const options of [
		{ copy: async () => { throw new Error("clipboard unavailable\u001b[31m"); } },
		{ select: () => { throw new Error("selector unavailable"); } },
	]) {
		const h = harness([assistant(text(fenced("code")))], options);
		await h.command();
		const notices = h.events.filter(([event]) => event === "notify");
		assert.equal(notices.length, 1);
		assert.equal(notices[0][2], "error");
		assert.match(notices[0][1], /^copy-code failed:/);
		assert.doesNotMatch(notices[0][1], /\u001b/);
	}
	const h = harness([]);
	h.ctx.sessionManager.getBranch = () => { throw new Error("branch unavailable"); };
	await copyCode("", h.ctx, async () => assert.fail("must not copy"));
	assert.deepEqual(h.events, [["notify", "copy-code failed: branch unavailable", "error"]]);
});
