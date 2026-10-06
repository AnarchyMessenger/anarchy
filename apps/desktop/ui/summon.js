// Summon (D44): ask your sidekick from anywhere, by voice or by typing, and
// get an answer made for that question: a few cards built from what this
// device can read, which go away when you're done. No windows to open.
//
// ⌘/Ctrl + Shift + Space, or the sparkle by the search. Esc closes.
//
// Until an AI model is connected, a request is matched against a few kinds
// (your day, money, tasks, a draft or weekly update, anything else is a
// search), and every card is built from this device's data. Cards come from a
// fixed kit (stat, list, draft) filled in with data, never from markup a model
// wrote: a model can choose what to show, not how the page is built.
"use strict";

const summon = { open: false, busy: false, rec: null, face: null };
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

function summonEls() {
  return { root: $("summon"), pill: $("summon-pill"), state: $("summon-state"), input: $("summon-input"), said: $("summon-said"), cards: $("summon-cards"), mic: $("summon-mic"), face: $("summon-face") };
}

function summonState(label, sk) {
  const e = summonEls();
  e.state.textContent = label;
  if (summon.face) skPatch(summon.face, summon.face._sk.p, sk);
}

function openSummon() {
  if (summon.open) return;
  const e = summonEls();
  summon.open = true;
  e.cards.replaceChildren();
  e.said.replaceChildren();
  e.input.value = "";
  const sk = profile?.sidekick;
  $("summon-name").textContent = sk?.name || "Sidekick";
  summon.face = skLive(sk?.look || skLook(SK_BUDDY), "listening", { track: false, react: false });
  e.face.replaceChildren(summon.face);
  e.mic.hidden = !SpeechRec;
  summonState("Listening", "listening");
  e.root.hidden = false;
  requestAnimationFrame(() => e.root.classList.add("on"));
  e.input.focus();
}

function closeSummon() {
  if (!summon.open) return;
  const e = summonEls();
  summon.open = false;
  summon.rec?.abort?.();
  e.root.classList.remove("on");
  // Let the cards dissolve before the layer goes.
  setTimeout(() => { if (!summon.open) e.root.hidden = true; }, 320);
}

// What you say or type shows big, the newest word still settling in.
function paintSaid(text, settled = true) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  $("summon-said").replaceChildren(...words.map((w, k) => el("span", { class: `w${!settled && k === words.length - 1 ? " fresh" : ""}`, text: `${w} ` })));
}

function listen() {
  if (!SpeechRec || summon.rec) return;
  const rec = new SpeechRec();
  rec.interimResults = true;
  rec.lang = navigator.language || "en-US";
  summon.rec = rec;
  $("summon-mic").classList.add("on");
  summonState("Listening", "listening");
  let final = "";
  rec.onresult = (ev) => {
    let interim = "";
    for (let k = ev.resultIndex; k < ev.results.length; k++) {
      const r = ev.results[k];
      if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
    }
    $("summon-input").value = (final + interim).trim();
    paintSaid(final + interim, !interim);
  };
  rec.onerror = () => {};
  rec.onend = () => {
    summon.rec = null;
    $("summon-mic").classList.remove("on");
    if (final.trim() && summon.open) runSummon(final.trim());
  };
  rec.start();
}

// ---------- understanding a request (no model yet) ----------

const ASK = {
  day: /\b(today|my day|agenda|schedule|calendar|what'?s on|meetings?)\b/i,
  money: /\b(invoices?|owed?|owes|paid|money|revenue|outstanding|overdue|cash|payments?)\b/i,
  tasks: /\b(tasks?|to-?dos?|due|late|board)\b/i,
  update: /\b(weekly|update|recap|summary|report)\b/i,
  draft: /^(draft|write|tell|message|post|send)\b/i,
};

async function runSummon(text) {
  const q = text.trim();
  if (!q || summon.busy) return;
  summon.busy = true;
  const e = summonEls();
  paintSaid(q);
  summonState("Thinking", "thinking");
  e.cards.replaceChildren();
  let cards = [], done = "";
  try {
    if (ASK.draft.test(q) || (ASK.update.test(q) && /\b(write|draft|post|send)\b/i.test(q))) [cards, done] = await draftCards(q);
    else if (ASK.update.test(q)) [cards, done] = await weekCards();
    else if (ASK.money.test(q)) [cards, done] = await moneyCards();
    else if (ASK.day.test(q)) [cards, done] = await dayCards();
    else if (ASK.tasks.test(q)) [cards, done] = await taskCards();
    else [cards, done] = await findCards(q);
  } catch (err) {
    cards = [{ type: "list", title: "Something went wrong", rows: [{ text: String(err) }] }];
    done = "Couldn't finish that";
  }
  summon.busy = false;
  if (!summon.open) return;
  e.cards.replaceChildren(...cards.map(cardEl));
  [...e.cards.children].forEach((c, k) => c.style.setProperty("--i", k));
  summonState(done || "Done", cards.length ? "success" : "idle");
}

// ---------- the card kit ----------
// { type: "stat", label, value, sub?, tone? } · { type: "list", title, rows: [{ text, sub?, go? }] }
// { type: "draft", to, channel, text }
function cardEl(c) {
  if (c.type === "stat") {
    return el("div", { class: `sm-card stat${c.tone ? ` ${c.tone}` : ""}` }, el("small", { text: c.label }), el("strong", { text: c.value }), c.sub ? el("span", { class: "sub", text: c.sub }) : null);
  }
  if (c.type === "list") {
    return el("div", { class: "sm-card list" }, el("small", { text: c.title }),
      ...(c.rows.length ? c.rows : [{ text: "Nothing here." }]).slice(0, 6).map((r) => r.go
        ? el("button", { class: "sm-row", type: "button", onclick: () => { closeSummon(); r.go(); } }, el("span", { text: r.text }), r.sub ? el("small", { text: r.sub }) : null)
        : el("div", { class: "sm-row" }, el("span", { text: r.text }), r.sub ? el("small", { text: r.sub }) : null)));
  }
  if (c.type === "draft") {
    const box = el("textarea", { class: "sm-draft-text", rows: "6", "aria-label": "Draft" });
    box.value = c.text;
    return el("div", { class: "sm-card draft" }, el("small", { text: `Draft for ${c.to}` }), box,
      el("div", { class: "sm-actions" },
        el("span", { class: "fine", text: "Nothing is sent until you send it." }),
        el("button", { class: "btn-ink inline", type: "button", onclick: async () => {
          closeSummon();
          await openChannel(c.channel);
          composer.value = box.value; fitComposer(); composer.focus();
        } }, `Open in ${c.to}`)));
  }
  return el("div");
}

// ---------- what each kind shows ----------

async function deskItemsOf(kind) {
  const out = [];
  for (const d of channels.filter((c) => c.desk === kind)) out.push({ d, items: await invoke("desk_items", { channel: d.id }).catch(() => []) });
  return out;
}

async function moneyCards() {
  const today = isoToday();
  const weekAgo = isoDaysAgo(7);
  let open = 0, late = 0, lateN = 0, paidWeek = 0, n = 0;
  const lateRows = [];
  for (const { d, items } of await deskItemsOf("collections")) {
    for (const i of items.filter((x) => x.kind === "invoice")) {
      const inv = i.data, st = invoiceState(inv, today);
      n++;
      if (st === "open" || st === "overdue") open += inv.amount || 0;
      if (st === "overdue") { late += inv.amount || 0; lateN++; lateRows.push({ text: `${inv.number} · ${inv.customer}`, sub: `${money(inv.amount)}, due ${inv.due}`, go: () => goTo(d.id) }); }
      if (st === "paid" && (inv.paid_on || "") >= weekAgo) paidWeek += inv.amount || 0;
    }
  }
  if (!n) return [[{ type: "list", title: "Money", rows: [{ text: "No invoices on this device yet." }] }], "No invoices yet"];
  return [[
    { type: "stat", label: "Outstanding", value: moneyShort(open) },
    { type: "stat", label: "Overdue", value: moneyShort(late), sub: `${lateN} ${lateN === 1 ? "invoice" : "invoices"}`, tone: late ? "warn" : "" },
    { type: "stat", label: "Paid this week", value: moneyShort(paidWeek), tone: paidWeek ? "good" : "" },
    ...(lateRows.length ? [{ type: "list", title: "Overdue", rows: lateRows }] : []),
  ], `${moneyShort(open)} outstanding`];
}

async function dayCards() {
  await loadAgenda();
  const today = isoToday();
  const rows = dayEvents(today).map((e) => ({ text: e.title, sub: e.due ? "Due today" : e.all_day ? "All day" : `${e.start || ""}${e.end ? ` - ${e.end}` : ""}`, go: () => (e.channel ? goTo(e.channel) : openAgenda()) }));
  const late = agenda.dues.filter((x) => x.task && x.date < today);
  return [[
    { type: "list", title: "Today", rows },
    ...(late.length ? [{ type: "list", title: "Late tasks", rows: late.map((t) => ({ text: t.title, sub: `Was due ${t.date}`, go: () => goTo(t.channel) })) }] : []),
  ], rows.length ? `${rows.length} ${rows.length === 1 ? "thing" : "things"} today` : "Nothing on today"];
}

async function taskCards() {
  let open = 0, late = 0, week = 0;
  const rows = [];
  for (const { d, items } of await deskItemsOf("tasks")) {
    const st = taskStats(items);
    open += st.open; late += st.late; week += st.week;
    const done = new Set(boardColumns(items).filter((c) => c.done).map((c) => c.id));
    for (const i of items) if (i.kind === "card" && !i.data.deleted && i.data.due && !done.has(i.data.column)) rows.push({ text: i.data.title, sub: `Due ${i.data.due}`, due: i.data.due, go: () => goTo(d.id) });
  }
  rows.sort((a, b) => a.due.localeCompare(b.due));
  return [[
    { type: "stat", label: "Open", value: String(open) },
    { type: "stat", label: "Late", value: String(late), tone: late ? "warn" : "" },
    { type: "stat", label: "Due this week", value: String(week) },
    { type: "list", title: "Next up", rows },
  ], `${open} open, ${late} late`];
}

// The week, as numbers: what got done, what came in, what's still out.
async function weekNumbers() {
  const weekAgoMs = Date.now() - 7 * 864e5, weekAgo = isoDaysAgo(7), today = isoToday();
  let doneN = 0, paid = 0, open = 0, late = 0;
  for (const { items } of await deskItemsOf("tasks")) {
    const done = new Set(boardColumns(items).filter((c) => c.done).map((c) => c.id));
    doneN += items.filter((i) => i.kind === "card" && !i.data.deleted && done.has(i.data.column) && i.updated_ms >= weekAgoMs).length;
  }
  for (const { items } of await deskItemsOf("collections")) {
    for (const i of items.filter((x) => x.kind === "invoice")) {
      const st = invoiceState(i.data, today);
      if (st === "paid" && (i.data.paid_on || "") >= weekAgo) paid += i.data.amount || 0;
      if (st === "open" || st === "overdue") open += i.data.amount || 0;
      if (st === "overdue") late++;
    }
  }
  return { doneN, paid, open, late };
}

async function weekCards() {
  const w = await weekNumbers();
  return [[
    { type: "stat", label: "Tasks done", value: String(w.doneN), sub: "last 7 days", tone: w.doneN ? "good" : "" },
    { type: "stat", label: "Paid in", value: moneyShort(w.paid), sub: "last 7 days" },
    { type: "stat", label: "Still out", value: moneyShort(w.open), sub: w.late ? `${w.late} overdue` : "none overdue", tone: w.late ? "warn" : "" },
  ], "Your week"];
}

// "Write the weekly update to #leadership", "Tell #studio: back Monday".
async function draftCards(q) {
  const to = /\b(?:to|in|for)\s+[#@]?([\p{L}\p{N}][\p{L}\p{N} _.-]{0,40}?)(?=[:,.]|\s+(?:that|saying|about)\b|$)/iu.exec(q)?.[1]?.trim()
    || /[#@]([\p{L}\p{N}_.-]+)/u.exec(q)?.[1];
  const target = to && channels.find((c) => c.name.toLowerCase() === to.toLowerCase() || c.peer?.name?.toLowerCase() === to.toLowerCase());
  if (!target) {
    return [[{ type: "list", title: "Where should it go?", rows: [{ text: to ? `There's no conversation called “${to}”.` : "Say where, like “write the weekly update to #studio”." }] }], "Needs a place"];
  }
  const where = target.kind === "dm" ? target.peer?.name || target.name : `#${target.name}`;
  let text = (/[:—]\s*(.+)$/u.exec(q) || /\b(?:saying|that)\s+(.+)$/iu.exec(q))?.[1]?.trim() || "";
  const cards = [];
  if (!text && ASK.update.test(q)) {
    const w = await weekNumbers();
    text = `Weekly update: ${w.doneN} ${w.doneN === 1 ? "task" : "tasks"} done, ${moneyShort(w.paid)} paid in, ${moneyShort(w.open)} still outstanding${w.late ? ` (${w.late} overdue)` : ""}.`;
    cards.push(
      { type: "stat", label: "Tasks done", value: String(w.doneN) },
      { type: "stat", label: "Paid in", value: moneyShort(w.paid) },
      { type: "stat", label: "Still out", value: moneyShort(w.open), tone: w.late ? "warn" : "" });
  }
  if (!text) text = q.replace(ASK.draft, "").replace(/\b(?:to|in|for)\s+[#@]?\S+/i, "").trim();
  cards.push({ type: "draft", to: where, channel: target.id, text });
  return [cards, `Drafted for ${where}`];
}

async function findCards(q) {
  const words = [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}#@.-]+/u).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 4);
  const seen = new Map();
  for (const w of words) for (const h of await invoke("search", { query: w }).catch(() => [])) {
    const k = `${h.channel}:${h.seq}:${h.text}`;
    const cur = seen.get(k) || { h, n: 0 }; cur.n++; seen.set(k, cur);
  }
  const hits = [...seen.values()].sort((a, b) => b.n - a.n || b.h.ts_ms - a.h.ts_ms).slice(0, 6).map(({ h }) => {
    const c = channels.find((x) => x.id === h.channel);
    return { text: h.text.length > 90 ? `${h.text.slice(0, 90)}…` : h.text, sub: `${h.by} · ${whereOf(c)}`, go: () => goTo(h.channel) };
  });
  return [[{ type: "list", title: words.length ? `Found for “${words.join(" ")}”` : "Ask about your day, money, tasks, or something to find", rows: hits }], hits.length ? `${hits.length} found` : "Nothing found"];
}

function isoDaysAgo(n) { const d = new Date(Date.now() - n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

// ---------- wiring ----------
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "Space") { e.preventDefault(); summon.open ? closeSummon() : openSummon(); return; }
  if (summon.open && e.key === "Escape") { e.preventDefault(); closeSummon(); }
});
$("summon-open").addEventListener("click", openSummon);
$("summon").addEventListener("mousedown", (e) => { if (e.target === $("summon")) closeSummon(); });
$("summon-mic").addEventListener("click", listen);
$("summon-input").addEventListener("input", (e) => paintSaid(e.target.value, false));
$("summon-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runSummon(e.target.value); } });
