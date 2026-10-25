# Background bash

A POSIX-only replacement for Pi's `bash` tool. The original transcript card keeps
its process status, elapsed time and live output after the agent is free to do
other work. It settles when the process exits. A separate compact completion
message appears when Pi delivers the notification into the conversation, not
when it is queued. Expand that message to see its output excerpt.

Load this package instead of other extensions that replace `bash`:

```sh
pi -e ./packages/background-bash
```

## Running commands

- `bash({ command, background: true })` returns a task ID immediately.
- Ordinary calls move to the background after 120 seconds, except calls with an
  explicit `timeout` or a command starting with `sleep`.
- `waitFor: "literal text"` returns when that text appears in output. Do not combine
  it with `background: true`.
- `timeout` is a total deadline in seconds. It still applies after any promotion.
  Without it there is no hard deadline.
- Ctrl+Shift+B moves all current foreground bash calls to the background.
- Aborting a foreground call terminates its process group. A promoted task is
  independent of subsequent turn cancellation.

Completion is delivered automatically. The agent should not poll or run sleeps
just to wait for a task. No extra start notices or footer widgets are added.

## Inspection and control

- `bash_tasks()` lists tasks in this session.
- `bash_output({ id, latest?, filter? })` reads a bounded chunk of unread output.
  `latest` skips to the newest unread output; `filter` is a JavaScript regex over
  that chunk. Filters run off-thread with a 500ms deadline; errors/timeouts leave
  the read position unchanged.
- `bash_kill({ id })` sends SIGTERM, then SIGKILL after up to 3 seconds, to the
  process group. It also cleans up descendants left by an already-exited shell,
  without revising that shell's result or sending another completion notification.
  Its `outcome` reports whether cleanup succeeded or the group remains present.
- `/bg`, `/bg <id>`, and `/bg kill <id>` provide user-facing inspection and control.

Pi's effective `shellPath` and `shellCommandPrefix` settings are respected.
Commands receive the current Pi session/model environment variables.

Codemode receives structured objects: `bash` provides `output`, `truncated`,
`wall_time_seconds`, `exit_code` after exit, and `task_id` when promoted. Nonzero
exit codes remain inspectable rather than rejecting the script. Structured output
can contain up to 1MiB from the retained log, independently of the compact card;
longer output retains its beginning and end and supplies `full_output_path`.
Companion tools expose task state/timing, unread bytes, and kill outcomes.

## Lifetime and output

Tasks survive `/reload` within the same Pi process. Quit, session replacement,
fork and tree navigation stop live tasks and their still-owned process groups,
including descendants of completed shells. They do not survive a Pi restart.
Completed cards restore from the active session branch. An old acknowledgement
without a saved completion is shown as unavailable, never as a live process.

Each task keeps a 50KB/2000-line output tail and a private disk log capped at 16MB
under `$XDG_STATE_HOME/pi-background-bash` (default
`~/.local/state/pi-background-bash`). After the disk cap, the task continues and
its recent tail remains available. Completed logs from this Pi process and logs
from inactive Pi processes are pruned on task completion and runtime creation to
100 files and seven days. Active writers and other live Pi processes are excluded.
These are capped logs, not guaranteed full command output; redirect important
artifacts to your own files.

If a child inherits the shell's output pipes, collection stops within 150ms of
shell exit. Children deliberately detached from the process group cannot be
controlled by this extension. Abrupt Pi termination (such as SIGKILL) can leave
processes behind; there is no persistent daemon or parent-death watcher.
