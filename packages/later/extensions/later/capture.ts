import type { LaterScope } from "./types.ts";

export function parseDirectCapture(args: string): {
	scope?: LaterScope;
	text: string;
} {
	const match = args.match(/^\s*(-s|--session|-p|--project|-g|--global)(?:\s+|$)/);
	if (!match) return { text: args.trim() };
	const scopes: Record<string, LaterScope> = {
		"-s": "session",
		"--session": "session",
		"-p": "project",
		"--project": "project",
		"-g": "global",
		"--global": "global",
	};
	return { scope: scopes[match[1]], text: args.slice(match[0].length).trim() };
}
