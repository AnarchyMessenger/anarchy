# Anarchy, Backspace and Agently

Written 2026-10-06 from the code of Anarchy (`AnarchyMessenger/anarchy`) and Backspace (`chamsco/ohMyHarness` @ `b1f2ea4`), and from screenshots of agently.dev. The site itself couldn't be opened from the build machine (the proxy refuses it, and the fetcher can't resolve it), so nothing here comes from its code.

## What each one is

| | Anarchy | Backspace | Agently |
|---|---|---|---|
| **What it's for** | Talking and working with people: chat, desks (tasks, invoices, clients), mail, files | Running coding agents: a goal becomes tickets, workers build them in git worktrees, you approve | "A chief of staff that already knows your company": one brain over your tools, answers and drafts |
| **Where your data lives** | On your devices, end-to-end encrypted; the server sees ciphertext | On your machine (`.backspace/`, the data folder, a git memory repo) | On their servers: connectors read Gmail, Slack, Notion, HubSpot, Linear… into "one brain" |
| **The AI** | A sidekick with a face (the Buddy), memory and search; **no model yet** | Many: Claude Code, Codex, Cursor, Ollama, routers; named agents with their own computers (folder, Docker, SSH) | Their agent over their brain; "the agent is the commodity, the brain is the product" |
| **How you use it** | Windows: sidebar, desks, inbox. Now also Summon (below) | Desktop app (Tauri, plus a GPUI shell), CLI, headless server | Voice first: "Jarvis · Listening" over your desktop; screens built for the question, then gone |
| **Reaching other tools** | Now an MCP server (the agent bridge, below) | An MCP server for its CLIs (`mcp.rs`); apps add tools | An MCP server ("Ask in Cursor. Draft in Claude. Same brain.") |
| **Phone** | Pairing built (D42), app not started | Pairing built (`companion.rs`), app not started | Not shown |

## Where they meet

1. **All three expose MCP.** That's the join: Agently's brain, Backspace's board and memory, and now Anarchy's desks are each a server any agent can call. Nothing needs merging to work together; each adds the others to its agents' MCP config.
2. **Anarchy's sidekick and Backspace's agents are the same idea from two ends.** Anarchy has the identity (a face, a name, a memory people see) and the data; Backspace has the runtime (models, routing, tools, computers). Anarchy shouldn't rebuild model routing for PLAN step 9: its sidekick should run on a Backspace route.
3. **Both have agent memory.** Backspace: an Agent Memory Repo (git + Markdown, a scorer that notices, a nightly tidy). Anarchy: the sidekick remembers what you tell it (D36), encrypted and synced between your devices. Two memories for one person will drift.
4. **Both paired a phone, differently.** Backspace: the desktop is the server, on the local network, with one long-lived token in the QR code. Anarchy: the account server, a one-time code, and you approve the phone on the desktop before it gets in.
5. **Agently's interface is where both want to go.** No windows: ask, see an answer built for that question, done. Anarchy now has a first version (Summon); Backspace's apps (sandboxed views with their own agent) are the other half of that idea.

## Where they differ, and should stay different

- **Anarchy never shows a server your data.** Agently's brain works because their servers read everything. Anarchy can't copy that and shouldn't: its brain is whatever your device can decrypt, and Sealed conversations never reach any agent (tested: `sealed_conversations_never_reach_an_agent`). That's the pitch against Agently, not a gap.
- **Backspace is for building software.** Tickets, worktrees, review, merge. Anarchy shouldn't grow a coding harness.
- **Anarchy is for people.** Conversations, spaces, guests, clients. Backspace's chat is you and your agents; it shouldn't grow messaging between people.

## Fix first: Backspace's phone pairing

`companion.rs` listens on `0.0.0.0:7421` and accepts the token from the QR code until you press *Unpair all phones*. That API can send chats, and chats drive agents that may have a computer (`computer_run` runs shell commands). So anyone on the same network who once saw or photographed the code can run commands on your machine through an agent, for as long as the token lives. Suggested fix, the same shape as Anarchy's (D42):

1. The QR code holds a one-time pairing secret that lasts minutes, not the API token.
2. The phone claims it; the desktop shows "Pixel 8 wants to connect" with Approve and Not mine.
3. Each approved phone gets its own token, listed in Settings and revocable one at a time.
4. Optional, but cheap: listen on the LAN address only while Settings → Phone is on.

## What's built today (Anarchy side)

### The agent bridge (D43)

Anarchy is now an MCP server for agents on the same computer. Settings → Agents on this computer → *Let agents on this computer read Anarchy*.

| Tool | Does |
|---|---|
| `anarchy_search` | Searches your desks and Company channels |
| `anarchy_today` | Today's agenda, plus tasks that are due or late |
| `anarchy_desks` | The desks agents may read, with record counts |
| `anarchy_desk_items` | One desk's records (keys stripped out) |
| `anarchy_draft` | Opens a draft in a conversation's composer; never sends |

- HTTP on 127.0.0.1 with a bearer token, or `anarchy-desktop --mcp` over stdio, which finds the running app through `bridge.json`. That file is readable only by you and is deleted when the bridge stops.
- Refused: other Host headers (DNS rebinding), anything with an Origin header (web pages), bodies over 256 KB.
- Every call is listed in Settings.

**For Backspace:** add one entry to the MCP config it gives its CLIs:

```json
{ "mcpServers": { "anarchy": { "command": "/Applications/Anarchy.app/Contents/MacOS/anarchy-desktop", "args": ["--mcp"] } } }
```

Then any Backspace agent can read your day or your invoices, and draft into Anarchy for you to send.

### Summon (D44)

⌘/Ctrl + Shift + Space, or the sparkle beside the search. Your sidekick's pill appears at the top ("Pip · Listening") and what you say or type shows large, the newest word still blurred. Cards built for the question follow, and the whole layer fades away on Esc.

- Without a model, a request is matched to a kind: your day, money, tasks, the weekly update, a draft to a conversation; anything else is a search. Every card comes from this device's data.
- Cards come from a fixed kit (stat, list, draft) filled with data, not from markup a model wrote. When a model arrives it picks the cards and fills them; it can't inject a page. That keeps generated screens inside the app's CSP and away from prompt-injected HTML.
- Voice uses the web view's speech recognition where it exists. Where it doesn't, the microphone is hidden and you type.

## How to get the rest of the way to Agently's feel

In order. Each step stands alone.

1. **Summon over everything, not just over Anarchy.** Agently's pill floats over your desktop and dock. Tauri can do that: a second, transparent, always-on-top window with no frame, shown by a system-wide shortcut (`tauri-plugin-global-shortcut`). The overlay code moves into that window unchanged. *(S–M)*
2. **Voice that works everywhere.** Web view speech recognition is missing on Linux and unreliable in WebView2. Use local Whisper (`whisper.cpp` through `whisper-rs`, MIT): push to talk, nothing leaves the machine. *(M)*
3. **A model behind Summon, through Backspace.** Summon sends the request plus the card kit's schema to a Backspace route. The model answers with card specs, and Anarchy renders them. Anarchy's own data reaches the model through the bridge tools, so the same Sealed rule applies. *(M, needs Backspace to accept requests from Anarchy: its `remote.rs` API on 127.0.0.1:7420 already takes a bearer token)*
4. **"Done · Posted to #leadership" with the sources shown.** Agently's done pill shows which tools it used. The bridge's call log already records that; show it in the pill. *(S)*
5. **One memory.** Agree on one format: Backspace's Agent Memory Repo. Anarchy's sidekick memory becomes a view of the same notes, encrypted at rest on Anarchy's side. Decide whether those notes may leave the device to a Backspace model. *(M, a decision first)*
6. **One phone app for both.** One pairing flow (step "Fix first" above), two backends: Anarchy for people and desks, Backspace for agents and approvals. *(L, PLAN step 12)*

## Inside Backspace, from its own map

- `crates/app` (GPUI, about 6,200 lines) repeats the Tauri shell's workbench and lacks Chat, Agents, Memory and Apps. Keeping both doubles every change.
- `cloud.rs` (832 lines: plans, quotas, ads) belongs with a backend; the app should keep only the client.
- The MCP server has moved out of `board.rs` into `mcp.rs` (commit `b1f2ea4`), so that item on your map is done.
