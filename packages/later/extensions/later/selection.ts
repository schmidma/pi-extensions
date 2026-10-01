interface EditorInsertion {
	pasteToEditor(text: string): void;
}

interface RenderRequester {
	requestRender(): void;
}

export function insertLaterReference(
	reference: string | null,
	editor: EditorInsertion,
	renderer: RenderRequester,
): void {
	if (!reference) return;
	editor.pasteToEditor(`${reference} `);
	renderer.requestRender();
}
