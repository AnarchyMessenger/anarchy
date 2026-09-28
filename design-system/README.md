Anarchy is a self-hostable, encrypted workspace that replaces the Teams + OneDrive + Discord stack. It comes in two editions on one design language. **Organisations** get chat, calls, a file drive, a portal, and time-limited guest access. **Communities** get Discord-style servers plus public forums that anyone can read, where commenting needs an account and an approved request. AI agents are members of the workspace, never hidden behind it.

The system ships three themes: **Light** and **Dark** (the default, modern look) and **Luna**, an opt-in playful skin inherited from codex-messenger's XP/MSN styling. Components are written once against tokens. Luna restyles them through a `[data-theme="luna"]` layer in `bundle.css`, so the markup never changes between themes.

## Content fundamentals

- **Plain and literal.** Buttons are sentence-case verbs: "Request access", "Copy link", "Revoke". Status lines are past tense and say what happened: "Maya started a call · 3 joined". No exclamation marks, no "Oops".
- **Say where data goes.** Any action that moves content (share, invite, run an agent) says who will be able to read it. "Nothing leaves Northwind" and "Posts are visible to anyone" are required copy, not decoration.
- **Address the user as *you*.** Agents speak in the first person inside their own messages, never in system lines. An agent is always named with its `agent` role tag.
- **Casing.** Channels are lowercase with `#`. Spaces and documents keep their owners' casing. Commands are shown literally in `code`: `/join #ops`, `/invite @scribe`, `/call`.
- **No emoji in the UI chrome.** Users' own messages can use any.

## Trust states: the core of the product

Every space, channel, folder, file, invite and call is in exactly one of three states. Show it with EncryptionBadge, and add a banner when the reader needs to know more.

| State | Meaning | Token pair | AI behaviour |
| --- | --- | --- | --- |
| **Sealed** | End-to-end encrypted. The server holds ciphertext only. | `sealed` on `sealed-soft` | Only on-device agents can read it. Server agents are unavailable and appear greyed out with the reason. |
| **Company** | Still end-to-end encrypted, but the org's Company Brain is a visible, removable member of the group. | `ink-muted` on `surface-sunken` | The Brain and agents using the Company MCP can read it, filtered by each caller's permissions. |
| **Public** | Discoverable and indexed by search engines (community forums). | `public` on `public-soft` | Any agent can read it. Commenting is gated by AccessRequest. |

The states differ in hue *and* in label and icon: lock, building, globe. Never show a state by color alone. Never let the Public amber be confused with the selection amber: public is dark amber text on a pale field, while selection is a light amber fill behind ink.

## Visual foundations

**Color.** Warm paper, not grey. `canvas` (#f3f1ec) sits behind panes, and panes are `surface` (#fdfcfa, never pure white). Sidebars are `surface` mixed with `surface-sunken`. Text is `ink` (#1a1814, warm near-black), with `ink-muted` for secondary lines and `ink-faint` for timestamps only. Primary actions are **ink** buttons, not coloured ones. The one accent is **vermilion** `primary` (#c2391a): unread dots, mentions, the brand mark, the eyebrow over a page title, icons on start cards. If a screen has more than two or three vermilion marks, one is wrong. The amber `surface-selected` marks the selected row and chosen options. It's the system's signature, carried over from Luna. Agent content uses the olive `agent` trio everywhere. Errors use `danger`.

**Why these choices.** Generated apps converge on zinc greys, an indigo or violet accent, Inter, purple-to-blue gradients and bubbly cards. Every one of those is swapped here on purpose: warm neutrals, a vermilion accent (the black-and-red of the name), Schibsted Grotesk, gradients only in the frame and identity cards, tighter radii.

**Type.** Set everything in **Schibsted Grotesk** (`sans`, variable 400–900) and handles, tags, codes and commands in **IBM Plex Mono** (`mono`). Both are OFL and ship with the app (`apps/desktop/ui/fonts/`), so nothing falls back to a system font. The interface runs at 13px; messages at 14/21. Weights do the work instead of size: 560 for labels, 620–640 for names and titles, 700 for the identity card. Headings track tight (−0.015 to −0.035em). Page titles are 22px, onboarding and Home titles 26–30px. Uppercase overlines (11px, +0.06em) label groups. Luna swaps the family to Tahoma and drops sizes to 11–13px.

**Spacing and density.** Use a 4px scale (`space-1` … `space-8`). Rows are 30px (DM rows 44px with two lines), controls 36px (28px small), headers 48px. Panes pad 14–18px, settings pages 36–40px. Luna keeps the same spacing and tightens type only.

**Radii.** `radius-sm` 5 for inputs' inner parts and rows, `radius-md` 7 for buttons and inputs, `radius-lg` 10 for panels and cards, `radius-xl` 12 for the composer. Avatars and space tiles are **rounded squares** (8px at 32px), not circles. Pills only for trust states and tags. Luna overrides them to 3/4/5/7.

**Depth.** The modern themes are flat, with a 1px `border` and small shadows. Use `shadow-1` at rest, `shadow-2` for menus and `shadow-3` for toasts and dialogs. Luna maps the same tokens to its bevels and glossy gradients. In Light and Dark, gradients belong to the **frame** only (below), never to panels, cards or anything behind body text.

**Frame.** The window is a coloured frame and the content is a neutral floating panel inset 8px from it, the way Arc does it. The frame is a three-stop gradient from one of the `frame-<theme>-a/b/c` token sets. There are ten: Ember (peach to clay, the default), Cobalt, Spring, Summer, Autumn, Winter, Coral, Ocean, Forest and Dusk. A person's profile colour uses the same names, and the frame follows it after onboarding. People pick one per workspace, so switching workspaces also switches colour. Only the rail's icons and labels sit on the frame, and `ink` reads at 5.6:1 or better on every stop. The panel has a 1px stroke *outside* its edge at 8% black (7% white in Dark) plus a soft lift, so it reads as floating rather than boxed. In Dark, a 60% `canvas` wash sits over the frame. Luna ignores the frame choice and uses its own blues.

**Motion.** Use 120–180ms ease-out for hover and open, and a single bounce loop for typing. `prefers-reduced-motion` turns all of it off.

**Focus.** A 2px solid `focus` ring with a 2px offset on every interactive element, at 6:1 or better on every ground in every theme.

**Calls** are always dark (`#0b0e12` stage) in Light and Dark, because video reads best on black. Luna gives them its blue glass.

## Layout

- **Organisation edition:** SpaceRail (64px) → sidebar (260px: search, channels, DMs, agents, and a Files entry) → main pane (ChannelHeader with Messages, Files and Pinned tabs, then the transcript and Composer) → an optional right panel for thread, call or file details. Portal is the landing screen.
- **Community edition:** the same shell, plus a *Forum* item per community that opens ForumThreadList. Public forums also render server-side at a public URL without the app shell, for search engines. Readers without access see ForumPost's gate instead of the composer.
- **Access flows:** InviteLink (who, what scope, what role, how long, how many uses) → AccessRequest queue for admins → the result posts as a SystemNotice and a Toast.

## Identity

- **Handle:** `@username#0427`. Username in ink, `#0427` in `ink-faint`, both mono. Always shown whole, with a copy button where people share it.
- **Avatar:** a rounded square tinted with the person's colour (`frame-<colour>-b`), holding their emoji or two initials in ink. Never a photo placeholder silhouette.
- **Identity card:** 340×214, the person's frame gradient, a diagonal sheen, `ANARCHY` and the account kind (MEMBER, FREELANCE, ANONYMOUS, GUEST) in tracked mono at the top, avatar, name (22px, 700), handle, "Since" and an E2EE chip. It's the right-hand art of onboarding, tilted −4°, and updates live as the person types. The same card sits on Settings → Profile.

## Screens built so far (desktop)

- **Sign-up and onboarding (split screen).** The form sits on a panel on the left (46%, at least 420px); the frame on the right carries the identity card and one line about what happens to your data at this step. Steps, with a four-segment progress mark: server → account (Continue with Google or SSO, "or", email → 6-digit code; below a rule, "Continue anonymously" and "I have a guest invite" as quiet rows) → what it's for (four cards) → lock this device (passphrase twice, a strength bar) → your card (name, username with its tag, picture, colour). Under 900px the art side is hidden.
- **Lock screen:** the brand mark, "Anarchy is locked", one passphrase field. Nothing else is reachable until it unlocks.
- **Home:** Chats in the sidebar (avatar, name, last line). With nothing open, a start panel: "Message someone" with an inline handle field, "Create a space", "Join with a code", and your handle with a copy button and your privacy setting in words. Spaces live in the rail as tinted tiles with initials; `+` creates or joins one.
- **Buttons on auth screens** are `ink` (near-black fill, `surface` text). Outline buttons are for the secondary route (SSO next to email). Links are underlined `ink-muted`. `primary` cobalt is kept for the app itself, so the sign-in never competes with the frame colour.
- **Chat.** Messages are grouped: a new header (avatar initials, name, time) when the sender changes or 5 minutes pass, otherwise the line continues under the previous one. Day rules separate days. Unread channels are bold with a dot. The composer is a `radius-xl` box. Enter sends and Shift+Enter adds a line. The send button stays disabled until there's text. A message being sent shows at 50% opacity until the server has it.
- **Channel header:** name, trust state pill (Sealed / Company, with icon), topic, then the member count and "Add people". The empty state explains what newcomers can't see: messages sent before they joined stay unreadable to them.
- **Dialogs:** a title, fields with labels above, and the trust choice as two radio cards with no default. The primary button is the last one and the only submit button, so Enter never triggers Cancel.
- **Settings:** a sidebar list of pages; each page has a title, one sentence saying what it's for, then facts (label/value rows), toggles (label + one-line explanation) or list rows (identifier, date, a tag or a button on the right).

Base element styles in `bundle.css` are wrapped in `:where()`, so any component class overrides them without specificity fights.

## Desks

Adapted from the reference designs the desks are based on, fitted to this system:

- **Notes column (300px, left):** a small orb and "Desk notes". Cards for what needs you: a coloured flag row (dot, what, amount in mono: `danger` for late, `public` for waiting, `sealed` for fine), a bold one-line title, one or two lines of plain explanation, then one ink pill button and one underlined link. Plain sentences with chips between cards. The desk's activity underneath, then a rounded composer with a "Today's brief" chip. Always say where the notes come from.
- **Headline sentence:** the board opens with one sentence at 34px that says how the job is going, figures in `ink` and the connecting words in `ink-faint`: "**€11,980** outstanding across **5** invoices." It replaces a row of KPI tiles.
- **Chart card:** a white card on the sunken hero; one solid ink line for what happened, dashed for what's expected, a dot where today is, month labels in `ink-faint`.
- **Tabs with counts:** a pill segmented control, count in `ink-faint` after each label.
- **Bulk bar:** when rows are selected, a black pill bar sticks above the table: "2 selected · €2,900 total" and pill actions on 12% white.
- **Tables:** 40px rows, customer shown with a small initials tile, money right-aligned and semibold, status as icon plus word in its colour (never colour alone), relative dates ("in 27 days", "6 days overdue" in `danger`) beside absolute ones.
- **Honest verbs:** a button that opens a draft says "Draft", not "Send".

## Themes

- **Light:** the default. Cool neutrals, cobalt, amber selection.
- **Dark:** the same roles on near-black. The cobalt lifts to `#7b93ff` with near-black `on-primary`, because white fails on it.
- **Luna (XP):** the fun theme from codex-messenger: four-stop blue titlebars, bevelled buttons, gradient bubbles, Tahoma at 11px. Its `ink-faint` (3.2:1) is kept exact from the source, and it's the only theme with a known contrast miss.

## Iconography

Use 16px outline icons with a 1.75 stroke and round caps and joins, colored with `currentColor`. The previews use a small hand-drawn set in that style. Adopt [Lucide](https://lucide.dev) (ISC license) for production, since it matches the style. No MSN or Microsoft icons, emoticons or sounds are used in any theme, Luna included. Luna gets its own glossy icon set later. No logo exists yet: set the name in `display`.
