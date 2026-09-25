# Anarchy roadmap

Company edition first. The Community edition starts only after the Company core is stable, and it reuses that core. Each phase ends with something a real team uses every day.

## Phase 0: foundations (≈ 6–8 weeks)

Done:
- [x] Cargo workspace: `anarchy-proto`, `anarchy-core`, `anarchy-server`, `anarchy-desktop`.
- [x] Core: device keys, OpenMLS channel groups (create, add device, join from Welcome, encrypt, decrypt, apply commits).
- [x] Sync engine: per-channel cursors, catch-up after offline, own-message and pre-join skipping, idempotent appends.
- [x] Delivery service: ordered per-channel logs, epoch check that serialises concurrent commits, key package claim, Welcome inbox (in memory).
- [x] Tauri 2 desktop shell using the design system (Light, Dark, Luna switcher), calling the Rust core over IPC.
- [x] CI: fmt, clippy, tests, desktop build, `cargo deny` license and advisory policy, generated-CSS drift check.
- [x] CLA workflow and draft `CLA.md` (needs legal review).
- [x] **Exit test:** two devices exchange E2EE messages in one channel and stay in sync offline and online (`crates/anarchy-core/tests/two_devices.rs`).

Remaining:
- [ ] Persistence: Postgres for the server (`Store` trait), SQLCipher local store on the device (MLS state survives restarts).
- [ ] WebSocket subscriptions (live push instead of polling `sync`).
- [ ] Directory and OIDC login (Keycloak for development); authenticate every request (today any caller can read any channel's ciphertext and post to any inbox).
- [ ] Bundle Instrument Sans and IBM Plex Mono (both OFL) in the app instead of relying on system fallbacks. The build already strips the Google Fonts import.
- [ ] Clean-room process note: how reference reading of Anytype and Filen docs is recorded.

## Phase 1: Company chat MVP (≈ 8 weeks)

- Channels, DMs, threads, mentions, reactions, edits and deletes, pins.
- IRC-style commands and compact IRC transcript mode.
- Local search (sealed channels included).
- Trust states: Sealed or Company chosen per channel with radio buttons at creation (D3); org policy can lock a state per channel class.
- Invites: org and channel invites with expiry, use limits and approval. AccessRequest queue.
- Admin console: users, devices, policy, audit.
- **Exit:** we use Anarchy internally instead of our current chat.

## Phase 2: voice and video channels (≈ 6 weeks)

- Persistent Discord-style voice channels, ad-hoc DM and channel calls, screen share.
- LiveKit SFU, SFrame E2EE keyed from MLS epochs.
- Call panel, presence ("in #standup-voice"), push-to-talk, and noise suppression on the device.
- **Exit:** daily standups run in Anarchy voice channels.

## Phase 3: files / drive (≈ 8 weeks)

- Chunked client-side encryption, folder key hierarchy, a folder per channel, *My files*.
- Web and desktop file browser (FileList), versions, quotas.
- External links with the key in the URL fragment, expiry and download limits.
- Desktop folder sync client (keep-both conflicts).
- **Exit:** a team moves its shared drive off OneDrive or Google Drive.

## Phase 4: Company Brain and Company MCP (≈ 8 weeks)

- The Brain as an MLS member: ingest, ACL-tagged index, deletion propagation.
- Company MCP server: `search`, `get_thread`, `get_file`, `propose_action`; OAuth 2.1 clients, scopes, audit.
- In-app agents (scribe: summaries, catch-up, meeting notes via call transcription).
- AgentApproval flow, and model policy (local vs external, per channel class).
- **Exit:** "What did we decide about X?" answered with sources, and no permission leaks in a red-team test.

## Phase 5: portal and enterprise hardening

- Portal (org landing page, app tiles, locked-but-visible resources).
- SCIM provisioning, retention policies, legal hold, eDiscovery export (Company channels only).
- Recovery escrow (threshold admin keys), confidential-VM Brain, SOC 2 / ISO 27001 groundwork.
- IRC gateway (IRCv3) for Company-readable channels.
- Mobile apps (iOS, Android) with payload-free push and UnifiedPush.

## Phase 6: Community edition (see COMMUNITY-PLAN.md)

- Communities alongside organisations in the SpaceRail.
- Discord-style servers: roles, channels, voice.
- Public forums: server-rendered, indexable, readable without an account. Commenting needs an account plus an approved access request.
- Moderation tooling.

## Later / parking lot

- Collaborative documents (Yjs or Automerge over encrypted events).
- Calendar, and email bridging.
- Federation between Anarchy servers (org ↔ org channels).
- Luna icon set and sounds (original, not MSN assets).
