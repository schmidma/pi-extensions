# Subagents

An independent Pi extension for nested asynchronous delegation and read-only
native transcript inspection. Try it without installing or changing settings:

```sh
pi -ne -e ./packages/subagents/extensions/subagents/index.ts
```

`-ne` disables other extensions only in the main session. Children still load
configured extensions, so disable any competing subagent manager before delegating.
This extension requires the public SDK and lifecycle APIs present in Pi 1.0.3.

## Delegate and continue

The main agent and every subagent get the same three delegation tools:

- `spawn_subagent({name, prompt, model, thinking, role?})` starts a subagent.
  Give it a short task/topic name (1-80 characters, one line, no controls), an
  exact advertised `provider/model`, and an explicit thinking level. The
  acknowledgement includes its name, stable `agent_id`, distinct `run_id`, and
  requested/effective thinking (including native clamping).
- `resume_subagent({agent_id, prompt})` continues a finished subagent's saved
  conversation, retaining its name, optional role, model, and thinking. No
  overrides are accepted. Missing or corrupt history is an error, not a new session.
- `steer_subagent({agent_id, message})` guides an open run, including one waiting
  for its children. Waiting is not finished; resume rejects until the run ends.

Each agent can control only its own direct children, not siblings, ancestors, or
more distant descendants. Names may repeat; use IDs, not names, to address subagents.

There is no polling or synchronous mode. The complete final assistant text,
with its outcome, arrives automatically in the immediate parent's conversation.
A busy parent receives ready reports at the next successful native turn boundary,
after its current response and tool calls, without waiting for the whole run to
finish or interrupting ongoing work. Idle or waiting parents wake automatically.
Main-session reports follow normal Pi compaction and may be summarized before
the next model request; the original reports remain in the saved sessions.
A question or blocker is a final prose report; answer it by resuming that
subagent. An empty response is reported explicitly and never reuses old text.

A subagent may delegate in turn. If it ends a response while children are still
working, that answer remains provisional: the subagent waits without making
model requests. Child reports or steering wake the same logical run. Success is
reported upstream only after every direct child run has ended and its full report
has been included in a successful subsequent assistant response. Merely saving a
report in the parent's transcript does not satisfy this requirement.

A failed or aborted parent does not cancel its descendants or restart itself.
Its failure identifies outstanding child runs. Their results remain addressed to
that parent, never directly to the main agent. Explicitly resume the parent to
adopt its unfinished children and unprocessed reports.

Roles are optional, user-authored instruction templates from
`<agent-dir>/agents/*.md` and, only when the parent trusts the project,
`<cwd>/.pi/agents/*.md`. There are no bundled roles or defaults: omitting `role`
always selects native Pi instructions without a role body, even when role files
exist. Supported frontmatter is `name`, `description`, `display_name`, `enabled`,
and `prompt_mode` (`append` or `replace`). The legacy `allowed_subagents` field
is accepted but ignored; roles do not constrain models, tools, or delegation.
Invalid roles, including unsupported fields, are omitted with file-specific
warnings; explicitly selecting one fails without starting a run. They do not
block role-free work or saved-session resume. Trusted project roles override
global roles of the same name; an invalid override does not fall back to the
global role, and `enabled: false` disables that role.

Role instructions and prompt mode are saved at creation and retained on resume.
A trusted-project subagent cannot resume from an untrusted parent context.

Children load configured global extensions and trusted-project resources through
native Pi discovery, alongside native instructions and skills. Native tool defaults,
exposure rules, and dynamic activation apply. The root subagent entrypoint is
excluded before initialization and replaced by the child-scoped delegation tools.
`ask_user_question` remains parent-only; children report questions to their parent.
CLI-only and inline extension factories are not copied from the main session.

Children have no inherited parent conversation, automatic worktrees, or sandbox.
Each child has its own provider registrations, while delegation uses the main
session's advertised executable physical-model roster. Unsupported virtual models
are omitted; a later change to a child's primary model configuration fails the
run rather than silently changing providers.

## Inspect

One compact live tree stays above the editor. Relevant mode accumulates work at
every depth while the main agent or any subagent is busy, with animated running
rows and static waiting/outcome markers. Completed work stays for review until
the next user prompt submitted while everything is idle. Busy steering and
follow-ups do not clear it later. This review state persists when reopening Pi;
it only changes the display, not reports or history. Tool cards
identify delegation requests, not task completion; Pi's tool-expansion key
reveals full tasks, guidance, and reports.

Press Left at the absolute start of the prompt, or run `/subagents`, to focus
that same tree. Up/Down selects; Home/End and PageUp/PageDown navigate longer
lists, stopping at the first and last rows. Tab switches between the default
unlabeled filtered view and [All], which retains the full subagent history.
When Relevant is empty, the passive tree hides and Left or `/subagents` opens
[All] directly.
Rows show status icons, names, abbreviated IDs, model/thinking metadata, and
elapsed wall time as space allows. Enter or Right opens the selected native
transcript; Left or Escape returns to the same tree selection and mode. Left or
Escape from the tree returns to the prompt and restores the default filtered
view and selection. Typing does
the same without losing the typed input.
The tree stays bounded and scrolls to keep the selection visible.

`/subagents <agent_id>` opens a transcript directly; Left or Escape returns to the
prompt. Viewing never prompts, resumes, or stops an agent, and does not change
where reports are delivered. `/subagents-preview` retains the current main
conversation preview. Native-compatible custom editors, including the
`completion-keys` package, compose with inline tree navigation in either load order.
Unsupported editors are kept unchanged with a warning; direct ID inspection and
the passive tree remain available.

In transcripts, Up/Down and PageUp/PageDown scroll; Home goes to the start;
End follows new output. Pi's tool-expansion and thinking-visibility keys apply
(defaults: Ctrl+O and Ctrl+T). Views use native projections, including compaction
and context edits. Images and input composers are disabled. Live child views
resolve the child's native tool renderers; the main preview and cold views use
built-in and delegation renderers with a generic fallback.

## Persistence and lifecycle

Delegation requires a saved root session. All branches of that session file
share the same subagents; a fork or new file owns a separate group. Child sessions
and the registry live under `<agent-dir>/subagent-sessions/<root-key>/`, outside
the ordinary session picker. Only one process may write a main session's
subagent registry. Unverifiable locks and corrupt registries fail closed.

The main agent finishing does not cancel active or waiting descendants.
Same-process `/reload` retains their runtimes and reconnects main-session report
delivery. Quitting or replacing the main session interrupts the entire tree.
Reopening recovers durable terminal markers; unmarked unfinished runs become
interrupted and are never replayed. Saved nested results stay with their immediate
parent and do not automatically restart it.

After changing extension versions, quit and restart Pi rather than relying on
`/reload`. Saved registries from earlier revisions of this extension are validated
and upgraded on opening. Sessions from other subagent extensions are not imported.

Reports are persisted before delivery and reconciled against native parent
receipts across all branches. This provides logical report deduplication, not
exactly-once model execution or side effects. Do not delete a group's files while
it is active. Native child histories, role snapshots, and reports remain on disk
for resume and inspection; they can contain sensitive task content.

## Terms

The **main agent** delegates to a **subagent** (parent and child, respectively).
A **role** is an optional instruction template; a **task** is the instructions
for a **run**, which may span several native prompt cycles separated by waiting.
A **report** is its terminal result, question, or blocker. A **session** is the
native persisted conversation, shared across runs. Only explicit resume creates
a new run ID.

## Tests

From the repository root:

```sh
npm run test:subagents
node packages/subagents/tests/check-types.mjs
```

Tests use deterministic providers with no paid model calls. They load the Pi
installation on PATH and print its versions. Set `PI_SUBAGENTS_HOST` to select an
installed package explicitly. The strict source check uses those declarations
and a pinned TypeScript compiler through `npx`.
