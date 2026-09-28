# Anarchy

Encrypted, self-hostable workspace for organisations: chat, IRC-style commands, voice and video channels, a file drive, temporary invites, and a Company Brain that agents reach through MCP. It's an alternative to Microsoft Teams + OneDrive.

The Community edition (Discord-style servers plus public forums) comes later. See [docs/COMMUNITY-PLAN.md](docs/COMMUNITY-PLAN.md).

| Doc | What |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Identity, MLS messaging, sync, files, calls, IRC, Company Brain and MCP |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phases, Company first |
| [docs/ENTERPRISE-PLAN.md](docs/ENTERPRISE-PLAN.md) | Company edition: buyers, editions, compliance, go-to-market |
| [docs/COMMUNITY-PLAN.md](docs/COMMUNITY-PLAN.md) | Community edition (parked) |
| [design-system/](design-system/) | Tokens (Light, Dark, Luna), component CSS, component guidelines |

## Screens

Sign in with SSO, an emailed code, or an invite code as a guest; then pick a frame colour.

| Sign in | Look |
|---|---|
| ![Sign in](docs/screens/sign-in.png) | ![Pick a frame colour](docs/screens/look.png) |

| Chat | Add people |
|---|---|
| ![Chat](docs/screens/chat.png) | ![Add people](docs/screens/add-people.png) |

| Devices | Dark, Ocean |
|---|---|
| ![Devices](docs/screens/devices.png) | ![Chat in dark mode](docs/screens/chat-dark.png) |

These are rendered by `apps/desktop/ui-preview.mjs` with a mocked backend. The screenshot below is the real app instead: two desktop instances against a real server, taken under Xvfb.

![Real app, two people](docs/screens/real-app-two-people.png)

## Repository layout

| Path | What |
|---|---|
| `crates/anarchy-proto` | Wire types shared by clients and server |
| `crates/anarchy-core` | Client core: device keys, MLS channels (OpenMLS), sync engine |
| `crates/anarchy-server` | Gateway and delivery service: OIDC sign-in, ordered ciphertext logs per channel in Postgres |
| `crates/anarchy-brain` | Company Brain: a member device that indexes the channels it's added to and answers audience-scoped searches |
| `crates/anarchy-testkit` | Test helpers: local OIDC provider, throwaway Postgres databases |
| `apps/desktop` | Tauri 2 desktop app (UI in `apps/desktop/ui`) |
| `design-system/` | Tokens, component CSS and guidelines; `build.mjs` generates the CSS |

## Quick start

```sh
docker compose up -d db        # Postgres for the tests
export ANARCHY_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
cargo test                     # E2EE messaging, auth and Brain scoping against a real server
cargo run -p anarchy-server    # needs DATABASE_URL and OIDC settings, see docs/SELF-HOSTING.md
cargo run -p anarchy-desktop   # desktop app (Linux needs WebKitGTK, see CONTRIBUTING.md)
```

Status: phase 0 in progress (see [docs/ROADMAP.md](docs/ROADMAP.md)).

## License

[AGPL-3.0-only](LICENSE). Contributions require a CLA so the project can also offer commercial licenses. See `docs/ARCHITECTURE.md` D1.
