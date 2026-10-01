import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
	AddLaterItemInput,
	CountLaterItemsOptions,
	LaterItem,
	LaterLifecycle,
	LaterScope,
	ListLaterItemsOptions,
	MoveLaterItemInput,
	RepositoryContext,
	UpdateLaterItemInput,
} from "./types.ts";

const BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const CURRENT_SCHEMA_VERSION = 2;

const CREATE_ITEMS_SQL = `
	CREATE TABLE items (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ownership_scope TEXT NOT NULL CHECK(ownership_scope IN ('global', 'project', 'session')),
		repository_id TEXT REFERENCES repositories(id),
		owner_session_id TEXT,
		text TEXT NOT NULL CHECK(length(trim(text)) > 0),
		context TEXT,
		lifecycle TEXT NOT NULL DEFAULT 'inbox'
			CHECK(lifecycle IN ('inbox', 'archived', 'deleted')),
		deleted_from TEXT
			CHECK(deleted_from IS NULL OR deleted_from IN ('inbox', 'archived')),
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		source_cwd TEXT NOT NULL,
		source_session_id TEXT,
		source_session_file TEXT,
		CHECK(
			(ownership_scope = 'global' AND repository_id IS NULL AND owner_session_id IS NULL) OR
			(ownership_scope = 'project' AND repository_id IS NOT NULL AND owner_session_id IS NULL) OR
			(ownership_scope = 'session' AND repository_id IS NULL AND owner_session_id IS NOT NULL)
		)
	) STRICT;
`;

interface ItemRow {
	id: number;
	ownership_scope: LaterScope;
	repository_id: string | null;
	repository_name: string | null;
	owner_session_id: string | null;
	text: string;
	context: string | null;
	lifecycle: LaterLifecycle;
	deleted_from: Exclude<LaterLifecycle, "deleted"> | null;
	created_at: string;
	updated_at: string;
	source_cwd: string;
	source_session_id: string | null;
	source_session_file: string | null;
}

function formatId(id: number): string {
	return `L-${id}`;
}

export function parseLaterId(value: string): number {
	const match = value.trim().match(/^(?:later:)?L-(\d+)$/i);
	if (!match) throw new Error(`Invalid later item reference: ${value}`);
	return Number(match[1]);
}

function normalizeText(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${field} must not be empty`);
	return normalized;
}

function mapRow(row: ItemRow): LaterItem {
	return {
		id: formatId(row.id),
		scope: row.ownership_scope,
		repositoryId: row.repository_id,
		repositoryName: row.repository_name ?? undefined,
		ownerSessionId: row.owner_session_id ?? undefined,
		text: row.text,
		context: row.context ?? undefined,
		lifecycle: row.lifecycle,
		deletedFrom: row.deleted_from ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		source: {
			cwd: row.source_cwd,
			sessionId: row.source_session_id ?? undefined,
			sessionFile: row.source_session_file ?? undefined,
		},
	};
}

export class LaterStore {
	readonly path: string;
	private readonly database: DatabaseSync;
	private closed = false;

	constructor(path: string) {
		this.path = path;
		const directory = dirname(path);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.database = new DatabaseSync(path, {
			timeout: BUSY_TIMEOUT_MS,
			enableForeignKeyConstraints: true,
		});
		try {
			chmodSync(path, 0o600);
		} catch {
			// The containing directory is private even if chmod is unavailable.
		}
		this.initialize();
	}

	private initialize(): void {
		this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS repositories (
				id TEXT PRIMARY KEY,
				common_git_dir TEXT NOT NULL,
				display_name TEXT NOT NULL,
				last_seen_at TEXT NOT NULL
			) STRICT;
		`);
		this.transaction(() => {
			const version = Number(
				(this.database.prepare("PRAGMA user_version").get() as { user_version: number })
					.user_version,
			);
			if (version > CURRENT_SCHEMA_VERSION) {
				throw new Error(`Unsupported later database version: ${version}`);
			}

			const itemsTable = this.database
				.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'items'")
				.get();
			if (!itemsTable) {
				this.database.exec(CREATE_ITEMS_SQL);
				this.database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};`);
				return;
			}
			if (version === CURRENT_SCHEMA_VERSION) return;

			// v1 used repository_id as its sole ownership signal. Rebuilding gives
			// upgraded databases the same constraints as newly created databases.
			this.database.exec(`
				ALTER TABLE items RENAME TO items_v1;
				${CREATE_ITEMS_SQL}
				INSERT INTO items(
					id, ownership_scope, repository_id, owner_session_id, text, context,
					lifecycle, deleted_from, created_at, updated_at, source_cwd,
					source_session_id, source_session_file
				)
				SELECT
					id,
					CASE WHEN repository_id IS NULL THEN 'global' ELSE 'project' END,
					repository_id,
					NULL,
					text,
					context,
					lifecycle,
					deleted_from,
					created_at,
					updated_at,
					source_cwd,
					source_session_id,
					source_session_file
				FROM items_v1;
				DROP TABLE items_v1;
				PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};
			`);
		});
		this.database.exec(`
			CREATE INDEX IF NOT EXISTS items_scope_lifecycle_updated
				ON items(ownership_scope, lifecycle, updated_at DESC);
			CREATE INDEX IF NOT EXISTS items_project_lifecycle_updated
				ON items(repository_id, lifecycle, updated_at DESC);
			CREATE INDEX IF NOT EXISTS items_session_lifecycle_updated
				ON items(owner_session_id, lifecycle, updated_at DESC);
		`);
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("The later store is closed");
	}

	private transaction<T>(operation: () => T): T {
		this.assertOpen();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch {
				// Preserve the original failure.
			}
			throw error;
		}
	}

	private upsertRepository(repository: RepositoryContext, now: string): void {
		this.database
			.prepare(
				`
			INSERT INTO repositories(id, common_git_dir, display_name, last_seen_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				common_git_dir = excluded.common_git_dir,
				display_name = excluded.display_name,
				last_seen_at = excluded.last_seen_at
		`,
			)
			.run(repository.id, repository.commonGitDir, repository.displayName, now);
	}

	private resolveOwner(input: {
		scope?: LaterScope;
		repository?: RepositoryContext | null;
		ownerSessionId?: string;
	}): {
		scope: LaterScope;
		repository: RepositoryContext | null;
		ownerSessionId: string | null;
	} {
		const scope = input.scope ?? (input.repository ? "project" : "global");
		if (scope === "project") {
			if (!input.repository) throw new Error("Project scope requires a Git repository");
			return { scope, repository: input.repository, ownerSessionId: null };
		}
		if (scope === "session") {
			if (!input.ownerSessionId) throw new Error("Session scope requires a session ID");
			return { scope, repository: null, ownerSessionId: input.ownerSessionId };
		}
		return { scope, repository: null, ownerSessionId: null };
	}

	add(input: AddLaterItemInput): LaterItem {
		const text = normalizeText(input.text, "text");
		const context = input.context?.trim() || null;
		const owner = this.resolveOwner(input);
		const now = new Date().toISOString();
		return this.transaction(() => {
			if (owner.repository) this.upsertRepository(owner.repository, now);
			const result = this.database
				.prepare(
					`
				INSERT INTO items(
					ownership_scope, repository_id, owner_session_id, text, context, lifecycle,
					deleted_from, created_at, updated_at, source_cwd, source_session_id, source_session_file
				) VALUES (?, ?, ?, ?, ?, 'inbox', NULL, ?, ?, ?, ?, ?)
			`,
				)
				.run(
					owner.scope,
					owner.repository?.id ?? null,
					owner.ownerSessionId,
					text,
					context,
					now,
					now,
					input.source.cwd,
					input.source.sessionId ?? null,
					input.source.sessionFile ?? null,
				);
			const item = this.getByNumericId(Number(result.lastInsertRowid));
			if (!item) throw new Error("Failed to read the newly created later item");
			return item;
		});
	}

	get(id: string): LaterItem | undefined {
		this.assertOpen();
		return this.getByNumericId(parseLaterId(id));
	}

	getVisible(id: string, sessionId: string): LaterItem | undefined {
		this.assertOpen();
		return this.getVisibleByNumericId(parseLaterId(id), sessionId);
	}

	private getVisibleByNumericId(id: number, sessionId?: string): LaterItem | undefined {
		const item = this.getByNumericId(id);
		if (sessionId !== undefined && item?.scope === "session" && item.ownerSessionId !== sessionId) {
			return undefined;
		}
		return item;
	}

	private getByNumericId(id: number): LaterItem | undefined {
		const row = this.database
			.prepare(
				`
			SELECT items.*, repositories.display_name AS repository_name
			FROM items LEFT JOIN repositories ON repositories.id = items.repository_id
			WHERE items.id = ?
		`,
			)
			.get(id) as unknown as ItemRow | undefined;
		return row ? mapRow(row) : undefined;
	}

	private appendFilters(
		options: CountLaterItemsOptions,
		conditions: string[],
		parameters: SQLInputValue[],
	): void {
		if (options.scope === "all") {
			conditions.push("(items.ownership_scope != 'session' OR items.owner_session_id = ?)");
			parameters.push(options.sessionId ?? "");
		} else if (options.scope) {
			conditions.push("items.ownership_scope = ?");
			parameters.push(options.scope);
			if (options.scope === "session") {
				if (!options.sessionId) {
					conditions.push("1 = 0");
				} else {
					conditions.push("items.owner_session_id = ?");
					parameters.push(options.sessionId);
				}
			}
		} else if (options.repositoryId !== undefined) {
			// Backward-compatible repository filters are also scope filters.
			conditions.push("items.ownership_scope = ?");
			parameters.push(options.repositoryId === null ? "global" : "project");
		} else {
			// Session items require an explicit current-session filter.
			conditions.push("items.ownership_scope != 'session'");
		}
		if (options.repositoryId !== undefined && options.repositoryId !== null) {
			conditions.push("items.repository_id = ?");
			parameters.push(options.repositoryId);
		}
		if (options.lifecycle) {
			conditions.push("items.lifecycle = ?");
			parameters.push(options.lifecycle);
		}
	}

	list(options: ListLaterItemsOptions = {}): LaterItem[] {
		this.assertOpen();
		const conditions: string[] = [];
		const parameters: SQLInputValue[] = [];
		this.appendFilters(options, conditions, parameters);
		const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
		const rows = this.database
			.prepare(
				`
			SELECT items.*, repositories.display_name AS repository_name
			FROM items LEFT JOIN repositories ON repositories.id = items.repository_id
			${where} ORDER BY items.updated_at DESC, items.id DESC
		`,
			)
			.all(...parameters) as unknown as ItemRow[];
		const query = options.query?.trim().toLocaleLowerCase();
		const filtered = query
			? rows.filter((row) =>
					[formatId(row.id), row.text, row.context ?? "", row.repository_name ?? ""]
						.join("\n")
						.toLocaleLowerCase()
						.includes(query),
				)
			: rows;
		if (options.limit === null) return filtered.map(mapRow);
		const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
		return filtered.slice(0, limit).map(mapRow);
	}

	update(id: string, changes: UpdateLaterItemInput, sessionId: string): LaterItem | undefined {
		const numericId = parseLaterId(id);
		const assignments: string[] = [];
		const parameters: SQLInputValue[] = [];
		if (changes.text !== undefined) {
			assignments.push("text = ?");
			parameters.push(normalizeText(changes.text, "text"));
		}
		if (changes.context !== undefined) {
			assignments.push("context = ?");
			parameters.push(changes.context.trim() || null);
		}
		if (!assignments.length) throw new Error("No later item changes were provided");
		assignments.push("updated_at = ?");
		parameters.push(new Date().toISOString(), numericId);
		return this.transaction(() => {
			if (!this.getVisibleByNumericId(numericId, sessionId)) return undefined;
			const result = this.database
				.prepare(`UPDATE items SET ${assignments.join(", ")} WHERE id = ?`)
				.run(...parameters);
			return result.changes === 0 ? undefined : this.getByNumericId(numericId);
		});
	}

	move(id: string, input: MoveLaterItemInput, sessionId: string): LaterItem | undefined {
		const numericId = parseLaterId(id);
		const owner = this.resolveOwner(input);
		const now = new Date().toISOString();
		return this.transaction(() => {
			if (!this.getVisibleByNumericId(numericId, sessionId)) return undefined;
			if (owner.repository) this.upsertRepository(owner.repository, now);
			this.database
				.prepare(
					`
				UPDATE items SET ownership_scope = ?, repository_id = ?, owner_session_id = ?, updated_at = ?
				WHERE id = ?
			`,
				)
				.run(owner.scope, owner.repository?.id ?? null, owner.ownerSessionId, now, numericId);
			return this.getByNumericId(numericId);
		});
	}

	archive(id: string, sessionId: string): LaterItem | undefined {
		return this.changeLifecycle(id, "archived", sessionId);
	}

	softDelete(id: string, sessionId: string): LaterItem | undefined {
		const numericId = parseLaterId(id);
		const now = new Date().toISOString();
		return this.transaction(() => {
			if (!this.getVisibleByNumericId(numericId, sessionId)) return undefined;
			this.database
				.prepare(
					`UPDATE items SET deleted_from = CASE WHEN lifecycle = 'archived' THEN 'archived' ELSE 'inbox' END, lifecycle = 'deleted', updated_at = ? WHERE id = ? AND lifecycle != 'deleted'`,
				)
				.run(now, numericId);
			return this.getByNumericId(numericId);
		});
	}

	restore(id: string, sessionId: string): LaterItem | undefined {
		const numericId = parseLaterId(id);
		const now = new Date().toISOString();
		return this.transaction(() => {
			const item = this.getVisibleByNumericId(numericId, sessionId);
			if (!item) return undefined;
			if (item.lifecycle === "inbox") return item;
			const lifecycle = item.lifecycle === "deleted" ? (item.deletedFrom ?? "inbox") : "inbox";
			this.database
				.prepare("UPDATE items SET lifecycle = ?, deleted_from = NULL, updated_at = ? WHERE id = ?")
				.run(lifecycle, now, numericId);
			return this.getByNumericId(numericId);
		});
	}

	private changeLifecycle(
		id: string,
		lifecycle: Exclude<LaterLifecycle, "deleted">,
		sessionId: string,
	): LaterItem | undefined {
		const numericId = parseLaterId(id);
		const now = new Date().toISOString();
		return this.transaction(() => {
			const item = this.getVisibleByNumericId(numericId, sessionId);
			if (!item) return undefined;
			if (item.lifecycle === "deleted")
				throw new Error(`Restore ${item.id} before changing its lifecycle`);
			if (item.lifecycle === lifecycle) return item;
			this.database
				.prepare("UPDATE items SET lifecycle = ?, deleted_from = NULL, updated_at = ? WHERE id = ?")
				.run(lifecycle, now, numericId);
			return this.getByNumericId(numericId);
		});
	}

	count(options: CountLaterItemsOptions = {}): number {
		this.assertOpen();
		const conditions: string[] = [];
		const parameters: SQLInputValue[] = [];
		this.appendFilters(options, conditions, parameters);
		const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
		return (
			this.database.prepare(`SELECT count(*) AS count FROM items ${where}`).get(...parameters) as {
				count: number;
			}
		).count;
	}

	countInbox(repositoryId: string | null): number {
		return this.count({ repositoryId, lifecycle: "inbox" });
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.database.close();
	}
}
