import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;
type Session = {
	ctx: ExtensionContext;
	factory: EditorFactory;
	predecessor: EditorFactory | undefined;
	observed: EditorFactory | undefined;
	undecorate?: () => void;
	warned: boolean;
};
type Binding = { session?: Session };

function decorate(editor: ReturnType<EditorFactory>): (() => void) | undefined {
	// Public native capabilities also work across jiti's module identities.
	const native = editor as CustomEditor;
	if (!["getCursor", "isShowingAutocomplete", "handleInput", "render", "onAction"]
		.every(key => typeof (editor as unknown as Record<string, unknown>)[key] === "function") ||
		!("onExtensionShortcut" in editor) || (native.onExtensionShortcut !== undefined && typeof native.onExtensionShortcut !== "function")) return;
	const descriptor = Object.getOwnPropertyDescriptor(editor, "handleInput");
	if (descriptor ? !descriptor.configurable || !("value" in descriptor) || !descriptor.writable : !Object.isExtensible(editor)) return;
	const original = native.handleInput;
	let active = true;
	const input = (data: string): void => {
		const acceptsSuggestion = matchesKey(data, "right") || matchesKey(data, "ctrl+f");
		// Keep the original Fish precedence: shortcuts receive Tab, not Right,
		// while a popup is visible. Native Tab owns undo/cursor/change callbacks.
		original.call(editor, active && acceptsSuggestion && native.isShowingAutocomplete() ? "\t" : data);
	};
	Object.defineProperty(editor, "handleInput", { configurable: true, enumerable: descriptor?.enumerable ?? false, writable: true, value: input });
	return () => {
		active = false;
		if (Object.getOwnPropertyDescriptor(editor, "handleInput")?.value !== input) return;
		if (descriptor) Object.defineProperty(editor, "handleInput", descriptor);
		else delete (native as Partial<CustomEditor>).handleInput;
	};
}

// Only the mutable binding is retained by an outer factory after shutdown.
// Never close over a session context in this pass-through factory.
function chain(predecessor: EditorFactory | undefined, binding: Binding): EditorFactory {
	return (tui, theme, keys) => {
		binding.session?.undecorate?.();
		if (binding.session) binding.session.undecorate = undefined;
		const editor = predecessor ? predecessor(tui, theme, keys) : new CustomEditor(tui, theme, keys);
		const session = binding.session;
		if (session) {
			session.observed = session.ctx.ui.getEditorComponent();
			session.undecorate = decorate(editor);
			if (!session.undecorate && !session.warned) {
				session.ctx.ui.notify("Completion keys: keeping the unsupported custom editor unchanged. Right/Ctrl+F completion is unavailable.", "warning");
				session.warned = true;
			}
		}
		return editor;
	};
}

export default function (pi: ExtensionAPI) {
	let binding: Binding | undefined;
	const dispose = () => {
		const session = binding?.session;
		if (binding) binding.session = undefined;
		binding = undefined;
		if (!session) return;
		session.undecorate?.(); session.undecorate = undefined;
		// An outer chain may still use our now-inactive factory. Do not replace
		// it, or resurrect a factory the host already cleared during reload.
		if (session.ctx.ui.getEditorComponent() === session.factory) session.ctx.ui.setEditorComponent(session.predecessor);
	};
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (binding?.session && ctx.ui.getEditorComponent() === binding.session.observed) {
			binding.session.ctx = ctx;
			return;
		}
		dispose();
		const predecessor = ctx.ui.getEditorComponent();
		binding = {};
		const factory = chain(predecessor, binding);
		binding.session = { ctx, factory, predecessor, observed: undefined, warned: false };
		ctx.ui.setEditorComponent(factory);
	});
	pi.on("session_shutdown", dispose);
}
