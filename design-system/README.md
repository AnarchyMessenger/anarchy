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

**Color.** `canvas` sits behind panes, and panes are `surface`. The rail and sidebars are `surface-sunken`. Text is `ink`, with `ink-muted` for secondary lines and `ink-faint` for timestamps only. `primary` (cobalt) is for the single main action, links, mentions and the active tab underline. The amber `surface-selected` marks the selected row and the menu hover. It's the system's signature, carried over from Luna. `highlight` amber marks new activity (rail dots). Agent content uses the olive `agent` trio everywhere. Errors use `danger`.

**Type.** Set UI and reading text in Instrument Sans (`sans`) and code, commands, IRC lines and invite codes in IBM Plex Mono (`mono`). The reading size is `message` (14/21). Rows and buttons use `label` (13, 500). Sidebar groups are `overline` (11, uppercase, tracked). `display` is reserved for the Portal and community landing pages. Luna swaps the family to Tahoma and drops sizes to 11–13px.

**Spacing and density.** Use a 4px scale (`space-1` … `space-8`). Rows are 34px, panes pad `space-4`, and dialogs pad `space-5`. Luna keeps the same spacing and tightens type only.

**Radii.** Use `radius-sm` 6 for inputs and chips, `radius-md` 8 for buttons and rows, `radius-lg` 12 for cards and panels, and `radius-xl` 16 for the composer and rail tiles. Pills (`radius-pill`) are only for badges and trust states. Luna overrides them to 3/4/5/7.

**Depth.** The modern themes are flat, with a 1px `border` and small shadows. Use `shadow-1` at rest, `shadow-2` for menus and `shadow-3` for toasts and dialogs. Luna maps the same tokens to its bevels and glossy gradients. In Light and Dark, gradients belong to the **frame** only (below), never to panels, cards or anything behind body text.

**Frame.** The window is a coloured frame and the content is a neutral floating panel inset 8px from it, the way Arc does it. The frame is a three-stop gradient from one of the `frame-<theme>-a/b/c` token sets. There are nine: Anarchy (cobalt, the default), Spring, Summer, Autumn, Winter, Coral, Ocean, Forest and Dusk. People pick one per workspace, so switching workspaces also switches colour. Only the rail's icons and labels sit on the frame, and `ink` reads at 5.6:1 or better on every stop. The panel has a 1px stroke *outside* its edge at 8% black (7% white in Dark) plus a soft lift, so it reads as floating rather than boxed. In Dark, a 60% `canvas` wash sits over the frame. Luna ignores the frame choice and uses its own blues.

**Motion.** Use 120–180ms ease-out for hover and open, and a single bounce loop for typing. `prefers-reduced-motion` turns all of it off.

**Focus.** A 2px solid `focus` ring with a 2px offset on every interactive element, at 6:1 or better on every ground in every theme.

**Calls** are always dark (`#0b0e12` stage) in Light and Dark, because video reads best on black. Luna gives them its blue glass.

## Layout

- **Organisation edition:** SpaceRail (64px) → sidebar (260px: search, channels, DMs, agents, and a Files entry) → main pane (ChannelHeader with Messages, Files and Pinned tabs, then the transcript and Composer) → an optional right panel for thread, call or file details. Portal is the landing screen.
- **Community edition:** the same shell, plus a *Forum* item per community that opens ForumThreadList. Public forums also render server-side at a public URL without the app shell, for search engines. Readers without access see ForumPost's gate instead of the composer.
- **Access flows:** InviteLink (who, what scope, what role, how long, how many uses) → AccessRequest queue for admins → the result posts as a SystemNotice and a Toast.

## Screens built so far (desktop)

- **Sign-in (split screen).** Inside the frame, a white panel on the left (about 47%, never narrower than 400px) holds the form. The frame itself is the right side and carries one dark glass card: a preview of the workspace ("Northwind is ready") with two cursor chips, a person's and an agent's, to show that agents work alongside people. Under 880px the art side is hidden and the panel fills the frame. Steps: workspace address → sign in (SSO button, "or" rule, email field → 6-digit code) → optional "Join as a guest" (invite code + name) → pick display mode and frame colour. One question per step, and the heading names the organisation once it's known.
- **Buttons on auth screens** are `ink` (near-black fill, `surface` text). Outline buttons are for the secondary route (SSO next to email). Links are underlined `ink-muted`. `primary` cobalt is kept for the app itself, so the sign-in never competes with the frame colour.
- **Chat.** Messages are grouped: a new header (avatar initials, name, time) when the sender changes or 5 minutes pass, otherwise the line continues under the previous one. Day rules separate days. Unread channels are bold with a dot. The composer is a `radius-xl` box. Enter sends and Shift+Enter adds a line. The send button stays disabled until there's text. A message being sent shows at 50% opacity until the server has it.
- **Channel header:** name, trust state pill (Sealed / Company, with icon), topic, then the member count and "Add people". The empty state explains what newcomers can't see: messages sent before they joined stay unreadable to them.
- **Dialogs:** a title, fields with labels above, and the trust choice as two radio cards with no default. The primary button is the last one and the only submit button, so Enter never triggers Cancel.
- **Settings:** a sidebar list of pages; each page has a title, one sentence saying what it's for, then facts (label/value rows), toggles (label + one-line explanation) or list rows (identifier, date, a tag or a button on the right).

Base element styles in `bundle.css` are wrapped in `:where()`, so any component class overrides them without specificity fights.

## Themes

- **Light:** the default. Cool neutrals, cobalt, amber selection.
- **Dark:** the same roles on near-black. The cobalt lifts to `#7b93ff` with near-black `on-primary`, because white fails on it.
- **Luna (XP):** the fun theme from codex-messenger: four-stop blue titlebars, bevelled buttons, gradient bubbles, Tahoma at 11px. Its `ink-faint` (3.2:1) is kept exact from the source, and it's the only theme with a known contrast miss.

## Iconography

Use 16px outline icons with a 1.75 stroke and round caps and joins, colored with `currentColor`. The previews use a small hand-drawn set in that style. Adopt [Lucide](https://lucide.dev) (ISC license) for production, since it matches the style. No MSN or Microsoft icons, emoticons or sounds are used in any theme, Luna included. Luna gets its own glossy icon set later. No logo exists yet: set the name in `display`.
