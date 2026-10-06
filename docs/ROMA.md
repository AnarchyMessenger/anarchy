# What we take from Roma

Written 2026-10-06 from Roma's public developer docs (roma.app/llms-full.txt) and the screenshots of its app. Roma is "the to-do list that does itself": a task app with an AI operator, notes that serve tasks, and standing orders it runs on a schedule.

## Roma's model, and ours

| Roma | Anarchy today | What we did |
|---|---|---|
| **Tasks first.** Status `todo` → `inProgress` → `completed`, a due date, a priority, a Markdown body, a project | Cards on a board: the column is the status, a due date, who's on it, `notes` | The board's columns now map onto Roma's three statuses (first column `todo`, done columns `completed`, the rest `inProgress`), so agents speak one task language (D46) |
| **Notes support tasks**: a plan or meeting notes live next to the work | Notes are a separate section; cards have a notes field | A task's notes are where agents add context; they append, never overwrite unless told |
| **Projects** group tasks and notes | Spaces and desks | A task desk is a project for agents; your own Tasks desk is the default |
| **Operator**: a chat that creates tasks, reminds, researches | The sidekick and its Ask panel; Summon | The assistant is now a bubble at the bottom right that grows into the side panel, like Roma's operator (D45) |
| **Automations**: standing orders on a schedule ("Weekly Review every Friday at 10"), with steps you can edit and a log of runs | Nothing yet; Summon's weekly update is the one-shot version | Planned: needs a model (PLAN step 9) |
| **`get_context`** first, one call that orients an agent | `anarchy_today`, `anarchy_desks` | `anarchy_get_context`: the person, today, desks, late/today/in-progress/this-week tasks, today's agenda, recent notes |
| **`create_tasks`** with `externalId`, so re-sending is safe; one bad row never fails the batch | Nothing | `anarchy_create_tasks`, the same rules |
| **`update_task`** appends to the body by default; replacing needs `confirmReplace` | Nothing | `anarchy_update_task`, the same rules |
| **Tool annotations**: each tool says whether it reads, adds or changes, so clients ask only before changes | Plain descriptions | Every bridge tool now carries `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` |
| **Rate limit**: 60 requests a minute | None | 60 a minute on the bridge |
| **Soft deletes**, a 30-day trash | Deletes are records marked `deleted` | Agents can't delete at all; there's nothing to undo |
| **Writes show in the event log as yours, marked as through the connection** | Bridge calls listed in Settings | Agent-made cards carry `by: "agent"`; the Settings list shows every write, including refused ones |
| **OAuth 2.1** for remote clients | A local token, 127.0.0.1 only | Stays local. A remote, OAuth-signed MCP endpoint would mean the server reading tasks, which Anarchy doesn't do |

## Where we differ, on purpose

- **Roma's server reads your tasks.** Its search runs embeddings server-side and its automations act through your connected apps there. Anarchy's tasks are end-to-end encrypted, so its MCP server is the desktop app on your computer, and an agent elsewhere can't reach it. That rules out "ask from ChatGPT on your phone" until the phone app holds a device of its own (PLAN step 12).
- **People.** Roma is one person's list ("There is no shared or team data on this surface"). Anarchy's tasks can sit in a space's desk with other people on it; agents may write there only when it's a Company channel, never a Sealed one.

## The layout, after Roma's app (D45)

- Sections run along the top of the canvas as folder tabs, under the working set; the column of section icons is gone.
- The right-hand rail is gone. People sit under the channels on the left; notifications are a section on Home; the assistant is a bubble at the bottom right.
- Home leads with Today, then notifications, then the task pipeline.

## Next, from Roma

1. **Standing orders** (Roma's automations): a schedule, steps in plain words, a log of runs, Run now. Needs the model (PLAN step 9) and reminders that fire while the app is closed.
2. **Tasks from conversation**: "remind me tomorrow at 10" in the assistant becomes a task with a due time, the way Roma's operator does it.
3. **Subtasks**, and a task's page as the place its notes, files and conversation meet.
