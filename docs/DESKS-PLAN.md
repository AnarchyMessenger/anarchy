# Desks plan: purpose-built workspaces that AI builds from how you work

> Status: design, not scheduled. It needs agents, the Company MCP and
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

## Limits we say out loud

- Phone numbers and calls need a telecom partner, per-country number rules, and
  telling callers they're talking to an AI (EU AI Act transparency rules).
- Payments go through licensed partners with limits and per-payment approval.
- Lead scraping: no scraping of sites whose terms forbid it; B2B prospecting
  only on a documented legitimate-interest basis (GDPR).
- A desk's agent reads its channel in plaintext on the org's infrastructure, so
  desks are Company-trust spaces, never Sealed ones.

## Build order

1. Item content type and a desk view with three blocks (queue, item detail,
   activity), hand-configured. Proves desks on encrypted channels.
2. Workflow as a list, compiled to that desk.
3. The agent interview that drafts the workflow; override → proposed change.
4. The first real desk (collections or front desk) with its partner.
5. More blocks and desk kinds.
