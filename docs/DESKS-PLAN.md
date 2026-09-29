# Desks plan: purpose-built workspaces that AI builds from how you work

> Status: step 1 built (a hand-configured Collections desk, see "What exists
> now"). Everything agent-driven still needs agents, the Company MCP and
> approvals (ROADMAP phase 4). Replaces the agent sections of SOLO-PLAN.md;
> Solo becomes "a space with desks and one human".

## What a desk is

A **desk** is a workspace built for one job: a help desk, a front desk,
dispatch, collections, purchasing, recruiting. It opens as a control center,
not a chat: what needs you now, what the agent did, the numbers that say
whether the job is going well.

The desk is **built from how the team works**, not picked from a template
gallery: the agent asks how the job is done today (or watches it being done),
writes that down as a workflow, and turns the workflow into the desk.

## Desks sit on channels; they don't replace them

Pushback on "desks instead of channels": keep channels underneath.

- People still need to talk about the work, with each other and with the agent.
- The channel is the audit trail: every agent action is a message anyone on the
  desk can read and question.
- Channels are what we encrypt (MLS). A desk's items are structured messages in
  its channel (`{"t":"item", …}`), so the server still sees only ciphertext
  and every member's device can rebuild the desk.

So the desk is the default *view* of a space set up for a job; the channel is
one tab of it ("Activity"). Plain chat spaces stay for teams that just talk.

## Anatomy

| Part | What it is | Example (front desk) |
|---|---|---|
| **Inbox** | Where work arrives: email address, phone number, web form, another desk | Calls, texts, the contact form |
| **Items** | Typed records with fields and a status | Request: caller, need, address, urgency |
| **Workflow** | Steps an item goes through, with who or what does each | Answer → qualify → book or hand over → confirm |
| **Rules** | What the agent may do alone and what needs a person | Book slots alone; quotes over €1,000 need approval |
| **Views** | Blocks arranged for the job | Today's queue, calendar, missed-call list, KPIs |
| **People and agents** | Who works the desk | 2 people, 1 agent |
| **Activity** | The desk's channel | "Booked Mme Roux Tue 9:00, texted confirmation" |

## From workflow to desk

1. **Describe.** The agent interviews: "Walk me through the last job you
   handled." Or it reads a week of the inbox (with permission). Output: a
   draft workflow.
2. **Edit.** The workflow is shown as a **list of steps**, not a node canvas.
   Each step: trigger, who does it (person / agent / either), what it needs,
   what it produces, and the rule for when a person must approve. Branches are
   indented under a step ("if urgent → call the on-call tech"). People who run
   a business read lists; node graphs (n8n, Zapier canvases) are for
   integrators, and the canvas is where most users give up.
3. **Generate.** The workflow compiles into the desk: item type and fields from
   what the steps need, statuses from the steps, views from what each role
   looks at, rules from the approval settings, inbox from the triggers.
4. **Run and adjust.** When a person overrides the agent ("no, that one goes
   to Karim"), the agent proposes a change to the workflow; the owner accepts
   it, and the desk updates. This is how "it learns each job from the person
   who does it" becomes something you can inspect.

The workflow is the source of truth; the desk is derived from it. Users can
also move blocks around, but changes that affect behaviour go through the
workflow so they stay reviewable.

## Blocks, not generated code

Desks are assembled from a fixed set of blocks the agent arranges and fills:
queue, table, board, calendar, map, timeline, form, metric, chart, item detail,
activity. No generated application code.

- Generated apps are unmaintainable and unsafe to run inside an E2EE client.
- Blocks upgrade for every desk at once, and look consistent.
- Everything a block shows comes from the desk's items, so access control is
  the channel's membership, nothing new.

A block set covers most desks. The ones it can't cover are a signal to add a
block, not to generate code.

## Built-in desk kinds (starting points, still generated from interviews)

- **Front desk:** calls, texts, booking. Needs a phone partner (see below).
- **Help desk:** customer questions by email and chat, answers from the
  company's knowledge (the Brain), escalations.
- **Dispatch:** jobs, crews, schedule changes, texting both sides.
- **Collections (AR):** invoices out, reminders, who paid. French e-invoicing
  (receiving mandatory since 1 Sept 2026, sending for SMEs from Sept 2027)
  through an approved platform partner.
- **Purchasing (AP):** supplier invoices from the inbox, matching, payment
  approval through a bank partner.

Pick **one** to launch, for one kind of customer. Recommendation: collections
for French SMEs (a live legal deadline, low risk, measurable in euros), unless
the target is trades, where the front desk wins.

## The client side: what people outside the company see

Most desks exist to deal with people who will never install Anarchy:
customers, suppliers, patients, tenants. Each desk has an **outside** (what
they touch) and an **inside** (the desk the team works). Payment links are
built (see "What exists now"); the rest is not yet.

**Outside: web, no account, one thing at a time.**

- **Links that do one thing:** pay this invoice, approve this quote, sign
  this, pick a slot, upload the missing document. Sent by email or SMS; open
  on a phone with no sign-in. This is most client interaction, and it
  converts better than any portal.
- **Client portal** per client per space, reached by magic link: open
  invoices, shared files, the status of their job, a message thread. It's a
  list of those links plus history, not a second app.
- **Chat widget** or QR code on the company's site or van, feeding the desk
  inbox. Phone and email land in the same inbox (partners, see Limits).
- **Branding is the company's, not ours.** Its name, logo and colour;
  "via Anarchy" only in the footer.

**Inside: the desk's Clients tab.**

- One conversation per client across channels (email, SMS, widget, portal,
  calls), newest first, grouped by state: *needs you*, *agent handling*,
  *waiting on client*.
- A client card (a desk item) beside the thread: contact, open invoices,
  jobs, files, consent to be contacted by AI.
- The agent drafts; a person sends, unless the desk's rules let the agent
  send that kind of message alone. Drafts show **Approve · Edit · Send**.

**Rules the UI enforces.**

- Anything a client can see carries the amber *Public* trust badge ("Client
  can see this"), and **Preview as client** shows exactly their view.
- Messages written by the agent say so to the client (EU AI Act transparency).
- Internal notes never share a composer with client replies: two tabs, two
  colours, so nobody pastes a margin note into a customer email.

**Encryption, honestly.** Clients have no device keys. Portal content can
be encrypted with a key in the link's fragment (the server never sees it),
but the page's JavaScript comes from the server, so a hostile server could
serve code that reads it. Email and SMS are plaintext anyway. So
client-facing desks are Company trust, and the portal says what's encrypted
and what isn't.

## Limits we say out loud

- Phone numbers and calls need a telecom partner, per-country number rules, and
  telling callers they're talking to an AI (EU AI Act transparency rules).
- Payments go through licensed partners with limits and per-payment approval.
- Lead scraping: no scraping of sites whose terms forbid it; B2B prospecting
  only on a documented legitimate-interest basis (GDPR).
- A desk's agent reads its channel in plaintext on the org's infrastructure, so
  desks are Company-trust spaces, never Sealed ones.

## What exists now (step 1)

- **Storage:** a desk is a channel in a space whose encrypted channel info
  names its kind (`"desk": "collections"`). Records are `item` messages
  (`{"t":"item","id","kind","data"}`), folded in order, latest write wins; a
  bulk change is one `items` message. The server sees ciphertext only.
- **Newcomers:** MLS doesn't let someone added later read earlier messages, so
  adding a person to a desk re-shares its current state (one `items` snapshot)
  in the new epoch. History of *changes* before they joined stays unreadable to
  them, by design.
- **Collections desk** (the first kind), laid out from the reference designs:
  - *Notes column* between the space sidebar and the board: cards for what needs you (overdue, due in 30 days, drafts
    not sent), each with one primary action; below them the desk's activity,
    which is its channel: every change is logged there as a message, and
    people talk there too. The notes are rules computed on the device, and
    the column says so. The desk agent will write them once the Brain exists.
  - *Board:* a sentence that says how the job is going ("€11,980 outstanding
    across 5 invoices."), paid-per-month with what's due dashed, status tabs
    with counts, search, a table, and a black bar for bulk actions.
- **Actions:** new or edit invoice; mark as paid; copy as CSV; aging report.
  *Draft reminder* opens one email per invoice in the person's own mail app,
  prefilled; Anarchy doesn't send mail for desks yet (that's the desk inbox),
  so the button says "Draft", not "Send".
- **Payment links** (the first client-facing piece, D20): *Payment details*
  on the desk (business name, account holder, IBAN, BIC, optional online
  payment page), then *Make a payment link* on an invoice. The link is copied
  and goes into reminder emails. The client's page shows the amount, due date,
  bank details with copy buttons, and "I've paid"; that shows up on the desk as
  a *Client says paid* card and a badge, never as paid, until someone marks it.
  Marking it paid, or editing the invoice, updates the page under the same
  link. *Withdraw* ends it. Links last 30 to 180 days.
- **@-mentions** (D21): type `@` in a channel or chat to mention a desk or a
  person; people on the desk see a live card, and the message lands in the
  desk's activity. The sparkle in the sidebar (`Ctrl J`) opens **Ask**, which
  for now searches what this device can decrypt and answers with desk figures.
- **Other kinds** (front desk, help desk, dispatch, purchasing) are shown in
  "Set up a desk" as not available yet, each with what it's waiting for.

## Build order

1. ~~Item content type and a desk view, hand-configured. Proves desks on
   encrypted channels.~~ Done: Collections.
2. Workflow as a list, compiled to that desk.
3. The agent interview that drafts the workflow; override → proposed change.
4. The first real desk (collections or front desk) with its partner.
5. More blocks and desk kinds.
