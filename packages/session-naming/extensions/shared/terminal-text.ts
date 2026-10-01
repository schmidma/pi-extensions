export function sanitizeSingleLine(text: string): string {
	let output = "";
	let ansiState: "none" | "escape" | "csi" | "osc" | "osc-escape" = "none";
	for (const character of text) {
		const code = character.charCodeAt(0);
		if (ansiState === "escape") {
			if (character === "[") ansiState = "csi";
			else if (character === "]") ansiState = "osc";
			else ansiState = "none";
			continue;
		}
		if (ansiState === "csi") {
			if (code >= 64 && code <= 126) ansiState = "none";
			continue;
		}
		if (ansiState === "osc") {
			if (code === 7) ansiState = "none";
			else if (code === 27) ansiState = "osc-escape";
			continue;
		}
		if (ansiState === "osc-escape") {
			ansiState = character === "\\" ? "none" : "osc";
			continue;
		}
		if (code === 27) {
			ansiState = "escape";
			continue;
		}
		if (code === 9 || code === 10 || code === 13) {
			output += " ";
			continue;
		}
		if (code < 32 || (code >= 127 && code <= 159)) continue;
		output += character;
	}
	return output.replace(/\s+/g, " ").trim();
}
