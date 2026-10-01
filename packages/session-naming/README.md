# Session naming

Automatically titles unnamed sessions from the prompt. Manual titles are
respected; `/retitle` explicitly generates a new title from the conversation.

By default, uses the current session model with low reasoning. To select another
model, create `~/.pi/agent/session-naming.json` outside the checkout:

```json
{
  "provider": "your-provider-id",
  "model": "your-model-id"
}
```

Configuration is read for each naming operation. A missing file or `{}` uses
the current model. Supply both fields to override it. Malformed configuration
skips naming; an unavailable override does not fall back to another model.

Automatic naming sends a prompt excerpt to the selected model provider.
`/retitle` sends current conversation text, including compaction and branch
summaries. Consider that data when choosing a provider.

Paths follow the [agent-directory convention](../../README.md).
