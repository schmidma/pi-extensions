export type LaterLifecycle = "inbox" | "archived" | "deleted";
export type LaterScope = "global" | "project" | "session";
export type LaterListScope = LaterScope | "all";

export interface RepositoryContext {
	id: string;
	commonGitDir: string;
	root: string;
	displayName: string;
}

export interface LaterSource {
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
}

export interface LaterItem {
	id: string;
	scope: LaterScope;
	repositoryId: string | null;
	repositoryName?: string;
	ownerSessionId?: string;
	text: string;
	context?: string;
	lifecycle: LaterLifecycle;
	deletedFrom?: Exclude<LaterLifecycle, "deleted">;
	createdAt: string;
	updatedAt: string;
	source: LaterSource;
}

export interface AddLaterItemInput {
	repository: RepositoryContext | null;
	scope?: LaterScope;
	ownerSessionId?: string;
	text: string;
	context?: string;
	source: LaterSource;
}

export interface MoveLaterItemInput {
	scope: LaterScope;
	repository?: RepositoryContext | null;
	ownerSessionId?: string;
}

export interface CountLaterItemsOptions {
	repositoryId?: string | null;
	sessionId?: string;
	scope?: LaterListScope;
	lifecycle?: LaterLifecycle;
}

export interface ListLaterItemsOptions extends CountLaterItemsOptions {
	query?: string;
	limit?: number | null;
}

export interface UpdateLaterItemInput {
	text?: string;
	context?: string;
}
