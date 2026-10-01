# Later

Later is a private inbox for work that should not interrupt the current task. Items have stable references such as `later:L-42` and are stored in:

```text
~/.pi/agent/data/later/later.sqlite
```

## Scopes

- **Session**: visible only when resuming the exact same session. New sessions, forks, clones, and other sessions do not inherit it.
- **Project**: shared by linked Git worktrees for the current repository.
- **Global**: available from any directory.

The existing unqualified behavior is unchanged: `/later text` saves to Project inside a Git repository and Global outside one.

## Capture

```text
/later Investigate stale diagnostic handling
/later --session Keep this only with the current conversation
/later --project Check the repository release notes
/later --global Read the API migration guide
```

Short flags `-s`, `-p`, and `-g` are also available. Scope flags are recognized only at the start of the command so the remaining capture text is kept intact. `/later` without text opens the manager.

`Ctrl+Alt+L` opens a one-line quick capture. It starts at Session; `Tab` cycles Session, Project (when available), and Global. `Enter` saves and `Esc` cancels.

## Manager

Run `/later` without arguments. It opens the **Here** view by default:

- Inside Git, Here groups the current Session and Project items.
- Outside Git, Here contains the current Session items.
- Global is a separate fallback inbox.
- Everywhere is the broad search and maintenance view across all projects.

Controls:

- `Left`/`Right`: switch Inbox, Archived, and Deleted
- `Up`/`Down` or `j`/`k`: navigate items
- `Enter`: insert `later:L-N` into the prompt editor
- `/`: search; `c`: clear search
- `a`: add to the selected item's scope in Here, or the active view elsewhere
- `Tab` while adding: choose Session, Project, or Global
- `e`: edit; `m`: move the selected item to another scope
- `Space` or `v`: view details
- `x`: archive; `d`: soft-delete; `r`: restore
- `1`/`2`/`3`: select Inbox, Archived, or Deleted directly
- `Tab`: cycle Here, Global, and Everywhere
- `h`/`g`/`A`: open Here, Global, or Everywhere
- `?`: help; `Esc`: close or return

The small widget above the editor shows up to five current-session inbox items. The minimal statusline count remains the contextual Project or Global inbox count.

## Agent interaction

The extension registers a `later` tool. The tool supports `scope: session | project | global | all` for list/add (with `all` for listing) and a `move` action. `all` includes global and project items plus items for the current session only; it never exposes another session's items.

```text
Park this discussion in later for this session.
Review my global later inbox and suggest what to prioritize.
Move later:L-42 to the project inbox.
Archive later:L-42 now that it is complete.
```

Items are not sent to the model unless the agent explicitly calls the tool in response to a request.
