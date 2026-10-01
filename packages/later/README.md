# Later

Save private items without interrupting the current task. `/later text` saves
an item; `/later` opens the manager. Items have stable references like `later:L-42`.

Choose a scope with a leading flag:

```text
/later --session Keep this with the current conversation
/later --project Check the release notes
/later --global Read the migration guide
```

Without a flag, capture defaults to project inside Git, otherwise global.
Session items belong only to the exact session, not forks or new sessions.
Project items are shared across linked Git worktrees; global items are available
from any directory. Short flags `-s`, `-p`, and `-g` also work.

`Ctrl+Alt+L` opens quick capture, initially in session scope. `Tab` changes scope.
In the manager, `Enter` inserts a reference into the editor; `?` shows controls.
The Here view contains current-session and current-project items; Global and
Everywhere provide broader views. Archive, soft-delete, and restore are available.

Items are stored locally in `~/.pi/agent/data/later/later.sqlite`, including
source directory and session metadata. Paths follow the
[agent-directory convention](../../README.md).

Capture and the manager do not send saved text to a model. The agent's `later`
tool can read and manage items, returning item text to model context. Listing
across scopes includes only the current session's session-scoped items.
