# What we build next, in order

Updated 2026-10-05. Each step lists why it comes where it does, a rough size (S ≈ days, M ≈ 1–2 weeks, L ≈ a month or more), what it needs first, and what "done" means. Phase checklists live in `docs/ROADMAP.md`; decisions in `docs/ARCHITECTURE.md` §11.

The order follows one rule: **fix what stops a new person from using the app with someone else before adding anything they'd use alone.** Today a new person can start locally (D38), but the moment they want to talk to someone, there is no public server, their second device can't read their conversations, and messages arrive by polling.

## Just shipped

- Local accounts, tour, new first screen (D38).
- Email threads that upgrade to encrypted conversations (D39).
- The Buddy sidekick body and headwear (D40); the Buddy is now the only body.
- The sidekick maker fits the window without scrolling.
- Title bars per platform: macOS traffic lights, Windows and GNOME controls (D41).
- Linking a phone: QR code, approve on the desktop, then a session (D42). Server, client and desktop are done; the phone app is step 12.
- Audit, October 2026 (`docs/AUDIT-2026-10.md`): the CSP was blocking inline styles in the real app; fixed, and the preview now runs under the same CSP.
- The agent bridge (D43): Anarchy is an MCP server for agents on this computer (Claude Code, Codex, Backspace). Reads desks and Company channels, never Sealed conversations; drafts but never sends.
- Summon (D44): ⌘/Ctrl Shift Space, a voice or typed request, an answer as cards that go away. How this fits with Backspace and Agently: `docs/HARNESSES.md`.
- Tasks lead (D45): sections as folder tabs on top, no right rail, people under the channels, notifications on Home, the assistant as a bubble that grows into the side panel.
- Agents can add and move tasks, Roma's way (D46, `docs/ROMA.md`).
- The sidekick is its own package, `packages/buddy`, with blobatar-style idle motion (D47).

## 1. A public server people can join (M)

**Why first:** `anarchy.chat` doesn't run Anarchy. Every social feature (chats, spaces, the email upgrade, others' sidekicks) is unreachable for anyone who doesn't host a server. Nothing below matters until this works.
**Needs:** hosting, a mail sender for sign-in codes, a domain for the API.
**Includes:** deploy `anarchy-server` with Postgres and backups; open sign-up; per-IP rate limits on sign-in and guest join (ROADMAP Phase 0); blocking and reporting in DMs; a status page; a written abuse policy.
**Done when:** a fresh install signs up at `anarchy.chat`, starts a DM with a second fresh install, and a blocked person can't reach them again.

## 2. Your other devices see your conversations (L)

**Why second:** today only the devices present when a conversation starts are in it. Someone who signs in on a laptop after their desktop sees an empty account. That's the first thing a new user of the public server will hit, and the first bad review.
**Needs:** 1.
**Includes:** a new device of yours is added to every group you're in (an existing device commits the add); optional history hand-over from your own devices (signed, logged); device proof of possession at registration.
**Done when:** a test signs in a second device after 50 messages in 3 conversations, and the second device can send in all three and reads the history it was handed.

## 3. Live delivery instead of polling (M)

**Why here:** chat feels broken at polling intervals, and steps 7 and 9 (live typing, co-editing) can't work without a push channel.
**Needs:** 1.
**Includes:** WebSocket subscriptions per device; reconnect with back-off; polling stays as fallback.
**Done when:** a message shows on the other device in under 300 ms on a LAN, and pulling the network for a minute loses nothing.

## 4. Account safety (S–M)

**Why here:** once people rely on it, losing the passphrase or a laptop must not mean losing everything.
**Includes:** change or remove the passphrase; add an email to an anonymous account; an encrypted export and restore for local accounts (they have no server copy, D38).
**Done when:** a local account exported on one machine opens on another with the same desks and files.

## 5. Email upgrade, part 2 (M)

**Why here:** the upgrade only works when both people are already on the same server (D39). Its value grows with step 1's user count; this step makes it pull people in.
**Needs:** 1; Google and Microsoft OAuth apps (their review takes weeks, so start the paperwork during step 1).
**Includes:** when the sender isn't on Anarchy, an optional line in your reply: "I've moved this to an encrypted conversation: <invite link>"; Gmail and Microsoft sign-in instead of app passwords; mail TLS path tests against a real certificate.
**Done when:** a reply with the invite line, opened by a stranger, ends in a DM with the sender in under three steps.

## 6. Measure, then publish budgets (S)

**Why here:** the pitch includes "light". Before telling anyone that, measure it: cold start, idle memory, installer size, sync of 10,000 messages.
**Includes:** a benchmark script; numbers in the README; CI fails if a budget regresses by more than 15%.
**Done when:** the numbers are in CI and the README.

## 7. Positioning and the landing page (S)

**Why here, not first:** a landing page that sends people to a server that doesn't exist (1), or an app that loses their second device's history (2), costs more trust than it gains.
**Includes:** one sentence that says who it's for (freelancers and small studios who want chat, desks and mail in one encrypted place); the tour (D38) as the main call to action; the numbers from step 6.

## 8. Wave's good ideas, without Wave (M)

Apache Wave is retired (2018) and its operational transforms need a server that reads the text, which end-to-end encryption rules out. We take the ideas, not the protocol:
- **Edits with visible history.** Editing a message sends an encrypted amendment; everyone sees "edited" and can open the earlier versions. Deleting leaves a marker.
- **Live typing, opt-in per conversation.** Drafts stream as encrypted MLS application messages that are never stored; off by default, clearly shown when on.
**Needs:** 3.
**Done when:** both work in DMs and channels, and the server stores no draft text (test reads its tables).

## 9. Sidekicks that think (M–L)

**Why here:** the sidekick searches and remembers (D36), but there's no model yet. Connecting one is the biggest privacy decision in the product, so it comes after the basics are trusted.
**How:** don't build model routing here. Backspace already runs Claude Code, Codex, Ollama and routers; the sidekick sends its request to a Backspace route and gets back card specs for Summon (D44) or a reply. Anarchy's data reaches the model only through the bridge's tools (D43), so the Sealed rule holds (`docs/HARNESSES.md`).
**From Roma (`docs/ROMA.md`):** standing orders (a schedule, steps in plain words, a log of runs, Run now) and tasks from conversation ("remind me tomorrow at 10" becomes a task with a due time).
**Includes:** connect a model (through Backspace, or directly: local first, e.g. Ollama; then a hosted API key you own); Summon over every app (a transparent always-on-top window and a system-wide shortcut), and local voice (Whisper) where the web view has none; what it may read set per channel and per desk, Sealed always excluded; others can remove a sidekick from a channel they're in; the sidekick on/off switch on each desk; reminders that fire while the app is closed (OS scheduler).
**Done when:** a sidekick answers from a desk it may read and refuses one it may not, in a test.

## 10. Co-editing notes and pages (L)

**Why this late:** the most expensive item, and it needs 3. CRDTs (e.g. `yrs`, MIT) work over encrypted messages: each change is an MLS application message and the server only orders them.
**Done when:** two devices edit one page offline, reconnect, and converge, with nothing readable on the server.

## 11. Roles and membership (M)

Space and channel roles; removing people from a space; leaving a channel yourself (MLS propose, another member commits); opt-in history sharing for newcomers.

## 12. Mobile (L)

Tauri mobile or native shells over `anarchy-core`. Comes after 2 and 3 because a phone is the second device.
**Already there (D42):** the desktop shows an `anarchy://link?server=…&secret=…` QR code and approves the phone; the server's `/v1/devices/links/claim` and `/collect` are the phone's side, and `Client::link_claim` / `link_collect` in `anarchy-core` are ready to call.
**The phone app needs:** a QR scanner that opens `anarchy://link` links; claim, then poll `collect` every two seconds while showing "Approve on your computer"; register the device and publish key packages; then wait for step 2 to add it to your conversations. Notifications need APNs and FCM, and the app has to show something useful before history arrives.
**Done when:** a phone scans the desktop's code, is approved, and reads and sends in a conversation that existed before it linked.

## 13. Federation (L)

Lookups and DMs across servers. Needed before self-hosters can reach the public server's users; also widens the email upgrade (D39) beyond one server.

## Later

Native file providers (Windows Cloud Files, macOS File Provider, FUSE); object storage, quotas and versions for Drive; client portal, quotes and e-signatures; Company Brain settings page; bundled fonts.

## Not doing

- **The Wave protocol.** See step 8.
- **Server-side reading of messages for any feature.** If a feature needs the server to see plaintext, it gets redesigned or dropped.
