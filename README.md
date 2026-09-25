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

## Repository layout

| Path | What |
|---|---|
| `crates/anarchy-proto` | Wire types shared by clients and server |
| `crates/anarchy-core` | Client core: device keys, MLS channels (OpenMLS), sync engine |
| `crates/anarchy-server` | Gateway and delivery service: ordered ciphertext logs per channel |
| `apps/desktop` | Tauri 2 desktop app (UI in `apps/desktop/ui`) |
| `design-system/` | Tokens, component CSS and guidelines; `build.mjs` generates the CSS |

## Quick start

```sh
cargo test                     # two devices exchange MLS-encrypted messages through a real server
cargo run -p anarchy-server    # server on 127.0.0.1:8080
cargo run -p anarchy-desktop   # desktop app (Linux needs WebKitGTK, see CONTRIBUTING.md)
```

Status: phase 0 in progress (see [docs/ROADMAP.md](docs/ROADMAP.md)).

## License

[AGPL-3.0-only](LICENSE). Contributions require a CLA so the project can also offer commercial licenses. See `docs/ARCHITECTURE.md` D1.
