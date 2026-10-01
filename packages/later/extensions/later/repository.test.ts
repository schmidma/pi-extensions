import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveRepository } from "./repository.ts";

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFile("git", args, { cwd, encoding: "utf8" });
	return result.stdout;
}

function testPi(): ExtensionAPI {
	return {
		exec: async (
			command: string,
			args: string[],
			options?: { cwd?: string },
		) => {
			try {
				const result = await execFile(command, args, {
					cwd: options?.cwd,
					encoding: "utf8",
				});
				return {
					code: 0,
					stdout: result.stdout,
					stderr: result.stderr,
					killed: false,
				};
			} catch (error) {
				const failure = error as {
					code?: number;
					stdout?: string;
					stderr?: string;
				};
				return {
					code: typeof failure.code === "number" ? failure.code : 1,
					stdout: failure.stdout ?? "",
					stderr: failure.stderr ?? "",
					killed: false,
				};
			}
		},
	} as unknown as ExtensionAPI;
}

test("linked worktrees resolve to one repository identity", async () => {
	const directory = mkdtempSync(join(tmpdir(), "later-repository-test-"));
	const repositoryPath = join(directory, "repository");
	const worktreePath = join(directory, "worktree");
	try {
		await git(directory, ["init", "-q", repositoryPath]);
		await git(repositoryPath, ["config", "user.email", "later@example.test"]);
		await git(repositoryPath, ["config", "user.name", "Later Test"]);
		writeFileSync(join(repositoryPath, "README.md"), "test\n");
		await git(repositoryPath, ["add", "README.md"]);
		await git(repositoryPath, ["commit", "-qm", "initial"]);
		await git(repositoryPath, [
			"worktree",
			"add",
			"-qb",
			"later-test",
			worktreePath,
		]);

		const pi = testPi();
		const main = await resolveRepository(pi, repositoryPath);
		const worktree = await resolveRepository(pi, worktreePath);

		assert.ok(main);
		assert.ok(worktree);
		assert.equal(main.id, worktree.id);
		assert.equal(main.commonGitDir, worktree.commonGitDir);
		assert.notEqual(main.root, worktree.root);
		assert.equal(main.displayName, "repository");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("returns null outside Git", async () => {
	const directory = mkdtempSync(join(tmpdir(), "later-repository-test-"));
	try {
		assert.equal(await resolveRepository(testPi(), directory), null);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
