// The tour (D38): a sample workspace that runs entirely in this page.
//
// Same command names and shapes as src-tauri/src/ops.rs, answered from made-up
// data: Maya's design studio, its channels, desks, files, agenda and mail.
// Nothing is saved and nothing leaves the window; ending the tour throws it
// all away. ui-preview.mjs uses the same file to screenshot every screen.
"use strict";

function anarchyDemo(startLocked) {
  const now = Date.now();
  const min = 60_000;
  let locked = startLocked;
  let localMode = false;
  let session = null;
  let profile = null;
  let storage = { kind: "saved", path: "~/.local/share/anarchy/device.db", lock: "keychain" };
  let appearance = { display: "light", frame: "ember", chosen: false };
  let notifications = { desktop: true, mentions_only: false, previews: true };
  let open = null;
  const listeners = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const people = {
    u1: { user_id: "u1", display_name: "Maya Chen", username: "maya", tag: 427, color: "ocean", avatar: "🌊" },
    pip: { user_id: "pip", display_name: "Pip", username: "pip.sidekick", tag: 4410, color: "summer", avatar: null, agent: true },
    u2: { user_id: "u2", display_name: "Tomás Ruiz", username: "tomas", tag: 1881, color: "autumn", avatar: null, sidekick: { name: "Juno", look: "s2.drop.grumpy.f15a4a.100.100.0.a" } },
    u3: { user_id: "u3", display_name: "Ines Bauer", username: "ines.b", tag: 42, color: "forest", avatar: null },
    u4: { user_id: "u4", display_name: "Léa Martin", username: "lea", tag: 9031, color: "dusk", avatar: "🪐" },
  };
  const handle = (p) => `${p.username}#${String(p.tag).padStart(4, "0")}`;
  const peer = (u) => ({ user_id: u, name: people[u].display_name, handle: handle(people[u]), color: people[u].color, avatar: people[u].avatar, is_guest: false, is_agent: !!people[u].agent, presence: people[u].agent ? null : (PRES[u] || "offline") });
  const PRES = { u2: "online", u3: "busy", u4: "away" };
  const lookOf = (name) => { const p = Object.values(people).find((x) => x.display_name === name); return p ? { color: p.color, avatar: p.avatar, sidekick: p.sidekick || null } : null; };
  let spaces = [
    { id: "sp1", name: "Studio Chen", kind: "freelance", role: "owner", members: 4, is_default: false },
    { id: "sp2", name: "Climbing club", kind: "community", role: "member", members: 38, is_default: false },
  ];
  const channels = [
    { id: "d1", kind: "dm", peer: "u2", unread: true, messages: [
      { sender: "Tomás Ruiz", ts: now - 50 * min, text: "Sent you the revised quote for the Acme rebrand." },
      { sender: "Tomás Ruiz", ts: now - 49 * min, text: "They want the first draft by Friday. Doable?" },
    ] },
    { id: "d2", kind: "dm", peer: "u3", unread: false, messages: [
      { sender: "Ines Bauer", ts: now - 26 * 60 * min, text: "Contract's signed. Invoice whenever you're ready." },
      { sender: "ME", ts: now - 25 * 60 * min, text: "Great, sending it tonight." },
    ] },
    { id: "d3", kind: "dm", peer: "u4", unread: false, messages: [] },
    { id: "c1", kind: "channel", space: "sp1", name: "acme-rebrand", topic: "Logo, type and the launch deck", trust: "sealed", unread: false, messages: [
      { sender: "Ines Bauer", ts: now - 3 * 60 * min, text: "Moodboard is in the drive, three directions." },
      { sender: "ME", ts: now - 2 * 60 * min, text: "Going with the second one. Warmer, less corporate." },
      { sender: "Ines Bauer", ts: now - 110 * min, text: "Do we keep the serif for headlines?", thread: 2 },
      { sender: "ME", ts: now - 100 * min, text: "Yes, only headlines. Body stays in the sans.", thread: 2 },
      { sender: "Tomás Ruiz", ts: now - 40 * min, text: "Exported both weights to the drive.", thread: 2 },
      { sender: "Tomás Ruiz", ts: now - 30 * min, text: "Agreed. I'll mock the deck cover with it." },
    ] },
    { id: "c2", kind: "channel", space: "sp1", name: "invoices", topic: "What's out, what's paid", trust: "company", unread: true, messages: [
      { sender: "Juno", agent: { owner: "Tomás Ruiz", mine: false, look: "s2.drop.grumpy.f15a4a.100.100.0.a" }, ts: now - 50 * min, text: "Tomás asked me to watch this channel: Acme's deposit landed this morning." },
      { sender: "Ines Bauer", ts: now - 10 * min, text: "Acme paid the deposit." },
    ] },
    { id: "c3", kind: "channel", space: "sp2", name: "general", topic: "", trust: "company", unread: false, messages: [] },
    { id: "k1", kind: "channel", space: "sp1", desk: "collections", name: "Collections", topic: "", trust: "company", unread: false, messages: [
      { sender: "Ines Bauer", ts: now - 3 * 864e5, text: "Added INV-1041: Nordic Outfitters, €5,400." },
      { sender: "ME", ts: now - 864e5, text: "Marked INV-1038 (Glow Beauty, €940) as paid." },
      { sender: "Tomás Ruiz", ts: now - 2 * 60 * min, text: "Trendy Terra said the transfer goes out Friday." },
    ] },
  ];
  channels.push({ id: "f1", kind: "channel", space: "sp1", desk: "files", name: "Files", topic: "", trust: "company", unread: false, messages: [] });
  channels.push({ id: "pa", kind: "personal", space: null, desk: "agenda", name: "Agenda", topic: "", trust: "sealed", unread: false, messages: [] });
  channels.push({ id: "pn", kind: "personal", space: null, desk: "notes", name: "Notes", topic: "", trust: "sealed", unread: false, messages: [] });
  channels.push({ id: "pf", kind: "personal", space: null, desk: "files", name: "My files", topic: "", trust: "sealed", unread: false, messages: [] });
  channels.push({ id: "pt", kind: "personal", space: null, desk: "tasks", name: "Tasks", topic: "", trust: "sealed", unread: false, messages: [] });
  channels.push({ id: "kt", kind: "channel", space: "sp1", desk: "tasks", name: "Launch plan", topic: "", trust: "company", unread: false, messages: [] });
  channels.push({ id: "kw", kind: "channel", space: "sp1", desk: "pages", name: "Studio handbook", topic: "", trust: "company", unread: false, messages: [] });
  const dayIso = (k) => { const d = new Date(now + k * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const ev = (id, k, title, start, end, color, where = "") => ({ id, kind: "event", data: { title, date: dayIso(k), start, end, all_day: !start, color, where }, seq: 1, updated_ms: now });
  const agendaItems = [
    ev("e1", 0, "Acme deck review", "10:00", "11:00", "ember", "Google Meet"), ev("e2", 0, "Coffee with Amélie", "15:30", "16:00", "plum", "Café Lomi"),
    ev("e3", 1, "Invoice run", "09:00", "09:30", "ink"), ev("e4", 2, "Design sync", "14:00", "15:00", "ocean"), ev("e5", 3, "Climbing", "18:30", "20:30", "spring"),
    ev("e6", -2, "Dentist", "08:30", "09:00", "ink"), ev("e7", 6, "Ava's birthday", "", "", "plum"), ev("e8", 9, "Quarterly review", "11:30", "12:30", "ember"), ev("e9", -6, "Portfolio shoot", "13:00", "17:00", "ocean"),
  ];
  const page = (id, title, icon, blocks, ago) => ({ id, kind: "page", data: { title, icon, blocks, updated: now - ago * 60_000 }, seq: 1, updated_ms: now });
  // A deterministic history per card: added some days ago, then moved along.
  const histFor = (id, column) => {
    const seed = [...id].reduce((h, c) => h * 31 + c.charCodeAt(0), 7);
    const added = now - (6 + (seed % 24)) * 864e5;
    const path = column === "todo" ? ["todo"] : column === "doing" ? ["todo", "doing"] : ["todo", "doing", "done"];
    return { added, hist: path.map((c, k) => [c, added + k * (2 + (seed % 5)) * 864e5]) };
  };
  const card = (id, title, column, order, extra = {}) => ({ id, kind: "card", data: { title, column, order, color: "ink", ...histFor(id, column), ...extra }, seq: 1, updated_ms: now });
  const launchCards = [
    card("t1", "Final logo files to Acme", "todo", 1, { due: dayIso(2), who: "Ines Bauer", color: "ember" }),
    card("t2", "Write launch post", "todo", 2, { who: "Maya Chen" }),
    card("t3", "Deck cover, second pass", "doing", 1, { due: dayIso(-1), who: "Tomás Ruiz", color: "ocean", notes: "Use direction 2" }),
    card("t4", "Brand guidelines PDF", "doing", 2, { due: dayIso(5), who: "Ines Bauer" }),
    card("t5", "Kickoff with Acme", "done", 1, { who: "Maya Chen", color: "spring" }),
    card("t6", "Moodboard, three directions", "done", 2, { who: "Ines Bauer" }),
    ...["Type pairing", "Signage mockups", "Business cards", "Letterhead", "Social templates", "Icon set", "Photo shoot brief", "Colour audit", "Packaging dieline", "Web hero"].map((t, k) =>
      card(`tx${k}`, t, k % 3 === 0 ? "todo" : k % 3 === 1 ? "doing" : "done", 10 + k)),
  ];
  const myCards = [card("m1", "Renew passport", "todo", 1, { due: dayIso(9), color: "plum" }), card("m2", "Send the Q3 VAT return", "doing", 1, { due: dayIso(3), color: "ember" }), card("m3", "Book the dentist", "done", 1)];
  const myFiles = [];
  const wb = (type, text, checked = false) => ({ id: Math.random().toString(36).slice(2, 10), type, text, checked });
  const wikiPages = [
    page("w1", "How we onboard a client", "🤝", [wb("p", "Every new client goes through the same five steps, so nothing depends on who took the call."), wb("h2", "Before the kickoff"), wb("todo", "Send the intake form", true), wb("todo", "Create their client card in Collections", true), wb("todo", "Agree the rate and write it on the card"), wb("h2", "Kickoff"), wb("bullet", "Share the moodboard folder in Files"), wb("bullet", "Book the review dates in everyone's agenda"), wb("quote", "Deposit before any work starts. No exceptions.")], 90),
    page("w2", "File naming", "🗂️", [wb("p", "client_project_version_date, lowercase, no spaces.")], 60 * 24 * 3),
    page("w3", "Rates 2026", "🧾", [wb("p", "Design €90/h, retouching €80/h, rush +25%.")], 60 * 24 * 12),
  ];
  const noteItems = [
    page("n1", "Acme rebrand, direction 2", "🎯", [
      { id: "a", type: "p", text: "Warmer, less corporate. Keep the serif for headlines only." },
      { id: "b", type: "h2", text: "Decisions" },
      { id: "c", type: "bullet", text: "Serif headlines, sans body" }, { id: "d", type: "bullet", text: "Ember as the accent, used sparingly" },
      { id: "e", type: "h2", text: "To do" },
      { id: "f", type: "todo", text: "Export both weights to the drive", checked: true }, { id: "g", type: "todo", text: "Mock the deck cover", checked: false }, { id: "h", type: "todo", text: "Send the invoice after sign-off", checked: false },
      { id: "i", type: "quote", text: "The logo should feel like a signature, not a stamp." },
    ], 40),
    page("n2", "Pricing ideas for 2027", "💡", [{ id: "a", type: "p", text: "Day rate vs. project pricing." }], 60 * 26),
    page("n3", "Reading list", "📚", [{ id: "a", type: "bullet", text: "Shape Up" }], 60 * 24 * 5),
  ];
  const fk = (size) => ({ key: "k", nonce: "n", sha256: "s", size });
  const file = (id, name, folder, size, mime, by, daysAgo) => ({ id, kind: "file", seq: 1, updated_ms: now, data: { name, folder, mime, by, added: now - daysAgo * 864e5, file_key: fk(size), chunks: [] } });
  let driveItems = [
    { id: "d1", kind: "folder", seq: 1, updated_ms: now, data: { path: "/Clients" } },
    { id: "d2", kind: "folder", seq: 1, updated_ms: now, data: { path: "/Clients/Acme" } },
    { id: "d3", kind: "folder", seq: 1, updated_ms: now, data: { path: "/Brand" } },
    file("x1", "Studio Chen - rate card 2026.pdf", "/", 412_000, "application/pdf", "Maya Chen", 2),
    file("x2", "moodboard-direction-2.png", "/", 3_800_000, "image/png", "Ines Bauer", 1),
    file("x3", "Kickoff notes.md", "/", 6_200, "text/plain", "Tomás Ruiz", 5),
    file("x4", "Acme - master services agreement.pdf", "/Clients/Acme", 988_000, "application/pdf", "Maya Chen", 12),
    file("x5", "Acme logo final.svg", "/Clients/Acme", 24_000, "image/svg+xml", "Ines Bauer", 3),
    file("x6", "Invoices 2026.xlsx", "/Clients", 64_000, "application/vnd.ms-excel", "Maya Chen", 20),
    file("x7", "Type specimen.pdf", "/Brand", 2_300_000, "application/pdf", "Ines Bauer", 30),
  ];
  // Invoices on the Collections desk, dated relative to today.
  const iso = (days) => { const d = new Date(now + days * 864e5); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const inv = (n, customer, email, euros, issuedAgo, terms, status, paidAgo) => ({ id: `i${n}`, kind: "invoice", seq: n, updated_ms: now, data: {
    number: `INV-${n}`, customer, email, amount: Math.round(euros * 100), currency: "EUR", issued: iso(-issuedAgo), terms, due: iso(terms - issuedAgo), status,
    ...(paidAgo !== undefined ? { paid_on: iso(-paidAgo) } : {}) } });
  const payLinks = [];
  // A client opened a payment link three times and pressed "I've paid".
  window.__addClaim = () => {
    const inv = items.find((i) => i.kind === "invoice" && i.data.status === "sent");
    inv.data = { ...inv.data, link: { id: "L0", url: "https://chat.studiochen.fr/p/L0#k3y", created: "2026-09-20" } };
    payLinks.push({ id: "L0", expires_at_ms: now + 60 * 864e5, revoked: false, views: 3, last_viewed_at_ms: now - 3600e3, claimed_paid_at_ms: now - 1800e3 });
    return inv.data.number;
  };
  let items = [
    inv(1044, "Urban Threads", "ap@urbanthreads.eu", 1200, 3, 30, "sent"),
    inv(1043, "Glow Beauty Hub", "billing@glowbeauty.com", 940, 5, 30, "paid", 1),
    inv(1042, "Trendy Terra", "finance@trendyterra.fr", 1650, 32, 30, "sent"),
    inv(1041, "Nordic Outfitters", "ap@nordic.se", 5400, 6, 90, "sent"),
    inv(1040, "Ridgewear Retail", "accounts@ridgewear.de", 1250, 36, 30, "sent"),
    inv(1039, "Hike+Supply Co.", "pay@hikesupply.com", 2480, 7, 60, "sent"),
    inv(1038, "Urban Threads", "ap@urbanthreads.eu", 3100, 11, 30, "draft"),
    inv(1037, "Glow Beauty Hub", "billing@glowbeauty.com", 760, 40, 30, "paid", 25),
    inv(1036, "Atlas Apparel", "hello@atlasapparel.co", 2310, 70, 30, "paid", 44),
    inv(1035, "Moss & Stone", "office@mossandstone.nl", 1880, 95, 30, "paid", 66),
    inv(1034, "Lumen Living", "ap@lumenliving.com", 4200, 125, 30, "paid", 92),
    inv(1033, "Field & Forest", "billing@fieldforest.ie", 1450, 150, 30, "paid", 118),
    inv(1032, "Saltwater Supply", "ops@saltwater.pt", 990, 176, 30, "paid", 150),
  ];
  const client = (id, name, extra) => ({ id, kind: "client", seq: 1, updated_ms: now, data: { name, added: now, ...extra } });
  const tentry = (id, what, cl, daysAgo, hour, minutes, rate, extra = {}) => { const start = new Date(now - daysAgo * 864e5); start.setHours(hour, 0, 0, 0); return { id, kind: "time", seq: 1, updated_ms: now, data: { what, client: cl, rate: rate * 100, start: start.getTime(), end: start.getTime() + minutes * 60e3, minutes, who: "me", who_name: "Maya Chen", ...extra } }; };
  items.push(
    client("c1", "Urban Threads", { contact: "Jonas Weber", email: "ap@urbanthreads.eu", phone: "+49 30 1234 567", rate: 9000 }),
    client("c2", "Glow Beauty Hub", { contact: "Priya Nair", email: "billing@glowbeauty.com", rate: 8000 }),
    client("c3", "Trendy Terra", { contact: "Camille Roux", email: "finance@trendyterra.fr", rate: 8500, notes: "Pays late; call Camille, not the AP inbox." }),
    client("c4", "Nordic Outfitters", { contact: "Erik Lind", email: "ap@nordic.se", rate: 9500 }),
    tentry("t1", "Lookbook layout", "c1", 0, 9, 135, 90),
    tentry("t2", "Client call", "c1", 0, 14, 40, 90),
    tentry("t3", "Packaging mockups", "c3", 1, 10, 210, 85),
    tentry("t4", "Retouching, batch 2", "c2", 2, 9, 180, 80),
    tentry("t5", "Brand audit", "c4", 4, 13, 150, 95, { billed: "i1041" }),
    { id: "intake", kind: "form", seq: 1, updated_ms: now, data: { title: "Start a project", intro: "", fields: [
      { id: "name", label: "Your name", type: "text", required: true }, { id: "company", label: "Company", type: "text" }, { id: "email", label: "Email", type: "email", required: true },
      { id: "phone", label: "Phone", type: "phone" }, { id: "need", label: "What do you need?", type: "longtext", required: true }],
      public_key: "PUB", private_key: "PRIV", link: { id: "F1", url: "https://chat.studiochen.fr/f/F1#k3y", expires: now + 300 * 864e5 }, status: "open", created: now - 20 * 864e5 } },
    { id: "req-F1-7", kind: "request", seq: 1, updated_ms: now, data: { at: now - 42 * 60e3, status: "new", labels: { name: "Your name", company: "Company", email: "Email", phone: "Phone", need: "What do you need?" },
      answers: { name: "Sofia Marchetti", company: "Casa Lume", email: "sofia@casalume.it", phone: "+39 02 555 0199", need: "A new identity for our lighting shop: logo, signage and a small website. Opening in March." } } },
  );
  const me = () => profile?.display_name || "You";
  const skOn = new Set();
  let mailOn = true;
  const mail = (uid, from_name, from_addr, subject, text, mins, seen) => ({ uid, message_id: `m${uid}@mail.test`, from_name, from_addr, to: ["maya@studiochen.fr"], subject, date_ms: now - mins * 60e3, text, seen, references: [] });
  let phonePolls = 0, phoneState = "open";
  const mailLinked = {};
  const mailbox = [
    mail(42, "Tomás Ruiz", "tomas@ruizstudio.es", "Deck fonts, licence question", "Hey Maya,\n\nBefore I send the deck: is the serif licensed for print too, or just web? Happy to switch if not.\n\nT.", 8, false),
    mail(41, "Jonas Weber", "ap@urbanthreads.eu", "Invoice 1042: payment date", "Hi Maya,\n\nThanks for the reminder. Finance has scheduled invoice 1042 for the 15th; you'll get the transfer confirmation the same day.\n\nBest,\nJonas Weber\nUrban Threads · Accounts payable", 25, false),
    mail(40, "Camille Roux", "camille@trendyterra.fr", "Packaging: second round of mockups", "Bonjour Maya,\n\nThe second round looks great. Could we try the lighter kraft for the outer box? Our printer needs files by Thursday.\n\nMerci !\nCamille", 140, false),
    mail(39, "Figma", "no-reply@figma.com", "Tomás commented on Acme rebrand", "Tomás Ruiz commented: \"Second direction, warmer. Shipping the deck cover today.\"", 60 * 20, true),
    mail(38, "Sofia Marchetti", "sofia@casalume.it", "Casa Lume: new identity", "Hi! We filled in your form. Opening in March, so we'd love to start in November. Is a call on Monday possible?", 60 * 30, true),
  ];
  const prefsItems = [];
  let skChat = false;
  channels.push({ id: "dpip", kind: "dm", peer: "pip", unread: false, messages: [
    { sender: "ME", ts: now - 4 * 60e3, text: "anything about the acme invoice?" },
    { sender: "Pip", agent: { owner: "Maya Chen", mine: true }, ts: now - 4 * 60e3 + 3000, text: "Here's what I found (2):\n• #invoices · Ines Bauer: Acme paid the deposit.\n• #invoices · Maya Chen: Invoice 1042 to Acme goes out Friday." },
  ] });
  const view = (c) => ({
    id: c.id, kind: c.kind, space: c.space ?? null, desk: c.desk ?? null, peer: c.kind === "dm" ? peer(c.peer) : null,
    name: c.kind === "dm" ? people[c.peer].display_name : c.name, topic: c.topic ?? "", trust: c.trust ?? "sealed",
    unread: c.unread && c.id !== open, last_ts: c.messages.at(-1)?.ts ?? 0,
    last_text: c.messages.at(-1) ? (c.messages.at(-1).sender === "ME" ? `You: ${c.messages.at(-1).text}` : c.messages.at(-1).text) : null,
  });
  const signIn = (server, extra = {}) => {
    session = { server, org_name: "Anarchy Cloud", is_guest: false, display_name: "maya.chen", email: "maya.chen@hey.com", expires_at_ms: now + 30 * 864e5, user_id: "me" };
    profile = { user_id: "me", display_name: "maya.chen", username: "maya.chen", tag: 7314, color: "ember", avatar: null, usage: null, dm_policy: "spaces", dm_humans_only: false, email: "maya.chen@hey.com", is_guest: false, is_anonymous: false, onboarded: false, ...extra };
  };
  const commands = {
    status: async () => ({
      locked, profile, device_id: "cb4148ab-32b3-4ded-943c-d1f04b01d3f4", storage: locked ? { kind: "locked" } : storage,
      appearance, notifications, last_server: null, default_server: "https://anarchy.chat", session, local: localMode,
    }),
    unlock: async ({ passphrase }) => {
      await wait(200);
      if (passphrase !== "correct horse battery") throw "That passphrase isn't right";
      locked = false; storage = { ...storage, lock: "passphrase" };
      signIn("https://anarchy.chat", { display_name: "Maya Chen", username: "maya", tag: 427, color: "ocean", avatar: "🌊", usage: "freelance", onboarded: true });
    },
    set_passphrase: async ({ passphrase }) => { await wait(300); if (passphrase.length < 8) throw "Use at least 8 characters"; storage = { ...storage, lock: "passphrase" }; },
    workspace_info: async ({ server }) => {
      await wait(100);
      if (!server.trim()) throw "Enter your server address, for example chat.northwind.org";
      const host = server.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
      if (host === "chat.northwind.org") return { server: `https://${host}`, config: { org_name: "Northwind", issuer: "https://login.northwind.org", client_id: "anarchy", email_enabled: true, guests_enabled: true, open_signup: false, anonymous_enabled: false } };
      return { server: `https://${host}`, config: { org_name: "Anarchy Cloud", issuer: "https://accounts.google.com", client_id: "anarchy-desktop", email_enabled: true, guests_enabled: false, open_signup: true, sidekicks_hosted: true, anonymous_enabled: true, client_secret: "public" } };
    },
    sign_in_sso: ({ server }) => new Promise((ok, fail) => { window.__cancel = () => fail("Sign-in cancelled"); window.__previewFinishSso = () => { signIn(server); ok(); }; }),
    cancel_sign_in: async () => window.__cancel?.(),
    request_email_code: async () => { await wait(100); },
    discover_server: async ({ email }) => (email.toLowerCase().endsWith("@northwind.org") ? "https://chat.northwind.org" : null),
    sign_in_email: async ({ server, code }) => { await wait(100); if (code.replace(/\D/g, "") !== "482913") throw "That code isn't right"; signIn(server); },
    sign_in_anonymous: async ({ server, name }) => { signIn(server, { display_name: name || "Anonymous", username: "anon", tag: 5120, email: null, is_anonymous: true }); },
    join_as_guest: async () => { throw "This server doesn't allow guests"; },
    me: async () => profile,
    update_profile: async ({ update }) => {
      await wait(120);
      if (update.username !== undefined && !/^[a-z0-9_.]{2,32}$/.test(update.username)) throw "Usernames are 2 to 32 characters: letters, digits, _ and .";
      for (const [k, v] of Object.entries(update)) if (v !== undefined) profile[k] = (k === "avatar" && v === "") || (k === "sidekick" && !v.name) ? null : v;
      if (session) session.display_name = profile.display_name;
      return { ...profile };
    },
    set_appearance: async ({ display, frame }) => { appearance = { display, frame, chosen: true }; },
    set_notifications: async ({ prefs }) => { notifications = prefs; },
    sign_out: async () => { session = null; profile = null; },
    spaces: async () => (localMode ? [] : spaces),
    start_local: async ({ name }) => {
      await wait(120);
      localMode = true;
      profile = { user_id: "me", display_name: name, username: name.toLowerCase().split(" ")[0], tag: 0, color: "ember", avatar: null, usage: null, dm_policy: "spaces", dm_humans_only: false, email: null, is_guest: false, is_anonymous: false, onboarded: false, sidekick: null, presence: "auto" };
      return { ...profile };
    },
    rename_space: async ({ space, name }) => { const s = spaces.find((x) => x.id === space); s.name = name; return s; },
    leave_space: async ({ space }) => { spaces = spaces.filter((x) => x.id !== space); },
    notify: async () => {},
    new_form_keys: async () => ({ public_key: "PUB", private_key: "PRIV" }),
    create_form: async () => ({ id: "F1", url: "https://chat.studiochen.fr/f/F1#k3y" }),
    update_form: async () => {},
    revoke_form: async () => {},
    form_answers: async () => [],
    forget_form_answer: async () => {},
    create_space: async ({ name, kind }) => { const s = { id: `sp${spaces.length + 1}`, name, kind, role: "owner", members: 1, is_default: false }; spaces.push(s); return s; },
    join_space: async () => { throw "This invite code isn't valid; ask for a new one"; },
    create_space_invite: async ({ hours, maxUses }) => ({ code: "PQ4T-7HWN-K2XA-9MRD-3FZL-VE6B-YC", expires_at_ms: Date.now() + hours * 3600e3, max_uses: maxUses }),
    start_dm: async ({ handle: h }) => {
      await wait(150);
      const found = Object.values(people).find((p) => handle(p) === h.replace(/^@/, "").toLowerCase());
      if (!found) throw `${h.replace(/^@/, "")} isn't taking messages from you. Check the handle, or share a space with them first.`;
      return channels.find((c) => c.kind === "dm" && c.peer === found.user_id).id;
    },
    list_channels: async () => channels.filter((c) => (localMode ? c.kind === "personal" : c.id !== "dpip" || skChat)).map(view),
    sidekick_state: async ({ channel }) => {
      const c = channels.find((x) => x.id === channel);
      return { hosted: true, on: skOn.has(channel), blocked: c.trust === "company" ? null : "Sealed channels promise the server can't read them, so no sidekick can join." };
    },
    sidekick_join: async ({ channel }) => {
      await wait(150); skOn.add(channel);
      channels.find((x) => x.id === channel).messages.push({ sender: "ME", ts: Date.now(), text: `${profile.sidekick?.name || "My sidekick"}, my sidekick, can read this channel from now on, including what you say here. It runs on the server, so the server's operator could read it too. It only sees messages from now on.` });
    },
    heartbeat: async () => {},
    mail_status: async () => ({ email: mailOn ? "maya@studiochen.fr" : null, name: "Maya Chen" }),
    mail_list: async () => (mailOn ? mailbox : []),
    mail_sync: async () => { await wait(150); return mailOn ? mailbox : []; },
    mail_seen: async ({ uid, seen }) => { const m = mailbox.find((x) => x.uid === uid); if (m) m.seen = seen; },
    mail_send: async () => { await wait(200); },
    mail_preset: async ({ email }) => (email.includes("@") ? { imap_host: `imap.${email.split("@")[1]}`, imap_port: 993, smtp_host: `smtp.${email.split("@")[1]}`, smtp_port: 465, note: email.endsWith("gmail.com") ? "Gmail needs an app password: Google Account → Security → App passwords." : null, security: "tls" } : null),
    mail_find: async ({ email }) => { await wait(250); return email === "tomas@ruizstudio.es" ? peer("u2") : null; },
    mail_continue: async ({ email }) => { await wait(150); const c = channels.find((x) => x.kind === "dm" && x.peer === "u2"); mailLinked[email] = c.id; return c.id; },
    mail_links: async () => ({ ...mailLinked }),
    // Linking a phone: a code that looks like one, then a phone that claims it.
    phone_link_start: async () => {
      const w = 29, dark = [];
      const finder = (x, y) => [[0, 0], [w - 7, 0], [0, w - 7]].some(([fx, fy]) => {
        const dx = x - fx, dy = y - fy;
        if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return false;
        return dx === 0 || dy === 0 || dx === 6 || dy === 6 || (dx > 1 && dx < 5 && dy > 1 && dy < 5) || null;
      });
      let seed = 7;
      for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
        const f = finder(x, y);
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        dark.push(f === true ? true : f === null ? false : [[0, 7], [w - 8, 7], [0, w - 8]].some(([gx, gy]) => (x >= gx && x <= gx + 7 && y === gy) || (y >= (gy === 7 ? 0 : w - 8) && y <= (gy === 7 ? 7 : w - 1) && x === (gx === 0 ? 7 : w - 8))) ? false : seed % 5 < 2);
      }
      phonePolls = 0; phoneState = "open";
      return { id: "link-1", uri: "anarchy://link?server=demo&secret=demo", width: w, dark, expires_at_ms: Date.now() + 600000 };
    },
    phone_link_status: async () => {
      if (phoneState === "open" && ++phonePolls > 2) phoneState = "claimed";
      return { state: phoneState, label: phoneState === "open" ? null : "Pixel 8", expires_at_ms: Date.now() + 540000 };
    },
    phone_link_approve: async () => { phoneState = "done"; },
    phone_link_end: async () => { phoneState = "ended"; },
    mail_connect: async () => { await wait(300); mailOn = true; },
    mail_disconnect: async () => { mailOn = false; },
    sidekick_leave: async ({ channel }) => { skOn.delete(channel); },
    sidekick_chat: async () => { skChat = true; return "dpip"; },
    open_channel: async ({ channel }) => {
      open = channel;
      const c = channels.find((x) => x.id === channel);
      c.unread = false;
      return c.messages.map((m, i) => ({ seq: i + 1, sender: m.sender === "ME" ? me() : m.sender, mine: m.sender === "ME", ts_ms: m.ts, text: m.text, thread: m.thread ?? null, agent: m.agent ?? null, look: m.sender === "ME" ? null : lookOf(m.sender) }));
    },
    blur: async () => { open = null; },
    send_message: async ({ channel, text, thread }) => { await wait(120); channels.find((x) => x.id === channel).messages.push({ sender: "ME", ts: Date.now(), text, thread: thread ?? null }); },
    create_channel: async ({ space, name, topic, trust }) => { const id = `c${channels.length + 1}`; channels.push({ id, kind: "channel", space, name: name.trim().toLowerCase().replace(/\s+/g, "-"), topic, trust, unread: false, messages: [] }); return id; },
    create_desk: async ({ space, name }) => { const id = `k${channels.length + 1}`; channels.push({ id, kind: "channel", space, desk: "collections", name, trust: "company", unread: false, messages: [] }); return id; },
    desk_items: async ({ channel }) => (channel === "pp" ? prefsItems : channel === "k1" ? items : channel === "f1" ? driveItems : channel === "pa" ? agendaItems : channel === "pn" ? noteItems : channel === "kt" ? launchCards : channel === "pt" ? myCards : channel === "pf" ? myFiles : channel === "kw" ? wikiPages : []),
    ensure_personal: async ({ kind }) => ({ agenda: "pa", notes: "pn", files: "pf", tasks: "pt", prefs: "pp" })[kind],
    save_text_file: async () => { await wait(80); },
    ensure_drive: async () => "f1",
    pick_and_upload: async ({ folder }) => { driveItems.push(file(`x${driveItems.length + 10}`, "Q4 plan.pdf", folder, 540_000, "application/pdf", me(), 0)); return ["Q4 plan.pdf"]; },
    upload_dropped: async () => [],
    save_file_as: async () => true,
    preview_file: async ({ id }) => {
      const f = driveItems.find((i) => i.id === id);
      if (f.data.mime === "text/plain") return { kind: "text", data: "# Kickoff\n\n- Scope: rebrand + launch deck\n- Owners: Maya (lead), Ines (design), Tomás (deck)\n- First review: Friday 10:00\n" };
      if (f.data.mime.startsWith("image/")) {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#f6d8c4"/><stop offset="1" stop-color="#c2391a"/></linearGradient></defs><rect width="800" height="500" fill="url(#g)"/><circle cx="560" cy="220" r="120" fill="#fbeee3" opacity=".85"/><rect x="80" y="330" width="360" height="26" rx="6" fill="#1a1814" opacity=".85"/><rect x="80" y="370" width="240" height="18" rx="6" fill="#1a1814" opacity=".5"/></svg>';
        return { kind: "image", data: `data:image/svg+xml;base64,${btoa(svg)}` };
      }
      return { kind: "none", data: "" };
    },
    put_items: async ({ channel, items: put }) => { const list = channel === "pp" ? prefsItems : channel === "f1" ? driveItems : channel === "pa" ? agendaItems : channel === "pn" ? noteItems : channel === "kw" ? wikiPages : channel === "kt" ? launchCards : channel === "pt" ? myCards : items; for (const r of put) { const at = list.findIndex((i) => i.id === r.id); const item = { ...r, seq: 99, updated_ms: Date.now() }; if (at >= 0) list[at] = item; else list.unshift(item); } },
    pay_links: async () => payLinks,
    create_pay_link: async () => { const id = `L${payLinks.length + 1}`; payLinks.push({ id, expires_at_ms: now + 90 * 864e5, revoked: false, views: 0, last_viewed_at_ms: null, claimed_paid_at_ms: null }); return { id, url: `https://chat.studiochen.fr/p/${id}#k3y` }; },
    update_pay_link: async () => {},
    revoke_pay_link: async ({ id }) => { payLinks.find((l) => l.id === id).revoked = true; },
    mount_info: async () => ({ enabled: false, running: false, url: "", windows: "" }),
    set_mount: async ({ enabled }) => ({ enabled, running: enabled, url: enabled ? "http://127.0.0.1:45901/d13ed9effb5a42b3/Anarchy/" : "", windows: "" }),
    open_mount: async () => {},
    compose_email: async () => { window.__drafted = (window.__drafted || 0) + 1; },
    space_members: async () => ["u1", "u2", "u3", "u4"].map(peer).map((p, k) => (k === 0 ? { ...p, name: me(), handle: `${profile.username}#${String(profile.tag).padStart(4, "0")}`, color: profile.color, avatar: profile.avatar } : p)),
    search: async ({ query }) => {
      const q = query.toLowerCase(); const out = [];
      for (const c of channels) for (const [k, m] of c.messages.entries()) if (m.text.toLowerCase().includes(q)) out.push({ channel: c.id, what: "message", seq: k + 1, ts_ms: m.ts, by: m.sender === "ME" ? "You" : m.sender, text: m.text });
      for (const i of items) if (!["settings", "form"].includes(i.kind) && JSON.stringify(i.data).toLowerCase().includes(q)) out.push({ channel: "k1", what: "record", seq: i.seq, ts_ms: i.updated_ms, by: i.kind, text: ["number", "customer", "name", "contact", "what", "folder", "title", "date"].map((k) => i.data[k]).filter((v) => typeof v === "string").join(" · ") });
      for (const i of driveItems) if (i.kind === "file" && `${i.data.name} ${i.data.folder}`.toLowerCase().includes(q)) out.push({ channel: "f1", what: "record", seq: 1, ts_ms: i.data.added, by: "file", text: `${i.data.name} · ${i.data.folder}` });
      return out.sort((a, b) => b.ts_ms - a.ts_ms).slice(0, 40);
    },
    sync_all: async () => ({ new_messages: 0, joined: 0, removed: 0 }),
    people: async () => Object.values(people).map((p, i) => ({ user_id: p.user_id, name: p.display_name, handle: handle(p), email: null, is_guest: false, can_be_added: i !== 3, in_channel: i < 2, me: false })),
    channel_members: async () => [{ user_id: "me", name: me(), is_guest: false, me: true }, { user_id: "u2", name: "Tomás Ruiz", is_guest: false, me: false }, { user_id: "u3", name: "Ines Bauer", is_guest: false, me: false }],
    add_people: async () => [],
    remove_person: async () => {},
    devices: async () => [
      { device_id: "cb4148ab-32b3-4ded-943c-d1f04b01d3f4", created_at_ms: now - 3 * 864e5, revoked: false, this_device: true },
      { device_id: "9f02d1e7-5c11-4a7e-b0c4-2e6b8d7aa901", created_at_ms: now - 40 * 864e5, revoked: false, this_device: false },
    ],
    revoke_device: async () => {},
    create_invite: async () => { throw "Not on this server"; },
  };
  return {
    core: { invoke: async (cmd, args) => { if (!commands[cmd]) throw new Error(`The tour can't do that (${cmd})`); return commands[cmd](args ?? {}); } },
    event: { listen: async (name, cb) => { listeners[name] = cb; } },
  };
}

window.anarchyDemo = anarchyDemo;
