# Contributing

## Setup

- Rust stable (1.88 or later) and Node 22.
- The desktop app on Linux also needs WebKitGTK: `sudo apt-get install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`.

## Everyday commands

| What | Command |
|---|---|
| Build and test core and server | `cargo test` |
| Run the server (port 8080) | `cargo run -p anarchy-server` |
| Run the desktop app | `cargo run -p anarchy-desktop` |
| Regenerate CSS after editing `design-system/tokens.json` or `components/bundle.css` | `node design-system/build.mjs` |
| Lint | `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings` |
| Licenses and advisories | `cargo deny check` |

## Rules

- **Clean room.** Never copy code from Anytype, Filen or any project with an incompatible license. Design notes cite ideas, not code. If you've read one of those codebases closely, don't implement the matching part of Anarchy.
- **Dependencies** must pass `cargo deny check` (permissive licenses, plus MPL-2.0 for file-level copyleft; see `deny.toml`).
- **The server never sees plaintext.** Any change that lets it read message content needs an architecture decision first.
- **CLA.** Your first pull request asks you to sign `CLA.md`.
