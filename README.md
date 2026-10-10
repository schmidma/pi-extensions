# Pi extensions

Independent local packages for Pi.

| Package | Purpose |
| --- | --- |
| [completion-keys](packages/completion-keys/README.md) | Completion shortcuts |
| [copy-code](packages/copy-code/README.md) | Copy code blocks from assistant responses |
| [later](packages/later/README.md) | Private saved items |
| [openai](packages/openai/README.md) | Fast mode and usage limits |
| [prompt-rewrite](packages/prompt-rewrite/README.md) | Rewrite editor drafts |
| [session-naming](packages/session-naming/README.md) | Automatic session titles |
| [subagent-model-context](packages/subagent-model-context/README.md) | Available subagent models |
| [subagents](packages/subagents/README.md) | Nested delegation and native transcript inspection |
| [terminal-ui](packages/terminal-ui/README.md) | Footer, spinner, write previews |
| [tool-replay](packages/tool-replay/README.md) | Repeat tool calls by short handle |

From the checkout root, replace `PACKAGE` with a name from the table:

```sh
pi install "$(pwd)/packages/PACKAGE"
```

Local packages load from this checkout, without copying. External configuration
and data paths below default to `~/.pi/agent`; if `PI_CODING_AGENT_DIR` is set,
use that directory instead in all package guides.

Tests require Node with TypeScript and `node:sqlite` support, plus Bun.
Copy-code, subagent, and tool-replay tests also require Pi installed on `PATH`:

```sh
npm test
```

[MIT license](LICENSE).
