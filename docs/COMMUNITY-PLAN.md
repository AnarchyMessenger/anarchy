# Anarchy Community edition: plan

Status: parked until Company phases 1–4 ship (see ROADMAP.md). This file records the intent so it isn't lost.

## What it is

A free alternative to Discord for communities (open-source projects, clubs, creators, local groups) with one thing Discord lacks: **forums that are discoverable online and readable without an account**, where participating requires an account and an approved request.

## Requirements (from the founder)

1. Discord-style community servers: text channels, voice channels (the same call stack as Company), roles.
2. **Public forums** that are easy to find and read on the open web.
3. **Users need an account to comment**, and they must **request access** to comment. Reading is open; writing is gated.
4. Lives in the same app as Company spaces: communities appear below the divider in the SpaceRail.

## Product shape

| Area | Behaviour |
|---|---|
| Community server | Channels, voice channels, roles, member list. The trust state is chosen per channel: Public, Company-style (readable by the community's own bots) or Sealed (private groups). |
| Forum | Threads with tags, pinned posts, "helpful" votes. Each public thread has a stable URL that works without JS. |
| Reading | Anyone, no account, including search engines. Server-side rendered, sitemap, canonical URLs, OpenGraph. |
| Commenting | Requires an account and an approved AccessRequest. The requester writes a short note. Moderators approve, approve as read-only, or decline. Communities can set auto-approve rules (account age, email verified, invite code). |
| Gate UI | Signed out: "Sign in to reply". Signed in without access: "Request access to comment", then "Pending". Uses the ForumPost gate component. |
| Moderation | Report, hide, lock thread, slow mode, ban. Moderation log visible to moderators. Agent assist for triage (a Brain-like community bot, a visible member). |
| Discovery | A public directory of communities that opt in. Forum content indexed by search engines. |

## Encryption stance

Public forums are **not** end-to-end encrypted, and they can't be, since the whole point is that anyone can read them. The UI says so with the Public badge and banner. Private community channels and DMs use the same MLS machinery as Company.

## Free vs paid

- **Free:** unlimited members, public forums, text and voice, and a fair-use file quota.
- **Paid "Community+":** custom domain for forums, larger uploads, more storage, advanced moderation automation, and a hosted community bot.
- **Self-hosted:** free, same features, community-supported.

## Risks to address before building

- **Abuse and spam at open-web scale:** needs rate limits, verification tiers and moderation tooling from day one, not bolted on later.
- **Legal:** EU DSA obligations for hosting platforms (notice and action, transparency reports), and handling illegal content on public forums.
- **Costs:** voice and file storage for free users need hard quotas.
- **Positioning:** Discourse already does "forum + login to post". The difference has to be *forum + live chat + voice in one app*.
