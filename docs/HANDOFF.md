# Handoff

Written 2026-10-07 at `7212e47` on `main`. CI, Windows and macOS builds are green on that commit. Read this first, then `PLAN.md` (what's next) and `docs/ARCHITECTURE.md` §11 (decisions D1–D48).

## What Anarchy is

An end-to-end encrypted workspace and messenger: chats, spaces and channels, desks (tasks, invoices, clients, time, intake forms, pages), an inbox that brings in real email, personal tasks, notes, agenda and files, and a sidekick (the Buddy) with memory. The server only ever sees ciphertext and metadata. A person can start with no server at all (a local account) and connect one later.

## Where things are

| Path | What |
|---|---|
| `crates/anarchy-proto` | Wire types |
| `crates/anarchy-core` | Client: MLS (openmls), file sealing, HTTP client, SQLCipher device DB |
| `crates/anarchy-server` | axum + Postgres (sqlx). Accounts, spaces, delivery, blobs, public pages, device links (`companion.rs`) |
| `crates/anarchy-mail` | IMAP/SMTP on the device; mail never touches the server |
| `crates/anarchy-sidekick` | Server-hosted sidekick that joins channels as a member |
| `crates/anarchy-brain` | Audience-scoped search; built, no UI yet |
| `crates/anarchy-testkit` | Spins up a real server against Postgres for tests |
| `apps/desktop/src-tauri` | Tauri 2 app. `main.rs` (commands via the `op!` macro), `ops.rs` (desks, agent tools, phone link), `bridge.rs` (MCP server), `dav.rs` (WebDAV mount), `local.rs`, `storage.rs` |
| `apps/desktop/ui` | Plain classic scripts, no bundler: `index.html`, `app.js` (most of the UI), `summon.js`, `sidekick.js`, `demo.js` (fake backend for the tour and the preview), `app.css`, `buddy/` (a copy, see below), `ds/` (generated tokens) |
| `apps/desktop/ui-preview.mjs` | Playwright run of every screen against `demo.js`, under the app's real CSP |
| `packages/buddy` | The Buddy as its own package (UMD + CSS, tests, demo) |
| `design-system` | Tokens; `build.mjs` writes `design-system/dist` and `apps/desktop/ui/ds` |
| `docs/` | `ARCHITECTURE.md` (decision log), `ROADMAP.md`, `AUDIT-2026-10.md`, `HARNESSES.md` (Anarchy × Backspace × Agently), `ROMA.md`, `SELF-HOSTING.md`, `screens/` |
| `.github/workflows` | `ci.yml` (Rust, desktop, deny, tokens, Buddy drift), `desktop-builds.yml` (Windows NSIS/MSI + macOS universal dmg, unsigned), `cla.yml` |

## Checks before every push

```sh
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo clippy -p anarchy-desktop --all-targets -- -D warnings
ANARCHY_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres cargo test   # docker compose up -d db
cargo deny check
node design-system/build.mjs && git diff --exit-code -- design-system/dist apps/desktop/ui/ds
node packages/buddy/test.mjs && node packages/buddy/build.mjs && git diff --exit-code -- apps/desktop/ui/buddy
NODE_PATH=$(npm root -g) node apps/desktop/ui-preview.mjs <out-dir>   # every screen; fails on any CSP refusal or page error
```

Copy the relevant preview shots into `docs/screens/` when a screen changes; the README shows them.

## Rules that bite

- **CSP is `style-src 'self'`.** No `style="…"` attributes and no inline `<style>`. Set styles through the CSSOM: `el()` in `app.js` handles `style` via `cssText`. The preview runs under the same CSP, so a refusal fails it. This bug once shipped because the preview didn't.
- **Buddy is edited in `packages/buddy`, never in `apps/desktop/ui/buddy`.** Run its `build.mjs` to copy; CI fails on drift.
- **Sealed conversations never reach an agent.** The MCP bridge (D43/D46) sees personal desks and Company channels only. Test: `sealed_conversations_never_reach_an_agent`. Keep it that way.
- **Agents draft, never send.** `anarchy_update_task` appends notes unless `confirm_replace`.
- **Title bar:** no system title bar. `data-os` comes from the user agent (`?os=windows|linux|mac` overrides in the preview); macOS draws its own lights (`tauri.macos.conf.json`). The open tabs sit in a second title-bar row that collapses when empty (D48).
- **Every new decision gets a row in `docs/ARCHITECTURE.md` §11** (next is D49) and a line in `PLAN.md` → *Just shipped*.
- **Commits go straight to `main`** and end with the session's `Co-Authored-By` and `Claude-Session` trailers. No model names in code or commits.
- **Disk in cloud sessions is small.** If it fills, clear `target/debug/incremental` and old test binaries.

## State, honestly

Works end to end against a real server: sign-in (email code, OIDC, anonymous, guest), DMs, spaces and channels, threads, desks, drive, mail, local accounts, the tour, the agent bridge, Summon, phone linking up to the approval step.

Not done, or partly:
- **No public server.** `anarchy.chat` doesn't run Anarchy, so a new person can't message anyone without hosting (PLAN step 1).
- **Your second device can't read old conversations** (step 2). **Delivery polls**; no WebSocket yet (step 3).
- **No phone app.** Pairing is built on server, client and desktop (D42).
- **No real model behind the sidekick or Summon.** They match intents and read local data (step 9). `HARNESSES.md` suggests running it on a Backspace route rather than building model routing here.
- **Company Brain** has an engine and no UI.
- **Installers are unsigned.** macOS: right-click → Open, or `xattr -cr /Applications/Anarchy.app`. Windows: More info → Run anyway. Signing needs an Apple Developer account and a Windows certificate as Actions secrets.
- **The empty-state audit was by reading code, plus preview shots of Notes and Agenda.** Clicking through a fresh, really empty account in the real app is still worth doing.
- **Backspace's phone pairing** (`chamsco/ohMyHarness`, `companion.rs`) accepts a long-lived token from the QR code over the LAN. The fix is written up in `HARNESSES.md`; it's not in this repo.

## Next, in order

`PLAN.md` holds the full list. In short: a public server (1), other devices see your conversations (2), live delivery (3), account safety (4). Pick up from step 1 unless told otherwise.

## Working with the owner

Push back first and agree only with reasons; lead with what's wrong; keep replies short; no praise without specifics. They work on Windows and macOS and test the downloaded builds, so say plainly when something only ran in the preview.
