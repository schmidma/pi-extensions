import {
	CustomEditor,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

class FishAutosuggestionEditor extends CustomEditor {
	override handleInput(data: string): void {
		const acceptsSuggestion =
			matchesKey(data, "right") || matchesKey(data, "ctrl+f");

		if (acceptsSuggestion && this.isShowingAutocomplete()) {
			// Reuse the editor's normal Tab completion path so applying a suggestion
			// keeps its built-in undo, cursor, and change-notification behavior.
			super.handleInput("\t");
			return;
		}

		// With no suggestion visible, Right/Ctrl+F retain their normal cursor motion.
		super.handleInput(data);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new FishAutosuggestionEditor(tui, theme, keybindings),
		);
	});
}
