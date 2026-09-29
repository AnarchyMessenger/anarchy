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

Sign up with Google, email or anonymously, then say what it's for, lock the device with a passphrase and make your card.

| Sign up | Your card |
|---|---|
| ![Sign up](docs/screens/sign-up.png) | ![Welcome card](docs/screens/welcome-card.png) |

| Home | Direct conversation |
|---|---|
| ![Home](docs/screens/home.png) | ![DM](docs/screens/dm.png) |

| Space overview | Search |
|---|---|
| ![Space overview](docs/screens/space-overview.png) | ![Search](docs/screens/search.png) |

| Files | File preview |
|---|---|
| ![Drive](docs/screens/drive.png) | ![Preview](docs/screens/drive-preview.png) |

| Desk (Collections) | Desk, bulk actions |
|---|---|
| ![Collections desk](docs/screens/desk.png) | ![Bulk actions](docs/screens/desk-bulk.png) |

| Client says paid (payment link) | What the client sees |
|---|---|
| ![Client says paid](docs/screens/desk-client-says-paid.png) | ![Payment link](docs/screens/pay-link.png) |

| @-mentioning a desk | Ask (sparkle, `Ctrl J`) |
|---|---|
| ![Desk mention](docs/screens/desk-mention.png) | ![Ask](docs/screens/ask.png) |

| Thread beside the conversation | Sidebar collapsed (`Ctrl \`) |
|---|---|
| ![Thread](docs/screens/thread.png) | ![Sidebar collapsed](docs/screens/tabs.png) |

| People, from the right | Desks folder |
|---|---|
| ![People](docs/screens/people.png) | ![Desks](docs/screens/desks.png) |

| A space's channel | Privacy |
|---|---|
| ![Channel in a space](docs/screens/space-channel.png) | ![Privacy settings](docs/screens/privacy.png) |

| Dark | Locked |
|---|---|
| ![Dark](docs/screens/dark.png) | ![Locked](docs/screens/locked.png) |

These are rendered by `apps/desktop/ui-preview.mjs` with a mocked backend. The one below is the real app: a DM from an anonymous account arriving by handle, against a real server, taken under Xvfb.

![Real app](docs/screens/real-app-dm-received.png)

The real app again, a Collections desk after a restart and unlock. The server's database holds none of the customer names, amounts or the desk's name in the clear.

![Real app, desk](docs/screens/real-app-desk.png)

A file uploaded through the real picker, encrypted in chunks, then fetched and decrypted to preview:

![Real app, drive](docs/screens/real-app-drive.png)

The client's payment page (above, and after "Mark as paid" below) is the real server's page on a phone-sized Chromium, decrypting a link made by the real app.

![Payment link after it's paid](docs/screens/pay-link-paid.png)

A thread in the real app: the reply went through the channel's MLS group like any message, and the thread joined the tabs because Maya replied in it.

![Real app, thread](docs/screens/real-app-thread.png)

And search in the real app (`Ctrl K`), over what this device decrypted:

![Real app, search](docs/screens/real-app-search.png)

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
