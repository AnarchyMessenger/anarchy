#!/usr/bin/env node
// Renders the desktop UI in Chromium with a mocked Tauri bridge and saves a
// screenshot of every screen: lock, sign-up and onboarding, Home, a DM, a space,
// dialogs and settings. No Tauri build needed.
//   NODE_PATH=$(npm root -g) node apps/desktop/ui-preview.mjs [out-dir]

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, "preview"));
mkdirSync(out, { recursive: true });

// A fake backend with the same command names and shapes as src-tauri/src/ops.rs.
const mock = (startLocked) => {
  const now = Date.now();
  const min = 60_000;
  let locked = startLocked;
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
    u2: { user_id: "u2", display_name: "Tomás Ruiz", username: "tomas", tag: 1881, color: "autumn", avatar: null },
    u3: { user_id: "u3", display_name: "Ines Bauer", username: "ines.b", tag: 42, color: "forest", avatar: null },
    u4: { user_id: "u4", display_name: "Léa Martin", username: "lea", tag: 9031, color: "dusk", avatar: "🪐" },
  };
  const handle = (p) => `${p.username}#${String(p.tag).padStart(4, "0")}`;
  const peer = (u) => ({ user_id: u, name: people[u].display_name, handle: handle(people[u]), color: people[u].color, avatar: people[u].avatar, is_guest: false, is_agent: false });
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
    { id: "c2", kind: "channel", space: "sp1", name: "invoices", topic: "What's out, what's paid", trust: "sealed", unread: true, messages: [
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
  const me = () => profile?.display_name || "You";
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
      appearance, notifications, last_server: null, session,
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
      return { server: `https://${server.trim()}`, config: { org_name: "Anarchy Cloud", issuer: "https://accounts.google.com", client_id: "anarchy-desktop", email_enabled: true, guests_enabled: false, open_signup: true, anonymous_enabled: true, client_secret: "public" } };
    },
    sign_in_sso: ({ server }) => new Promise((ok, fail) => { window.__cancel = () => fail("Sign-in cancelled"); window.__previewFinishSso = () => { signIn(server); ok(); }; }),
    cancel_sign_in: async () => window.__cancel?.(),
    request_email_code: async () => { await wait(100); },
    sign_in_email: async ({ server, code }) => { await wait(100); if (code.replace(/\D/g, "") !== "482913") throw "That code isn't right"; signIn(server); },
    sign_in_anonymous: async ({ server, name }) => { signIn(server, { display_name: name || "Anonymous", username: "anon", tag: 5120, email: null, is_anonymous: true }); },
    join_as_guest: async () => { throw "This server doesn't allow guests"; },
    me: async () => profile,
    update_profile: async ({ update }) => {
      await wait(120);
      if (update.username !== undefined && !/^[a-z0-9_.]{2,32}$/.test(update.username)) throw "Usernames are 2 to 32 characters: letters, digits, _ and .";
      for (const [k, v] of Object.entries(update)) if (v !== undefined) profile[k] = k === "avatar" && v === "" ? null : v;
      session.display_name = profile.display_name;
      return { ...profile };
    },
    set_appearance: async ({ display, frame }) => { appearance = { display, frame, chosen: true }; },
    set_notifications: async ({ prefs }) => { notifications = prefs; },
    sign_out: async () => { session = null; profile = null; },
    spaces: async () => spaces,
    create_space: async ({ name, kind }) => { const s = { id: `sp${spaces.length + 1}`, name, kind, role: "owner", members: 1, is_default: false }; spaces.push(s); return s; },
    join_space: async () => { throw "This invite code isn't valid; ask for a new one"; },
    create_space_invite: async ({ hours, maxUses }) => ({ code: "PQ4T-7HWN-K2XA-9MRD-3FZL-VE6B-YC", expires_at_ms: Date.now() + hours * 3600e3, max_uses: maxUses }),
    start_dm: async ({ handle: h }) => {
      await wait(150);
      const found = Object.values(people).find((p) => handle(p) === h.replace(/^@/, "").toLowerCase());
      if (!found) throw `${h.replace(/^@/, "")} isn't taking messages from you. Check the handle, or share a space with them first.`;
      return channels.find((c) => c.kind === "dm" && c.peer === found.user_id).id;
    },
    list_channels: async () => channels.map(view),
    open_channel: async ({ channel }) => {
      open = channel;
      const c = channels.find((x) => x.id === channel);
      c.unread = false;
      return c.messages.map((m, i) => ({ seq: i + 1, sender: m.sender === "ME" ? me() : m.sender, mine: m.sender === "ME", ts_ms: m.ts, text: m.text, thread: m.thread ?? null }));
    },
    blur: async () => { open = null; },
    send_message: async ({ channel, text, thread }) => { await wait(120); channels.find((x) => x.id === channel).messages.push({ sender: "ME", ts: Date.now(), text, thread: thread ?? null }); },
    create_channel: async ({ space, name, topic, trust }) => { const id = `c${channels.length + 1}`; channels.push({ id, kind: "channel", space, name: name.trim().toLowerCase().replace(/\s+/g, "-"), topic, trust, unread: false, messages: [] }); return id; },
    create_desk: async ({ space, name }) => { const id = `k${channels.length + 1}`; channels.push({ id, kind: "channel", space, desk: "collections", name, trust: "company", unread: false, messages: [] }); return id; },
    desk_items: async ({ channel }) => (channel === "k1" ? items : channel === "f1" ? driveItems : []),
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
    put_items: async ({ items: put }) => { for (const r of put) { const at = items.findIndex((i) => i.id === r.id); const item = { ...r, seq: 99, updated_ms: Date.now() }; if (at >= 0) items[at] = item; else items.unshift(item); } },
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
      for (const i of items) if (JSON.stringify(i.data).toLowerCase().includes(q)) out.push({ channel: "k1", what: "record", seq: i.seq, ts_ms: i.updated_ms, by: "invoice", text: `${i.data.number} · ${i.data.customer}` });
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
  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => { if (!commands[cmd]) throw new Error(`mock has no ${cmd}`); return commands[cmd](args ?? {}); } },
    event: { listen: async (name, cb) => { listeners[name] = cb; } },
  };
};

const browser = await chromium.launch();
const errors = [];
process.on("exit", () => { if (errors.length) console.error("page errors:\n" + errors.join("\n")); });
async function newPage(startLocked) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.addInitScript(mock, startLocked);
  await page.goto(pathToFileURL(join(here, "ui/index.html")).href);
  await page.evaluate(() => document.fonts.ready);
  return page;
}
let page = await newPage(false);
const shot = async (name) => { await page.waitForTimeout(160); await page.screenshot({ path: join(out, `${name}.png`) }); console.log("saved", name); };
const visible = (sel) => page.waitForSelector(`${sel}:not([hidden])`, { timeout: 5000 });
// The chats list pops over from the left; open it, pick, and it closes.
async function pick(list, name) {
  if (await page.isHidden("#drawer-chats")) await page.click("#tool-chats");
  await page.click(`${list} .side-item >> text="${name}"`);
}
const folder = (label) => page.click(`.folder >> text="${label}"`);

// Sign-up and onboarding.
await visible("#s-server");
await shot("01-server");
await page.fill("#server", "anarchy.chat");
await page.click("#server-continue");
await visible("#s-account");
await shot("02-create-account");
await page.fill("#email", "maya.chen@hey.com");
await page.click("#email-send");
await visible("#code-form");
await page.fill("#code", "111111");
await visible("#account-error");
await shot("03-code-wrong");
await page.click("#code-other");
await page.click("#to-anon");
await page.fill("#anon-name", "Night owl");
await shot("04-anonymous");
await page.click("#anon-back");
await page.fill("#email", "maya.chen@hey.com");
await page.click("#email-send");
await visible("#code-form");
await page.fill("#code", "482913");
await visible("#s-usage");
await page.click('.usage[data-usage="freelance"]');
await shot("05-usage");
await page.click("#usage-next");
await visible("#s-lock");
await page.fill("#pass1", "correct horse battery");
await page.fill("#pass2", "correct horse battery");
await shot("06-passphrase");
await page.click("#lock-set");
await visible("#s-card");
await page.fill("#card-name", "Maya Chen");
await page.fill("#card-user", "maya");
await page.click('#avatar-picker [data-avatar="🌊"]');
await page.click('#color-picker [data-color="ocean"]');
await shot("07-welcome-card");
await page.click("#card-save");
await visible("#app");

// Home and DMs.
await visible("#view-start");
await shot("08-home");
await page.fill("#start-dm", "tomas#1881");
await page.press("#start-dm", "Enter");
await visible("#view-convo");
await shot("09-dm");
await page.click("#tool-chats");
await shot("09b-chats-popover");
await page.click('.dm-item >> text="Léa Martin"');
await shot("10-dm-empty");
await page.click("#tool-people");
await visible("#drawer-people");
await shot("10b-people-home");
await page.keyboard.press("Escape");
await page.click("#tool-chats");
await page.click("#new-dm");
await page.fill("#dm-handle", "nobody#0001");
await page.click("#dm-open");
await visible("#dm-error");
await shot("11-new-message-refused");
await page.click("#dm-cancel");

// Spaces.
await page.click('.rail-btn.space[title="Studio Chen"]');
await visible("#view-space-empty");
await page.waitForTimeout(300);
await shot("12-space-overview");
await page.fill("#search", "acme");
await visible("#search-results");
await page.waitForTimeout(200);
await shot("12b-search");
await page.press("#search", "Escape");
await folder("Files");
await visible("#view-drive");
await page.waitForTimeout(200);
await shot("12c-drive");
await page.click('#drive-rows tr >> text="Clients"');
await page.click('#drive-rows tr >> text="Acme"');
await shot("12d-drive-folder");
await page.click('#drive-crumbs button >> text="Files"');
await page.click('#drive-rows tr >> text="moodboard-direction-2.png"');
await visible("#preview-body img");
await shot("12e-drive-preview");
await page.click("#preview-close");
await page.fill("#drive-search", "pdf");
await shot("12f-drive-search");
await page.fill("#drive-search", "");
await pick("#channel-list", "acme-rebrand");
await visible("#view-convo");
await page.fill("#message", "Deck cover looks great, shipping it to Acme today.");
await page.press("#message", "Enter");
await page.waitForTimeout(300);
await shot("13-channel");
await pick("#desk-list", "Collections");
await visible("#view-desk");
await page.waitForTimeout(250);
await shot("13b-desk");
await page.click('#desk-tabs button >> text="Overdue"');
await page.click("#check-all");
await shot("13c-desk-overdue-selected");
await page.click("#bulk-clear");
await page.click('#desk-tabs button >> text="All"');
await page.click("#new-invoice");
await page.fill("#inv-customer", "Common Goods");
await page.fill("#inv-email", "ap@commongoods.co");
await page.fill("#inv-amount", "1840");
await shot("13d-new-invoice");
await page.click("#invoice-save");
await page.waitForTimeout(250);
await page.click("#notes-brief");
await shot("13e-desk-after-add");
// A client pressed "I've paid" on a payment link.
const claimed = await page.evaluate(() => window.__addClaim());
await pick("#desk-list", "Collections");
await page.waitForTimeout(250);
await shot("13g-desk-client-says-paid");
await page.click(`#desk-rows tr >> text="${claimed}"`);
await visible("#inv-link");
await shot("13h-invoice-payment-link");
await page.click("#invoice-cancel");
await page.click("#desk-paydetails");
await shot("13i-payment-details");
await page.click("#paydetails-cancel");
await pick("#channel-list", "acme-rebrand");
await visible("#view-convo");
await page.fill("#message", "");
await page.type("#message", "Is Acme late again? @Col");
await visible("#mention-pop");
await shot("13j-mention-picker");
await page.press("#message", "Enter");
await page.press("#message", "Enter");
await page.waitForTimeout(300);
await shot("13k-desk-mention");
await page.click("#tool-ask");
await page.fill("#ask-input", "acme deck");
await page.press("#ask-input", "Enter");
await page.waitForTimeout(300);
await shot("13l-ask");
await pick("#channel-list", "acme-rebrand");
await page.click(".thread-sum");
await visible("#thread");
await page.fill("#thread-input", "Perfect, locking it.");
await page.press("#thread-input", "Enter");
await page.waitForTimeout(300);
await shot("13o-thread");
await page.click("#thread-close");
await page.click("#tool-chats");
await page.click("#side-space .drawer-pin");
await page.waitForTimeout(150);
await shot("13p-chats-pinned");
await page.click("#side-space .drawer-pin");
await page.click("#tool-people");
await page.waitForTimeout(300);
await shot("13q-people-space");
await page.keyboard.press("Escape");
await folder("Desks");
await page.waitForTimeout(150);
await folder("Desks");
await visible("#view-desks");
await page.waitForTimeout(300);
await shot("13r-desks");
await folder("Overview");
await page.click("#rail-me");
await shot("13m-me-popover");
await page.click("#me-settings");
await folder("Files on this computer");
await page.click("#m-enabled");
await page.waitForTimeout(150);
await shot("13n-files-on-this-computer");
await page.click('.rail-btn.space >> nth=0');
await pick("#desk-list", "Collections");
await visible("#view-desk");
await folder("Desks");
await visible("#view-desks");
await page.click("#desks-new");
await shot("13f-new-desk");
await page.click("#desk-cancel");
await page.click("#rail-add");
await page.fill("#space-new-name", "Family");
await page.check('input[name=space-kind][value="personal"]');
await shot("14-create-space");
await page.click("#space-cancel");
await page.click("#tool-people");
await page.click("#space-invite");
await page.click("#sp-create");
await visible("#sp-result");
await shot("15-space-invite");
await page.click("#sp-close");

// Settings.
await page.click("#rail-settings");
await visible('.page[data-page="profile"]');
await shot("16-settings-profile");
await folder("Privacy");
await page.check('input[name=dm-policy][value="anyone"]');
await page.check("#humans-only");
await shot("17-settings-privacy");
await folder("Account & device");
await shot("18-settings-account");
await folder("Appearance");
await page.click('#settings-appearance [data-display="dark"]');
await shot("19-appearance-dark");
await page.click("#rail-home");
await page.click("#tool-chats");
await page.click('.dm-item >> text="Tomás Ruiz"');
await shot("20-dm-dark");
await page.click("#rail-settings");
await folder("Appearance");
await page.click('#settings-appearance [data-display="luna"]');
await page.click('.rail-btn.space[title="Studio Chen"]');
await pick("#channel-list", "acme-rebrand");
await shot("21-channel-luna");
await page.close();

// Locked start.
page = await newPage(true);
await visible("#lock");
await shot("22-locked");
await page.fill("#lock-pass", "nope nope nope");
await page.click("#lock-submit");
await visible("#lock-error");
await page.fill("#lock-pass", "correct horse battery");
await page.click("#lock-submit");
await visible("#app");
await shot("23-unlocked-home");
await browser.close();
if (errors.length) { console.error("page errors:\n" + errors.join("\n")); process.exit(1); }
