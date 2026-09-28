#!/usr/bin/env node
// Renders the desktop UI in Chromium with a mocked Tauri bridge and saves a
// screenshot of each sign-in step, chat and settings page. No Tauri build needed.
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
const mock = () => {
  const now = Date.now();
  const min = 60_000;
  let session = null;
  let appearance = { display: "light", frame: "cobalt", chosen: false };
  let notifications = { desktop: true, mentions_only: false, previews: true };
  let cancel = null;
  let open = null;
  const listeners = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const people = [
    { user_id: "u1", name: "Maya Chen", email: "maya@northwind.org", is_guest: false, can_be_added: true },
    { user_id: "u2", name: "Tomás Ruiz", email: "tomas@northwind.org", is_guest: false, can_be_added: true },
    { user_id: "u3", name: "Ines Bauer", email: "ines@northwind.org", is_guest: false, can_be_added: true },
    { user_id: "u4", name: "Jonas Weber", email: "jonas@northwind.org", is_guest: false, can_be_added: false },
    { user_id: "u5", name: "Léa (auditor)", email: null, is_guest: true, can_be_added: true },
  ];
  const channels = [
    { id: "c1", name: "launch-planning", topic: "Q4 launch, owners and dates", trust: "sealed", members: ["u1", "u2", "u3"], unread: false, messages: [
      { sender: "Tomás Ruiz", ts: now - 26 * 60 * min, text: "Morning. Draft timeline is in the doc, dates still soft." },
      { sender: "Ines Bauer", ts: now - 25 * 60 * min, text: "Legal needs two weeks for the DPA review, so the 14th is the earliest." },
      { sender: "Maya Chen", ts: now - 42 * min, text: "Agreed on the 14th. Tomás, can you own the rollout checklist?" },
      { sender: "Tomás Ruiz", ts: now - 38 * min, text: "Yes. I'll post it here by Thursday." },
      { sender: "Tomás Ruiz", ts: now - 37 * min, text: "Also: the press embargo lifts at 09:00 CET, not 10:00." },
    ] },
    { id: "c2", name: "general", topic: "Company-wide", trust: "company", members: ["u1", "u2", "u3", "u5"], unread: true, messages: [
      { sender: "Ines Bauer", ts: now - 5 * min, text: "Office is closed Friday for the move. Remote day for everyone." },
    ] },
    { id: "c3", name: "design-review", topic: "", trust: "sealed", members: ["u1", "u3"], unread: false, messages: [] },
  ];
  const me = () => (session?.is_guest ? "u5" : "u1");
  const view = (c) => ({ id: c.id, name: c.name, topic: c.topic, trust: c.trust, unread: c.unread && c.id !== open, last_ts: c.messages.at(-1)?.ts ?? 0 });
  const signIn = (server, extra) => { session = { server, org_name: "Northwind", is_guest: false, display_name: "Maya Chen", email: "maya@northwind.org", expires_at_ms: now + 30 * 864e5, user_id: "u1", ...extra }; };
  const commands = {
    status: async () => ({
      device_id: "cb4148ab-32b3-4ded-943c-d1f04b01d3f4",
      storage: { kind: "saved", path: "~/.local/share/org.anarchymessenger.desktop/device.db" },
      appearance, notifications, last_server: null, session,
    }),
    workspace_info: async ({ server }) => {
      await wait(120);
      if (!server.trim()) throw "Enter your workspace address, for example chat.northwind.org";
      if (server.includes("nope")) throw `Couldn't reach https://${server}. Check the address and your connection.`;
      return { server: `https://${server.trim()}`, config: { org_name: "Northwind", issuer: "https://sso.northwind.org", client_id: "anarchy-desktop", email_enabled: true, guests_enabled: true } };
    },
    sign_in_sso: ({ server }) => new Promise((ok, fail) => {
      cancel = () => fail("Sign-in cancelled");
      setTimeout(() => listeners["sign-in-link"]?.({ payload: "https://sso.northwind.org/authorize?client_id=anarchy-desktop&code_challenge=…" }), 200);
      window.__previewFinishSso = () => { signIn(server); ok(); };
    }),
    cancel_sign_in: async () => cancel?.(),
    request_email_code: async ({ email }) => { await wait(120); if (!email.endsWith("@northwind.org")) throw "Northwind doesn't allow sign-in with that email address"; },
    sign_in_email: async ({ server, code }) => { await wait(120); if (code.replace(/\D/g, "") !== "482913") throw "That code is wrong or has expired"; signIn(server); },
    join_as_guest: async ({ server, code, name }) => {
      await wait(120);
      if (code.startsWith("bad")) throw "This invite code isn't valid; ask for a new one";
      signIn(server, { is_guest: true, display_name: name, email: null, expires_at_ms: Date.parse("2026-10-05T17:00:00Z"), user_id: "u5" });
    },
    set_appearance: async ({ display, frame }) => { appearance = { display, frame, chosen: true }; },
    set_notifications: async ({ prefs }) => { notifications = prefs; },
    sign_out: async () => { session = null; },
    list_channels: async () => channels.filter((c) => c.members.includes(me())).map(view),
    open_channel: async ({ channel }) => {
      open = channel;
      const c = channels.find((x) => x.id === channel);
      c.unread = false;
      return c.messages.map((m, i) => ({ seq: i + 1, sender: m.sender, mine: m.sender === session.display_name, ts_ms: m.ts, text: m.text }));
    },
    blur: async () => { open = null; },
    send_message: async ({ channel, text }) => { await wait(150); channels.find((x) => x.id === channel).messages.push({ sender: session.display_name, ts: Date.now(), text }); },
    create_channel: async ({ name, topic, trust }) => {
      const id = `c${channels.length + 1}`;
      channels.push({ id, name: name.trim().toLowerCase().replace(/\s+/g, "-"), topic, trust, members: [me()], unread: false, messages: [] });
      return id;
    },
    sync_all: async () => ({ new_messages: 0, joined: 0, removed: 0 }),
    people: async ({ channel }) => {
      const c = channels.find((x) => x.id === channel);
      return people.map((p) => ({ ...p, in_channel: c.members.includes(p.user_id), me: p.user_id === me() }));
    },
    channel_members: async ({ channel }) => channels.find((x) => x.id === channel).members.map((u) => {
      const p = people.find((x) => x.user_id === u);
      return { user_id: u, name: p.name, is_guest: p.is_guest, me: u === me() };
    }),
    add_people: async ({ channel, users }) => { channels.find((x) => x.id === channel).members.push(...users); return []; },
    remove_person: async ({ channel, user }) => { const c = channels.find((x) => x.id === channel); c.members = c.members.filter((u) => u !== user); },
    devices: async () => [
      { device_id: "cb4148ab-32b3-4ded-943c-d1f04b01d3f4", created_at_ms: now - 3 * 864e5, revoked: false, this_device: true },
      { device_id: "9f02d1e7-5c11-4a7e-b0c4-2e6b8d7aa901", created_at_ms: now - 40 * 864e5, revoked: false, this_device: false },
      { device_id: "41aa7c3d-0b9e-4f6d-9d12-7c3e5f8b2a10", created_at_ms: now - 90 * 864e5, revoked: true, this_device: false },
    ],
    revoke_device: async () => {},
    create_invite: async ({ hours, maxUses }) => ({ code: "7QK2-MX9F-RT4W-A8CD-2HNE-YPQ6-KW", expires_at_ms: Date.now() + hours * 3600e3, max_uses: maxUses }),
  };
  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => { if (!commands[cmd]) throw new Error(`mock has no ${cmd}`); return commands[cmd](args ?? {}); } },
    event: { listen: async (name, cb) => { listeners[name] = cb; } },
  };
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.addInitScript(mock);
await page.goto(pathToFileURL(join(here, "ui/index.html")).href);
const shot = async (name) => { await page.waitForTimeout(150); await page.screenshot({ path: join(out, `${name}.png`) }); console.log("saved", name); };
const visible = (sel) => page.waitForSelector(`${sel}:not([hidden])`, { timeout: 5000 });

await visible("#s-workspace");
await shot("01-workspace");
await page.fill("#server", "nope.example");
await page.click("#server-continue");
await visible("#server-error");
await shot("02-workspace-error");
await page.fill("#server", "chat.northwind.org");
await page.click("#server-continue");
await visible("#s-signin");
await shot("03-sign-in");
await page.click("#sso");
await visible("#sso-link-box");
await shot("04-sso-waiting");
await page.click("#sso-cancel");
await visible("#email-form");
await page.fill("#email", "maya@northwind.org");
await page.click("#email-send");
await visible("#code-form");
await page.fill("#code", "111111");
await visible("#signin-error");
await shot("05-code-wrong");
await page.click("#code-other");
await page.click("#to-guest");
await page.fill("#invite-code", "7qk2-mx9f-rt4w-a8cd-2hne-ypq6-kw");
await page.fill("#guest-name", "Léa (auditor)");
await shot("06-guest");
await page.click("#guest-back");
await page.fill("#email", "maya@northwind.org");
await page.click("#email-send");
await visible("#code-form");
await page.fill("#code", "482913");
await visible("#s-look");
await page.click('#auth-appearance .swatch[data-frame="dusk"]');
await shot("07-look-dusk");
await page.click("#look-done");
await visible("#app");
await visible("#channel");
await shot("08-chat");
await page.fill("#message", "Checklist draft is up, comments welcome.");
await page.press("#message", "Enter");
await page.waitForTimeout(300);
await shot("09-chat-sent");
await page.click("#ch-add");
await visible("#people-list .person");
await page.check('#people-list input[value="u5"]');
await shot("10-add-people");
await page.click("#people-add");
await page.click("#new-channel");
await page.fill("#ch-new-name", "Vendor contracts");
await page.fill("#ch-new-topic", "Renewals and negotiations");
await page.check('input[name=trust][value="sealed"]');
await shot("11-new-channel");
await page.click("#channel-create");
await page.waitForTimeout(200);
await shot("12-empty-channel");
await page.click('.rail-btn[data-view="settings"]');
await shot("13-settings-account");
await page.click('#side-settings [data-page="notifications"]');
await shot("14-settings-notifications");
await page.click('#side-settings [data-page="devices"]');
await visible("#device-list .list-row");
await shot("15-settings-devices");
await page.click('#side-settings [data-page="invites"]');
await page.click("#invite-form button[type=submit]");
await visible("#invite-result");
await shot("16-settings-invites");
await page.click('#side-settings [data-page="appearance"]');
await page.click('#settings-appearance [data-display="dark"]');
await page.click('#settings-appearance .swatch[data-frame="ocean"]');
await shot("17-appearance-dark-ocean");
await page.click('.rail-btn[data-view="chat"]');
await shot("18-chat-dark");
await page.click('.rail-btn[data-view="settings"]');
await page.click('#side-settings [data-page="appearance"]');
await page.click('#settings-appearance [data-display="luna"]');
await page.click('.rail-btn[data-view="chat"]');
await shot("19-chat-luna");
await page.setViewportSize({ width: 820, height: 700 });
await page.click('.rail-btn[data-view="settings"]');
await page.click("#sign-out");
await visible("#s-workspace");
await shot("20-narrow-sign-in");
await browser.close();
if (errors.length) { console.error("page errors:\n" + errors.join("\n")); process.exit(1); }
