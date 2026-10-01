import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RepositoryContext } from "./types.ts";

const REPOSITORY_ID_VERSION = "later-repository-v1";

export async function resolveRepository(
	pi: ExtensionAPI,
	cwd: string,
): Promise<RepositoryContext | null> {
	const result = await pi.exec(
		"git",
		[
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
			"--show-toplevel",
		],
		{ cwd, timeout: 5_000 },
	);
	if (result.code !== 0) return null;

	const [rawCommonGitDir, rawRoot] = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (!rawCommonGitDir || !rawRoot) return null;

	let commonGitDir: string;
	let root: string;
	try {
		[commonGitDir, root] = await Promise.all([
			realpath(rawCommonGitDir),
			realpath(rawRoot),
		]);
	} catch {
		return null;
	}

	const identity = `${REPOSITORY_ID_VERSION}\0${commonGitDir}`;
	const id = createHash("sha256").update(identity).digest("hex");
	const displayName =
		basename(commonGitDir) === ".git"
			? basename(dirname(commonGitDir))
			: basename(root) || root;

	return { id, commonGitDir, root, displayName };
}
