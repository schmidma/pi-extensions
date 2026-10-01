import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";
import { LaterStore, parseLaterId } from "./store.ts";
import type { RepositoryContext } from "./types.ts";

function withStore(run: (store: LaterStore, path: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "later-store-test-"));
	const path = join(directory, "private", "later.sqlite");
	const store = new LaterStore(path);
	try {
		run(store, path);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

const repository: RepositoryContext = {
	id: "repo-one",
	commonGitDir: "/tmp/repo-one/.git",
	root: "/tmp/repo-one",
	displayName: "repo-one",
};

const source = {
	cwd: "/tmp/repo-one",
	sessionId: "session-one",
	sessionFile: "/tmp/session-one.jsonl",
};

test("adds globally unique references and lists by repository", () => {
	withStore((store, path) => {
		const first = store.add({ repository, text: "First thought", source });
		const second = store.add({
			repository: null,
			text: "Global thought",
			context: "Some context",
			source,
		});

		assert.equal(first.id, "L-1");
		assert.equal(second.id, "L-2");
		assert.deepEqual(store.list({ repositoryId: repository.id }), [first]);
		assert.deepEqual(store.list({ repositoryId: null }), [second]);
		assert.equal(store.countInbox(repository.id), 1);
		assert.equal(store.countInbox(null), 1);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.ok(readFileSync(path).length > 0);
	});
});

test("updates, searches, archives, deletes, and restores", () => {
	withStore((store) => {
		const created = store.add({
			repository,
			text: "Improve diagnostics",
			context: "Distinguish stale results",
			source,
		});

		const updated = store.update(
			created.id,
			{ text: "Improve diagnostic freshness" },
			source.sessionId,
		);
		assert.equal(updated?.context, "Distinguish stale results");
		assert.equal(store.list({ query: "freshness" }).length, 1);
		assert.equal(store.list({ query: "stale" }).length, 1);

		assert.equal(store.archive(created.id, source.sessionId)?.lifecycle, "archived");
		assert.equal(store.countInbox(repository.id), 0);
		const deleted = store.softDelete(created.id, source.sessionId);
		assert.equal(deleted?.lifecycle, "deleted");
		assert.equal(deleted?.deletedFrom, "archived");
		assert.throws(
			() => store.archive(created.id, source.sessionId),
			/Restore L-1 before changing its lifecycle/,
		);
		assert.equal(store.restore(created.id, source.sessionId)?.lifecycle, "archived");
		assert.equal(store.restore(created.id, source.sessionId)?.lifecycle, "inbox");
	});
});

test("counts and uncapped manager reads remain accurate beyond 500 items", () => {
	withStore((store) => {
		for (let index = 0; index < 501; index++) {
			store.add({ repository, text: `item ${index}`, source });
		}
		assert.equal(store.count({ repositoryId: repository.id, lifecycle: "inbox" }), 501);
		assert.equal(
			store.list({
				repositoryId: repository.id,
				lifecycle: "inbox",
				limit: null,
			}).length,
			501,
		);
		assert.equal(store.list({ repositoryId: repository.id }).length, 100);
	});
});

test("multiple store connections allocate IDs without collisions", () => {
	const directory = mkdtempSync(join(tmpdir(), "later-store-test-"));
	const path = join(directory, "later.sqlite");
	const first = new LaterStore(path);
	const second = new LaterStore(path);
	try {
		const items = [
			first.add({ repository, text: "one", source }),
			second.add({ repository, text: "two", source }),
			first.add({ repository, text: "three", source }),
		];
		assert.deepEqual(
			items.map((item) => item.id),
			["L-1", "L-2", "L-3"],
		);
		assert.equal(second.list({ lifecycle: "inbox" }).length, 3);
	} finally {
		first.close();
		second.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("keeps session items isolated and moves without changing provenance", () => {
	withStore((store) => {
		const session = store.add({
			repository: null,
			scope: "session",
			ownerSessionId: "session-one",
			text: "private thought",
			source,
		});
		store.add({ repository, scope: "project", text: "project thought", source });
		store.add({ repository: null, scope: "global", text: "global thought", source });
		assert.deepEqual(store.list({ scope: "session", sessionId: "session-two" }), []);
		assert.equal(store.getVisible(session.id, "session-two"), undefined);
		assert.equal(store.getVisible(session.id, "session-one")?.id, session.id);
		assert.equal(store.update(session.id, { text: "intrusion" }, "session-two"), undefined);
		assert.equal(store.archive(session.id, "session-two"), undefined);
		assert.equal(store.softDelete(session.id, "session-two"), undefined);
		assert.equal(store.restore(session.id, "session-two"), undefined);
		assert.equal(
			store.move(session.id, { scope: "project", repository }, "session-two"),
			undefined,
		);
		assert.equal(store.get(session.id)?.text, "private thought");
		assert.equal(store.get(session.id)?.scope, "session");
		assert.equal(store.list({ scope: "all", sessionId: "session-two" }).length, 2);
		assert.equal(store.list({ scope: "all", sessionId: "session-one" }).length, 3);
		const moved = store.move(session.id, { scope: "project", repository }, "session-one");
		assert.equal(moved?.id, session.id);
		assert.equal(moved?.scope, "project");
		assert.equal(moved?.source.sessionId, "session-one");
		assert.equal(moved?.lifecycle, "inbox");
		const global = store.move(session.id, { scope: "global" }, "session-one");
		assert.equal(global?.repositoryId, null);
		assert.equal(global?.ownerSessionId, undefined);
	});
});

test("migrates v1 rows to explicit persistent ownership", () => {
	const directory = mkdtempSync(join(tmpdir(), "later-store-migration-"));
	const path = join(directory, "later.sqlite");
	const database = new DatabaseSync(path);
	try {
		database.exec(`
			CREATE TABLE repositories (id TEXT PRIMARY KEY, common_git_dir TEXT NOT NULL, display_name TEXT NOT NULL, last_seen_at TEXT NOT NULL) STRICT;
			CREATE TABLE items (
				id INTEGER PRIMARY KEY AUTOINCREMENT, repository_id TEXT, text TEXT NOT NULL, context TEXT,
				lifecycle TEXT NOT NULL, deleted_from TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				source_cwd TEXT NOT NULL, source_session_id TEXT, source_session_file TEXT
			) STRICT;
			INSERT INTO repositories VALUES ('repo-one', '/tmp/repo-one/.git', 'repo-one', '2025-01-01T00:00:00.000Z');
			INSERT INTO items VALUES (1, 'repo-one', 'project', NULL, 'inbox', NULL, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '/tmp', 'source-session', NULL);
			INSERT INTO items VALUES (2, NULL, 'global', NULL, 'inbox', NULL, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '/tmp', 'source-session', NULL);
			PRAGMA user_version = 1;
		`);
	} finally {
		database.close();
	}
	const store = new LaterStore(path);
	try {
		assert.equal(store.get("L-1")?.scope, "project");
		assert.equal(store.get("L-2")?.scope, "global");
		assert.equal(store.get("L-1")?.source.sessionId, "source-session");
		assert.equal(
			store.add({ repository: null, scope: "global", text: "after migration", source }).id,
			"L-3",
		);
	} finally {
		store.close();
	}

	const upgraded = new DatabaseSync(path);
	try {
		assert.equal(
			(upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
			2,
		);
		assert.throws(() =>
			upgraded.exec(`
				INSERT INTO items(
					ownership_scope, repository_id, owner_session_id, text, lifecycle,
					created_at, updated_at, source_cwd
				) VALUES (
					'project', NULL, NULL, 'invalid owner', 'inbox',
					'2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '/tmp'
				)
			`),
		);
	} finally {
		upgraded.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("parses canonical and prompt references", () => {
	assert.equal(parseLaterId("L-42"), 42);
	assert.equal(parseLaterId("later:L-42"), 42);
	assert.throws(() => parseLaterId("#42"), /Invalid later item reference/);
});
