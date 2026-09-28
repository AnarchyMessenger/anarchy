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
- [x] Postgres for the server: migrations, per-channel row lock for ordering, idempotent appends, paging (ARCHITECTURE D4).
- [x] Encrypted device storage: MLS state, key packages, channel list and sync cursors in one SQLCipher file; desktop keeps its key in the OS keychain and falls back to a clearly labelled temporary device when there is none (D7).
- [ ] WebSocket subscriptions (live push instead of polling `sync`).
- [x] OIDC sign-in (ID token verified against the provider's keys), hashed server sessions, device registration, membership checks on every endpoint (D5). Tests cover forged, expired and wrong-audience tokens, non-members and spoofed devices.
- [x] Desktop onboarding: workspace address → sign in with the organisation (system browser, PKCE, loopback) or join as a guest with an invite code → pick display mode and frame colour (D9, D10).
- [x] Guest invites: expiry, use limits, revocation; guests expire with their invite and are cleaned out of channels.
- [x] Email one-time codes as a second sign-in method, limited to the organisation's domains; SSO becomes optional (D11).
- [x] Desktop opens instantly: an engine thread owns the device and unlocks it behind the painted window; the keychain gets 3 seconds before the app falls back to a temporary device (D12).
- [x] Split-screen sign-in (SSO, email code, guest invite) inside the gradient frame.
- [x] Real chat: create Sealed/Company channels, send and receive, unread markers, add and remove people (all of a person's devices at once), desktop notifications. Channel names and topics are encrypted too.
- [x] Settings: Account, Appearance, Notifications, Devices (revoke), Invite guests.
- [x] Personal accounts: sign up with Google/SSO, email or anonymously; `username#tag` handles; profile card (name, picture, colour) (D13).
- [x] Spaces: create, invite by code, join; channels belong to a space; the directory is scoped to shared spaces (D14).
- [x] Direct conversations by handle, with privacy settings (anyone / people in my spaces / only humans) (D15).
- [x] Passphrase lock for the device, which also saves devices on computers without a keychain (D16).
- [x] Onboarding: account → what it's for → passphrase → welcome card → Home.
- [ ] Changing or removing the passphrase; adding an email to an anonymous account.
- [ ] Space roles and settings (rename, leave, remove people from the space).
- [ ] A new device of yours joins your existing conversations (today only devices present when a conversation starts are in it).
- [ ] Blocking and reporting people in DMs.
- [ ] Company Brain settings page (needs the Brain binary first).
- [ ] People who join a channel can't read what was sent before they joined (MLS forward secrecy). Decide whether to offer history sharing: a member re-encrypts recent history for the newcomer (opt-in per channel, logged).
- [ ] Rate limiting per IP on sign-in and guest join. Email codes are already limited per address; invite codes are 128-bit, so guessing isn't feasible, but floods still cost.
- [x] Member removal (keys rotate; removed devices read up to their removal, then delete the channel), re-adding, device revocation with `remove_revoked` clean-up (D8).
- [x] Brain purges a channel's index when removed from it; survives restarts.
- [ ] Device proof of possession at registration.
- [ ] Leaving a channel yourself (MLS: propose, another member commits).
- [ ] Channel roles: today any member can remove any other member.
- [ ] Brain: write index rows in the same step as advancing the cursor (a crash in between drops those messages from the index).
- [ ] Bundle Instrument Sans and IBM Plex Mono (both OFL) in the app instead of relying on system fallbacks. The build already strips the Google Fonts import.
- [ ] Clean-room process note: how reference reading of Anytype and Filen docs is recorded.

Pulled forward from phase 4:
- [x] `anarchy-brain`: the Brain as a member device, ingest with cursors, Postgres full-text index, audience-scoped search (D6).

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

- [x] First version pulled forward: a drive per space, files encrypted on the device in chunks, folders, preview, download, rename and delete, drag and drop, search by name (D18).
- [ ] Object storage for chunks, quotas, garbage collection of deleted files, versions, sharing across spaces, external links, sync client.

- Chunked client-side encryption, folder key hierarchy, a folder per channel, *My files*.
- Web and desktop file browser (FileList), versions, quotas.
- External links with the key in the URL fragment, expiry and download limits.
- Desktop folder sync client (keep-both conflicts).
- **Exit:** a team moves its shared drive off OneDrive or Google Drive.

## Phase 4: Company Brain and Company MCP (≈ 8 weeks)

- The Brain as an MLS member: ingest and audience-scoped search are done; still to do: deletion propagation, pgvector embeddings, triage, cooldowns.
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

- **Desks** (purpose-built workspaces generated from a workflow): see DESKS-PLAN.md. Step 1 is in: a Collections desk on encrypted records (D17). Next: the workflow list that compiles into a desk.
- **Solo spaces** (personal ERP, one human with desks): see SOLO-PLAN.md.

- Branded frame themes extracted from an organisation's brand guidelines (colours from a PDF), as in the Deel reference: an Enterprise feature for the Brain.

- Collaborative documents (Yjs or Automerge over encrypted events).
- Calendar, and email bridging.
- Federation between Anarchy servers (org ↔ org channels).
- Luna icon set and sounds (original, not MSN assets).
