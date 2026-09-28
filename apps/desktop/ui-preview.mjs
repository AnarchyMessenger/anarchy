#!/usr/bin/env node
// Renders the desktop UI in Chromium with a mocked Tauri bridge and saves a
// screenshot of each onboarding step and the app shell. No Tauri build needed.
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

// A fake backend with the same command names and shapes as src-tauri/src/main.rs.
const mock = () => {
  let session = null;
  let appearance = { display: "light", frame: "cobalt" };
  let cancel = null;
  const listeners = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const commands = {
    app_status: async () => ({
      device_id: "cb4148ab-32b3-4ded-943c-d1f04b01d3f4",
      storage: { kind: "saved", path: "~/.local/share/org.anarchymessenger.desktop/device.db" },
      appearance, session,
    }),
    workspace_info: async ({ server }) => {
      await wait(150);
      if (!server.trim()) throw "Enter your workspace address, for example chat.northwind.org";
      if (server.includes("nope")) throw `Couldn't reach https://${server}. Check the address and your connection.`;
      return { server: `https://${server.trim()}`, config: { org_name: "Northwind", issuer: "https://sso.northwind.org", client_id: "anarchy-desktop", guests_enabled: true } };
    },
    sign_in_sso: ({ server }) => new Promise((ok, fail) => {
      cancel = () => fail("Sign-in cancelled");
      window.__previewFinishSso = () => { session = { server, org_name: "Northwind", is_guest: false, display_name: "Maya Chen", expires_at_ms: Date.now() + 864e5 }; ok(); };
    }),
    cancel_sign_in: async () => cancel?.(),
    join_as_guest: async ({ server, code, name }) => {
      await wait(150);
      if (code.startsWith("bad")) throw "this invite code isn't valid; ask for a new one";
      session = { server, org_name: "Northwind", is_guest: true, display_name: name, expires_at_ms: Date.parse("2026-10-05T17:00:00Z") };
    },
    set_appearance: async (a) => { appearance = a; },
    sign_out: async () => { session = null; },
  };
  window.__TAURI__ = {
    core: { invoke: (cmd, args) => commands[cmd](args ?? {}) },
    event: { listen: async (name, cb) => { listeners[name] = cb; } },
  };
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 780 }, deviceScaleFactor: 1 });
await page.addInitScript(mock);
await page.goto(pathToFileURL(join(here, "ui/index.html")).href);
const shot = async (name) => { await page.waitForTimeout(120); await page.screenshot({ path: join(out, `${name}.png`) }); console.log("saved", name); };

await shot("1-workspace");
await page.fill("#server", "nope.example");
await page.click("#server-continue");
await page.waitForSelector("#server-error:not([hidden])");
await shot("1b-workspace-error");
await page.fill("#server", "chat.northwind.org");
await page.click("#server-continue");
await page.waitForSelector("#step-2:not([hidden])");
await shot("2-join");
await page.click("#choose-sso");
await page.waitForSelector("#sso-waiting:not([hidden])");
await shot("2b-sso-waiting");
await page.click("#sso-cancel");
await page.waitForSelector("#join-choices:not([hidden])");
await page.click("#choose-guest");
await page.fill("#invite-code", "7qk2-mx9f-rt4w-a8cd-2hne-ypq6-kw");
await page.fill("#guest-name", "Léa (auditor)");
await shot("2c-guest");
await page.click("#guest-join");
await page.waitForSelector("#step-3:not([hidden])");
await page.click('.swatch[data-frame="dusk"]');
await shot("3-look-dusk");
await page.click('.swatch[data-frame="spring"]');
await shot("3-look-spring");
await page.click("#finish");
await page.waitForSelector("#app:not([hidden])");
await shot("4-app-guest");
await page.click('.rail-btn[data-view="settings"]');
await page.click('#settings-appearance [data-display="dark"]');
await page.click('#settings-appearance .swatch[data-frame="ocean"]');
await shot("5-settings-dark-ocean");
await page.click('#settings-appearance [data-display="luna"]');
await shot("6-settings-luna");
await browser.close();
