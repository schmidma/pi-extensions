# OpenAI

`/fast [on|off|toggle|status]` requests priority processing on supported OpenAI
and OpenAI Codex APIs. With no argument, it toggles fast mode. Other providers
are unaffected.

Fast mode defaults to disabled. The command saves its setting outside the
checkout in `~/.pi/agent/openai-fast-mode.json`:

```json
{ "enabled": true }
```

`/usage` shows Codex usage limits. It requires an OpenAI Codex login via `/login`.

Paths follow the [agent-directory convention](../../README.md).
