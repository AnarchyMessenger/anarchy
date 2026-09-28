# Solo plan: a personal workspace with an agent team

> Status: idea, not scheduled. It depends on the Company edition's chat,
> Brain and Company MCP (ROADMAP phases 1 and 4). Nothing here is built yet.

## The idea

A freelancer, consultant or one-person business gets a **Solo space**: the
same app, the same encryption, but set up for one human and a team of AI
agents. It is a personal ERP (invoices, clients, projects, bookkeeping
exports) run through chat, in the spirit of Manus's Cue: each agent has its
own identity and tools, and you work with them in group chats.

From a Solo space you can also **join other spaces**: a client's Company
workspace as a guest, a Community server, or another freelancer's Solo space.
Your agents can come with you where the space allows it, and can talk to other
people's agents.

## One app or two?

**One app, a new space type.** Not a second app.

- Everything it needs already exists or is planned for the Company edition:
  E2EE channels, the Brain (memory), Company MCP (tools), agents as visible
  channel members, guests, and the SpaceRail for switching spaces.
- The main selling point is moving between your own space and your clients'
  spaces without switching apps. Two apps would break that.
- A second app doubles the release, signing and support cost for a team
  that hasn't shipped the first one.

What *should* be separate: the **business model and onboarding**. Solo is
priced per person, set up without an IT admin, and signs in with email
codes (D11), not SSO.

The risk is the reverse: Solo pulls the roadmap away from the Company MVP.
Rule: no Solo work until the Company edition passes its phase 1 exit test.

## What an agent is

An agent is a **device in the MLS sense**, like the Company Brain (ARCHITECTURE
§9). It is a member of the channels it's added to, shown as such, and it
can only read those channels. Everything the Brain rules say applies: an
agent answering in a channel only uses what that channel's audience may see.

Per agent:

| Capability | Plan | Notes |
|---|---|---|
| Name, avatar, role, instructions | Phase A | Stored encrypted in the space. |
| Memory | Phase A | A per-agent Brain index, scoped like the Company Brain. |
| Tools (MCP) | Phase A | Allow-listed per agent; every call logged in the channel. |
| **Email address** | Phase A | `agent@yourname.anarchy.eu` or your own domain. Inbound mail becomes an encrypted channel message; outbound needs your approval by default. Mail is not E2EE, so we say so on screen. |
| **Computer** (browser and shell in a sandbox) | Phase B | A disposable VM per task (Firecracker or similar) on EU hosting, or on your own machine. Screen recording kept in the channel. |
| **Phone number** | Later | Needs a telecom partner and per-country number rules (identity checks in most of the EU). Voice agents calling people raise consent and disclosure rules, including the EU AI Act's rules on telling people they're talking to an AI. |
| **Wallet / payments** | Later | Holding or moving money is regulated (PSD2/PSD3 payment services, e-money, KYC/AML). Do it through a licensed partner with spending limits and approval per payment, never as our own wallet. Crypto wallets are out of scope. |

## Agent group chats and other people's bots

- **Your team:** a channel with you and several agents (for example
  "bookkeeper", "sales", "scribe"). Agents take tasks, report back, and ask
  for approval (the AgentApproval flow from phase 4).
- **Agents meeting agents:** when your agent joins a client's space, it joins
  as a guest device under that space's rules. The host decides whether agents
  are allowed, and they're always labelled as agents.
- **Agent-to-agent protocol:** messages between agents are ordinary channel
  messages plus a structured content type (`{"t":"task", …}`), so humans can
  always read what agents say to each other. No hidden side channel.

## Everyday services

Cue-style services (ordering in a restaurant by QR code, booking, paying)
mean an agent acting in the world for you. Order of work:

1. Read-only: find, compare, draft (no risk).
2. Act with approval: the agent prepares, you tap to confirm.
3. Act within limits: pre-approved spending caps per agent, per merchant.

Step 3 waits for the wallet partner above.

## Personal ERP modules

Built as agent tools, with plain screens for checking, not as a separate ERP:

- Clients and projects (a lightweight CRM from your channels and email).
- Time tracking from calendar and chat.
- Quotes and invoices, with EU e-invoicing formats (Factur-X / ZUGFeRD,
  Peppol), since several EU countries now require e-invoices for B2B.
- Expenses from receipts (photo → agent → ledger).
- Export to accountants (CSV, DATEV, FEC for France). We don't do tax filing.

## Phases

- **A (after Company phase 4):** Solo space type, agents with memory, tools
  and email; agent group chats; invoices and clients.
- **B:** sandboxed computer use; agents joining other spaces as guests.
- **Later:** phone numbers and payments through licensed partners.

## Open questions

1. Which models run agents by default, and can a Solo user bring their own API key?
2. Where agent sandboxes run: our EU hosting only, or also on the user's machine?
3. Pricing: per agent, per task, or flat per person.
