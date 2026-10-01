# Pi extensions

Seven independent local Pi packages, licensed under MIT:

| Package | Purpose |
| --- | --- |
| `completion-keys` | Fish-style autosuggestion keyboard shortcuts |
| `later` | Private later-item capture and management ([guide](packages/later/extensions/later/README.md)) |
| `openai` | OpenAI fast-mode toggle and usage command |
| `prompt-rewrite` | Rewrite the editor draft for clarity with `alt+shift+e` |
| `session-naming` | Automatic session titles and `/retitle` |
| `subagent-model-context` | Supply available subagent models to the agent |
| `terminal-ui` | Statusline, working-prompt display, and write preview |

## Local use

Install individual packages from the checkout using absolute paths:

```sh
pi install "$(pwd)/packages/session-naming"
pi install "$(pwd)/packages/prompt-rewrite"
```

Use the other package directories the same way. Local packages are loaded from
this checkout, not copied. Pi supplies the host libraries; tests require Node
with TypeScript support and Bun. From the repository root:

```sh
npm test
```

## Naming and rewrite models

Both extensions default to the current Pi model at the time of each request,
with low reasoning. They use Pi's model runtime, including custom and virtual
models, rather than requiring an API key themselves.

Optional configuration lives outside the checkout:

- `~/.pi/agent/session-naming.json`
- `~/.pi/agent/prompt-rewrite.json`

When `PI_CODING_AGENT_DIR` is set, replace `~/.pi/agent` with that directory.
Each file is read on every generation or rewrite; edits apply to the next
invocation, not an already-running request. A missing file or `{}` uses the
current model. To override it, supply both nonempty string fields:

```json
{
  "provider": "your-provider-id",
  "model": "your-model-id"
}
```

An override can select a different provider from the current model. For prompt
rewrite only, add `"fallbackToCurrentModel": true` to allow one attempt with
the captured current model if the override is unavailable or fails. The default
is `false`; fallback only occurs when the models differ and never on
cancellation. Session naming never falls back to another model.

Invalid JSON, partial overrides, unknown fields, invalid field types, and read
errors other than a missing file prevent any model request. Naming skips with
a warning for configuration errors; rewrite reports the error. Unknown or
unavailable models fail without silently choosing another provider (except
rewrite's explicit fallback). Failed automatic naming leaves the session
unnamed and does not retry automatically. Failed `/retitle` preserves its name.

These operations send text to the selected model provider: automatic naming
sends a bounded portion of the prompt; `/retitle` sends current conversation
text, including compaction and branch summaries; rewrite sends the editor draft.
Consider that data before selecting a provider or enabling fallback. Rewrites
are not applied if the editor changed while the request was running, and normal
editor undo remains available.
