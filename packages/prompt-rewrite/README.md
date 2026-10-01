# Prompt rewrite

`Alt+Shift+E` rewrites the editor draft for clarity, instructing the model to
preserve your intent. Normal editor undo restores the original. The rewrite
is not applied if you change the draft while the request is running.

By default, uses the current session model with low reasoning. To select another
model, create `~/.pi/agent/prompt-rewrite.json` outside the checkout:

```json
{
  "provider": "your-provider-id",
  "model": "your-model-id"
}
```

Configuration is read on each invocation. A missing file or `{}` uses the current
model; invalid configuration fails the rewrite. Supply both fields to override.
Add `"fallbackToCurrentModel": true` to allow a current-model attempt if a
different override is unavailable or fails. Fallback defaults to `false` and
never occurs on cancellation.

The draft is sent to the chosen model provider, and to the current provider if
fallback is used. Consider that data before choosing a model or enabling fallback.

Paths follow the [agent-directory convention](../../README.md).
