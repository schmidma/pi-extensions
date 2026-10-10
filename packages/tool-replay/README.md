# Tool replay

Tool results expose short handles such as `[Replay handle: r1]`. The model can
call `replay_tool({handle: "r1"})` to execute the original tool and arguments again.
This repeats side effects, not cached output, under current validation and hooks.

Handles persist in the session and follow its active branch, surviving reload,
compaction, and copied forks. They cannot replay hidden/model-only tools, nested
calls, unavailable tools, or calls from a different working directory. There is
no handle search/list tool or history UI.
