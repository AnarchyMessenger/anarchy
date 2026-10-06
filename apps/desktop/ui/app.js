// Anarchy desktop UI: lock, sign-up and onboarding, Home (chats), spaces, settings.
// Talks to the Rust engine through Tauri commands (src-tauri/src/main.rs).
// Everything people type or receive goes in through textContent, never as HTML.

const $ = (id) => document.getElementById(id);
const tauri = window.__TAURI__;
// During the tour (D38) every command goes to the sample workspace in demo.js.
let tour = null;
const invoke = (cmd, args) => (tour ? tour.core.invoke(cmd, args) : tauri.core.invoke(cmd, args));
const media = window.matchMedia("(prefers-color-scheme: dark)");
const POLL_MS = 2500;
const COLORS = ["ember", "cobalt", "spring", "summer", "autumn", "winter", "coral", "ocean", "forest", "dusk"];
const AVATARS = ["", "🦊", "🐙", "🌊", "🔥", "🌿", "🪐", "🎧", "🧪", "🛠️", "📐", "🍋"];
const KIND_LABEL = { company: "Company", freelance: "Freelance", personal: "Personal", community: "Community" };
const USAGE_KIND = { work: "company", freelance: "freelance", personal: "personal", community: "community" };

let status = null;
let profile = null;
let appearance = { display: "system", frame: "ember", chosen: false };
let workspace = null; // { server, config } during sign-in
let pendingEmail = "";
let draft = {}; // onboarding choices
let spaces = [];
let channels = [];
let view = "home"; // home | space | settings
let currentSpace = null;
let current = null; // open channel id
let pollTimer = null;
let syncing = false;

// ---------- helpers ----------

function show(el, visible = true) { (typeof el === "string" ? $(el) : el).hidden = !visible; }
function setError(id, message) { $(id).textContent = message || ""; show(id, !!message); }
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    // Through the CSSOM: the app's CSP refuses style attributes.
    else if (k === "style") node.style.cssText = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
function initials(name) {
  const words = (name || "").split(/[\s._-]+/).map((w) => w.replace(/^[^\p{L}\p{N}]+/u, "")).filter(Boolean);
  return words.slice(0, 2).map((w) => [...w][0].toUpperCase()).join("") || "?";
}
// A stable colour for people and spaces that haven't picked one.
function colorFor(key) {
  let h = 0;
  for (const c of String(key)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
function avatarEl(name, { color, avatar, size, sidekick, presence } = {}) {
  const a = el("span", { class: `avatar${size ? ` ${size}` : ""}${avatar ? " emoji" : ""}`, "data-color": color || colorFor(name) });
  a.textContent = avatar || initials(name);
  // The person's sidekick rides on their picture, never replaces it.
  if (sidekick && size !== "xs") a.append(sidekickEl(sidekick, "badge"));
  // Presence sits top-right, clear of the sidekick (D35).
  if (presence && size !== "xs") a.append(el("span", { class: `presence-dot p-${presence}`, title: PRESENCE_LABEL[presence], "aria-label": PRESENCE_LABEL[presence] }));
  return a;
}
const PRESENCE_LABEL = { online: "Online", busy: "Busy, notifications held", away: "Away", offline: "Offline" };

// ---------- sidekicks ----------
// Each person's own agent (D30, D31). Its look is a shape on a colour; it's
// shown as a badge on its person's avatar, and with its own face on anything
// it writes, so nobody mistakes it for the person.
const SK_NAMES = ["Pip", "Nova", "Otto", "Juno", "Rook", "Mika", "Bix", "Lumen"];
// Drawing and the maker live in sidekick.js (D34). `state` is what it's doing.
function sidekickEl(sk, cls = "", state = "idle") {
  const n = el("span", { class: `sk ${cls}`.trim(), title: sk?.name ? `${sk.name}, a sidekick` : "Sidekick" });
  n.append(skSvg(sk?.look, state));
  return n;
}
function defaultSidekick() {
  // New sidekicks start as the Buddy with cat ears; the maker changes everything (D40).
  return { name: SK_NAMES[Math.floor(Math.random() * SK_NAMES.length)], look: skLook(SK_BUDDY) };
}
function fillAvatar(node, name, color, avatar) {
  node.dataset.color = color || colorFor(name);
  node.classList.toggle("emoji", !!avatar);
  node.textContent = avatar || initials(name);
}
function handleOf(p) { return p && p.username ? `${p.username}#${String(p.tag).padStart(4, "0")}` : ""; }
function hostOf(server) { return (server || "").replace(/^https?:\/\//, ""); }
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });
async function busy(button, label, fn) {
  // Keep the nodes themselves: re-parsing markup would drop listeners and inline styles.
  const old = [...button.childNodes];
  button.disabled = true;
  button.textContent = label;
  try { return await fn(); } finally { button.disabled = false; button.replaceChildren(...old); }
}
async function copy(text, button) {
  try { await navigator.clipboard.writeText(text); } catch { return; }
  if (button) { const old = [...button.childNodes]; button.textContent = "Copied"; setTimeout(() => button.replaceChildren(...old), 1400); }
}
function isCompanyServer() { return spaces.some((s) => s.is_default); }

// ---------- appearance ----------

function applyAppearance() {
  const theme = appearance.display === "system" ? (media.matches ? "dark" : "light") : appearance.display;
  document.documentElement.dataset.theme = theme;
  $("frame").dataset.frame = appearance.frame;
  for (const b of document.querySelectorAll("[data-display]")) b.setAttribute("aria-checked", String(b.dataset.display === appearance.display));
  for (const b of document.querySelectorAll(".swatch[data-frame]")) b.setAttribute("aria-checked", String(b.dataset.frame === appearance.frame));
}
async function setAppearance(change) {
  appearance = { ...appearance, ...change, chosen: true };
  applyAppearance();
  try { await invoke("set_appearance", { display: appearance.display, frame: appearance.frame }); } catch (e) { console.warn(e); }
}
function mountAppearance(container) {
  container.replaceChildren($("appearance-template").content.cloneNode(true));
  container.addEventListener("click", (e) => {
    const d = e.target.closest("[data-display]");
    const s = e.target.closest(".swatch[data-frame]");
    if (d) setAppearance({ display: d.dataset.display });
    if (s) setAppearance({ frame: s.dataset.frame });
  });
}
media.addEventListener("change", () => { if (appearance.display === "system") applyAppearance(); });

// ---------- identity card ----------

function paintCard(prefix, p) {
  const name = p.display_name || "You";
  $(`${prefix}card`).dataset.color = p.color || "ember";
  const av = $(`${prefix}card-avatar`);
  av.textContent = p.avatar || initials(name);
  if (p.sidekick) av.append(sidekickEl(p.sidekick, "badge"));
  $(`${prefix}card-name`).textContent = name;
  $(`${prefix}card-handle`).replaceChildren(`@${p.username || "you"}`, el("span", { text: `#${String(p.tag || 0).padStart(4, "0")}` }));
  $(`${prefix}card-kind`).textContent = p.is_anonymous ? "ANONYMOUS" : p.is_guest ? "GUEST" : (p.usage ? p.usage.toUpperCase() : "MEMBER");
  $(`${prefix}card-since`).textContent = `Since ${monthFmt.format(Date.now())}`;
}
// The sign-in screen's card (art-card-*) and the profile page's (p-card-*).
function paintArt(p) { paintCard("art-", { display_name: "You", username: "you", tag: 0, ...p }); }

function mountPickers(avatarBox, colorBox, get, set) {
  avatarBox.replaceChildren(...AVATARS.map((a) => el("button", {
    type: "button", role: "radio", class: a ? "" : "initials", "data-avatar": a, "aria-label": a || "Initials",
    onclick: () => set({ avatar: a }),
  }, a || initials(get().display_name))));
  colorBox.replaceChildren(...COLORS.map((c) => el("button", {
    type: "button", role: "radio", "data-color": c, "aria-label": c, title: c[0].toUpperCase() + c.slice(1),
    onclick: () => set({ color: c }),
  })));
}
function syncPickers(avatarBox, colorBox, p) {
  for (const b of avatarBox.children) {
    b.setAttribute("aria-checked", String((b.dataset.avatar || "") === (p.avatar || "")));
    if (!b.dataset.avatar) b.textContent = initials(p.display_name);
  }
  for (const b of colorBox.children) b.setAttribute("aria-checked", String(b.dataset.color === p.color));
}

// ---------- lock ----------

$("lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("lock-error", "");
  await busy($("lock-submit"), "Unlocking…", async () => {
    try { await invoke("unlock", { passphrase: $("lock-pass").value }); $("lock-pass").value = ""; await route(); }
    catch (err) { setError("lock-error", String(err)); $("lock-pass").select(); }
  });
});

// ---------- sign-in and onboarding ----------

const FLOW = ["s-account", "s-usage", "s-lock", "s-card"];
// A local account's first step stands in for signing in.
const FLOW_ALIAS = { "s-local": "s-account", "s-anon": "s-account", "s-guest": "s-account", "s-invite": "s-account", "s-server": "s-account" };
function authStep(id) {
  for (const s of document.querySelectorAll(".auth-step")) show(s, s.id === id);
  const at = FLOW.indexOf(FLOW_ALIAS[id] || id);
  $("steps").replaceChildren(...(at < 0 ? [] : FLOW.map((_, i) => el("i", { class: i <= at ? "on" : "" }))));
  const focus = { "s-local": "local-name", "s-server": "server", "s-invite": "invite-link", "s-guest": "invite-code", "s-anon": "anon-name", "s-lock": "pass1", "s-card": "card-name" }[id];
  if (focus) requestAnimationFrame(() => $(focus).focus());
  const notes = {
    "s-usage": "Nothing about how you use Anarchy leaves your account settings.",
    "s-lock": "Your passphrase never leaves this computer.",
    "s-card": "Your handle is how people find you. Nobody sees your email.",
  };
  $("art-note-text").textContent = notes[id] || "Messages are encrypted on your device. The server only relays them.";
}

function showAuth() {
  stopPolling();
  show("omnibox", false);
  show("starting", false); show("lock", false); show("app", false); show("auth");
  paintArt({});
  $("server").value = "";
  // Nothing here needs a server (D38): start on this computer, take a tour,
  // or sign in. Someone with a local account who's connecting skips this.
  if (connecting) { paintArt(profile || {}); openSignIn(); return; }
  authStep("s-welcome");
}
let connecting = false;
function openSignIn() {
  authStep("s-account");
  // The server you used last, or the public one.
  connect(status.last_server || status.default_server);
}
$("go-signin").addEventListener("click", openSignIn);
$("go-local").addEventListener("click", () => { setError("local-error", ""); authStep("s-local"); });
$("local-back").addEventListener("click", () => authStep("s-welcome"));
$("account-back").addEventListener("click", () => { if (connecting) { connecting = false; showApp(); } else authStep("s-welcome"); });
$("s-local").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("local-name").value.trim();
  if (!name) return setError("local-error", "Add a name. It can be just your first name.");
  await busy($("local-go"), "Starting…", async () => {
    try { await invoke("start_local", { name }); await afterSignIn(); }
    catch (err) { setError("local-error", String(err)); }
  });
});
// From inside the app: sign in to a server and bring the local account along.
function connectServer() {
  if (tour) return endTour();
  connecting = true;
  showAuth();
}
$("local-connect").addEventListener("click", connectServer);

// ---------- the tour (D38) ----------
async function startTour() {
  tour = anarchyDemo(true);
  await tour.core.invoke("unlock", { passphrase: "correct horse battery" });
  status = await invoke("status");
  show("tour-bar");
  document.body.classList.add("touring");
  await afterSignIn();
}
async function endTour() {
  tour = null;
  show("tour-bar", false);
  document.body.classList.remove("touring");
  // The sample data goes with the tour.
  mails = []; mailAcct = null; channels = []; spaces = []; profile = null; tabs = [];
  status = await invoke("status");
  showAuth();
}
$("go-tour").addEventListener("click", () => startTour().catch((e) => alert(String(e))));
$("tour-end").addEventListener("click", endTour);

// Loads a server's sign-in options. Failing to reach the default server
// leaves a way out (another server, an invite) rather than a dead end.
async function connect(server) {
  show("account-methods", false); show("server-loading");
  $("server-loading-host").textContent = hostOf(server);
  setError("account-error", "");
  try { workspace = await invoke("workspace_info", { server }); prepareAccount(); return true; }
  catch (err) {
    show("server-loading", false);
    for (const id of ["to-anon", "to-guest"]) show(id, false);
    $("org-server").textContent = hostOf(server);
    const pub = server === status.default_server;
    setError("account-error", pub
      ? "Anarchy's public server isn't open yet. Join with an invite or your company's server, or go back and start on this computer: you can connect later and keep everything."
      : `${err} You can use a different server, or an invite.`);
    return false;
  }
}

$("s-server").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("server-error", "");
  await busy($("server-continue"), "Checking…", async () => {
    try { workspace = await invoke("workspace_info", { server: $("server").value }); pendingNote = ""; prepareAccount(); }
    catch (err) { setError("server-error", String(err)); }
  });
});
$("server-back").addEventListener("click", () => authStep("s-account"));

// Invite links look like https://<server>/i/<code>; a bare code means this server.
let pendingSpaceCode = null;
let pendingNote = "";
function parseInvite(text) {
  const t = text.trim();
  const m = /^(https?:\/\/[^/\s]+)\/i\/([^\s/?#]+)/i.exec(t) || /^anarchy:\/\/join\?server=([^&\s]+)&code=([^&\s]+)/i.exec(t);
  if (m) return { server: decodeURIComponent(m[1]), code: decodeURIComponent(m[2]) };
  return { server: null, code: t };
}
$("to-invite").addEventListener("click", () => { setError("invite-error", ""); authStep("s-invite"); });
$("invite-back").addEventListener("click", () => authStep("s-account"));
$("s-invite").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { server, code } = parseInvite($("invite-link").value);
  if (!code) return setError("invite-error", "Paste the link or code you were given.");
  await busy($("invite-continue"), "Checking…", async () => {
    try {
      if (server && server !== workspace?.server) workspace = await invoke("workspace_info", { server });
      if (!workspace) throw new Error("Can't reach the server for that invite.");
      // Company servers take guests with a code; elsewhere a code joins a space once you have an account.
      if (workspace.config.guests_enabled) { $("invite-code").value = code; setError("guest-error", ""); authStep("s-guest"); return; }
      pendingSpaceCode = code;
      pendingNote = `Make an account or sign in on ${hostOf(workspace.server)}, and you'll join the space right after.`;
      prepareAccount();
    } catch (err) { setError("invite-error", String(err).replace(/^Error: /, "")); }
  });
});

function prepareAccount() {
  const c = workspace.config;
  const google = /accounts\.google\.com/.test(c.issuer || "");
  show("server-loading", false); show("account-methods");
  const isDefault = workspace.server === status.default_server;
  $("account-title").textContent = connecting ? `Connect ${c.org_name}` : c.open_signup ? "Welcome to Anarchy" : `Sign in to ${c.org_name}`;
  $("account-sub").textContent = connecting
    ? "Sign in or make an account there. Everything on this computer moves into it: your tasks, notes, agenda, files and sidekick."
    : c.open_signup
      ? "Messages are encrypted on this computer before they leave it. New here or coming back, it's the same step."
      : "Use the account your organisation gave you.";
  $("account-note").textContent = pendingNote;
  show("account-note", !!pendingNote);
  $("change-server").textContent = isDefault ? "Use a different server" : "Change";
  $("org-server").textContent = hostOf(workspace.server);
  $("guest-org").textContent = c.org_name;
  $("sso-label").textContent = google ? "Continue with Google" : `Continue with ${c.org_name} SSO`;
  $("sso-icon").replaceChildren(icon(google ? "google" : "key").firstChild);
  $("email").placeholder = c.open_signup ? "you@example.com" : "you@work-address";
  show("sso", !!c.issuer);
  show("email-form", c.email_enabled);
  show("or", !!c.issuer && c.email_enabled);
  show("code-form", false);
  show("sso-waiting", false);
  show("to-anon", !!c.anonymous_enabled);
  show("to-guest", c.guests_enabled);
  show("no-method", !c.issuer && !c.email_enabled && !c.anonymous_enabled);
  setError("account-error", "");
  authStep("s-account");
}

$("change-server").addEventListener("click", () => { $("server").value = workspace && workspace.server !== status.default_server ? hostOf(workspace.server) : ""; setError("server-error", ""); authStep("s-server"); });

$("sso").addEventListener("click", async () => {
  setError("account-error", "");
  for (const id of ["sso", "or", "email-form"]) show(id, false);
  show("sso-waiting");
  try { await invoke("sign_in_sso", { server: workspace.server }); await afterSignIn(); }
  catch (err) { prepareAccount(); if (String(err) !== "Sign-in cancelled") setError("account-error", String(err)); }
});
$("sso-cancel").addEventListener("click", () => invoke("cancel_sign_in"));
tauri?.event?.listen("sign-in-link", (event) => { $("sso-link").textContent = event.payload; show("sso-link-box"); });
$("sso-copy").addEventListener("click", () => copy($("sso-link").textContent, $("sso-copy")));

$("email-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  pendingEmail = $("email").value.trim();
  if (!pendingEmail) return setError("account-error", "Enter your email address.");
  setError("account-error", "");
  await busy($("email-send"), "Sending…", async () => {
    try {
      // A work email can point to the company's own server (…/.well-known/anarchy.json).
      const own = pendingSpaceCode ? null : await invoke("discover_server", { email: pendingEmail }).catch(() => null);
      if (own && own !== workspace.server) {
        workspace = await invoke("workspace_info", { server: own });
        const domain = pendingEmail.split("@")[1];
        pendingNote = `${domain} has its own Anarchy server, ${hostOf(own)}. You'll sign in there.`;
        prepareAccount();
        $("email").value = pendingEmail;
        if (!workspace.config.email_enabled) return; // SSO only: the button is there now
      }
      await invoke("request_email_code", { server: workspace.server, email: pendingEmail });
      $("sent-to").textContent = pendingEmail;
      for (const id of ["email-form", "sso", "or"]) show(id, false);
      show("code-form");
      $("code").value = "";
      requestAnimationFrame(() => $("code").focus());
    } catch (err) { setError("account-error", String(err)); }
  });
});
$("code").addEventListener("input", () => {
  const digits = $("code").value.replace(/\D/g, "").slice(0, 6);
  $("code").value = digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
  if (digits.length === 6) $("code-form").requestSubmit();
});
$("code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("account-error", "");
  await busy($("code-submit"), "Checking…", async () => {
    try { await invoke("sign_in_email", { server: workspace.server, email: pendingEmail, code: $("code").value }); await afterSignIn(); }
    catch (err) { setError("account-error", String(err)); $("code").select(); }
  });
});
$("code-resend").addEventListener("click", async () => {
  try { await invoke("request_email_code", { server: workspace.server, email: pendingEmail }); setError("account-error", ""); $("code").focus(); }
  catch (err) { setError("account-error", String(err)); }
});
$("code-other").addEventListener("click", prepareAccount);

$("to-anon").addEventListener("click", () => { setError("anon-error", ""); authStep("s-anon"); });
$("anon-back").addEventListener("click", () => authStep("s-account"));
$("s-anon").addEventListener("submit", async (e) => {
  e.preventDefault();
  await busy($("anon-go"), "Creating…", async () => {
    try { await invoke("sign_in_anonymous", { server: workspace.server, name: $("anon-name").value }); await afterSignIn(); }
    catch (err) { setError("anon-error", String(err)); }
  });
});

$("to-guest").addEventListener("click", () => { setError("guest-error", ""); authStep("s-guest"); });
$("guest-back").addEventListener("click", () => authStep("s-account"));
$("s-guest").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("invite-code").value.trim();
  const name = $("guest-name").value.trim();
  if (!code) return setError("guest-error", "Enter the invite code you were given.");
  if (!name) return setError("guest-error", "Enter a name so people know who you are.");
  await busy($("guest-join"), "Joining…", async () => {
    try { await invoke("join_as_guest", { server: workspace.server, code, name }); await afterSignIn(); }
    catch (err) { setError("guest-error", String(err)); }
  });
});

async function afterSignIn() {
  connecting = false;
  status = await invoke("status");
  profile = status.profile;
  if (profile?.onboarded) return showApp();
  draft = { usage: profile?.usage || null, display_name: profile?.display_name || "", username: profile?.username || "", tag: profile?.tag || 0, color: profile?.color || "ember", avatar: profile?.avatar, sidekick: profile?.sidekick || "" };
  paintArt({ ...profile, ...draft });
  try { spaces = await invoke("spaces"); } catch { spaces = []; }
  // Company servers already know what it's for; guests don't pick.
  if (isCompanyServer() || profile?.is_guest) { draft.usage = profile?.is_guest ? null : "work"; return toLockStep(); }
  authStep("s-usage");
  for (const b of document.querySelectorAll(".usage")) b.setAttribute("aria-checked", String(b.dataset.usage === draft.usage));
  $("usage-next").disabled = !draft.usage;
}

for (const b of document.querySelectorAll(".usage")) {
  b.addEventListener("click", () => {
    draft.usage = b.dataset.usage;
    for (const o of document.querySelectorAll(".usage")) o.setAttribute("aria-checked", String(o === b));
    $("usage-next").disabled = false;
    paintArt({ ...profile, ...draft });
  });
}
$("usage-next").addEventListener("click", toLockStep);

function toLockStep() {
  const s = status.storage;
  if (s.kind === "saved" && s.lock === "passphrase") return toCardStep();
  $("lock-why").textContent = s.kind === "temporary"
    ? "This computer has no keychain Anarchy can use, so without a passphrase this device is forgotten when you quit."
    : "Your keys and history live on this computer, encrypted. A passphrase means nobody opens Anarchy here without you.";
  $("lock-skip").textContent = s.kind === "temporary" ? "Continue without saving" : "Skip, the keychain is enough";
  $("pass1").value = ""; $("pass2").value = ""; meter();
  setError("pass-error", "");
  authStep("s-lock");
}
function strength(p) {
  let score = Math.min(p.length / 16, 1) * 3;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score += .5;
  if (/\d/.test(p)) score += .5;
  if (/[^\w]|\s/.test(p)) score += .5;
  if (/\s/.test(p.trim()) && p.length >= 14) score += 1;
  return Math.min(score / 4, 1);
}
function meter() {
  const p = $("pass1").value;
  const s = strength(p);
  $("meter-bar").style.width = `${Math.max(s, p ? .08 : 0) * 100}%`;
  $("meter-bar").style.background = s < .45 ? "var(--danger)" : s < .75 ? "var(--highlight)" : "var(--sealed)";
  $("meter-text").textContent = !p ? "Three or four unrelated words work well." : p.length < 8 ? "Too short." : s < .45 ? "Easy to guess." : s < .75 ? "Fair. Longer is better." : "Strong.";
}
$("pass1").addEventListener("input", meter);
$("s-lock").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p1 = $("pass1").value, p2 = $("pass2").value;
  if (p1.length < 8) return setError("pass-error", "Use at least 8 characters.");
  if (p1 !== p2) return setError("pass-error", "The two don't match.");
  await busy($("lock-set"), "Securing…", async () => {
    try { await invoke("set_passphrase", { passphrase: p1 }); status = await invoke("status"); toCardStep(); }
    catch (err) { setError("pass-error", String(err)); }
  });
});
$("lock-skip").addEventListener("click", toCardStep);

function toCardStep() {
  $("card-name").value = draft.display_name;
  $("card-user").value = draft.username;
  $("card-tag").textContent = status.local ? "#····" : `#${String(draft.tag).padStart(4, "0")}`;
  // A local account gets its number from the server it connects to (D38).
  $("card-local-note").hidden = !status.local;
  mountPickers($("avatar-picker"), $("color-picker"), () => draft, (c) => { Object.assign(draft, c); refreshCard(); });
  refreshCard();
  setError("card-error", "");
  authStep("s-card");
}
function refreshCard() {
  draft.display_name = $("card-name").value;
  draft.username = $("card-user").value.toLowerCase();
  $("card-hint-name").textContent = draft.username || "you";
  syncPickers($("avatar-picker"), $("color-picker"), draft);
  paintArt({ ...profile, ...draft });
  $("frame").dataset.frame = draft.color; // the window follows the card
}
$("card-name").addEventListener("input", refreshCard);
$("card-user").addEventListener("input", refreshCard);
$("s-card").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!draft.display_name.trim()) return setError("card-error", "Add a name.");
  await busy($("card-save"), "Saving…", async () => {
    try {
      profile = await invoke("update_profile", { update: {
        display_name: draft.display_name.trim(), username: draft.username.trim(), color: draft.color,
        avatar: draft.avatar || "", usage: draft.usage || undefined,
      } });
      await setAppearance({ frame: draft.color });
      toSidekickStep();
    } catch (err) { setError("card-error", String(err)); }
  });
});

function toSidekickStep() {
  draft.sidekick = profile?.sidekick || draft.sidekick || defaultSidekick(draft);
  $("sk-name").value = draft.sidekick.name;
  mountSidekickMaker($("sk-maker"), () => draft.sidekick, (look) => { draft.sidekick.look = look; });
  paintArt({ ...profile, ...draft });
  setError("sk-error", "");
  $("auth").classList.add("making");
  authStep("s-sidekick");
}
$("sk-name").addEventListener("input", () => { draft.sidekick.name = $("sk-name").value; });
async function finishOnboarding(sidekick) {
  $("auth").classList.remove("making");
  profile = await invoke("update_profile", { update: { onboarded: true, ...(sidekick ? { sidekick } : {}) } });
  status = await invoke("status");
  showApp();
}
$("s-sidekick").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("sk-name").value.trim();
  if (!name) return setError("sk-error", "Give it a name, or skip for now.");
  await busy($("sk-save"), "Saving…", async () => {
    try { await finishOnboarding({ name, look: draft.sidekick.look }); } catch (err) { setError("sk-error", String(err)); }
  });
});
$("sk-skip").addEventListener("click", async () => {
  draft.sidekick = null; paintArt({ ...profile, ...draft, sidekick: null });
  try { await finishOnboarding(null); } catch (err) { setError("sk-error", String(err)); }
});

// ---------- app ----------

async function showApp() {
  profile = status.profile || profile;
  show("starting", false); show("lock", false); show("auth", false); show("app");
  show("omnibox");
  paintMe();
  beat();
  // A local account (D38): what needs a server says so, and offers to connect one.
  show("local-banner", !!status.local && !tour);
  // Messaging someone, making or joining a space: all need a server.
  for (const n of document.querySelectorAll("#view-start .start-grid")) show(n, !status.local);
  show("me-connect", !!status.local);
  try { spaces = await invoke("spaces"); } catch { spaces = []; }
  loadOrg();
  loadMail().then(() => syncMail());
  if (status.session?.server) invoke("workspace_info", { server: status.session.server }).then((w) => { skHosted = !!w.config?.sidekicks_hosted; paintAskHead(); }).catch(() => {});
  renderRail();
  go("home");
  await refreshChannels();
  startPolling();
  startReminders();
  if (pendingSpaceCode) {
    const code = pendingSpaceCode; pendingSpaceCode = null; pendingNote = "";
    try { const sp = await invoke("join_space", { code }); spaces = await invoke("spaces"); openSpace(spaces.find((x) => x.id === sp.id) || sp); }
    catch (err) { alert(`Couldn't join with that invite: ${err}`); }
  }
  refreshDeskNeeds().then(renderTabs);
  // Brings the local file share back up if it was on.
  invoke("mount_info").then((m) => { mount = m; }).catch(() => {});
  // The agent bridge comes back on after unlock if it was on (D43).
  invoke("bridge_info").then((b) => { bridgeInfo = b; }).catch(() => {});
}

// ---------- presence (D35) ----------
// You choose Online (automatic), Busy, Away or Invisible. While automatic, the
// app checks in once a minute when you've used it in the last five minutes, so
// leaving the computer turns you away on its own. Busy holds notifications.
let lastInput = Date.now();
for (const ev of ["pointerdown", "keydown", "pointermove", "wheel"]) addEventListener(ev, () => { const was = idle(); lastInput = Date.now(); if (was) { beat(); paintMe(); } }, { passive: true });
function idle() { return Date.now() - lastInput > 5 * 60e3 || document.hidden; }
function myPresence() {
  const c = profile?.presence || "auto";
  return c === "busy" ? "busy" : c === "away" ? "away" : c === "invisible" ? "offline" : idle() ? "away" : "online";
}
async function beat() { if (!idle() && status?.session) { try { await invoke("heartbeat"); } catch { /* offline: fine */ } } }
setInterval(() => { beat(); if (profile) paintMe(); }, 60e3);
document.addEventListener("visibilitychange", () => { if (!document.hidden) beat(); });
async function setPresence(choice) {
  try { profile = await invoke("update_profile", { update: { presence: choice } }); paintMe(); }
  catch (err) { alert(String(err)); }
}
for (const b of document.querySelectorAll("#me-presence [data-p]")) b.addEventListener("click", () => setPresence(b.dataset.p));

function paintMe() {
  const p = profile || { display_name: status.session?.display_name || "You" };
  const name = p.display_name || "You";
  paintAskHead();
  $("rail-me").replaceChildren(avatarEl(name, { color: p.color, avatar: p.avatar, sidekick: p.sidekick, presence: myPresence() }));
  for (const b of document.querySelectorAll("#me-presence [data-p]")) b.setAttribute("aria-checked", String(b.dataset.p === (p.presence || "auto")));
  $("share-handle").textContent = handleOf(p) ? `@${handleOf(p)}` : "";
  $("me-name").textContent = name;
  $("me-avatar").replaceChildren(avatarEl(name, { color: p.color, avatar: p.avatar, sidekick: p.sidekick }));
  $("share-policy").textContent = p.dm_policy === "anyone" ? "Anyone with it can message you." : "Only people in your spaces can message you.";
  const kind = USAGE_KIND[p.usage];
  $("start-create-sub").textContent = kind === "freelance" ? "A place for clients and projects." : kind === "personal" ? "For friends and family." : kind === "community" ? "For a group, club or server." : "Channels and people, for one purpose.";
}

function renderRail() {
  $("rail-spaces").replaceChildren(...spaces.map((s) => {
    const b = el("button", { class: `rail-btn space${view === "space" && currentSpace?.id === s.id ? " active" : ""}`, "data-color": colorFor(s.id), title: s.name, "aria-label": s.name, onclick: () => openSpace(s) }, initials(s.name));
    return b;
  }));
  $("rail-home").classList.toggle("active", view === "home");
  $("rail-me").classList.toggle("active", view === "settings");
}

function go(which) {
  view = which;
  chatsHint = false;
  closeDrawers();
  renderRail();
  if (which === "settings") {
    hideMain();
    show("view-settings");
    invoke("blur");
    settingsPage("profile");
    return;
  }
  show("view-settings", false);
  show("view-desk", false);
  renderSide();
  renderHomeSpaces();
  const inView = current && channels.find((c) => c.id === current && belongsHere(c));
  if (inView) openChannel(current);
  else { current = null; invoke("blur"); showStart(); }
}
function belongsHere(c) {
  return view === "home" ? c.kind === "dm" : view === "space" && c.kind === "channel" && c.space === currentSpace?.id;
}
function hideMain() {
  for (const v of ["view-start", "view-convo", "view-space-empty", "view-desk", "view-drive", "view-settings", "view-agenda", "view-notes", "view-board", "view-spaceset"]) show(v, false);
  show("view-desks", false);
  show("view-inbox", false);
}
function showStart() {
  hideMain();
  show("view-start", view === "home");
  if (view === "home") renderHomeToday();
  show("view-space-empty", view === "space");
  markNav();
  if (view === "space") renderSpaceOverview();
}
// The "Overview" row is active whenever nothing more specific is open.
function markNav() { renderFolders(); }
function openSpace(s) {
  currentSpace = s;
  current = null;
  go("space");
}
$("rail-home").addEventListener("click", () => go("home"));
// The person's card: name, handle to share, and a way into settings.
function toggleMe(open) {
  const on = open ?? $("me-pop").hidden;
  show("me-pop", on);
  $("rail-me").setAttribute("aria-expanded", String(on));
}
$("rail-me").addEventListener("click", (e) => { e.stopPropagation(); toggleMe(); });
document.addEventListener("click", (e) => { if (!$("me-pop").hidden && !$("me-pop").contains(e.target)) toggleMe(false); });
$("me-profile").addEventListener("click", () => { toggleMe(false); go("settings"); });
$("me-privacy").addEventListener("click", () => { toggleMe(false); go("settings"); settingsPage("privacy"); });
$("me-settings").addEventListener("click", () => { toggleMe(false); go("settings"); });
$("share-copy").addEventListener("click", (e) => { e.stopPropagation(); copy(`@${handleOf(profile)}`, $("share-copy")); });

// Lists

async function refreshChannels() {
  channels = await invoke("list_channels");
  renderSide();
  renderTabs();
  renderHomeSpaces();
  const dmUnread = channels.some((c) => c.kind === "dm" && c.unread && c.id !== current);
  show("home-dot", dmUnread);
}
function renderSide() {
  const dms = channels.filter((c) => c.kind === "dm");
  $("dm-list").replaceChildren(...dms.map((c) => {
    const unread = c.unread && c.id !== current;
    return el("button", { class: `side-item dm-item${c.id === current ? " active" : ""}${unread ? " unread" : ""}`, "data-id": c.id, onclick: () => openChannel(c.id).then(() => composer.focus()) },
      peerFace(c),
      el("span", { class: "lines" }, el("strong", { text: c.name }), el("small", { text: c.last_text || (c.peer?.handle ? `@${c.peer.handle}` : "") })),
      unread ? el("span", { class: "unread-dot", "aria-label": "unread" }) : null);
  }));
  show("no-dms", dms.length === 0);
  if (view === "space" && currentSpace) {
    const desks = channels.filter((c) => c.kind === "channel" && c.space === currentSpace.id && c.desk && c.desk !== "files");
    const list = channels.filter((c) => c.kind === "channel" && c.space === currentSpace.id && !c.desk);
    const row = (c) => {
      const unread = c.unread && c.id !== current;
      return foldDraggable(el("button", { class: `side-item${c.id === current ? " active" : ""}${unread ? " unread" : ""}`, "data-id": c.id, onclick: () => openChannel(c.id).then(() => composer.focus()) },
        el("span", { class: "hash", text: "#" }), el("span", { class: "name", text: c.name }), unread ? el("span", { class: "unread-dot" }) : null,
        el("span", { class: "fold-move", role: "button", tabindex: "0", title: "Move to a folder", "aria-label": `Move #${c.name} to a folder`, onclick: (e) => { e.stopPropagation(); openFoldMenu(e.currentTarget, "channels", c.id); } }, icon("folder"))), c.id);
    };
    const { folders, loose } = foldGroups("channels", list);
    $("channel-list").replaceChildren(
      ...folders.map((f) => {
        const kids = f.items.map((id) => list.find((c) => c.id === id)).filter(Boolean);
        const unread = kids.some((c) => c.unread && c.id !== current);
        // A closed folder still shows the conversation you're in.
        const shown = f.open ? kids : kids.filter((c) => c.id === current);
        return el("div", { class: `fold${f.open ? " open" : ""}` }, foldHead("channels", f, kids.length, unread), el("div", { class: "fold-body" }, ...shown.map(row)));
      }),
      ...loose.map(row));
    show("no-channels", list.length === 0);
    foldDropTarget($("channels-group"), "channels", null);
  }
}

// Conversation

async function openChannel(id) {
  const c = channels.find((x) => x.id === id);
  if (!c) return;
  if (thread && thread.channel !== id) closeThread();
  current = id;
  // Agenda and Notes are folders already; they don't need a tab too.
  if (c.kind !== "personal") addTab({ channel: id });
  markNav();
  if (c.desk === "files") return openDrive(c);
  if (c.desk === "agenda") return openAgenda();
  if (c.desk === "notes") return openNotes();
  if (c.desk === "pages") return openNotes(undefined, c);
  if (c.desk === "tasks") return openBoard(c);
  if (c.desk) return openDesk(c);
  hideMain(); show("view-convo");
  const dm = c.kind === "dm";
  const agent = dm && c.peer?.is_agent;
  show("convo-avatar", dm && !agent);
  show("convo-sk-face", agent);
  if (agent) $("convo-sk-face").replaceChildren(sidekickEl(profile?.sidekick || { look: "orb-ocean" }, "msg-face"));
  else if (dm) fillAvatar($("convo-avatar"), c.name, c.peer?.color, c.peer?.avatar);
  $("convo-name").textContent = dm ? c.name : `# ${c.name}`;
  $("convo-topic").textContent = dm ? (c.peer?.handle ? `@${c.peer.handle}` : "") : c.topic;
  const trust = $("convo-trust");
  // Your sidekick runs on the server, so this conversation isn't only yours (D32).
  if (agent) { trust.className = "ax-seal server"; trust.replaceChildren(icon("building"), "Runs on the server"); }
  else if (dm) { trust.className = "ax-seal sealed"; trust.replaceChildren(icon("lock"), "Only you two"); }
  else { trust.className = `ax-seal ${c.trust === "company" ? "server" : "sealed"}`; trust.replaceChildren(icon(c.trust === "company" ? "building" : "lock"), c.trust === "company" ? "Company" : "Sealed"); }
  show("convo-add", !dm && !profile?.is_guest);
  show("convo-members", !dm);
  composer.placeholder = dm ? `Message ${c.name}` : `Message #${c.name}`;
  fitComposer();
  for (const b of document.querySelectorAll(".side-item[data-id]")) b.classList.toggle("active", b.dataset.id === id);
  const messages = await invoke("open_channel", { channel: id });
  if (!dm) invoke("channel_members", { channel: id }).then((m) => { $("convo-count").textContent = String(m.length); });
  paintSidekickToggle(dm ? null : c);
  renderMessages(messages, c);
  renderThread();
  refreshChannels();
}

function renderMessages(messages, c) {
  convo = { channel: c, messages };
  const t = $("transcript");
  const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 40;
  const rows = [];
  const threads = threadsOf(messages);
  const known = new Set(messages.map((m) => m.seq));
  const placed = new Set();
  let lastDay = "", lastSender = "", lastTs = 0;
  for (const m of messages) {
    const day = dayFmt.format(m.ts_ms);
    if (m.thread != null) {
      // Replies live in their thread. One whose first message is from before
      // this person joined (unreadable to them) gets a stand-in row instead.
      if (known.has(m.thread) || placed.has(m.thread)) continue;
      placed.add(m.thread);
      if (day !== lastDay) { rows.push(el("div", { class: "day", text: day })); lastDay = day; }
      rows.push(el("div", { class: "msg orphan" }, el("span", { class: "orphan-mark" }, icon("thread")),
        el("div", {}, el("p", { class: "fine", text: "Replies to a message from before you joined" }), threadSummary(c, m.thread, threads.get(m.thread)))));
      lastSender = "";
      continue;
    }
    if (day !== lastDay) { rows.push(el("div", { class: "day", text: day })); lastDay = day; lastSender = ""; }
    const cont = m.sender === lastSender && m.ts_ms - lastTs < 5 * 60 * 1000 && !threads.has(lastSeqOf(rows));
    const look = m.mine ? { color: profile?.color, avatar: profile?.avatar, sidekick: profile?.sidekick } : c.kind === "dm" ? { color: c.peer?.color, avatar: c.peer?.avatar, sidekick: c.peer?.sidekick } : (m.look || {});
    // A sidekick writes with its own face and says whose it is (D31).
    const face = m.agent ? sidekickEl(m.agent.mine && profile?.sidekick ? profile.sidekick : { name: m.sender, look: m.agent.look || `orb-${colorFor(m.agent.owner)}` }, "msg-face") : avatarEl(m.sender, look);
    const row = el("div", { class: `msg${cont ? " cont" : ""}${m.agent ? " by-agent" : ""}`, "data-seq": String(m.seq) },
      face,
      el("div", {},
        cont ? null : el("header", {}, el("strong", { text: m.sender }), m.agent ? el("span", { class: "agent-tag", text: m.agent.mine ? "your sidekick" : `${m.agent.owner}'s sidekick` }) : null, el("time", { text: timeFmt.format(m.ts_ms) })),
        el("div", { class: "body" }, ...mentionChips(m.text)),
        ...deskCards(m.text),
        threads.has(m.seq) ? threadSummary(c, m.seq, threads.get(m.seq)) : null),
      el("div", { class: "msg-acts" }, el("button", { class: "icon-btn sm", type: "button", title: "Reply in thread", "aria-label": "Reply in thread", onclick: () => openThread(c.id, m.seq) }, icon("thread"))));
    rows.push(row);
    lastSender = threads.has(m.seq) ? "" : m.sender; lastTs = m.ts_ms;
  }
  if (!messages.length) {
    rows.push(c.kind === "dm"
      ? el("div", { class: "transcript-empty" }, peerFace(c), el("strong", { text: c.name }),
          el("span", { class: "mono", text: c.peer?.handle ? `@${c.peer.handle}` : "" }), el("p", { text: "This conversation is end-to-end encrypted. Only the two of you can read it." }))
      : el("div", { class: "transcript-empty" }, el("strong", { text: `Welcome to #${c.name}` }), el("p", { text: "No messages since you joined. Earlier ones stay readable only to the people who were here." })));
  }
  t.replaceChildren(...rows);
  if (atBottom || messages.length < 30) t.scrollTop = t.scrollHeight;
}
function lastSeqOf(rows) { const r = rows[rows.length - 1]; return r?.dataset?.seq ? Number(r.dataset.seq) : -1; }
// Root seq -> its replies, oldest first.
function threadsOf(messages) {
  const out = new Map();
  for (const m of messages) if (m.thread != null) { if (!out.has(m.thread)) out.set(m.thread, []); out.get(m.thread).push(m); }
  return out;
}
function threadSummary(c, root, replies) {
  const who = [...new Map(replies.map((r) => [r.sender, r])).values()].slice(-3);
  const last = replies[replies.length - 1];
  const unseen = replies.filter((r) => !r.mine && r.seq > (threadSeen[`${c.id}:${root}`] || 0)).length;
  return el("button", { class: `thread-sum${unseen ? " new" : ""}`, type: "button", onclick: () => openThread(c.id, root) },
    el("span", { class: "who" }, ...who.map((r) => avatarEl(r.sender, r.mine ? { color: profile?.color, avatar: profile?.avatar, sidekick: profile?.sidekick, size: "sm" } : { size: "sm" }))),
    el("strong", { text: `${replies.length} ${replies.length === 1 ? "reply" : "replies"}` }),
    el("small", { text: unseen ? `${unseen} new` : `Last ${sinceFmt(last.ts_ms)}` }));
}
function sinceFmt(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : shortDate.format(ts);
}

// ---------- threads ----------
// A reply names the message that starts its thread (its seq in the channel's
// log). The thread opens beside the conversation, and can be kept as a tab.

let convo = null; // { channel, messages } on screen
let thread = null; // { channel, root }
let threadSeen = readStore("anarchy.threadSeen", {});
function openThread(channelId, root) {
  if (current !== channelId) { goTo(channelId).then(() => openThread(channelId, root)); return; }
  openAsk(false);
  thread = { channel: channelId, root };
  show("thread", true);
  document.querySelector(".main")?.classList.add("with-panel");
  syncDock();
  renderThread();
  renderTabs();
  $("thread-input").focus();
}
function closeThread() {
  thread = null;
  show("thread", false);
  document.querySelector(".main")?.classList.remove("with-panel");
  syncDock();
  renderTabs();
}
function renderThread() {
  if (!thread || !convo || convo.channel.id !== thread.channel) return;
  const c = convo.channel;
  const root = convo.messages.find((m) => m.seq === thread.root && m.thread == null);
  const replies = convo.messages.filter((m) => m.thread === thread.root);
  $("thread-where").textContent = c.kind === "dm" ? `With ${c.name}` : `#${c.name}`;
  const line = (m, big) => el("div", { class: `thread-msg${big ? " root" : ""}` },
    avatarEl(m.sender, m.mine ? { color: profile?.color, avatar: profile?.avatar, sidekick: profile?.sidekick, size: big ? undefined : "sm" } : c.kind === "dm" && !m.mine ? { color: c.peer?.color, avatar: c.peer?.avatar, sidekick: c.peer?.sidekick, size: big ? undefined : "sm" } : { size: big ? undefined : "sm" }),
    el("div", {}, el("header", {}, el("strong", { text: m.sender }), el("time", { text: `${shortDate.format(m.ts_ms)} ${timeFmt.format(m.ts_ms)}` })), el("div", { class: "body" }, ...mentionChips(m.text)), ...deskCards(m.text)));
  $("thread-log").replaceChildren(
    root ? line(root, true) : el("p", { class: "fine thread-orphan", text: "This thread starts with a message from before you joined. You can read the replies sent since." }),
    el("div", { class: "thread-count", text: replies.length ? `${replies.length} ${replies.length === 1 ? "reply" : "replies"}` : "No replies yet" }),
    ...replies.map((m) => line(m, false)));
  $("thread-log").scrollTop = $("thread-log").scrollHeight;
  const last = replies[replies.length - 1];
  if (last) { threadSeen[`${c.id}:${thread.root}`] = last.seq; writeStore("anarchy.threadSeen", threadSeen); }
  $("thread-input").placeholder = root && !root.mine ? `Reply to ${root.sender}…` : "Reply in thread…";
}
$("thread-close").addEventListener("click", closeThread);
function threadLabel() {
  const root = convo?.messages.find((m) => m.seq === thread?.root && m.thread == null);
  return root ? root.text.slice(0, 32) : null;
}
$("thread-tab").addEventListener("click", () => { if (thread) { addTab({ channel: thread.channel, thread: thread.root, label: threadLabel() }); renderTabs(); } });
$("thread-input").addEventListener("input", () => { $("thread-send").disabled = !$("thread-input").value.trim(); mentionInput($("thread-input")); });
$("thread-input").addEventListener("blur", closeMentionSoon);
$("thread-input").addEventListener("keydown", (e) => {
  if (mentionKey(e)) return;
  if (e.key === "Escape") { e.preventDefault(); closeThread(); composer.focus(); return; }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("thread-form").requestSubmit(); }
});
$("thread-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("thread-input").value.trim();
  if (!text || !thread) return;
  const { channel, root } = thread;
  $("thread-input").value = ""; $("thread-send").disabled = true;
  try {
    await invoke("send_message", { channel, text, thread: root });
    await forwardToDesks(text, channels.find((c) => c.id === channel));
    // Taking part in a thread puts it in the working set.
    addTab({ channel, thread: root, label: threadLabel() });
  } catch (err) { $("thread-input").value = text; alert(`Not sent: ${err}`); }
  await openChannel(channel);
});

// ---------- tabs: the working set ----------
// The sidebar is the whole tree; the tabs are what's live. Opening a
// conversation or desk adds it (at most MAX_TABS, the least recently used goes
// first); threads join when you reply or keep them. Each tab carries its
// status: unread, new replies, what a desk needs. Stored on this device only.

const MAX_TABS = 6;
let tabs = readStore("anarchy.tabs", []);
function readStore(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; } }
function writeStore(key, value) { if (tour) return; try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: fine */ } }
const tabKey = (t) => (t.thread != null ? `${t.channel}:${t.thread}` : t.channel);
function addTab(t) {
  const key = tabKey(t);
  const at = tabs.find((x) => tabKey(x) === key);
  if (at) { at.used = Date.now(); if (t.label) at.label = t.label; }
  else {
    tabs.push({ channel: t.channel, thread: t.thread ?? null, label: t.label || null, used: Date.now() });
    while (tabs.length > MAX_TABS) {
      const active = activeTabKey();
      const victim = tabs.filter((x) => tabKey(x) !== active).sort((a, b) => a.used - b.used)[0];
      tabs = tabs.filter((x) => x !== victim);
    }
  }
  writeStore("anarchy.tabs", tabs);
}
function closeTab(t, e) {
  e?.stopPropagation();
  const key = tabKey(t);
  const idx = tabs.findIndex((x) => tabKey(x) === key);
  const wasActive = activeTabKey() === key;
  tabs = tabs.filter((x) => tabKey(x) !== key);
  writeStore("anarchy.tabs", tabs);
  if (wasActive) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    if (next) openTab(next);
    else { if (thread) closeThread(); current = null; invoke("blur"); showStart(); renderSide(); }
  }
  renderTabs();
}
function activeTabKey() {
  if (!current) return null;
  if (thread && thread.channel === current && tabs.some((x) => x.channel === current && x.thread === thread.root)) return `${current}:${thread.root}`;
  return current;
}
async function openTab(t) {
  if (t.thread != null) { openThread(t.channel, t.thread); return; }
  if (thread) closeThread();
  await goTo(t.channel);
}
const deskNeeds = new Map(); // desk id -> count, refreshed as desks are opened or polled
async function refreshDeskNeeds() {
  const today = isoToday();
  for (const t of tabs) {
    const c = channels.find((x) => x.id === t.channel);
    if (c?.desk !== "collections" || t.thread != null) continue;
    try {
      const items = await invoke("desk_items", { channel: c.id });
      const late = items.filter((i) => i.kind === "invoice" && invoiceState(i.data, today) === "overdue").length;
      const claims = desk?.channel === c.id ? invoices().filter((i) => claimOf(i)).length : 0;
      const asks = items.filter((i) => i.kind === "request" && !i.data.deleted && i.data.status === "new").length;
      deskNeeds.set(c.id, late + claims + asks);
    } catch { /* keep the last count */ }
  }
}
function renderTabs() {
  const live = tabs.filter((t) => channels.some((c) => c.id === t.channel && c.kind !== "personal"));
  if (live.length !== tabs.length && channels.length) { tabs = live; writeStore("anarchy.tabs", tabs); }
  const active = activeTabKey();
  $("tab-list").replaceChildren(...live.map((t) => {
    const c = channels.find((x) => x.id === t.channel);
    const key = tabKey(t);
    let lead, name, status = null;
    if (t.thread != null) {
      lead = el("span", { class: "tab-icon" }, icon("thread"));
      const root = convo?.channel.id === c.id ? convo.messages.find((m) => m.seq === t.thread && m.thread == null) : null;
      name = root ? root.text.slice(0, 32) : t.label || `Thread in ${c.kind === "dm" ? c.name : `#${c.name}`}`;
      const replies = convo?.channel.id === c.id ? convo.messages.filter((m) => m.thread === t.thread) : [];
      const unseen = replies.filter((r) => !r.mine && r.seq > (threadSeen[key] || 0)).length;
      if (unseen && key !== active) status = el("span", { class: "tab-badge", text: String(unseen) });
    } else if (c.kind === "dm") {
      lead = c.peer?.is_agent ? sidekickEl(profile?.sidekick || { look: "orb-ocean" }, "xs") : avatarEl(c.name, { color: c.peer?.color, avatar: c.peer?.avatar, sidekick: c.peer?.sidekick, size: "xs" });
      name = c.name;
    } else if (c.desk) {
      lead = el("span", { class: "tab-icon is-desk" }, icon(DESK_ICON[c.desk] || "receipt"));
      name = c.name;
      const n = deskNeeds.get(c.id);
      if (n) status = el("span", { class: "tab-badge warn", title: `${n} need you`, text: String(n) });
    } else {
      lead = el("span", { class: "tab-icon hash", text: "#" });
      name = c.name;
    }
    if (!status && t.thread == null && c.unread && c.id !== current) status = el("span", { class: "unread-dot", "aria-label": "unread" });
    const sp = c.space ? spaces.find((x) => x.id === c.space) : null;
    return el("div", { class: `tab${key === active ? " active" : ""}`, role: "tab", "aria-selected": String(key === active), tabindex: "0", title: sp ? `${name} · ${sp.name}` : name,
      "data-color": sp ? colorFor(sp.id) : undefined, onclick: () => openTab(t), onauxclick: (e) => { if (e.button === 1) closeTab(t, e); },
      onkeydown: (e) => { if (e.key === "Enter") openTab(t); } },
      sp ? el("span", { class: "tab-space", "aria-hidden": "true" }) : null,
      lead, el("span", { class: "tab-name", text: name }), status,
      el("button", { class: "tab-x", type: "button", "aria-label": `Close ${name}`, onclick: (e) => closeTab(t, e) }, icon("x")));
  }));
  show("tabs", true);
  renderFolders();
  show("tool-chats-dot", !pinned && drawer !== "chats" && channels.some((c) => c.unread && c.id !== current && belongsHere(c)));
}
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "\\") { e.preventDefault(); if (pinned) { pinned = false; writeStore("anarchy.chatsPinned", false); closeDrawers(); } else toggleDrawer("chats"); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w" && current) { e.preventDefault(); const t = tabs.find((x) => tabKey(x) === activeTabKey()); if (t) closeTab(t); }
});

// ---------- folders: the space's sections ----------
// Overview, Channels, Files and Desks sit on top of the canvas like folder
// tabs; the working set follows them. In settings, the folders are its pages.

let settingsAt = "profile";
const SETTINGS_PAGES = [["profile", "Profile"], ["privacy", "Privacy"], ["account", "Account & device"], ["appearance", "Appearance"], ["notifications", "Notifications"], ["files", "Files on this computer"], ["agents", "Agents on this computer"], ["devices", "Devices"], ["invites", "Guest invites"]];
// Set when you pick Chats with no conversation open, so the list still shows.
let chatsHint = false;
function sectionNow() {
  const cur = channels.find((c) => c.id === current);
  if (!cur && chatsHint && (view === "home" || view === "space")) return "chats";
  if (!$("view-desks").hidden) return "desks";
  if (!$("view-inbox").hidden) return "inbox";
  if (!$("view-spaceset").hidden) return "spaceset";
  if (!$("view-agenda").hidden) return "agenda";
  if (!$("view-notes").hidden) return note?.file ? "files" : notesState.shared ? "desks" : "notes";
  if (!cur) return "overview";
  if (cur.desk === "files") return "files";
  if (cur.desk === "tasks" && cur.kind === "personal") return "tasks";
  if (cur.desk) return "desks";
  return "chats";
}
function renderFolders() {
  let folders;
  if (view === "settings") {
    folders = SETTINGS_PAGES.filter(([k]) => k !== "invites" || (isCompanyServer() && !profile?.is_guest))
      .map(([k, label]) => ({ key: k, label, active: settingsAt === k, go: () => settingsPage(k) }));
  } else {
    const now = sectionNow();
    const unread = channels.some((c) => c.unread && c.id !== current && belongsHere(c));
    folders = view === "home"
      ? [{ key: "overview", label: "Home", icon: "home" }, inboxFolder(), { key: "tasks", label: "My tasks", icon: "board" }, { key: "chats", label: "Chats", icon: "chat", dot: unread }, { key: "agenda", label: "Agenda", icon: "calendar" }, { key: "notes", label: "Notes", icon: "note" }, { key: "files", label: "Files", icon: "folder" }]
      : [{ key: "overview", label: "Overview", icon: "home" }, inboxFolder(), { key: "tasks", label: "My tasks", icon: "board" }, { key: "chats", label: "Channels", icon: "chat", dot: unread }, { key: "files", label: "Files", icon: "folder" }, { key: "desks", label: "Desks", icon: "receipt", n: [...deskNeeds.entries()].filter(([id]) => channels.find((c) => c.id === id)?.space === currentSpace?.id).reduce((a, [, n]) => a + n, 0) }];
    folders = folders.map((f) => ({ ...f, active: f.key === now, go: () => openSection(f.key) }));
  }
  const item = (f) => el("button", { class: `section${f.active ? " active" : ""}`, type: "button", role: "tab", "aria-selected": String(!!f.active), title: f.label, onclick: f.go },
    f.icon ? el("span", { class: "section-icon" }, icon(f.icon), f.n ? el("span", { class: "tab-badge warn", text: String(f.n) }) : f.dot ? el("span", { class: "unread-dot", "aria-label": "unread" }) : null) : null,
    el("span", { class: "section-label", text: f.label }));
  $("folder-tabs").replaceChildren(...folders.map(item));
  // A space's own settings sit at the foot of its sections.
  $("section-foot").replaceChildren(...(view === "space" && currentSpace ? [item({ key: "spaceset", label: "Settings", icon: "settings", active: sectionNow() === "spaceset", go: openSpaceSettings })] : []));
  $("sections").classList.toggle("pages", view === "settings");
  paintSide();
  show("tab-list", view !== "settings");
  show("tools", view !== "settings");
  $("workspace").classList.toggle("no-tools", view === "settings");
}
// The last thing of a kind you had open here, from the working set.
function lastOpen(pred) {
  return [...tabs].filter((t) => t.thread == null).sort((a, b) => b.used - a.used).map((t) => channels.find((c) => c.id === t.channel)).find((c) => c && pred(c));
}
async function openSection(key) {
  if (thread) closeThread();
  chatsHint = false;
  const here = (c) => (view === "home" ? c.kind === "dm" : c.space === currentSpace?.id);
  if (key === "overview") { current = null; invoke("blur"); showStart(); renderSide(); return; }
  if (key === "agenda") return openAgenda();
  if (key === "notes") return openNotes();
  if (key === "files") return view === "home" ? openPersonal("files") : openDriveOf(currentSpace);
  if (key === "tasks") return openPersonal("tasks");
  if (key === "inbox") return openInbox();
  if (key === "desks") {
    const already = sectionNow() === "desks";
    const last = lastOpen((c) => here(c) && c.desk && c.desk !== "files");
    if (last && !already) return openChannel(last.id);
    return showDesks();
  }
  // Chats / Channels: pick up where you left off, else the first one, else the list.
  const last = lastOpen((c) => here(c) && !c.desk) || channels.find((c) => here(c) && !c.desk && (view === "home" ? true : c.kind === "channel"));
  if (last) { await openChannel(last.id); composer.focus(); }
  else { current = null; showStart(); chatsHint = true; renderFolders(); toggleDrawer("chats", true); }
}
async function showDesks() {
  const sp = currentSpace;
  current = null; invoke("blur");
  hideMain(); show("view-desks");
  renderFolders(); renderTabs();
  const desks = channels.filter((c) => c.space === sp.id && c.desk && c.desk !== "files");
  $("desks-kind").textContent = `${sp.name} · Desks`;
  $("desks-headline").replaceChildren(desks.length ? `${desks.length} ${desks.length === 1 ? "desk" : "desks"}. ` : "No desks yet. ", el("span", { class: "soft", text: desks.length ? "Each one holds a job: its records, its rules and who works it." : "A desk holds a job: invoices, requests, jobs." }));
  const cards = await Promise.all(desks.map(async (d) => el("button", { class: "ov-desk", type: "button", onclick: () => openChannel(d.id) },
    el("span", { class: "top" }, icon(DESK_ICON[d.desk] || "receipt"), d.name),
    el("span", { class: "big" }, await deskSummary(d)),
    deskNeeds.get(d.id) ? el("span", { class: "flags" }, el("span", { class: "flag-pill warn", text: `${deskNeeds.get(d.id)} need you` })) : el("span", { class: "flags" }, el("span", { class: "flag-pill good", text: "Nothing waiting" })))));
  if (currentSpace !== sp) return;
  desks.forEach((d, k) => {
    foldDraggable(cards[k], d.id);
    cards[k].querySelector(".top").append(el("span", { class: "fold-move", role: "button", tabindex: "0", title: "Move to a folder", "aria-label": `Move ${d.name} to a folder`, onclick: (e) => { e.stopPropagation(); openFoldMenu(e.currentTarget, "desks", d.id); } }, icon("folder")));
  });
  const byId = new Map(desks.map((d, k) => [d.id, cards[k]]));
  const { folders, loose } = foldGroups("desks", desks);
  const add = el("button", { class: "ov-desk add", type: "button", onclick: openNewDesk }, el("span", { class: "top" }, icon("plus"), "Set up a desk"), el("span", { class: "fine", text: "Front desk, help desk, dispatch and more are on the way." }));
  $("desks-grid").replaceChildren(
    ...folders.map((f) => {
      const kids = f.items.filter((id) => byId.has(id));
      const need = kids.reduce((n, id) => n + (deskNeeds.get(id) || 0), 0);
      return el("section", { class: `desk-fold fold${f.open ? " open" : ""}` }, foldHead("desks", f, kids.length, need > 0),
        f.open ? el("div", { class: "desks-grid inner" }, ...(kids.length ? kids.map((id) => byId.get(id)) : [el("p", { class: "fine fold-empty", text: "Drag a desk here, or use its folder button." })])) : null);
    }),
    folders.length ? foldDropTarget(el("h3", { class: "fold-loose", text: "Not in a folder" }), "desks", null) : null,
    el("div", { class: "desks-grid inner" }, ...loose.map((d) => byId.get(d.id)), add));
}
$("desks-new").addEventListener("click", () => openNewDesk());
$("desks-folder").addEventListener("click", () => newFold("desks"));
$("new-channel-folder").addEventListener("click", () => newFold("channels"));

// ---------- folders in the channel and desk lists (D33) ----------
// Yours alone: how you organise a space doesn't change anyone else's list.
// Kept in a personal record, so it syncs between your devices and the server
// can't read the folder names; a copy in local storage covers start-up.
let org = readStore("anarchy.org", { v: 1, spaces: {} });
let prefsChannel = null;
async function loadOrg() {
  try {
    prefsChannel = await invoke("ensure_personal", { kind: "prefs" });
    const rec = (await invoke("desk_items", { channel: prefsChannel })).find((i) => i.id === "sidebar");
    if (rec?.data?.v === 1) { org = rec.data; writeStore("anarchy.org", org); renderSide(); if (!$("view-desks").hidden) showDesks(); }
  } catch (e) { console.warn("folders stay on this device for now", e); }
}
let orgSave = null;
function saveOrg() {
  writeStore("anarchy.org", org);
  clearTimeout(orgSave);
  orgSave = setTimeout(async () => {
    try {
      if (!prefsChannel) prefsChannel = await invoke("ensure_personal", { kind: "prefs" });
      await invoke("put_items", { channel: prefsChannel, items: [{ id: "sidebar", kind: "settings", data: org }] });
    } catch (e) { console.warn(e); }
  }, 400);
}
function foldsOf(kind) {
  const sp = currentSpace?.id || "home";
  org.spaces[sp] ??= { channels: [], desks: [] };
  return org.spaces[sp][kind];
}
// Folders in order with only the ids still around; the rest is loose, as before.
function foldGroups(kind, list) {
  const ids = new Set(list.map((c) => c.id));
  const folders = foldsOf(kind);
  const placed = new Set();
  for (const f of folders) { f.items = f.items.filter((id) => ids.has(id) && !placed.has(id)); f.items.forEach((id) => placed.add(id)); }
  return { folders, loose: list.filter((c) => !placed.has(c.id)) };
}
function moveInto(kind, id, folderId) {
  for (const f of foldsOf(kind)) f.items = f.items.filter((x) => x !== id);
  const f = foldsOf(kind).find((x) => x.id === folderId);
  if (f) { f.items.push(id); f.open = true; }
  saveOrg(); repaintFolds(kind);
}
function repaintFolds(kind) { if (kind === "channels") renderSide(); else showDesks(); }
function newFold(kind, then) {
  const name = prompt(kind === "channels" ? "Name the folder, like Clients or Internal" : "Name the folder, like Money or Clients")?.trim();
  if (!name) return null;
  const f = { id: crypto.randomUUID().slice(0, 8), name: name.slice(0, 40), open: true, items: [] };
  foldsOf(kind).push(f);
  if (then) then(f); else { saveOrg(); repaintFolds(kind); }
  return f;
}
function foldHead(kind, f, n, alert) {
  const head = el("div", { class: "fold-head" },
    el("button", { class: "fold-toggle", type: "button", "aria-expanded": String(f.open), onclick: () => { f.open = !f.open; saveOrg(); repaintFolds(kind); } },
      el("span", { class: "chev" }, icon("chevron")), el("span", { class: "fold-name", text: f.name }),
      !f.open && n ? el("span", { class: "fold-n", text: String(n) }) : null,
      !f.open && alert ? el("span", { class: "unread-dot", "aria-label": kind === "channels" ? "unread inside" : "needs you" }) : null),
    el("span", { class: "fold-acts" },
      el("button", { class: "icon-btn sm", type: "button", title: "Rename folder", "aria-label": `Rename ${f.name}`, onclick: () => { const v = prompt("Rename folder", f.name)?.trim(); if (v) { f.name = v.slice(0, 40); saveOrg(); repaintFolds(kind); } } }, icon("pen")),
      el("button", { class: "icon-btn sm", type: "button", title: "Delete folder", "aria-label": `Delete ${f.name}`, onclick: () => {
        if (f.items.length && !confirm(`Delete the folder ${f.name}? What's in it stays, outside any folder.`)) return;
        const list = foldsOf(kind); list.splice(list.indexOf(f), 1); saveOrg(); repaintFolds(kind);
      } }, icon("trash"))));
  return foldDropTarget(head, kind, f.id);
}
function foldDraggable(node, id) {
  node.draggable = true;
  node.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/x-anarchy-item", id); e.dataTransfer.effectAllowed = "move"; });
  return node;
}
function foldDropTarget(node, kind, folderId) {
  if (node.dataset.dropFold) return node;
  node.dataset.dropFold = "1";
  node.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/x-anarchy-item")) { e.preventDefault(); node.classList.add("drop-on"); } });
  node.addEventListener("dragleave", () => node.classList.remove("drop-on"));
  node.addEventListener("drop", (e) => {
    node.classList.remove("drop-on");
    const id = e.dataTransfer.getData("text/x-anarchy-item");
    if (id) { e.preventDefault(); moveInto(kind, id, folderId); }
  });
  return node;
}
function openFoldMenu(anchor, kind, id) {
  const menu = $("fold-menu");
  const inFold = foldsOf(kind).find((f) => f.items.includes(id))?.id ?? null;
  const item = (label, folderId, ic) => el("button", { class: `fold-menu-item${folderId === inFold ? " on" : ""}`, type: "button", role: "menuitemradio", "aria-checked": String(folderId === inFold), onclick: () => { show(menu, false); moveInto(kind, id, folderId); } }, icon(ic), label);
  menu.replaceChildren(
    el("p", { class: "fold-menu-title", text: "Move to" }),
    ...foldsOf(kind).map((f) => item(f.name, f.id, "folder")),
    item("No folder", null, "list"),
    el("button", { class: "fold-menu-item", type: "button", onclick: () => { show(menu, false); newFold(kind, (f) => moveInto(kind, id, f.id)); } }, icon("folder-plus"), "New folder…"));
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.round(Math.min(r.left, innerWidth - 220))}px`;
  menu.style.top = `${Math.round(Math.min(r.bottom + 4, innerHeight - 260))}px`;
  show(menu, true);
}
document.addEventListener("click", (e) => { const m = $("fold-menu"); if (!m.hidden && !m.contains(e.target) && !e.target.closest(".fold-move, #drive-sort")) show(m, false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") show("fold-menu", false); });

// ---------- drawers: chats and people pop over from the left ----------

let drawer = null; // "chats" | "people" | "notifs" | "spaceset" | null
const RIGHT_PANELS = ["people", "notifs"];
let pinned = readStore("anarchy.chatsPinned", true);
function toggleDrawer(name, force) {
  const open = force ?? drawer !== name;
  if (open && name !== "chats" && pinned) { /* the pinned list stays; the other panel opens over the canvas */ }
  drawer = open ? name : null;
  if (open) openAsk(false);
  if (open && RIGHT_PANELS.includes(name) && thread) closeThread();
  paintDrawers();
  if (open && name === "people") renderPeopleDrawer();
  if (open && name === "notifs") renderNotifs();
}
function closeDrawers() { drawer = null; paintDrawers(); }
function paintDrawers() {
  // The sidebar belongs to conversations only: Chats on Home, Channels in a space.
  const chatSection = view !== "settings" && sectionNow() === "chats";
  const chatsOn = chatSection && (pinned || drawer === "chats");
  show("drawer-chats", chatsOn);
  for (const n of RIGHT_PANELS) { show(`drawer-${n}`, drawer === n); $(`tool-${n}`).setAttribute("aria-expanded", String(drawer === n)); }
  syncDock();
  $("workspace").classList.toggle("chats-pinned", pinned);
  $("drawer-chats").classList.toggle("pinned", pinned);
  $("tool-chats").setAttribute("aria-expanded", String(chatsOn));
  if (chatsOn) show("tool-chats-dot", false);
  show("drawer-chats", chatsOn);
  show("tool-chats", chatSection);
  $("workspace").classList.toggle("chats-pinned", chatsOn && pinned);
  $("tool-people").setAttribute("aria-expanded", String(drawer === "people"));
  // Docked: the button collapses it. Popped over: the same button docks it.
  for (const b of document.querySelectorAll(".drawer-pin")) {
    b.setAttribute("aria-pressed", String(pinned));
    b.title = pinned ? "Collapse the sidebar (Ctrl \\)" : "Keep the sidebar open";
    b.setAttribute("aria-label", b.title);
    b.firstElementChild.firstElementChild.setAttribute("href", pinned ? "#i-sidebar" : "#i-pin");
  }
  $("tool-chats").setAttribute("aria-pressed", String(pinned));
  $("tool-chats").title = pinned ? "Hide the sidebar (Ctrl \\)" : "Show the sidebar (Ctrl \\)";
}
// Docked: hide it. Hidden: pop it over (pin it from there to dock it again).
$("tool-chats").addEventListener("click", () => {
  if (pinned) { pinned = false; writeStore("anarchy.chatsPinned", false); closeDrawers(); }
  else toggleDrawer("chats");
});
$("tool-people").addEventListener("click", () => toggleDrawer("people"));
$("tool-notifs").addEventListener("click", () => toggleDrawer("notifs"));
for (const b of document.querySelectorAll(".drawer-pin")) b.addEventListener("click", () => { pinned = !pinned; writeStore("anarchy.chatsPinned", pinned); if (!pinned) drawer = null; paintDrawers(); });
// Picking something in a pop-over closes it; clicking the canvas does too.
$("drawer-chats").addEventListener("click", (e) => { if (!pinned && e.target.closest(".side-item")) setTimeout(closeDrawers, 0); });
$("main").addEventListener("mousedown", (e) => { if (drawer === "chats" && !e.target.closest(".drawer")) closeDrawers(); });
window.addEventListener("resize", () => syncDock());
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawer && !document.querySelector("dialog[open]")) closeDrawers(); });
paintDrawers();

async function renderPeopleDrawer() {
  const list = $("drawer-people-list");
  show("people-dm-form", view === "home");
  show("space-invite", view === "space" && !profile?.is_guest);
  if (view === "home") {
    $("people-title").textContent = "People you talk to";
    const dms = channels.filter((c) => c.kind === "dm");
    list.replaceChildren(...(dms.length ? dms.map((c) => el("button", { class: "person-row", type: "button", onclick: () => { closeDrawers(); openChannel(c.id); } },
      peerFace(c), el("span", { class: "lines" }, el("strong", { text: c.name }), el("small", { text: c.peer?.handle ? `@${c.peer.handle}` : "" })))) : [el("p", { class: "fine", text: "Nobody yet. Message someone by their handle." })]));
    return;
  }
  const sp = currentSpace;
  $("people-title").textContent = "People";
  list.replaceChildren(el("p", { class: "fine", text: "Loading…" }));
  let members = [];
  try { members = await invoke("space_members", { space: sp.id }); } catch (err) { list.replaceChildren(el("p", { class: "error", text: String(err) })); return; }
  if (currentSpace !== sp) return;
  const mine = handleOf(profile);
  list.replaceChildren(...members.map((m) => {
    const me = m.handle && m.handle === mine;
    return el("div", { class: "person-row" }, (m.is_agent ? sidekickEl(m.sidekick, "msg-face") : avatarEl(m.name, { color: m.color, avatar: m.avatar, sidekick: m.sidekick, presence: m.presence })),
      el("span", { class: "lines" }, el("strong", {}, m.name, me ? el("span", { class: "fine", text: " · you" }) : null, m.is_agent ? el("span", { class: "flag-pill warn", text: "AI" }) : null), el("small", { text: m.handle ? `@${m.handle}` : m.is_guest ? "Guest" : "" })),
      !me && m.handle ? el("button", { class: "btn-outline sm", type: "button", text: "Message", onclick: async (e) => { closeDrawers(); await startDm(m.handle, "people-dm-error", e.currentTarget); } }) : null);
  }));
}
$("people-dm-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const h = $("people-dm").value.trim();
  if (h) { await startDm(h, "people-dm-error", e.submitter); closeDrawers(); }
});


const composer = $("message");
function fitComposer() { composer.style.height = "auto"; composer.style.height = `${Math.min(composer.scrollHeight, 160)}px`; $("send").disabled = !composer.value.trim(); }
composer.addEventListener("input", fitComposer);
composer.addEventListener("keydown", (e) => {
  if (mentionKey(e)) return;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); }
});
composer.addEventListener("input", () => mentionInput(composer));
composer.addEventListener("blur", closeMentionSoon);
$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = composer.value.trim();
  if (!text || !current) return;
  composer.value = ""; fitComposer();
  $("transcript").append(el("div", { class: "msg pending" }, avatarEl(profile?.display_name || "You", { color: profile?.color, avatar: profile?.avatar, sidekick: profile?.sidekick }), el("div", {}, el("div", { class: "body", text }))));
  $("transcript").scrollTop = $("transcript").scrollHeight;
  try {
    await invoke("send_message", { channel: current, text });
    await forwardToDesks(text, channels.find((c) => c.id === current));
  }
  catch (err) { composer.value = text; fitComposer(); $("transcript").append(el("p", { class: "error", text: `Not sent: ${err}` })); }
  openChannel(current);
});

// ---------- @mentions: people and desks ----------
// A desk is mentioned like a person. Everyone who is on that desk sees a live
// card with its state (worked out on their own device); anyone else sees plain
// text, so a mention never reveals a desk to people outside it. The message is
// also copied into the desk's activity, because the sender chose to address it.

const DESK_ICON = { collections: "receipt", files: "folder", agenda: "calendar", notes: "note", tasks: "board", pages: "note" };
function desksInScope() {
  const here = channels.find((c) => c.id === current);
  const space = view === "space" ? currentSpace?.id : here?.space;
  return channels.filter((c) => c.desk && (!space || c.space === space));
}
function allDesks() { return channels.filter((c) => c.desk); }
// Longest names first, so "@Front desk" wins over "@Front".
function deskMatcher() {
  const names = allDesks().map((d) => d.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return null;
  const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`@(${esc.join("|")})(?![\\w-])`, "gi");
}
function deskNamed(name) { const n = name.toLowerCase(); return allDesks().find((d) => d.name.toLowerCase() === n); }
function mentionedDesks(text) {
  const re = deskMatcher();
  if (!re) return [];
  const found = new Map();
  for (const m of text.matchAll(re)) { const d = deskNamed(m[1]); if (d) found.set(d.id, d); }
  return [...found.values()];
}
function mentionChips(text) {
  const re = deskMatcher();
  const out = [];
  let last = 0;
  const people = /(?<![\w@])@([a-z0-9_.-]{2,32})(#\d{4})?/gi;
  const pushText = (t) => {
    let k = 0;
    for (const m of t.matchAll(people)) {
      if (m.index > k) out.push(t.slice(k, m.index));
      out.push(el("span", { class: `mention${m[1].toLowerCase() === profile?.username ? " me" : ""}`, text: m[0] }));
      k = m.index + m[0].length;
    }
    if (k < t.length) out.push(t.slice(k));
  };
  if (re) {
    for (const m of text.matchAll(re)) {
      const d = deskNamed(m[1]);
      if (!d) continue;
      pushText(text.slice(last, m.index));
      out.push(el("button", { class: "mention desk", type: "button", title: `Open ${d.name}`, onclick: () => goTo(d.id) }, icon(DESK_ICON[d.desk] || "sparkle"), d.name));
      last = m.index + m[0].length;
    }
  }
  pushText(text.slice(last));
  return out;
}
function deskCards(text) {
  return mentionedDesks(text).slice(0, 2).map((d) => {
    const card = el("button", { class: "desk-card", type: "button", onclick: () => goTo(d.id) },
      el("span", { class: "space-tile" }, icon(DESK_ICON[d.desk] || "sparkle")), el("span", { class: "lines" }, el("strong", { text: d.name }), el("small", { text: "…" })));
    deskSummary(d).then((line) => { card.querySelector("small").textContent = line; });
    return card;
  });
}
// One line about a desk's state, from its records on this device.
async function deskSummary(d) {
  let items = [];
  try { items = await invoke("desk_items", { channel: d.id }); } catch { return "Open the desk"; }
  if (d.desk === "collections") {
    const today = isoToday();
    const inv = items.filter((i) => i.kind === "invoice").map((i) => ({ ...i.data, state: invoiceState(i.data, today) }));
    const open = inv.filter((i) => i.state === "open" || i.state === "overdue");
    const late = inv.filter((i) => i.state === "overdue");
    if (!inv.length) return "No invoices yet";
    return `${money(open.reduce((n, i) => n + i.amount, 0))} outstanding · ${late.length} overdue · ${inv.filter((i) => i.state === "paid").length} paid`;
  }
  if (d.desk === "pages") {
    const ps = items.filter((i) => i.kind === "page" && !i.data.deleted);
    if (!ps.length) return "No pages yet";
    const last = ps.reduce((m, i) => Math.max(m, i.data.updated || 0), 0);
    return `${ps.length} ${ps.length === 1 ? "page" : "pages"} · edited ${sinceFmt(last)}`;
  }
  if (d.desk === "tasks") {
    const st = taskStats(items);
    return `${st.open} open · ${st.late ? `${st.late} late · ` : ""}${st.week} due this week`;
  }
  if (d.desk === "files") {
    const files = items.filter((i) => i.kind === "file" && !i.data.deleted);
    return `${files.length} ${files.length === 1 ? "file" : "files"} · ${sizeFmt(files.reduce((n, f) => n + (f.data.file_key?.size || 0), 0))}`;
  }
  return `${items.length} records`;
}
async function forwardToDesks(text, from) {
  for (const d of mentionedDesks(text)) {
    if (d.id === from?.id) continue;
    const where = from?.kind === "dm" ? `a conversation with ${from.name}` : `#${from?.name || "a channel"}`;
    try { await invoke("send_message", { channel: d.id, text: `Mentioned in ${where}: \u201c${text}\u201d` }); } catch (e) { console.warn(e); }
  }
}

// The picker that opens when you type "@".
let mention = null; // { input, start, items, cursor }
const membersCache = new Map();
async function mentionPeople() {
  const space = view === "space" ? currentSpace?.id : channels.find((c) => c.id === current)?.space;
  if (!space) return [];
  if (!membersCache.has(space)) membersCache.set(space, invoke("space_members", { space }).catch(() => []));
  return (await membersCache.get(space)).filter((p) => p.handle && p.handle.split("#")[0] !== profile?.username);
}
async function mentionInput(input) {
  const upto = input.value.slice(0, input.selectionStart);
  const m = /(^|\s)@([^\s@]{0,24})$/.exec(upto);
  if (!m) return closeMention();
  const q = m[2].toLowerCase();
  const start = upto.length - m[2].length - 1;
  const desks = desksInScope().filter((d) => d.name.toLowerCase().includes(q)).map((d) => ({ kind: "desk", label: d.name, sub: `Desk · ${KIND_OF_DESK[d.desk] || d.desk}`, insert: `@${d.name}`, d }));
  // Desks are known on this device: show them now; people follow once loaded.
  const show = (people) => {
    const items = [...desks, ...people].slice(0, 7);
    if (!items.length) return closeMention();
    const keep = mention && mention.input === input && mention.start === start ? mention.cursor : 0;
    mention = { input, start, items, cursor: Math.min(keep, items.length - 1) };
    paintMention();
  };
  if (desks.length) show([]);
  const all = await mentionPeople();
  // Still typing the same mention?
  const now = input.value.slice(0, input.selectionStart);
  if (!now.endsWith(`@${m[2]}`)) return;
  show(all.filter((p) => `${p.name} ${p.handle}`.toLowerCase().includes(q)).slice(0, 5)
    .map((p) => ({ kind: "person", label: p.name, sub: `@${p.handle}`, insert: `@${p.handle.split("#")[0]}`, p })));
}
function paintMention() {
  const pop = $("mention-pop");
  pop.replaceChildren(
    el("div", { class: "sr-group", text: "Mention" }),
    ...mention.items.map((it, k) => el("button", { class: `sr-item${k === mention.cursor ? " active" : ""}`, type: "button", role: "option", "aria-selected": String(k === mention.cursor), onmousedown: (e) => { e.preventDefault(); pickMention(k); } },
      it.kind === "desk" ? el("span", { class: "space-tile mention-desk" }, icon(DESK_ICON[it.d.desk] || "sparkle")) : avatarEl(it.label, { color: it.p.color, avatar: it.p.avatar, size: "sm" }),
      el("span", { class: "lines" }, el("span", { text: it.label }), el("small", { text: it.sub })),
      null)));
  const r = mention.input.getBoundingClientRect();
  pop.style.left = `${Math.round(r.left)}px`;
  pop.style.bottom = `${Math.round(window.innerHeight - r.top + 8)}px`;
  pop.style.width = `${Math.min(340, Math.round(r.width))}px`;
  show(pop, true);
}
function pickMention(k) {
  const it = mention.items[k];
  const { input, start } = mention;
  const end = input.selectionStart;
  input.value = `${input.value.slice(0, start)}${it.insert} ${input.value.slice(end)}`;
  const at = start + it.insert.length + 1;
  input.setSelectionRange(at, at);
  closeMention();
  input.dispatchEvent(new Event("input"));
  input.focus();
}
function closeMention() { mention = null; show("mention-pop", false); }
// On blur, after a click on the picker has had its turn; not if focus moved to the input the picker now serves.
function closeMentionSoon() { setTimeout(() => { if (!mention || document.activeElement !== mention.input) closeMention(); }, 120); }
// Arrow keys, Enter/Tab and Escape while the picker is open. True if handled.
function mentionKey(e) {
  if (!mention) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); mention.cursor = (mention.cursor + (e.key === "ArrowDown" ? 1 : -1) + mention.items.length) % mention.items.length; paintMention(); return true; }
  if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(mention.cursor); return true; }
  if (e.key === "Escape") { e.preventDefault(); closeMention(); return true; }
  return false;
}
const KIND_OF_DESK = { collections: "Collections", files: "Files", tasks: "Tasks", pages: "Pages" };

// ---------- Ask ----------
// The pull-out panel where the AI will live. Until a model is connected it's
// honest about being search: it looks through what this device can decrypt and
// answers desk questions from their records. It never sends anything anywhere.

const STOP = new Set("the a an and or of to in on for with is are was were be what who when where which how much many my our your me i we you it this that there any all do does did have has from about show find tell please status check update latest new give list".split(" "));
// ---------- the sidekick on the server (D32) ----------
// The only sidekick anyone can talk to one to one is their own.
function peerFace(c, size) {
  if (c.peer?.is_agent) return sidekickEl(profile?.sidekick || { name: c.name, look: "orb-ocean" }, size === "sm" ? "tool" : "msg-face");
  return avatarEl(c.name, { color: c.peer?.color, avatar: c.peer?.avatar, sidekick: c.peer?.sidekick, presence: c.peer?.presence, size });
}
let skHosted = null;
async function paintSidekickToggle(c) {
  const b = $("convo-sk");
  const sk = profile?.sidekick;
  if (!c || !sk || profile?.is_guest || c.desk) return show(b, false);
  let st;
  try { st = await invoke("sidekick_state", { channel: c.id }); } catch { return show(b, false); }
  if (current !== c.id) return;
  skHosted = st.hosted;
  paintAskHead();
  if (!st.hosted) return show(b, false);
  b.replaceChildren(sidekickEl(sk, "tool"), el("span", { text: st.on ? `${sk.name} reads this` : `Let ${sk.name} read` }));
  b.setAttribute("aria-pressed", String(st.on));
  b.classList.toggle("on", st.on);
  b.classList.toggle("blocked", !!st.blocked && !st.on);
  b.title = st.blocked && !st.on ? st.blocked : st.on ? `Turn ${sk.name} off here` : `${sk.name} runs on the server: turning it on lets the server read this channel`;
  b.onclick = async () => {
    if (st.blocked && !st.on) return alert(st.blocked);
    const msg = st.on
      ? `Take ${sk.name} out of #${c.name}? It forgets what it read here.`
      : `Let ${sk.name} read #${c.name}?\n\n${sk.name} runs on the server, so the server's operator could read this channel from now on. Everyone here will see a note saying so. It only sees messages from now on.`;
    if (!confirm(msg)) return;
    await busy(b, st.on ? "Removing…" : "Adding…", async () => {
      try { await invoke(st.on ? "sidekick_leave" : "sidekick_join", { channel: c.id }); await openChannel(c.id); }
      catch (err) { alert(String(err)); }
    });
  };
  show(b, true);
}
// Its memory lives with it on the server (D36): asking opens your chat with it.
$("ask-memory").addEventListener("click", async () => {
  try {
    const id = await invoke("sidekick_chat"); openAsk(false); await refreshChannels(); await openChannel(id);
    await invoke("send_message", { channel: id, text: "what do you remember?", thread: null });
    await openChannel(id);
  } catch (err) { alert(String(err)); }
});
$("ask-server-chat").addEventListener("click", async () => {
  try { const id = await invoke("sidekick_chat"); openAsk(false); await refreshChannels(); await openChannel(id); }
  catch (err) { alert(String(err)); }
});

let askFace = null;
function paintAskHead() {
  paintAskBubble();
  const sk = profile?.sidekick;
  // The panel's sidekick is alive: it watches the pointer and reacts (D36).
  if (sk) {
    if (!askFace || askFace._look !== sk.look) { askFace = skLive(sk.look); askFace._look = sk.look; }
    const holder = el("span", { class: "sk head" }); holder.append(askFace);
    if (!$("ask-mark").contains(askFace)) $("ask-mark").replaceChildren(holder);
  } else $("ask-mark").replaceChildren(icon("sparkle"));
  $("ask-mark").classList.toggle("has-sk", !!sk);
  $("ask-name").textContent = sk ? sk.name : "Assistant";
  $("tool-ask").replaceChildren(sk ? sidekickEl(sk, "tool") : icon("sparkle"));
  $("tool-ask").title = sk ? `${sk.name}, your sidekick (Ctrl J)` : "Ask (Ctrl J)";
  show("ask-server", !!sk && skHosted === true);
  $("ask-server-chat").textContent = sk ? `Ask ${sk.name} on the server instead` : "Ask on the server instead";
  $("ask-memory").textContent = sk ? `What does ${sk.name} remember?` : "What does it remember?";
}
// The assistant lives in a bubble at the bottom right; opening it grows the
// bubble into the side panel, closing it shrinks the panel back (D45).
function morphAsk(on) {
  const panel = $("ask"), bubble = $("ask-bubble");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !panel.animate) return;
  const p = panel.getBoundingClientRect(), b = bubble.getBoundingClientRect();
  if (!p.width || !b.width) return;
  // The bubble's box, as an inset of the panel's.
  const from = `inset(${Math.max(0, b.top - p.top)}px ${Math.max(0, p.right - b.right)}px ${Math.max(0, p.bottom - b.bottom)}px ${Math.max(0, b.left - p.left)}px round ${b.height / 2}px)`;
  const to = "inset(0px 0px 0px 0px round 16px)";
  const frames = on ? [{ clipPath: from, opacity: .6 }, { clipPath: to, opacity: 1 }] : [{ clipPath: to, opacity: 1 }, { clipPath: from, opacity: .4 }];
  return panel.animate(frames, { duration: on ? 420 : 300, easing: on ? "cubic-bezier(.2, .9, .25, 1)" : "cubic-bezier(.4, 0, .6, 1)" });
}
function paintAskBubble() {
  const sk = profile?.sidekick;
  $("ask-bubble-name").textContent = sk?.name || "Assistant";
  const face = $("ask-bubble-face");
  if (sk && face.dataset.look !== sk.look) {
    face.dataset.look = sk.look;
    face.replaceChildren(skLive(sk.look, "idle", { track: false, react: false }));
  } else if (!sk) face.replaceChildren(icon("sparkle"));
}
$("ask-bubble").addEventListener("click", () => openAsk(true));
function openAsk(on = true) {
  if (on && thread) closeThread();
  if (on) { drawer = null; paintDrawers(); }
  const wasOpen = !$("ask").hidden;
  if (!on && wasOpen) {
    // Shrink back into the bubble, then hide.
    show("ask-bubble", true);
    const a = morphAsk(false);
    const done = () => { if (!$("ask").classList.contains("opening")) { show("ask", false); syncDock(); } };
    if (a) a.finished.then(done, done);
    else done();
  } else show("ask", on);
  $("ask").classList.toggle("opening", on);
  if (on && !wasOpen) morphAsk(true)?.finished.then(() => { if (!$("ask").hidden) show("ask-bubble", false); }).catch(() => {});
  else if (on) show("ask-bubble", false);
  $("tool-ask").setAttribute("aria-expanded", String(on));
  syncDock();
  document.querySelector(".main")?.classList.toggle("with-ask", on);
  if (!on) return;
  paintAskHead();
  const sp = view === "space" ? currentSpace : null;
  $("ask-scope").textContent = sp ? `In ${sp.name}` : "Your day, on this device";
  if (!$("ask-log").children.length) {
    const desks = desksInScope();
    $("ask-log").replaceChildren(el("div", { class: "ask-msg bot" },
      el("p", { text: "Ask about your messages, files and desks. Type @ to address a desk." }),
      desks.length ? el("div", { class: "chips" }, ...desks.slice(0, 3).map((d) => el("button", { class: "chip", type: "button", text: `@${d.name}`, onclick: () => { $("ask-input").value = `@${d.name} `; $("ask-input").focus(); fitAsk(); } }))) : null));
  }
  $("ask-input").focus();
}
for (const b of document.querySelectorAll("[data-ask]")) b.addEventListener("click", () => openAsk($("ask").hidden));
$("ask-close").addEventListener("click", () => openAsk(false));
$("ask-new").addEventListener("click", () => { $("ask-log").replaceChildren(); openAsk(true); });
// Today's brief: worked out on this device from the agenda, conversations and desks.
$("ask-brief").addEventListener("click", async () => {
  const log = $("ask-log");
  log.append(el("div", { class: "ask-msg me", text: "Today's brief" }));
  const out = [];
  try { agenda.channel = await personalDesk("agenda"); agenda.items = await invoke("desk_items", { channel: agenda.channel }); } catch { /* offline */ }
  const today = isoToday();
  const evs = events().filter((e) => e.date === today).sort((a, b) => (a.start || "").localeCompare(b.start || ""));
  out.push(el("p", { class: "brief-h", text: evs.length ? `${evs.length} ${evs.length === 1 ? "thing" : "things"} on today` : "Nothing on your agenda today" }));
  for (const e of evs) out.push(el("button", { class: "ask-hit", type: "button", onclick: () => openAgenda().then(() => openEvent(e)) }, el("small", { text: e.all_day ? "All day" : `${e.start}${e.end ? ` - ${e.end}` : ""}${e.where ? ` · ${e.where}` : ""}` }), el("span", { text: e.title })));
  const unread = channels.filter((c) => c.unread && (c.kind === "dm" || c.kind === "channel") && !c.desk);
  if (unread.length) {
    out.push(el("p", { class: "brief-h", text: `${unread.length} ${unread.length === 1 ? "conversation has" : "conversations have"} new messages` }));
    for (const c of unread.slice(0, 4)) out.push(el("button", { class: "ask-hit", type: "button", onclick: () => goTo(c.id) }, el("small", { text: whereOf(c) }), el("span", { text: c.last_text || c.name })));
  }
  for (const d of channels.filter((c) => c.desk === "collections")) {
    const line = await deskSummary(d);
    out.push(el("button", { class: "desk-card", type: "button", onclick: () => goTo(d.id) }, el("span", { class: "space-tile" }, icon("receipt")), el("span", { class: "lines" }, el("strong", { text: d.name }), el("small", { text: line }))));
  }
  out.push(el("p", { class: "fine", text: "Worked out on this device. Nothing was sent anywhere." }));
  log.append(el("div", { class: "ask-msg bot" }, ...out));
  log.scrollTop = log.scrollHeight;
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") { e.preventDefault(); openAsk($("ask").hidden); }
  else if (e.key === "Escape" && !$("ask").hidden && !mention && document.activeElement?.closest?.("#ask")) openAsk(false);
});
function fitAsk() { $("ask-send").disabled = !$("ask-input").value.trim(); }
$("ask-input").addEventListener("input", () => { fitAsk(); mentionInput($("ask-input")); });
$("ask-input").addEventListener("blur", closeMentionSoon);
$("ask-input").addEventListener("keydown", (e) => {
  if (mentionKey(e)) return;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("ask-form").requestSubmit(); }
});
$("ask-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("ask-input").value.trim();
  if (!q) return;
  $("ask-input").value = ""; fitAsk();
  const log = $("ask-log");
  log.append(el("div", { class: "ask-msg me" }, ...mentionChips(q)));
  const reply = el("div", { class: "ask-msg bot" }, el("p", { class: "fine", text: "Looking…" }));
  log.append(reply); log.scrollTop = log.scrollHeight;
  skMood("thinking");
  try {
    const parts = await answer(q);
    reply.replaceChildren(...parts);
    skMood(parts.length ? "success" : "idle", parts.length ? 1600 : 0);
  } catch (err) { reply.replaceChildren(el("p", { class: "error", text: String(err) })); skMood("error", 2400); }
  log.scrollTop = log.scrollHeight;
});
// The sidekick's face in the panel shows what it's doing (D34).
let skMoodTimer = null;
function skMood(state, back = 0) {
  const sk = profile?.sidekick;
  if (!sk) return;
  if (!askFace) paintAskHead();
  skPatch(askFace, sk.look, state);
  clearTimeout(skMoodTimer);
  if (back) skMoodTimer = setTimeout(() => skMood("idle"), back);
}
async function answer(q) {
  const out = [];
  const desks = mentionedDesks(q);
  for (const d of desks) {
    out.push(el("button", { class: "desk-card", type: "button", onclick: () => goTo(d.id) }, el("span", { class: "space-tile" }, icon(DESK_ICON[d.desk] || "sparkle")),
      el("span", { class: "lines" }, el("strong", { text: d.name }), el("small", { text: await deskSummary(d) }))));
  }
  let rest = q;
  const re = deskMatcher();
  if (re) rest = rest.replace(re, " ");
  const words = [...new Set(rest.toLowerCase().split(/[^\p{L}\p{N}#@.-]+/u).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 5);
  const scoped = view === "space" && currentSpace ? new Set(channels.filter((c) => c.space === currentSpace.id).map((c) => c.id)) : null;
  const score = new Map();
  for (const w of words) {
    let hits = [];
    try { hits = await invoke("search", { query: w }); } catch { /* keep going */ }
    for (const h of hits) {
      if (scoped && !scoped.has(h.channel)) continue;
      const k = `${h.channel}:${h.what}:${h.seq}:${h.text}`;
      const cur = score.get(k) || { h, n: 0 };
      cur.n += 1; score.set(k, cur);
    }
  }
  const ranked = [...score.values()].sort((a, b) => b.n - a.n || b.h.ts_ms - a.h.ts_ms).slice(0, 6);
  if (ranked.length) {
    out.push(el("p", { text: `${ranked.length === 1 ? "One thing" : `${ranked.length} things`} on this device match${ranked.length === 1 ? "es" : ""} ${words.map((w) => `\u201c${w}\u201d`).join(", ")}:` }));
    for (const { h } of ranked) {
      const c = channels.find((x) => x.id === h.channel);
      out.push(el("button", { class: "ask-hit", type: "button", onclick: () => goTo(h.channel) },
        el("small", { text: `${h.what === "record" ? h.by : `${h.by} · ${shortDate.format(h.ts_ms)}`} · ${whereOf(c)}` }), el("span", {}, ...highlight(h.text, words[0] || ""))));
    }
  } else if (!desks.length) {
    out.push(el("p", { text: words.length ? `Nothing on this device matches ${words.map((w) => `\u201c${w}\u201d`).join(", ")}.` : "Ask with a few words, like \u201cAcme invoice\u201d or \u201ccontract\u201d." }));
  }
  if (desks.length && !ranked.length && words.length) out.push(el("p", { class: "fine", text: "Questions beyond the desk's numbers need the desk agent, which comes with the Company Brain." }));
  return out;
}

// ---------- right-hand panels dock beside the page ----------
// People, Ask and threads sit next to the content and push it over, like a
// second column; on narrow windows they cover it instead.
function syncDock() {
  const open = !$("ask").hidden || !$("thread").hidden || RIGHT_PANELS.some((n) => !$(`drawer-${n}`).hidden);
  $("main").classList.toggle("dock-right", open && window.innerWidth >= 1100);
  // The composer's height depends on its width.
  requestAnimationFrame(fitComposer);
}

// Which list the sidebar shows: the space's desks and channels, or on Home the
// list for the section you're in (conversations, pages, what's coming).
function paintSide() {
  paintDrawers();
  show("side-space", view === "space");
  show("side-home", view === "home");
  renderTodos();
  renderSidePeople();
}
// People sit under the channels, on the left (D45): who's in this space and
// whether they're around. On Home the conversations above already are the people.
let sidePeopleFor = null;
async function renderSidePeople() {
  const sp = view === "space" ? currentSpace : null;
  show("side-people", !!sp);
  if (!sp || $("drawer-chats").hidden) return;
  show("side-people-invite", !profile?.is_guest);
  if (sidePeopleFor === sp.id && $("side-people-list").children.length) return;
  sidePeopleFor = sp.id;
  let members = [];
  try { members = await invoke("space_members", { space: sp.id }); } catch { sidePeopleFor = null; return; }
  if (currentSpace !== sp) return;
  const mine = handleOf(profile);
  // Who's around first, then by name.
  const rank = { online: 0, busy: 1, away: 2 };
  members.sort((a, b) => (rank[a.presence] ?? 3) - (rank[b.presence] ?? 3) || a.name.localeCompare(b.name));
  $("side-people-list").replaceChildren(...members.map((m) => {
    const me = m.handle && m.handle === mine;
    return el("button", { class: "side-item person", type: "button", title: m.handle ? `Message @${m.handle}` : m.name, disabled: me || !m.handle || undefined,
      onclick: async (e) => { await startDm(m.handle, "people-dm-error", e.currentTarget); } },
      m.is_agent ? sidekickEl(m.sidekick, "xs") : avatarEl(m.name, { color: m.color, avatar: m.avatar, sidekick: m.sidekick, presence: m.presence, size: "xs" }),
      el("span", { class: "name", text: me ? `${m.name} (you)` : m.name }), m.is_agent ? el("span", { class: "flag-pill warn", text: "AI" }) : null);
  }));
}
$("side-people-invite").addEventListener("click", () => openInvite());

// ---------- personal desks: agenda and notes ----------
// Each lives in a personal channel: only this person's devices are in it, so
// nobody else, the server included, can read it (ChannelKind::Personal).

const personal = { agenda: null, notes: null }; // channel ids
async function personalDesk(kind) {
  if (!personal[kind]) personal[kind] = await invoke("ensure_personal", { kind });
  return personal[kind];
}
const pad2 = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const monthLong = new Intl.DateTimeFormat(undefined, { month: "long" });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
function weekNumber(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  return Math.ceil(((t - new Date(Date.UTC(t.getUTCFullYear(), 0, 1))) / 864e5 + 1) / 7);
}
const mondayOf = (d) => { const x = new Date(d); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

// ---- agenda ----
const EV_COLORS = ["ink", "ember", "ocean", "spring", "plum"];
let agenda = { channel: null, items: [], dues: [], mode: readStore("anarchy.agendaMode", "month"), cursor: new Date() };
function events() { return agenda.items.filter((i) => i.kind === "event" && !i.data.deleted).map((i) => ({ id: i.id, ...i.data })); }
function dayEvents(iso) {
  const own = events().filter((e) => e.date === iso).sort((a, b) => (a.all_day ? -1 : 0) - (b.all_day ? -1 : 0) || (a.start || "").localeCompare(b.start || ""));
  return [...own, ...agenda.dues.filter((d) => d.date === iso)];
}
async function loadAgenda() {
  agenda.channel = await personalDesk("agenda");
  agenda.items = await invoke("desk_items", { channel: agenda.channel });
  // Invoices that fall due, from every Collections desk this device can read.
  const dues = [];
  for (const d of channels.filter((c) => c.desk === "collections")) {
    const items = await invoke("desk_items", { channel: d.id }).catch(() => []);
    for (const i of items) {
      if (i.kind !== "invoice" || !i.data.due || i.data.status === "paid" || i.data.status === "void" || i.data.status === "draft") continue;
      dues.push({ due: true, date: i.data.due, title: `${i.data.number} due · ${i.data.customer}`, channel: d.id, amount: i.data.amount });
    }
  }
  for (const d of channels.filter((c) => c.desk === "tasks")) {
    const items = await invoke("desk_items", { channel: d.id }).catch(() => []);
    const done = new Set(boardColumns(items).filter((c) => c.done).map((c) => c.id));
    for (const i of items) {
      if (i.kind !== "card" || i.data.deleted || !i.data.due || done.has(i.data.column)) continue;
      dues.push({ due: true, task: true, date: i.data.due, title: i.data.title, channel: d.id });
    }
  }
  agenda.dues = dues;
}
async function openAgenda() {
  if (thread) closeThread();
  current = personal.agenda; invoke("blur");
  hideMain(); show("view-agenda");
  try { await loadAgenda(); } catch (err) { $("cal-grid").replaceChildren(el("p", { class: "error", text: String(err) })); return; }
  current = agenda.channel;
  renderAgenda(); renderAgendaSide(); renderFolders(); renderTabs();
}
function chip(e) {
  const time = e.due ? "due" : e.all_day ? "" : e.start || "";
  return el("button", { class: `ev ${e.due ? "due" : `c-${e.color || "ink"}`}`, type: "button", title: e.where ? `${e.title} · ${e.where}` : e.title,
    onclick: (x) => { x.stopPropagation(); if (e.due) goTo(e.channel); else openEvent(e); } },
    el("span", { class: "ev-title", text: e.title }), time ? el("span", { class: "ev-time", text: time }) : null);
}
function renderAgenda() {
  const c = agenda.cursor;
  const today = isoToday();
  $("agenda-title").replaceChildren(`${monthLong.format(c)} `, el("span", { class: "soft", text: String(c.getFullYear()) }));
  // The week shown: this week if it's in view, else the first week of the month.
  const now = new Date();
  const ref = agenda.mode === "week" ? mondayOf(c) : (now.getMonth() === c.getMonth() && now.getFullYear() === c.getFullYear() ? now : new Date(c.getFullYear(), c.getMonth(), 1, 12));
  $("agenda-kind").textContent = `Agenda · Week ${weekNumber(ref)}`;
  for (const b of document.querySelectorAll(".agenda-mode button")) b.setAttribute("aria-selected", String(b.dataset.mode === agenda.mode));
  const heads = [...Array(7)].map((_, k) => { const d = mondayOf(new Date()); d.setDate(d.getDate() + k); return el("div", { class: "cal-dow", text: weekdayFmt.format(d) }); });
  const grid = $("cal-grid");
  grid.className = `cal-grid ${agenda.mode}`;
  if (agenda.mode === "day") {
    grid.className = "cal-grid day";
    renderDay(isoOf(c), grid);
    requestAnimationFrame(() => { grid.scrollTop = 1.5 * HOUR_PX; });
    return;
  }
  if (agenda.mode === "month") {
    const first = new Date(c.getFullYear(), c.getMonth(), 1, 12);
    const start = mondayOf(first);
    const cells = [];
    for (let k = 0; k < 42; k++) {
      const d = new Date(start); d.setDate(start.getDate() + k);
      if (k === 35 && d.getMonth() !== c.getMonth()) break;
      const iso = isoOf(d);
      const evs = dayEvents(iso);
      cells.push(el("div", { class: `cal-cell${d.getMonth() !== c.getMonth() ? " out" : ""}${iso === today ? " today" : ""}`, onclick: (e) => quickAdd(iso, e.currentTarget) },
        el("span", { class: "cal-day", text: String(d.getDate()) }),
        ...evs.slice(0, 3).map(chip),
        evs.length > 3 ? el("button", { class: "cal-more", type: "button", text: `${evs.length - 3} more`, onclick: (x) => { x.stopPropagation(); agenda.mode = "week"; agenda.cursor = d; renderAgenda(); } }) : null));
    }
    grid.replaceChildren(...heads, ...cells);
  } else {
    const start = mondayOf(c);
    const cols = [...Array(7)].map((_, k) => {
      const d = new Date(start); d.setDate(start.getDate() + k);
      const iso = isoOf(d);
      const evs = dayEvents(iso);
      return el("div", { class: `cal-col${iso === today ? " today" : ""}`, onclick: (e) => quickAdd(iso, e.currentTarget) },
        el("div", { class: "cal-col-head" }, el("span", { text: weekdayFmt.format(d) }), el("strong", { text: String(d.getDate()) })),
        ...(evs.length ? evs.map((e) => { const b = chip(e); b.classList.add("big"); if (!e.due && !e.all_day && e.end) b.append(el("span", { class: "ev-range", text: `${e.start} - ${e.end}` })); if (e.where) b.append(el("span", { class: "ev-where", text: e.where })); return b; }) : [el("p", { class: "fine cal-free", text: "Free" })]));
    });
    grid.replaceChildren(...cols);
  }
}
function renderAgendaSide() { /* the calendar shows it; no sidebar outside chats */ }
const stepDays = () => (agenda.mode === "day" ? 1 : 7);
$("agenda-prev").addEventListener("click", () => { const c = agenda.cursor; agenda.cursor = agenda.mode === "month" ? new Date(c.getFullYear(), c.getMonth() - 1, 1, 12) : new Date(c.getTime() - stepDays() * 864e5); renderAgenda(); });
$("agenda-next-btn").addEventListener("click", () => { const c = agenda.cursor; agenda.cursor = agenda.mode === "month" ? new Date(c.getFullYear(), c.getMonth() + 1, 1, 12) : new Date(c.getTime() + stepDays() * 864e5); renderAgenda(); });
$("agenda-today").addEventListener("click", () => { agenda.cursor = new Date(); renderAgenda(); });
for (const b of document.querySelectorAll(".agenda-mode button")) b.addEventListener("click", () => { agenda.mode = b.dataset.mode; writeStore("anarchy.agendaMode", agenda.mode); renderAgenda(); });

let editingEvent = null;
let evColor = "ink";
function paintEvColors() {
  $("ev-colors").replaceChildren(...EV_COLORS.map((c) => el("button", { class: `ev-swatch c-${c}`, type: "button", role: "radio", "aria-checked": String(c === evColor), "aria-label": c, onclick: () => { evColor = c; paintEvColors(); } })));
}
function openEvent(e, iso) {
  editingEvent = e || null;
  evColor = e?.color || "ink";
  $("dlg-event-title").textContent = e ? "Event" : "New event";
  $("ev-title").value = e?.title || "";
  $("ev-date").value = e?.date || iso || isoToday();
  $("ev-allday").checked = !!e?.all_day;
  $("ev-start").value = e?.start || "09:00"; $("ev-end").value = e?.end || "10:00";
  $("ev-where").value = e?.where || ""; $("ev-notes").value = e?.notes || "";
  for (const id of ["ev-start", "ev-end"]) $(id).disabled = $("ev-allday").checked;
  show("event-delete", !!e);
  setError("event-error", "");
  paintEvColors();
  $("dlg-event").showModal();
  $("ev-title").focus();
}
$("ev-allday").addEventListener("change", () => { for (const id of ["ev-start", "ev-end"]) $(id).disabled = $("ev-allday").checked; });
$("event-new").addEventListener("click", () => openEvent(null, isoOf(agenda.cursor)));
$("event-cancel").addEventListener("click", () => $("dlg-event").close());
async function putEvent(id, data) {
  const channel = await personalDesk("agenda");
  await invoke("put_items", { channel, items: [{ id, kind: "event", data }] });
  agenda.items = await invoke("desk_items", { channel });
  renderAgenda(); renderAgendaSide();
}
$("event-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("ev-title").value.trim();
  if (!title) return setError("event-error", "Give it a title.");
  const allDay = $("ev-allday").checked;
  if (!allDay && $("ev-end").value && $("ev-end").value < $("ev-start").value) return setError("event-error", "It ends before it starts.");
  const data = { title, date: $("ev-date").value || isoToday(), all_day: allDay, start: allDay ? "" : $("ev-start").value, end: allDay ? "" : $("ev-end").value, where: $("ev-where").value.trim(), notes: $("ev-notes").value.trim(), color: evColor };
  try { await putEvent(editingEvent?.id || crypto.randomUUID(), data); $("dlg-event").close(); } catch (err) { setError("event-error", String(err)); }
});
$("event-delete").addEventListener("click", async () => {
  if (!editingEvent) return;
  const { id, ...data } = editingEvent;
  try { await putEvent(id, { ...data, deleted: true }); $("dlg-event").close(); } catch (err) { setError("event-error", String(err)); }
});

// ---- notes: pages made of blocks ----
// A page is one record: a title, an icon and a list of blocks (paragraph,
// headings, bullets, to-dos, quote, code, divider). Latest save wins, so two
// devices editing the same page at once keep the last one; CRDT merging later.
// The same editor opens text files from a drive, saving them back as Markdown.

const BLOCKS = [["p", "Text", "Just writing"], ["h1", "Heading 1", "Big section title"], ["h2", "Heading 2", "Medium title"], ["h3", "Heading 3", "Small title"], ["bullet", "Bulleted list", "A simple list"], ["todo", "To-do", "Track tasks"], ["quote", "Quote", "Set text apart"], ["code", "Code", "Monospace, as typed"], ["divider", "Divider", "A line between sections"]];
const PAGE_ICONS = ["📝", "💡", "📌", "📅", "✅", "📚", "🧾", "🌱", "🎯", "🗂️"];
let notesState = { channel: null, items: [], query: "", shared: null }; // shared: the pages desk, when not your own notes
let note = null; // { id, title, icon, blocks, file?: { channel, id, name, folder } }
let noteTimer = null;
const newBlock = (type = "p", text = "") => ({ id: crypto.randomUUID().slice(0, 8), type, text, checked: false });
function pages() {
  const q = notesState.query.toLowerCase();
  return notesState.items.filter((i) => i.kind === "page" && !i.data.deleted)
    .map((i) => ({ id: i.id, ...i.data }))
    .filter((p) => !q || `${p.title} ${(p.blocks || []).map((b) => b.text).join(" ")}`.toLowerCase().includes(q))
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
}
// A pages desk (a space's shared wiki) opens in the same editor; everyone on
// the desk can read and edit its pages, and nobody else, the server included.
async function openNotes(pageId, shared = null) {
  if (thread) closeThread();
  hideMain(); show("view-notes");
  if (shared && notesState.shared?.id !== shared.id) { flushNote(); note = null; notesState.query = ""; $("note-search").value = ""; }
  if (!shared && notesState.shared) { flushNote(); note = null; }
  notesState.shared = shared;
  notesState.channel = shared ? shared.id : await personalDesk("notes").catch((err) => { alert(String(err)); return null; });
  if (!notesState.channel) return;
  current = notesState.channel; invoke("blur");
  notesState.items = await invoke("desk_items", { channel: notesState.channel });
  const list = pages();
  const pick = list.find((p) => p.id === (pageId || note?.id)) || list[0];
  if (pick) loadPage(pick); else { note = null; renderNote(); }
  renderNoteList(); renderFolders(); renderTabs();
}
function loadPage(p) {
  note = { id: p.id, title: p.title || "", icon: p.icon || "📝", blocks: (p.blocks && p.blocks.length ? p.blocks : [newBlock()]).map((b) => ({ ...newBlock(), ...b })) };
  renderNote();
}
function renderNoteList() {
  const list = pages();
  $("note-list").replaceChildren(...list.map((p) => el("button", { class: `side-item note-item${note && !note.file && note.id === p.id ? " active" : ""}`, type: "button", onclick: () => { flushNote(); loadPage(p); renderNoteList(); } },
    el("span", { class: "note-emoji", text: p.icon || "📝" }), el("span", { class: "lines" }, el("span", { class: "name", text: p.title || "Untitled" }), el("small", { text: p.updated ? sinceFmt(p.updated) : "" })))));
  show("no-notes", list.length === 0);
}
$("note-search").addEventListener("input", () => { notesState.query = $("note-search").value; renderNoteList(); });
$("note-new").addEventListener("click", async () => {
  flushNote();
  note = { id: crypto.randomUUID(), title: "", icon: PAGE_ICONS[Math.floor(Math.random() * PAGE_ICONS.length)], blocks: [newBlock()] };
  if ($("view-notes").hidden) await openNotes(undefined, notesState.shared);
  renderNote(); saveNoteSoon(0);
  $("note-title").focus();
});
function renderNote() {
  show("note-page", !!note);
  if (!note) {
    $("note-crumbs").replaceChildren(el("span", { text: notesState.shared ? notesState.shared.name : "Notes" }));
    $("note-blocks").replaceChildren();
    return;
  }
  $("note-crumbs").replaceChildren(...(note.file
    ? [el("button", { class: "link", type: "button", text: "Files", onclick: () => { flushNote(); goTo(note.file.channel); } }), el("span", { text: " / " }), el("span", { text: `${note.file.folder === "/" ? "" : `${note.file.folder.slice(1)} / `}${note.file.name}` })]
    : [el("span", { text: notesState.shared ? notesState.shared.name : "Notes" }), el("span", { text: " / " }), el("span", { text: note.title || "Untitled" })]));
  $("note-icon").textContent = note.file ? "📄" : note.icon;
  $("note-icon").disabled = !!note.file;
  $("note-title").textContent = note.file ? note.file.name : note.title;
  $("note-title").contentEditable = note.file ? "false" : "plaintext-only";
  show("note-delete", !note.file);
  $("note-blocks").replaceChildren(...note.blocks.map(blockEl));
  $("note-saved").textContent = "";
}
function blockEl(b) {
  if (b.type === "divider") {
    return el("div", { class: "blk divider", "data-id": b.id, tabindex: "0", onkeydown: (e) => { if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); removeBlock(b.id, -1); } else if (e.key === "Enter") { e.preventDefault(); insertAfter(b.id, newBlock()); } } }, el("hr"));
  }
  const txt = el("div", { class: "txt", contenteditable: "plaintext-only", spellcheck: b.type === "code" ? "false" : "true", "data-placeholder": b.type === "p" ? "Type / for blocks" : BLOCKS.find((x) => x[0] === b.type)?.[1] || "" });
  txt.textContent = b.text;
  txt.addEventListener("input", () => onBlockInput(b, txt));
  txt.addEventListener("keydown", (e) => onBlockKey(e, b, txt));
  const lead = b.type === "todo" ? el("input", { type: "checkbox", checked: b.checked, "aria-label": "Done", onchange: (e) => { b.checked = e.target.checked; wrap.classList.toggle("done", b.checked); saveNoteSoon(); } })
    : b.type === "bullet" ? el("span", { class: "bul", "aria-hidden": "true", text: "•" }) : null;
  const wrap = el("div", { class: `blk ${b.type}${b.checked ? " done" : ""}`, "data-id": b.id }, lead, txt);
  return wrap;
}
function caretOf(node) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !node.contains(sel.anchorNode)) return node.textContent.length;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(node); r.setEnd(sel.anchorNode, sel.anchorOffset);
  return r.toString().length;
}
function placeCaret(node, at) {
  node.focus();
  const sel = window.getSelection();
  const r = document.createRange();
  const t = node.firstChild;
  if (!t) { r.setStart(node, 0); } else { r.setStart(t, Math.min(at, t.textContent.length)); }
  r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
}
function txtOf(id) { return $("note-blocks").querySelector(`.blk[data-id="${id}"] .txt, .blk[data-id="${id}"].divider`); }
const SHORTCUTS = [[/^#\s$/, "h1"], [/^##\s$/, "h2"], [/^###\s$/, "h3"], [/^[-*]\s$/, "bullet"], [/^\[\s?\]\s$/, "todo"], [/^>\s$/, "quote"], [/^```$/, "code"], [/^---$/, "divider"]];
function onBlockInput(b, txt) {
  b.text = txt.textContent;
  if (b.type === "p") {
    for (const [re, type] of SHORTCUTS) if (re.test(b.text)) { turnInto(b, type, ""); return; }
  }
  if (b.text === "/") openSlash(b, txt); else if (!b.text.startsWith("/")) closeSlash(); else filterSlash(b.text.slice(1));
  saveNoteSoon();
}
function turnInto(b, type, text = b.text) {
  b.type = type; b.text = text;
  if (type === "divider") { const next = newBlock(); insertAfter(b.id, next, false); }
  rerenderKeepFocus(type === "divider" ? note.blocks[note.blocks.indexOf(b) + 1].id : b.id, 0);
  saveNoteSoon();
}
function rerenderKeepFocus(id, at) {
  $("note-blocks").replaceChildren(...note.blocks.map(blockEl));
  const t = txtOf(id);
  if (t) (t.classList.contains("divider") ? t.focus() : placeCaret(t, at ?? t.textContent.length));
}
function insertAfter(id, blk, focus = true) {
  const i = note.blocks.findIndex((x) => x.id === id);
  note.blocks.splice(i + 1, 0, blk);
  if (focus) rerenderKeepFocus(blk.id, 0);
  saveNoteSoon();
}
function removeBlock(id, dir) {
  const i = note.blocks.findIndex((x) => x.id === id);
  if (note.blocks.length === 1) { note.blocks[0] = newBlock(); rerenderKeepFocus(note.blocks[0].id, 0); return; }
  note.blocks.splice(i, 1);
  const to = note.blocks[Math.max(0, dir < 0 ? i - 1 : i)];
  rerenderKeepFocus(to.id);
  saveNoteSoon();
}
function onBlockKey(e, b, txt) {
  if (slash && handleSlashKey(e, b, txt)) return;
  const at = caretOf(txt);
  const i = note.blocks.indexOf(b);
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && b.type !== "code") {
    e.preventDefault();
    // An empty list item or to-do ends the list.
    if (!b.text && ["bullet", "todo", "quote", "h1", "h2", "h3"].includes(b.type)) { turnInto(b, "p"); return; }
    const after = b.text.slice(at);
    b.text = b.text.slice(0, at);
    const next = newBlock(["bullet", "todo"].includes(b.type) ? b.type : "p", after);
    note.blocks.splice(i + 1, 0, next);
    rerenderKeepFocus(next.id, 0); saveNoteSoon();
  } else if (e.key === "Enter" && e.shiftKey && b.type === "code") {
    e.preventDefault(); insertAfter(b.id, newBlock());
  } else if (e.key === "Backspace" && at === 0 && !window.getSelection().toString()) {
    if (b.type !== "p") { e.preventDefault(); turnInto(b, "p"); return; }
    if (i > 0) {
      e.preventDefault();
      const prev = note.blocks[i - 1];
      if (prev.type === "divider") { note.blocks.splice(i - 1, 1); rerenderKeepFocus(b.id, 0); saveNoteSoon(); return; }
      const join = prev.text.length;
      prev.text += b.text; note.blocks.splice(i, 1);
      rerenderKeepFocus(prev.id, join); saveNoteSoon();
    }
  } else if (e.key === "ArrowUp" && at === 0 && i > 0) {
    e.preventDefault(); const t = txtOf(note.blocks[i - 1].id); if (t) (t.classList.contains("divider") ? t.focus() : placeCaret(t, t.textContent.length));
  } else if (e.key === "ArrowDown" && at === txt.textContent.length && i < note.blocks.length - 1) {
    e.preventDefault(); const t = txtOf(note.blocks[i + 1].id); if (t) (t.classList.contains("divider") ? t.focus() : placeCaret(t, 0));
  }
}
// The "/" menu turns the current block into another kind.
let slash = null; // { block, cursor, items }
function openSlash(b, txt) {
  slash = { block: b, cursor: 0, items: BLOCKS };
  paintSlash(txt);
}
function filterSlash(q) {
  if (!slash) return;
  slash.items = BLOCKS.filter(([, label]) => label.toLowerCase().includes(q.toLowerCase()));
  slash.cursor = 0;
  if (!slash.items.length) return closeSlash();
  paintSlash(txtOf(slash.block.id));
}
function paintSlash(txt) {
  const pop = $("slash-pop");
  pop.replaceChildren(el("div", { class: "sr-group", text: "Turn into" }), ...slash.items.map(([type, label, sub], k) => el("button", { class: `sr-item${k === slash.cursor ? " active" : ""}`, type: "button", onmousedown: (e) => { e.preventDefault(); pickSlash(k); } },
    el("span", { class: "space-tile slash-glyph", text: { p: "¶", h1: "H1", h2: "H2", h3: "H3", bullet: "•", todo: "☐", quote: "❝", code: "</>", divider: "—" }[type] }), el("span", { class: "lines" }, el("span", { text: label }), el("small", { text: sub })))));
  const r = txt.getBoundingClientRect(), host = $("view-notes").getBoundingClientRect();
  pop.style.left = `${Math.round(r.left - host.left)}px`;
  pop.style.top = `${Math.round(r.bottom - host.top + 6)}px`;
  show(pop, true);
}
function closeSlash() { slash = null; show("slash-pop", false); }
function pickSlash(k) { const [type] = slash.items[k]; const b = slash.block; closeSlash(); turnInto(b, type, ""); }
function handleSlashKey(e, b, txt) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); slash.cursor = (slash.cursor + (e.key === "ArrowDown" ? 1 : -1) + slash.items.length) % slash.items.length; paintSlash(txt); return true; }
  if (e.key === "Enter") { e.preventDefault(); pickSlash(slash.cursor); return true; }
  if (e.key === "Escape") { e.preventDefault(); closeSlash(); return true; }
  return false;
}
$("note-title").addEventListener("input", () => {
  if (!note || note.file) return;
  note.title = $("note-title").textContent.trim();
  const last = $("note-crumbs").lastElementChild;
  if (last) last.textContent = note.title || "Untitled";
  saveNoteSoon();
});
$("note-title").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const t = txtOf(note.blocks[0].id); if (t) placeCaret(t, 0); } });
$("note-icon").addEventListener("click", () => { if (!note || note.file) return; note.icon = PAGE_ICONS[(PAGE_ICONS.indexOf(note.icon) + 1) % PAGE_ICONS.length]; $("note-icon").textContent = note.icon; saveNoteSoon(); });
$("note-delete").addEventListener("click", async () => {
  if (!note || note.file || !confirm(`Delete "${note.title || "Untitled"}"? ${notesState.shared ? "It's removed for everyone on this desk." : "It's removed from all your devices."}`)) return;
  const { id, file, ...data } = note; void file;
  clearTimeout(noteTimer);
  await invoke("put_items", { channel: notesState.channel, items: [{ id, kind: "page", data: { ...data, deleted: true, updated: Date.now() } }] });
  if (notesState.shared) invoke("send_message", { channel: notesState.channel, text: `Deleted the page "${data.title || "Untitled"}".` }).catch(() => {});
  note = null;
  await openNotes(undefined, notesState.shared);
});
function saveNoteSoon(ms = 700) {
  if (!note) return;
  $("note-saved").textContent = "Editing…";
  clearTimeout(noteTimer);
  noteTimer = setTimeout(saveNote, ms);
}
function flushNote() { if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; saveNote(); } }
async function saveNote() {
  noteTimer = null;
  if (!note) return;
  const n = note, ch = notesState.channel, shared = notesState.shared;
  try {
    if (n.file) {
      await invoke("save_text_file", { channel: n.file.channel, id: n.file.id, text: toMarkdown(n.blocks) });
    } else {
      const data = { title: n.title, icon: n.icon, blocks: n.blocks.map(({ id, type, text, checked }) => ({ id, type, text, checked })), updated: Date.now() };
      await invoke("put_items", { channel: ch, items: [{ id: n.id, kind: "page", data }] });
      if (notesState.channel !== ch) return; // moved to another notes desk meanwhile
      const at = notesState.items.findIndex((i) => i.id === n.id);
      // Shared pages: a new page is announced once in the desk's activity (edits aren't, they'd flood it).
      if (at < 0 && shared && n.title) invoke("send_message", { channel: ch, text: `Added the page "${n.title}".` }).catch(() => {});
      const rec = { id: n.id, kind: "page", data, seq: 0, updated_ms: data.updated };
      if (at >= 0) notesState.items[at] = rec; else notesState.items.push(rec);
      renderNoteList();
    }
    if (note === n) $("note-saved").textContent = n.file ? "Saved to the drive, encrypted" : notesState.shared ? "Saved · everyone on this desk can read it" : "Saved · only your devices can read it";
  } catch (err) { $("note-saved").textContent = `Not saved: ${err}`; }
}
function toMarkdown(blocks) {
  return blocks.map((b) => ({ p: b.text, h1: `# ${b.text}`, h2: `## ${b.text}`, h3: `### ${b.text}`, bullet: `- ${b.text}`, todo: `- [${b.checked ? "x" : " "}] ${b.text}`, quote: `> ${b.text}`, code: `\`\`\`\n${b.text}\n\`\`\``, divider: "---" }[b.type] ?? b.text)).join("\n\n") + "\n";
}
function fromMarkdown(md) {
  const out = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (l.startsWith("```")) { const body = []; k++; while (k < lines.length && !lines[k].startsWith("```")) body.push(lines[k++]); out.push(newBlock("code", body.join("\n"))); continue; }
    if (!l.trim()) continue;
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(l))) out.push(newBlock(`h${m[1].length}`, m[2]));
    else if ((m = /^[-*]\s+\[([ xX])\]\s*(.*)$/.exec(l))) { const b = newBlock("todo", m[2]); b.checked = m[1] !== " "; out.push(b); }
    else if ((m = /^[-*]\s+(.*)$/.exec(l))) out.push(newBlock("bullet", m[1]));
    else if ((m = /^>\s?(.*)$/.exec(l))) out.push(newBlock("quote", m[1]));
    else if (/^(---|\*\*\*)\s*$/.test(l)) out.push(newBlock("divider"));
    else out.push(newBlock("p", l));
  }
  return out.length ? out : [newBlock()];
}
// Opens a text or Markdown file from a drive in the editor.
async function editDriveFile(f) {
  let text = "";
  try { const pv = await invoke("preview_file", { channel: drive.channel, id: f.id }); text = pv.kind === "text" ? pv.data : ""; } catch (err) { alert(String(err)); return; }
  flushNote();
  note = { id: f.id, title: f.data.name, icon: "📄", blocks: fromMarkdown(text), file: { channel: drive.channel, id: f.id, name: f.data.name, folder: f.data.folder || "/" } };
  hideMain(); show("view-notes");
  renderNote(); renderFolders();
}

// Home's own Files and Tasks: personal desks like the agenda and notes.
async function openPersonal(kind) {
  const id = await personalDesk(kind).catch((err) => { alert(String(err)); return null; });
  if (!id) return;
  if (!channels.some((c) => c.id === id)) await refreshChannels();
  await openChannel(id);
}

// ---------- tasks: a board of cards ----------
// Cards are records (kind "card") with a column, an order, a due date, who's on
// it and a label. Columns are one "settings" record. Drag cards between
// columns; the last column counts as done.

const DEFAULT_COLUMNS = [{ id: "todo", name: "To do" }, { id: "doing", name: "Doing" }, { id: "done", name: "Done", done: true }];
function boardColumns(items) {
  const cols = items.find((i) => i.kind === "settings" && i.id === "columns")?.data?.list;
  const list = cols && cols.length ? cols : DEFAULT_COLUMNS;
  return list.map((c, k) => ({ ...c, done: c.done ?? k === list.length - 1 }));
}
function taskStats(items) {
  const done = new Set(boardColumns(items).filter((c) => c.done).map((c) => c.id));
  const cards = items.filter((i) => i.kind === "card" && !i.data.deleted);
  const open = cards.filter((c) => !done.has(c.data.column));
  const today = isoToday(), week = addDays(today, 7);
  return { total: cards.length, open: open.length, done: cards.length - open.length,
    late: open.filter((c) => c.data.due && c.data.due < today).length, week: open.filter((c) => c.data.due && c.data.due >= today && c.data.due <= week).length };
}
let board = { channel: null, name: "", items: [], query: "", personal: false };
async function openBoard(c) {
  if (thread) closeThread();
  hideMain(); show("view-board");
  current = c.id; invoke("blur");
  if (board.channel !== c.id) { board = { channel: c.id, name: c.name, items: [], query: "", personal: c.kind === "personal" }; $("board-search").value = ""; }
  board.items = await invoke("desk_items", { channel: c.id });
  renderBoard(); renderFolders(); renderTabs(); refreshChannels();
}
function boardCards() { return board.items.filter((i) => i.kind === "card" && !i.data.deleted).map((i) => ({ id: i.id, ...i.data })); }
function renderBoard() {
  const cols = boardColumns(board.items);
  const st = taskStats(board.items);
  const sp = spaces.find((x) => x.id === channels.find((c) => c.id === board.channel)?.space);
  $("board-kind").textContent = board.personal ? "Your tasks · only your devices can read them" : `${sp?.name || ""} · ${board.name}`;
  $("board-headline").replaceChildren(st.total ? `${st.open} open, ` : "Nothing on the board ", el("span", { class: "soft", text: st.total ? `${st.late ? `${st.late} late, ` : ""}${st.week} due this week.` : "yet." }));
  const q = board.query.toLowerCase();
  const all = boardCards().filter((c) => !q || `${c.title} ${c.who || ""} ${c.notes || ""}`.toLowerCase().includes(q));
  const today = isoToday();
  $("board").replaceChildren(...cols.map((col) => {
    const cards = all.filter((c) => (c.column || cols[0].id) === col.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const list = el("div", { class: "col-cards", "data-col": col.id });
    for (const c of cards) {
      const late = c.due && c.due < today && !col.done;
      list.append(el("div", { class: `bcard${col.done ? " done" : ""}`, draggable: "true", "data-id": c.id, tabindex: "0",
        ondragstart: (e) => { e.dataTransfer.setData("text/plain", c.id); e.dataTransfer.effectAllowed = "move"; e.currentTarget.classList.add("dragging"); },
        ondragend: (e) => e.currentTarget.classList.remove("dragging"),
        onclick: () => openCard(c), onkeydown: (e) => { if (e.key === "Enter") openCard(c); } },
        c.color && c.color !== "ink" ? el("span", { class: `bcard-label c-${c.color}` }) : null,
        el("span", { class: "bcard-title", text: c.title }),
        (c.due || c.who || c.notes) ? el("span", { class: "bcard-meta" },
          c.due ? el("span", { class: `bcard-due${late ? " late" : ""}` }, icon("calendar"), shortDate.format(asDate(c.due))) : null,
          c.notes ? el("span", { class: "bcard-notes", title: "Has notes" }, icon("note")) : null,
          c.who ? el("span", { class: "bcard-who", title: c.who }, avatarEl(c.who, { size: "sm" })) : null) : null));
    }
    const adder = el("div", { class: "col-add" });
    const openAdder = () => {
      const ta = el("textarea", { class: "text-input", rows: "2", placeholder: "What needs doing?" });
      const done = () => { adder.replaceChildren(addBtn); };
      ta.addEventListener("keydown", async (e) => {
        if (e.key === "Escape") { done(); return; }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const t = ta.value.trim(); if (!t) return done(); await addCard(col.id, t); openAdderAgain(col.id); }
      });
      ta.addEventListener("blur", () => setTimeout(() => { if (!ta.value.trim()) done(); }, 150));
      adder.replaceChildren(ta, el("p", { class: "fine", text: "Enter to add, Esc to stop" }));
      ta.focus();
    };
    const addBtn = el("button", { class: "col-add-btn", type: "button", onclick: openAdder }, icon("plus"), el("span", { text: "Add a card" }));
    adder.append(addBtn);
    const column = el("section", { class: `bcol${col.done ? " done" : ""}`, "data-col": col.id,
      ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add("over"); },
      ondragleave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove("over"); },
      ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove("over"); moveCard(e.dataTransfer.getData("text/plain"), col.id, e.clientY, list); } },
      el("header", { class: "bcol-head" }, el("span", { class: "bcol-dot" }), el("strong", { text: col.name }), el("span", { class: "n", text: String(cards.length) })),
      list, adder);
    return column;
  }));
}
let pendingAdder = null;
function openAdderAgain(colId) { pendingAdder = colId; }
async function putCards(recs) {
  await invoke("put_items", { channel: board.channel, items: recs });
  board.items = await invoke("desk_items", { channel: board.channel });
  renderBoard();
  loadTodos().then(renderTodos).catch(() => {});
  if (pendingAdder) { const col = document.querySelector(`.bcol[data-col="${pendingAdder}"] .col-add-btn`); pendingAdder = null; col?.click(); }
}
async function addCard(colId, title) {
  const last = boardCards().filter((c) => c.column === colId).reduce((m, c) => Math.max(m, c.order ?? 0), 0);
  await putCards([{ id: crypto.randomUUID(), kind: "card", data: { title, column: colId, order: last + 1, color: "ink", added: Date.now(), hist: [[colId, Date.now()]] } }]);
}
// Drops a card in a column, between the cards above and below the pointer.
async function moveCard(id, colId, y, list) {
  const card = boardCards().find((c) => c.id === id);
  if (!card) return;
  const others = [...list.querySelectorAll(".bcard")].filter((n) => n.dataset.id !== id);
  const below = others.find((n) => { const r = n.getBoundingClientRect(); return y < r.top + r.height / 2; });
  const orderOf = (n) => boardCards().find((c) => c.id === n?.dataset.id)?.order ?? 0;
  let order;
  if (!others.length) order = 1;
  else if (!below) order = orderOf(others[others.length - 1]) + 1;
  else { const idx = others.indexOf(below); order = idx === 0 ? orderOf(below) - 1 : (orderOf(others[idx - 1]) + orderOf(below)) / 2; }
  const { id: _, ...data } = card;
  const moved = data.column !== colId;
  // Each column change is kept (D35), so the pipeline on Home has real history.
  const hist = moved ? [...(data.hist || []), [colId, Date.now()]].slice(-40) : data.hist;
  await putCards([{ id, kind: "card", data: { ...data, column: colId, order, ...(hist ? { hist } : {}) } }]);
  if (moved && !board.personal) {
    const col = boardColumns(board.items).find((c) => c.id === colId);
    try { await invoke("send_message", { channel: board.channel, text: `Moved \u201c${card.title}\u201d to ${col?.name || colId}.` }); } catch { /* the move is saved either way */ }
  }
}
let editingCard = null, cardColor = "ink";
function openCard(c) {
  editingCard = c || null;
  const cols = boardColumns(board.items);
  $("dlg-card-title").textContent = c ? "Card" : "New card";
  $("cd-title").value = c?.title || "";
  $("cd-col").replaceChildren(...cols.map((col) => el("option", { value: col.id, text: col.name, selected: (c?.column || cols[0].id) === col.id })));
  $("cd-due").value = c?.due || "";
  $("cd-who").value = c?.who || "";
  $("cd-notes").value = c?.notes || "";
  cardColor = c?.color || "ink";
  paintCardColors();
  show("card-delete", !!c);
  setError("card-error", "");
  const sp = channels.find((x) => x.id === board.channel)?.space;
  if (sp) invoke("space_members", { space: sp }).then((m) => $("cd-people").replaceChildren(...m.map((p) => el("option", { value: p.name })))).catch(() => {});
  $("dlg-card").showModal();
  $("cd-title").focus();
}
function paintCardColors() {
  $("cd-colors").replaceChildren(...EV_COLORS.map((c) => el("button", { class: `ev-swatch c-${c}`, type: "button", role: "radio", "aria-checked": String(c === cardColor), "aria-label": c, onclick: () => { cardColor = c; paintCardColors(); } })));
}
$("board-new").addEventListener("click", () => openCard(null));
$("board-search").addEventListener("input", () => { board.query = $("board-search").value; renderBoard(); });
$("board-add-col").addEventListener("click", async () => {
  const name = prompt("Name the new column", "Review");
  if (!name?.trim()) return;
  const cols = boardColumns(board.items).map(({ id, name: n }) => ({ id, name: n }));
  cols.splice(cols.length - 1, 0, { id: crypto.randomUUID().slice(0, 8), name: name.trim() });
  await putCards([{ id: "columns", kind: "settings", data: { list: cols } }]);
});
$("card-cancel").addEventListener("click", () => $("dlg-card").close());
$("card-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("cd-title").value.trim();
  if (!title) return setError("card-error", "Give the card a title.");
  const colId = $("cd-col").value;
  const base = editingCard ? (({ id, ...d }) => d)(editingCard) : { added: Date.now(), order: boardCards().filter((c) => c.column === colId).reduce((m, c) => Math.max(m, c.order ?? 0), 0) + 1 };
  const data = { ...base, title, column: colId, due: $("cd-due").value || null, who: $("cd-who").value.trim() || null, notes: $("cd-notes").value.trim(), color: cardColor };
  if (base.column !== colId) data.hist = [...(base.hist || []), [colId, Date.now()]].slice(-40);
  try { await putCards([{ id: editingCard?.id || crypto.randomUUID(), kind: "card", data }]); $("dlg-card").close(); } catch (err) { setError("card-error", String(err)); }
});
$("card-delete").addEventListener("click", async () => {
  if (!editingCard) return;
  const { id, ...data } = editingCard;
  await putCards([{ id, kind: "card", data: { ...data, deleted: true } }]);
  $("dlg-card").close();
});

// ---------- agenda: quick add, day view, search ----------
let quick = null; // { iso, start }
let qeColor = "ink";
function paintQuickColors() {
  $("qe-colors").replaceChildren(...EV_COLORS.map((c) => el("button", { class: `ev-swatch sm c-${c}`, type: "button", role: "radio", "aria-checked": String(c === qeColor), "aria-label": c, onclick: () => { qeColor = c; paintQuickColors(); } })));
}
// Opens a small form by the day (or hour) you clicked; "More options" opens the full one.
function quickAdd(iso, anchor, start) {
  const pop = $("quick-event");
  quick = { iso, start };
  qeColor = "ink";
  $("qe-title").value = "";
  $("qe-when").textContent = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(asDate(iso));
  const s = start || "09:00";
  const [h, m] = s.split(":").map(Number);
  $("qe-start").value = s; $("qe-end").value = `${pad2(Math.min(23, h + 1))}:${pad2(m)}`;
  $("qe-allday").checked = false; $("qe-start").disabled = $("qe-end").disabled = false;
  paintQuickColors();
  const host = $("view-agenda").getBoundingClientRect(), r = anchor.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.left - host.left), host.width - 300);
  const top = Math.min(r.top - host.top + Math.min(r.height, 40), host.height - 230);
  pop.style.left = `${left}px`; pop.style.top = `${top}px`;
  show(pop, true);
  $("qe-title").focus();
}
function closeQuick() { quick = null; show("quick-event", false); }
$("qe-allday").addEventListener("change", () => { $("qe-start").disabled = $("qe-end").disabled = $("qe-allday").checked; });
$("qe-title").addEventListener("keydown", (e) => { if (e.key === "Escape") closeQuick(); });
$("qe-more").addEventListener("click", () => {
  const iso = quick?.iso;
  const draft = { title: $("qe-title").value, start: $("qe-start").value, end: $("qe-end").value, all_day: $("qe-allday").checked, color: qeColor };
  closeQuick();
  openEvent(null, iso);
  $("ev-title").value = draft.title; $("ev-start").value = draft.start; $("ev-end").value = draft.end; $("ev-allday").checked = draft.all_day; evColor = draft.color; paintEvColors();
  for (const id of ["ev-start", "ev-end"]) $(id).disabled = draft.all_day;
});
$("quick-event").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("qe-title").value.trim();
  if (!title || !quick) return $("qe-title").focus();
  const allDay = $("qe-allday").checked;
  const data = { title, date: quick.iso, all_day: allDay, start: allDay ? "" : $("qe-start").value, end: allDay ? "" : $("qe-end").value, where: "", notes: "", color: qeColor };
  closeQuick();
  await putEvent(crypto.randomUUID(), data);
});
document.addEventListener("mousedown", (e) => { if (quick && !e.target.closest("#quick-event")) closeQuick(); });
$("agenda-q").addEventListener("input", () => {
  const q = $("agenda-q").value.trim().toLowerCase();
  const box = $("agenda-results");
  if (!q) { show(box, false); return; }
  const hits = [...events(), ...agenda.dues].filter((e) => `${e.title} ${e.where || ""} ${e.notes || ""}`.toLowerCase().includes(q)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 12);
  box.replaceChildren(...(hits.length ? hits.map((e) => el("button", { class: "sr-item", type: "button", onmousedown: (x) => x.preventDefault(), onclick: () => { show(box, false); $("agenda-q").value = ""; agenda.cursor = asDate(e.date); agenda.mode = "day"; renderAgenda(); if (!e.due) openEvent(e); } },
    el("span", { class: `ev-dot ${e.due ? "due" : `c-${e.color || "ink"}`}` }), el("span", { class: "lines" }, el("span", { text: e.title }), el("small", { text: `${dateFmt.format(asDate(e.date))}${e.start ? ` · ${e.start}` : ""}` }))))
    : [el("p", { class: "sr-empty", text: "Nothing on your agenda matches." })]));
  show(box, true);
});
$("agenda-q").addEventListener("blur", () => setTimeout(() => show("agenda-results", false), 150));
// Day view: hours from 7 to 22, events placed by their times.
const DAY_FROM = 7, DAY_TO = 22, HOUR_PX = 52;
function renderDay(iso, grid) {
  const evs = dayEvents(iso);
  const allDay = evs.filter((e) => e.due || e.all_day || !e.start);
  const timed = evs.filter((e) => !e.due && !e.all_day && e.start);
  const mins = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const hours = el("div", { class: "day-hours", style: `height:${(DAY_TO - DAY_FROM) * HOUR_PX}px` });
  for (let h = DAY_FROM; h < DAY_TO; h++) {
    hours.append(el("div", { class: "day-hour", style: `top:${(h - DAY_FROM) * HOUR_PX}px`, onclick: (e) => quickAdd(iso, e.currentTarget, `${pad2(h)}:00`) }, el("span", { class: "day-hlabel", text: `${pad2(h)}:00` })));
  }
  for (const e of timed) {
    const top = Math.max(0, (mins(e.start) - DAY_FROM * 60) / 60 * HOUR_PX);
    const len = Math.max(26, ((e.end ? mins(e.end) : mins(e.start) + 60) - mins(e.start)) / 60 * HOUR_PX - 3);
    const b = chip(e); b.classList.add("big", "day-ev"); b.style.top = `${top}px`; b.style.height = `${len}px`;
    b.append(el("span", { class: "ev-range", text: `${e.start}${e.end ? ` - ${e.end}` : ""}${e.where ? ` · ${e.where}` : ""}` }));
    hours.append(b);
  }
  if (iso === isoToday()) {
    const now = new Date(); const m = now.getHours() * 60 + now.getMinutes();
    if (m >= DAY_FROM * 60 && m <= DAY_TO * 60) hours.append(el("div", { class: "day-now", style: `top:${(m - DAY_FROM * 60) / 60 * HOUR_PX}px` }));
  }
  grid.replaceChildren(el("div", { class: "day-top" }, el("strong", { text: new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(asDate(iso)) }), ...allDay.map(chip)), hours);
}

// Home: what's on today, next to your spaces.
// ---------- Home (D35, after Ottas) ----------
// A greeting with what's going on, the task pipeline across every board you
// can read, and a Today list. Everything is worked out on this device.
const PIPE_STAGES = [["todo", "To do"], ["doing", "In progress"], ["done", "Done"]];
let pipeCards = [], todayTab = "all";
// Which stage a column is: the first is to do, the last (or one marked done)
// is done, anything between is in progress.
function stageOf(cols, colId) {
  const k = cols.findIndex((c) => c.id === colId);
  if (k < 0) return "todo";
  if (cols[k].done) return "done";
  return k === 0 ? "todo" : "doing";
}
async function loadPipeline() {
  const out = [];
  for (const d of channels.filter((c) => c.desk === "tasks")) {
    const items = await invoke("desk_items", { channel: d.id }).catch(() => []);
    const cols = boardColumns(items);
    for (const i of items) {
      if (i.kind !== "card" || i.data.deleted) continue;
      // Cards from before history was kept count in their current column since they were added.
      const hist = (i.data.hist?.length ? i.data.hist : [[i.data.column, i.data.added || i.updated_ms]]).map(([c, t]) => [stageOf(cols, c), t]);
      out.push({ id: i.id, stage: stageOf(cols, i.data.column), hist, added: i.data.added || hist[0][1], due: i.data.due, title: i.data.title, desk: d });
    }
  }
  pipeCards = out;
}
// Count per stage at the end of each of the last `days` days.
function pipeSeries(days = 30) {
  const end = new Date(); end.setHours(23, 59, 59, 999);
  const series = Object.fromEntries(PIPE_STAGES.map(([k]) => [k, []]));
  for (let d = days - 1; d >= 0; d--) {
    const t = end.getTime() - d * 864e5;
    const n = { todo: 0, doing: 0, done: 0 };
    for (const c of pipeCards) {
      if (c.added > t) continue;
      let st = null;
      for (const [stage, at] of c.hist) if (at <= t) st = stage;
      n[st || c.hist[0][0]]++;
    }
    for (const [k] of PIPE_STAGES) series[k].push({ t, v: n[k] });
  }
  return series;
}
function renderPipeline() {
  const series = pipeSeries();
  const W = 260, H = 96, P = 4;
  const fmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  const panels = PIPE_STAGES.map(([k, label], s) => {
    const pts = series[k];
    const now = pts.at(-1).v, weekAgo = pts.at(-8)?.v ?? pts[0].v;
    const diff = now - weekAgo;
    const max = Math.max(4, ...Object.values(series).flat().map((p) => p.v));
    const x = (i) => P + (i / (pts.length - 1)) * (W - 2 * P);
    const y = (v) => H - P - (v / max) * (H - 2 * P - 6);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join("");
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "pipe-chart"); svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = `<line class="pipe-base" x1="${P}" x2="${W - P}" y1="${H - P}" y2="${H - P}"/><path class="pipe-area" d="${line}L${x(pts.length - 1)} ${H - P}L${x(0)} ${H - P}Z"/><path class="pipe-line" d="${line}"/><circle class="pipe-end" r="4" cx="${x(pts.length - 1)}" cy="${y(now)}"/><line class="pipe-cross" y1="${P}" y2="${H - P}" x1="-10" x2="-10"/><circle class="pipe-dot" r="4" cx="-10" cy="-10"/>`;
    const tip = el("div", { class: "pipe-tip", hidden: "" });
    const panel = el("div", { class: "pipe-panel", style: `--series:var(--series-${s + 1})` },
      el("p", { class: "pipe-label" }, el("span", { class: "pipe-key" }), label),
      el("strong", { class: "pipe-n", text: String(now) }),
      el("p", { class: "pipe-diff" }, el("span", { class: `chip ${diff > 0 ? "up" : diff < 0 ? "down" : ""}`, text: diff === 0 ? "No change" : `${diff > 0 ? "+" : "\u2212"}${Math.abs(diff)}` }), " vs a week ago"),
      el("div", { class: "pipe-plot" }, svg, tip));
    // Crosshair and readout: nearest day to the pointer.
    const plot = panel.querySelector(".pipe-plot");
    plot.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(((e.clientX - r.left) / r.width * W - P) / (W - 2 * P) * (pts.length - 1))));
      svg.querySelector(".pipe-cross").setAttribute("x1", x(i)); svg.querySelector(".pipe-cross").setAttribute("x2", x(i));
      const dot = svg.querySelector(".pipe-dot"); dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(pts[i].v));
      tip.textContent = `${fmt.format(pts[i].t)} · ${pts[i].v} ${pts[i].v === 1 ? "card" : "cards"}`;
      tip.style.left = `${(x(i) / W) * 100}%`;
      show(tip, true);
    });
    plot.addEventListener("pointerleave", () => { show(tip, false); svg.querySelector(".pipe-cross").setAttribute("x1", -10); svg.querySelector(".pipe-cross").setAttribute("x2", -10); svg.querySelector(".pipe-dot").setAttribute("cx", -10); });
    return panel;
  });
  $("pipe-grid").replaceChildren(...panels);
  // The same numbers as a table, for screen readers.
  $("pipe-table").replaceChildren(el("caption", { text: "Cards per stage, last 30 days" }),
    el("tr", {}, el("th", { text: "Day" }), ...PIPE_STAGES.map(([, l]) => el("th", { text: l }))),
    ...series.todo.map((p, i) => el("tr", {}, el("td", { text: fmt.format(p.t) }), ...PIPE_STAGES.map(([k]) => el("td", { text: String(series[k][i].v) })))));
  show($("pipe-grid").closest(".pipe"), pipeCards.length > 0);
}
function todayItems() {
  const today = isoToday();
  const out = [];
  for (const c of pipeCards) {
    if (c.stage === "done" || !c.due || c.due > today) continue;
    out.push({ kind: "task", late: c.due < today, icon: "board", title: c.title, sub: `${c.desk.kind === "personal" ? "My tasks" : c.desk.name} · ${c.due < today ? `was due ${shortDay(c.due)}` : "due today"}`, at: c.due, go: () => openChannel(c.desk.id) });
  }
  for (const e of dayEvents(today).filter((e) => !e.due)) out.push({ kind: "agenda", icon: "calendar", title: e.title, sub: e.all_day ? "All day" : `${e.start}${e.end ? ` - ${e.end}` : ""}${e.where ? ` · ${e.where}` : ""}`, at: e.start || "", go: () => openAgenda().then(() => openEvent(e)) });
  for (const c of channels) if (c.unread && c.kind !== "personal") out.push({ kind: "msg", icon: c.kind === "dm" ? "chat" : "thread", title: c.kind === "dm" ? c.name : `#${c.name}`, sub: c.last_text || "New messages", at: "", go: () => goTo(c.id) });
  return out.sort((a, b) => (b.late ? 1 : 0) - (a.late ? 1 : 0));
}
function renderTodayList() {
  const items = todayItems();
  const tabs = [["all", "All"], ["task", "Tasks"], ["msg", "Unread"], ["agenda", "Agenda"]];
  const n = (k) => (k === "all" ? items : items.filter((i) => i.kind === k)).length;
  $("today-pills").replaceChildren(...tabs.map(([k, label]) => el("button", { class: `pill-tab${todayTab === k ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(todayTab === k), onclick: () => { todayTab = k; renderTodayList(); } }, label, el("span", { class: "n", text: String(n(k)) }))));
  const shown = todayTab === "all" ? items : items.filter((i) => i.kind === todayTab);
  $("today-list").replaceChildren(...(shown.length ? shown.map((i) => el("button", { class: `inbox-row${i.late ? " late" : ""}`, type: "button", onclick: i.go },
    el("span", { class: "inbox-icon" }, icon(i.icon)), el("span", { class: "lines" }, el("strong", { text: i.title }), el("small", { text: i.sub })),
    el("span", { class: "inbox-kind", text: i.late ? "Late" : { task: "Due", msg: "Unread", agenda: "Agenda" }[i.kind] }), el("time", { text: i.kind === "agenda" ? (i.at || "") : "" }), el("span")))
    : [el("div", { class: "inbox-empty" }, icon("check"), el("strong", { text: "Nothing for today" }), el("p", { class: "fine", text: "Tasks due today, unread conversations and today's agenda show up here." }))]));
}
async function renderHomeToday() {
  try {
    agenda.channel = await personalDesk("agenda");
    agenda.items = await invoke("desk_items", { channel: agenda.channel });
    await loadPipeline();
  } catch { /* offline: show what's there */ }
  renderPipeline();
  renderTodayList();
  renderHomeHeadline();
}

function renderHomeHeadline() {
  const hour = new Date().getHours();
  const hello = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = (profile?.display_name || "").split(" ")[0];
  $("home-headline").textContent = `${hello}${first ? `, ${first}` : ""}`;
  const today = isoToday();
  const doing = pipeCards.filter((c) => c.stage === "doing").length;
  const late = pipeCards.filter((c) => c.stage !== "done" && c.due && c.due < today).length;
  const unread = channels.filter((c) => c.unread && c.kind !== "personal").length;
  const next = dayEvents(today).filter((e) => !e.due && e.start && e.start >= new Date().toTimeString().slice(0, 5)).sort((a, b) => a.start.localeCompare(b.start))[0];
  const bits = [
    doing ? el("span", { text: `${doing} in progress` }) : null,
    el("span", { text: unread ? `${unread} unread` : "nothing unread" }),
    late ? el("span", { class: "late", text: `${late} overdue` }) : null,
    next ? el("span", { text: `${next.title} at ${next.start}` }) : null,
  ].filter(Boolean);
  $("home-summary").replaceChildren(...bits.flatMap((b, k) => (k ? [el("span", { class: "dot-sep", text: " · " }), b] : [b])));
}
$("home-new-task").addEventListener("click", async () => {
  await openPersonal("tasks");
  $("board-new")?.click();
});

function renderHomeSpaces() {
  renderHomeHeadline();
  show("home-spaces-wrap", spaces.length > 0);
  $("home-spaces").replaceChildren(...spaces.map((sp) => {
    const desks = channels.filter((c) => c.space === sp.id && c.desk).length;
    const chans = channels.filter((c) => c.space === sp.id && c.kind === "channel" && !c.desk).length;
    const bits = [`${sp.members} ${sp.members === 1 ? "member" : "members"}`, desks ? `${desks} ${desks === 1 ? "desk" : "desks"}` : null, chans ? `${chans} ${chans === 1 ? "channel" : "channels"}` : null].filter(Boolean);
    return el("button", { class: "space-card", type: "button", onclick: () => openSpace(sp) },
      el("span", { class: "tile", "data-color": colorFor(sp.id), text: initials(sp.name) }),
      el("span", {}, el("strong", { text: sp.name }), el("small", { text: bits.join(" · ") })));
  }));
}

// ---------- drive ----------

let drive = null; // { channel, folder, query, items }
const sizeFmt = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
function fileIcon(mime) {
  if (mime?.startsWith("image/")) return ["image", "image"];
  if (mime === "application/pdf") return ["file", "pdf"];
  return ["file", ""];
}
function driveFiles() { return drive.items.filter((i) => i.kind === "file" && !i.data.deleted); }
function driveFolders() {
  const set = new Set(drive.items.filter((i) => i.kind === "folder" && !i.data.deleted).map((i) => i.data.path));
  for (const f of driveFiles()) {
    const parts = (f.data.folder || "/").split("/").filter(Boolean);
    for (let k = 1; k <= parts.length; k++) set.add(`/${parts.slice(0, k).join("/")}`);
  }
  return [...set];
}

async function openDriveOf(sp) {
  try {
    const id = await invoke("ensure_drive", { space: sp.id });
    await refreshChannels();
    await openChannel(id);
  } catch (err) { alert(String(err)); }
}
async function openDrive(c) {
  hideMain(); show("view-drive");
  current = c.id;
  markNav();
  for (const b of document.querySelectorAll(".side-item[data-id]")) b.classList.remove("active");
  if (!drive || drive.channel !== c.id) { drive = { channel: c.id, folder: "/", query: "", items: [] }; $("drive-search").value = ""; }
  drive.items = await invoke("desk_items", { channel: c.id });
  renderDrive();
  loadDriveLooks().then(() => { if (drive?.channel === c.id) renderDrive(); });
}
// Files, laid out like a document browser (D35): tabs with counts, a filter, a
// sort, and a table with who added each file. Favourites are yours (kept with
// your folders); Trash holds deleted files until someone restores them.
const DRIVE_TABS = [["all", "All"], ["fav", "Favorites"], ["mine", "Created by me"], ["trash", "Trash"]];
const DRIVE_SORTS = [["added", "Last added"], ["name", "Name"], ["size", "Size"]];
function favs() { org.fav ??= {}; return org.fav; }
function isMine(f) { return f.data.by_user ? f.data.by_user === status.session?.user_id : f.data.by === (profile?.display_name || ""); }
function renderDrive() {
  drive.tab ??= "all"; drive.sort ??= "added";
  const live = driveFiles();
  const trash = drive.items.filter((i) => i.kind === "file" && i.data.deleted);
  const total = live.reduce((n, f) => n + (f.data.file_key?.size || 0), 0);
  const mine = channels.find((c) => c.id === drive.channel)?.kind === "personal";
  $("drive-kind").textContent = mine ? "My files" : "Files";
  $("drive-headline").replaceChildren(`${live.length} ${live.length === 1 ? "file" : "files"}, ${sizeFmt(total)}${mine ? "" : ` in ${currentSpace?.name || "this space"}`}. `, el("span", { class: "soft", text: mine ? "Only your devices can open them." : "Only people in this space can open them." }));
  const sets = { all: live, fav: live.filter((f) => favs()[f.id]), mine: live.filter(isMine), trash };
  $("drive-pills").replaceChildren(...DRIVE_TABS.map(([k, label]) => el("button", { class: `pill-tab${drive.tab === k ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(drive.tab === k), onclick: () => { drive.tab = k; renderDrive(); } }, label, el("span", { class: "n", text: String(sets[k].length) }))));
  $("drive-sort-label").textContent = DRIVE_SORTS.find(([k]) => k === drive.sort)[1];
  $("drive-when").textContent = drive.tab === "trash" ? "Deleted" : "Added";
  // Folders and breadcrumbs belong to "All"; the other tabs list files wherever they are.
  const browsing = drive.tab === "all" && !drive.query;
  const parts = drive.folder.split("/").filter(Boolean);
  show("drive-crumbs", browsing);
  const crumbs = [dropTarget(el("button", { type: "button", text: mine ? "My files" : "Files", onclick: () => { drive.folder = "/"; renderDrive(); } }), "/")];
  parts.forEach((p, k) => { const path = `/${parts.slice(0, k + 1).join("/")}`; crumbs.push(el("span", { class: "sep", text: "/" }), dropTarget(el("button", { type: "button", text: p, onclick: () => { drive.folder = path; renderDrive(); } }), path)); });
  $("drive-crumbs").replaceChildren(...crumbs);
  const q = drive.query.toLowerCase();
  let shown = sets[drive.tab];
  if (q) shown = shown.filter((f) => `${f.data.name} ${f.data.folder} ${f.data.by || ""}`.toLowerCase().includes(q));
  else if (browsing) shown = shown.filter((f) => (f.data.folder || "/") === drive.folder);
  const by = { added: (a, b) => (b.data.deleted_at || b.data.added || 0) - (a.data.deleted_at || a.data.added || 0), name: (a, b) => a.data.name.localeCompare(b.data.name), size: (a, b) => (b.data.file_key?.size || 0) - (a.data.file_key?.size || 0) }[drive.sort];
  shown = [...shown].sort(by);
  const folders = browsing ? driveFolders().filter((p) => p.split("/").filter(Boolean).length === parts.length + 1 && p.startsWith(drive.folder === "/" ? "/" : `${drive.folder}/`)).sort() : [];
  const owner = (name) => el("span", { class: "owner" }, name ? avatarEl(name, { size: "sm", ...(driveLooks.get(name) || {}) }) : null, el("span", { text: !name ? "" : name === profile?.display_name ? "You" : name }));
  const kindOf = (f) => { const ext = (f.data.name.split(".").pop() || "").toUpperCase(); return f.data.mime?.startsWith("image/") ? "Image" : ext && ext.length <= 4 && f.data.name.includes(".") ? ext : "File"; };
  const rows = [
    ...folders.map((p) => {
      const inside = live.filter((f) => under(f.data.folder || "/", p)).length;
      const fbtns = el("span", { class: "row-btns" },
        el("button", { class: "icon-btn", type: "button", title: "Rename folder", "aria-label": `Rename ${p.split("/").pop()}`, onclick: (e) => { e.stopPropagation(); renameFolder(p); } }, icon("pen")),
        el("button", { class: "icon-btn", type: "button", title: "Delete folder", "aria-label": `Delete ${p.split("/").pop()}`, onclick: (e) => { e.stopPropagation(); deleteFolder(p); } }, icon("trash")));
      return dropTarget(el("tr", { class: "folder-row", onclick: () => { drive.folder = p; renderDrive(); } },
        el("td", { class: "c-fav" }),
        el("td", {}, el("span", { class: "fname" }, el("span", { class: "ficon folder" }, icon("folder")), el("span", { class: "fname-lines" }, el("strong", { text: p.split("/").pop() }), el("small", { text: `Folder · ${inside} ${inside === 1 ? "file" : "files"}` })))),
        el("td", { class: "c-owner" }), el("td", { class: "c-issued" }), el("td", { class: "c-actions" }, fbtns)), p);
    }),
    ...shown.map((f) => {
      const [ic, cls] = fileIcon(f.data.mime);
      const deleted = !!f.data.deleted;
      const fav = !!favs()[f.id];
      const btns = deleted
        ? el("span", { class: "row-btns show" }, el("button", { class: "btn-outline sm", type: "button", onclick: (e) => { e.stopPropagation(); restoreFile(f); } }, icon("undo"), "Restore"))
        : el("span", { class: "row-btns" },
          el("button", { class: "icon-btn", type: "button", title: "Download", "aria-label": `Download ${f.data.name}`, onclick: (e) => { e.stopPropagation(); downloadFile(f); } }, icon("download")),
          el("button", { class: "icon-btn", type: "button", title: "Rename", "aria-label": `Rename ${f.data.name}`, onclick: (e) => { e.stopPropagation(); renameFile(f); } }, icon("pen")),
          el("button", { class: "icon-btn", type: "button", title: "Move to a folder", "aria-label": `Move ${f.data.name}`, onclick: (e) => { e.stopPropagation(); openMove([f]); } }, icon("folder")),
          el("button", { class: "icon-btn", type: "button", title: "Move to Trash", "aria-label": `Delete ${f.data.name}`, onclick: (e) => { e.stopPropagation(); deleteFile(f); } }, icon("trash")));
      const where = !browsing && (f.data.folder || "/") !== "/" ? ` · ${f.data.folder}` : "";
      return el("tr", { class: deleted ? "deleted" : "", onclick: () => (deleted ? null : previewFile(f)), draggable: deleted ? "false" : "true", ondragstart: (e) => { e.dataTransfer.setData("text/x-anarchy-file", f.id); e.dataTransfer.effectAllowed = "move"; } },
        el("td", { class: "c-fav" }, deleted ? null : el("button", { class: `star${fav ? " on" : ""}`, type: "button", title: fav ? "Remove from favorites" : "Add to favorites", "aria-pressed": String(fav), "aria-label": `Favorite ${f.data.name}`, onclick: (e) => { e.stopPropagation(); if (fav) delete favs()[f.id]; else favs()[f.id] = Date.now(); saveOrg(); renderDrive(); } }, icon("star"))),
        el("td", {}, el("span", { class: "fname" }, el("span", { class: `ficon ${cls}` }, icon(ic)), el("span", { class: "fname-lines" }, el("strong", { text: f.data.name }), el("small", { text: `${kindOf(f)} · ${sizeFmt(f.data.file_key?.size || 0)}${where}` })))),
        el("td", { class: "c-owner" }, owner(f.data.by)),
        el("td", { class: "c-issued", text: (deleted ? f.data.deleted_at : f.data.added) ? dateFmt.format(deleted ? f.data.deleted_at : f.data.added) : "" }),
        el("td", { class: "c-actions" }, btns));
    }),
  ];
  $("drive-rows").replaceChildren(...rows);
  show("drive-table", rows.length > 0);
  show("drive-empty", rows.length === 0);
  $("drive-empty-title").textContent = q ? "No files match" : { fav: "No favorites yet", mine: "Nothing you added", trash: "Trash is empty" }[drive.tab] || (drive.folder === "/" ? "Nothing here yet" : "This folder is empty");
  $("drive-empty-sub").textContent = { fav: "Star a file to keep it here. Favorites are yours alone.", mine: "Files you upload show up here.", trash: "Deleted files wait here until someone restores them." }[drive.tab] || "Upload files or drop them here. Everyone in this space can open them; the server only ever holds encrypted pieces.";
}
let driveLooks = new Map();
async function loadDriveLooks() {
  try { driveLooks = new Map((await invoke("channel_members", { channel: drive.channel })).map((m) => [m.name, { color: m.color, avatar: m.avatar }])); } catch { /* names only */ }
}
async function restoreFile(f) {
  const { deleted, deleted_at, ...data } = f.data;
  await invoke("put_items", { channel: drive.channel, items: [{ id: f.id, kind: "file", data }] });
  await logTo(drive.channel, `Restored ${f.data.name} from Trash.`);
  drive.items = await invoke("desk_items", { channel: drive.channel });
  renderDrive();
}
$("drive-sort").addEventListener("click", (e) => {
  e.stopPropagation();
  openMenu($("drive-sort"), "Sort by", DRIVE_SORTS.map(([k, label]) => ({ label, on: drive.sort === k, go: () => { drive.sort = k; renderDrive(); } })));
});
// A small menu at a button; used for sorting and the like.
function openMenu(anchor, title, items) {
  const menu = $("fold-menu");
  menu.replaceChildren(el("p", { class: "fold-menu-title", text: title }), ...items.map((it) => el("button", { class: `fold-menu-item${it.on ? " on" : ""}`, type: "button", role: "menuitemradio", "aria-checked": String(!!it.on), onclick: () => { show(menu, false); it.go(); } }, icon(it.on ? "check" : "list"), it.label)));
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.round(Math.min(r.left, innerWidth - 220))}px`;
  menu.style.top = `${Math.round(Math.min(r.bottom + 4, innerHeight - 200))}px`;
  show(menu, true);
}
async function logTo(channel, text) { try { await invoke("send_message", { channel, text }); } catch (e) { console.warn(e); } }
async function afterUpload(names) {
  if (!names.length) return;
  await logTo(drive.channel, names.length === 1 ? `Uploaded ${names[0]}${drive.folder !== "/" ? ` to ${drive.folder}` : ""}.` : `Uploaded ${names.length} files${drive.folder !== "/" ? ` to ${drive.folder}` : ""}: ${names.join(", ")}.`);
  drive.items = await invoke("desk_items", { channel: drive.channel });
  renderDrive();
  refreshChannels();
}
$("drive-upload").addEventListener("click", async () => {
  await busy($("drive-upload"), "Encrypting…", async () => {
    try { await afterUpload(await invoke("pick_and_upload", { channel: drive.channel, folder: drive.folder })); }
    catch (err) { alert(String(err)); }
  });
});
$("drive-search").addEventListener("input", () => { drive.query = $("drive-search").value; renderDrive(); });
tauri?.event?.listen?.("tauri://drag-enter", () => { if (!$("view-drive").hidden) { $("drop-target").textContent = `to ${currentSpace?.name || ""}${drive.folder === "/" ? "" : ` · ${drive.folder}`}`; show("drop-veil"); } });
tauri?.event?.listen?.("tauri://drag-leave", () => show("drop-veil", false));
tauri?.event?.listen?.("tauri://drag-drop", async (e) => {
  show("drop-veil", false);
  if ($("view-drive").hidden || !drive) return;
  try { await afterUpload(await invoke("upload_dropped", { channel: drive.channel, folder: drive.folder, paths: e.payload.paths || [] })); }
  catch (err) { alert(String(err)); }
});
async function downloadFile(f) {
  try { if (await invoke("save_file_as", { channel: drive.channel, id: f.id, name: f.data.name })) await logTo(drive.channel, `Downloaded ${f.data.name}.`); }
  catch (err) { alert(String(err)); }
}
async function renameFile(f) {
  const name = prompt("New name", f.data.name)?.trim();
  if (!name || name === f.data.name) return;
  await invoke("put_items", { channel: drive.channel, items: [{ id: f.id, kind: "file", data: { ...f.data, name } }] });
  await logTo(drive.channel, `Renamed ${f.data.name} to ${name}.`);
  drive.items = await invoke("desk_items", { channel: drive.channel });
  renderDrive();
}
async function deleteFile(f) {
  await invoke("put_items", { channel: drive.channel, items: [{ id: f.id, kind: "file", data: { ...f.data, deleted: true, deleted_at: Date.now() } }] });
  await logTo(drive.channel, `Moved ${f.data.name} to Trash.`);
  drive.items = await invoke("desk_items", { channel: drive.channel });
  renderDrive();
}
let previewing = null;
async function previewFile(f) {
  previewing = f;
  $("dlg-preview-title").textContent = f.data.name;
  $("preview-meta").textContent = `${sizeFmt(f.data.file_key?.size || 0)} · ${f.data.by || ""}${f.data.added ? ` · ${dateFmt.format(f.data.added)}` : ""}`;
  $("preview-body").replaceChildren(el("p", { text: "Decrypting…" }));
  show("preview-edit", /\.(md|markdown|txt)$/i.test(f.data.name));
  $("dlg-preview").showModal();
  try {
    const p = await invoke("preview_file", { channel: drive.channel, id: f.id });
    if (previewing !== f) return;
    $("preview-body").replaceChildren(p.kind === "image" ? el("img", { src: p.data, alt: f.data.name }) : p.kind === "text" ? el("pre", { text: p.data }) : el("p", { text: "No preview for this kind of file. Download it to open it." }));
  } catch (err) { $("preview-body").replaceChildren(el("p", { class: "error", text: String(err) })); }
}
$("preview-close").addEventListener("click", () => $("dlg-preview").close());
$("preview-download").addEventListener("click", () => previewing && downloadFile(previewing));
$("preview-edit").addEventListener("click", () => { if (!previewing) return; const f = previewing; $("dlg-preview").close(); editDriveFile(f); });
$("drive-folder").addEventListener("click", () => { $("folder-name").value = ""; setError("folder-error", ""); $("dlg-folder").showModal(); $("folder-name").focus(); });
$("folder-cancel").addEventListener("click", () => $("dlg-folder").close());
$("folder-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("folder-name").value.trim().replace(/\//g, "-");
  if (!name) return setError("folder-error", "Name the folder.");
  const path = `${drive.folder === "/" ? "" : drive.folder}/${name}`;
  if (driveFolders().includes(path)) return setError("folder-error", "There's already a folder with that name here.");
  await invoke("put_items", { channel: drive.channel, items: [{ id: crypto.randomUUID(), kind: "folder", data: { path } }] });
  $("dlg-folder").close();
  drive.items = await invoke("desk_items", { channel: drive.channel });
  drive.folder = path;
  renderDrive();
});

// Organising: moving files between folders, renaming and deleting folders.
// A folder is a path; files carry theirs, so a move is one encrypted write.
function dropTarget(node, path) {
  node.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/x-anarchy-file")) { e.preventDefault(); node.classList.add("drop-on"); } });
  node.addEventListener("dragleave", () => node.classList.remove("drop-on"));
  node.addEventListener("drop", (e) => {
    node.classList.remove("drop-on");
    const f = driveFiles().find((x) => x.id === e.dataTransfer.getData("text/x-anarchy-file"));
    if (f) { e.preventDefault(); moveFiles([f], path); }
  });
  return node;
}
async function moveFiles(files, to) {
  const moving = files.filter((f) => (f.data.folder || "/") !== to);
  if (!moving.length) return;
  await invoke("put_items", { channel: drive.channel, items: moving.map((f) => ({ id: f.id, kind: "file", data: { ...f.data, folder: to } })) });
  const where = to === "/" ? "the top level" : to;
  await logTo(drive.channel, moving.length === 1 ? `Moved ${moving[0].data.name} to ${where}.` : `Moved ${moving.length} files to ${where}.`);
  drive.items = await invoke("desk_items", { channel: drive.channel });
  renderDrive();
}
let moving = [], moveTo = "/";
function paintMoveList() {
  const all = ["/", ...driveFolders().sort()];
  $("move-list").replaceChildren(...all.map((p) => {
    const depth = p === "/" ? 0 : p.split("/").filter(Boolean).length;
    return el("button", { type: "button", role: "radio", class: "move-row", "aria-checked": String(p === moveTo), style: `padding-left:${10 + depth * 16}px`, onclick: () => { moveTo = p; paintMoveList(); } },
      el("span", { class: "ficon folder" }, icon("folder")), p === "/" ? "Files" : p.split("/").pop());
  }));
}
function openMove(files) {
  moving = files; moveTo = files[0]?.data.folder || "/";
  $("move-what").textContent = files.length === 1 ? files[0].data.name : `${files.length} files`;
  setError("move-error", "");
  paintMoveList();
  $("dlg-move").showModal();
}
$("move-cancel").addEventListener("click", () => $("dlg-move").close());
$("move-new").addEventListener("click", async () => {
  const name = prompt(`New folder in ${moveTo === "/" ? "Files" : moveTo}`)?.trim().replace(/\//g, "-");
  if (!name) return;
  const path = `${moveTo === "/" ? "" : moveTo}/${name}`;
  if (!driveFolders().includes(path)) {
    await invoke("put_items", { channel: drive.channel, items: [{ id: crypto.randomUUID(), kind: "folder", data: { path } }] });
    drive.items = await invoke("desk_items", { channel: drive.channel });
  }
  moveTo = path; paintMoveList();
});
$("move-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await busy($("move-save"), "Moving…", async () => {
    try { await moveFiles(moving, moveTo); $("dlg-move").close(); } catch (err) { setError("move-error", String(err)); }
  });
});
// Everything under `from` (the folder itself, its subfolders and their files).
function under(path, from) { return path === from || path.startsWith(`${from}/`); }
async function renameFolder(from) {
  const old = from.split("/").pop();
  const name = prompt("Rename folder", old)?.trim().replace(/\//g, "-");
  if (!name || name === old) return;
  const to = `${from.slice(0, from.lastIndexOf("/"))}/${name}`;
  if (driveFolders().includes(to)) return alert("There's already a folder with that name here.");
  const moved = (p) => to + p.slice(from.length);
  const items = [
    ...drive.items.filter((i) => i.kind === "folder" && !i.data.deleted && under(i.data.path, from)).map((i) => ({ id: i.id, kind: "folder", data: { ...i.data, path: moved(i.data.path) } })),
    ...driveFiles().filter((f) => under(f.data.folder || "/", from)).map((f) => ({ id: f.id, kind: "file", data: { ...f.data, folder: moved(f.data.folder) } })),
  ];
  // A folder that only existed because files were in it gets a record of its own.
  if (!drive.items.some((i) => i.kind === "folder" && !i.data.deleted && i.data.path === from)) items.push({ id: crypto.randomUUID(), kind: "folder", data: { path: to } });
  await invoke("put_items", { channel: drive.channel, items });
  await logTo(drive.channel, `Renamed the folder ${old} to ${name}.`);
  if (under(drive.folder, from)) drive.folder = moved(drive.folder);
  drive.items = await invoke("desk_items", { channel: drive.channel });
  renderDrive();
}
async function deleteFolder(path) {
  const parent = path.slice(0, path.lastIndexOf("/")) || "/";
  const files = driveFiles().filter((f) => under(f.data.folder || "/", path));
  const name = path.split("/").pop();
  if (!confirm(files.length ? `Delete the folder ${name}? Its ${files.length} ${files.length === 1 ? "file moves" : "files move"} to ${parent === "/" ? "the top level" : parent}; nothing is deleted.` : `Delete the empty folder ${name}?`)) return;
  const items = [
    ...drive.items.filter((i) => i.kind === "folder" && !i.data.deleted && under(i.data.path, path)).map((i) => ({ id: i.id, kind: "folder", data: { ...i.data, deleted: true } })),
    ...files.map((f) => ({ id: f.id, kind: "file", data: { ...f.data, folder: parent } })),
  ];
  if (items.length) await invoke("put_items", { channel: drive.channel, items });
  await logTo(drive.channel, files.length ? `Deleted the folder ${name}; its files are in ${parent === "/" ? "Files" : parent} now.` : `Deleted the folder ${name}.`);
  if (under(drive.folder, path)) drive.folder = parent;
  drive.items = await invoke("desk_items", { channel: drive.channel });
  renderDrive();
}

// ---------- space overview ----------

async function renderSpaceOverview() {
  const sp = currentSpace;
  const desks = channels.filter((c) => c.space === sp.id && c.desk && c.desk !== "files");
  const driveCh = channels.find((c) => c.space === sp.id && c.desk === "files");
  const chans = channels.filter((c) => c.space === sp.id && c.kind === "channel" && !c.desk);
  $("space-empty-kind").textContent = `${KIND_LABEL[sp.kind] || "Space"} · ${sp.members} ${sp.members === 1 ? "member" : "members"}`;
  // One sentence, like a desk's: what this space is doing right now.
  const deskData = await Promise.all(desks.map(async (d) => ({ d, items: await invoke("desk_items", { channel: d.id }).catch(() => []) })));
  if (currentSpace !== sp) return;
  const today = isoToday();
  let owed = 0, late = 0;
  const cards = deskData.map(({ d, items }) => {
    if (d.desk === "tasks") {
      const st = taskStats(items);
      return el("button", { class: "ov-desk", type: "button", onclick: () => openChannel(d.id) },
        el("span", { class: "top" }, icon("board"), d.name),
        el("span", { class: "big" }, `${st.open} open`, el("span", { text: ` · ${st.done} done` })),
        el("span", { class: "flags" }, st.late ? el("span", { class: "flag-pill bad", text: `${st.late} late` }) : null, st.week ? el("span", { class: "flag-pill warn", text: `${st.week} due this week` }) : null,
          !st.late && !st.week ? el("span", { class: "flag-pill good", text: st.total ? "Nothing due soon" : "No cards yet" }) : null));
    }
    const inv = items.filter((i) => i.kind === "invoice").map((i) => ({ ...i.data, state: invoiceState(i.data, today) }));
    const open = inv.filter((i) => i.state === "open" || i.state === "overdue");
    const overdue = inv.filter((i) => i.state === "overdue");
    const drafts = inv.filter((i) => i.state === "draft");
    const sum = open.reduce((n, i) => n + i.amount, 0);
    owed += sum; late += overdue.length;
    return el("button", { class: "ov-desk", type: "button", onclick: () => openChannel(d.id) },
      el("span", { class: "top" }, icon("receipt"), d.name),
      el("span", { class: "big" }, money(sum), el("span", { text: ` outstanding · ${open.length} ${open.length === 1 ? "invoice" : "invoices"}` })),
      el("span", { class: "flags" },
        overdue.length ? el("span", { class: "flag-pill bad", text: `${overdue.length} overdue` }) : null,
        drafts.length ? el("span", { class: "flag-pill warn", text: `${drafts.length} ${drafts.length === 1 ? "draft" : "drafts"}` }) : null,
        !overdue.length && !drafts.length ? el("span", { class: "flag-pill good", text: inv.length ? "All caught up" : "No invoices yet" }) : null));
  });
  const h = $("space-empty-title");
  if (desks.length && owed) h.replaceChildren(`${sp.name} `, el("span", { class: "soft", text: "has " }), money(owed), el("span", { class: "soft", text: late ? " outstanding, " : " outstanding." }), ...(late ? [`${late} overdue`, el("span", { class: "soft", text: "." })] : []));
  else h.replaceChildren(sp.name, el("span", { class: "soft", text: ` · ${[desks.length && `${desks.length} ${desks.length === 1 ? "desk" : "desks"}`, `${chans.length} ${chans.length === 1 ? "channel" : "channels"}`].filter(Boolean).join(", ")}.` }));
  const driveItems = driveCh ? await invoke("desk_items", { channel: driveCh.id }).catch(() => []) : [];
  if (currentSpace !== sp) return;
  const files = driveItems.filter((i) => i.kind === "file" && !i.data.deleted);
  const filesCard = el("button", { class: "ov-desk", type: "button", onclick: () => openDriveOf(sp) },
    el("span", { class: "top" }, icon("folder"), "Files"),
    el("span", { class: "big" }, `${files.length} ${files.length === 1 ? "file" : "files"}`, el("span", { text: ` · ${sizeFmt(files.reduce((n, f) => n + (f.data.file_key?.size || 0), 0))}` })),
    el("span", { class: "flags" }, el("span", { class: "flag-pill good", text: "Encrypted on your devices" })));
  $("ov-desks").replaceChildren(...cards, ...(cards.length ? [] : [el("div", { class: "ov-empty" }, "A desk holds the work: invoices, requests, jobs. ", el("button", { class: "link", type: "button", text: "Set up the first one", onclick: openNewDesk }))]), filesCard);
  $("ov-channels").replaceChildren(...(chans.length ? chans.map((c) => el("button", { class: "ov-chan", type: "button", onclick: () => openChannel(c.id).then(() => composer.focus()) },
    el("span", { class: "hash", text: "#" }), el("span", { class: "lines" }, el("strong", { text: c.name }), el("small", { text: c.last_text || c.topic || "No messages yet" })),
    c.unread ? el("span", { class: "unread-dot" }) : el("time", { text: c.last_ts ? shortDate.format(c.last_ts) : "" })))
    : [el("div", { class: "ov-empty" }, "Channels are for talking. ", el("button", { class: "link", type: "button", text: "Start one", onclick: openNewChannel }))]));
  try {
    const members = await invoke("space_members", { space: sp.id });
    if (currentSpace !== sp) return;
    $("ov-people").replaceChildren(...members.map((m) => el("div", { class: "ov-person" }, avatarEl(m.name, { color: m.color, avatar: m.avatar, sidekick: m.sidekick, size: "sm" }),
      el("span", { class: "lines" }, el("span", { text: m.name }), el("small", { text: m.handle ? `@${m.handle}` : "" })))),
      el("button", { class: "link", type: "button", text: "Invite people", onclick: openInvite }));
  } catch { $("ov-people").replaceChildren(el("p", { class: "fine", text: "Couldn't load people." })); }
}

// ---------- window and search ----------

// Window controls follow the platform. macOS: traffic lights at the left (the
// system's own in the app, see tauri.macos.conf.json). Windows and Linux:
// minimize, maximize and close at the right, in each system's style.
// `?os=mac|windows|linux` picks one for previews.
const OS = new URLSearchParams(location.search).get("os")
  || (/Mac/i.test(navigator.userAgentData?.platform || navigator.platform) ? "mac" : /Win/i.test(navigator.userAgentData?.platform || navigator.platform) ? "windows" : "linux");
document.documentElement.dataset.os = OS;
if (OS === "mac" && tauri) document.documentElement.dataset.nativeLights = "";
const appWindow = tauri?.window?.getCurrentWindow?.();
const winAct = { close: () => appWindow?.close(), min: () => appWindow?.minimize(), max: () => appWindow?.toggleMaximize() };
$("win-close").addEventListener("click", winAct.close);
$("win-min").addEventListener("click", winAct.min);
$("win-max").addEventListener("click", winAct.max);
for (const b of document.querySelectorAll(".winctl [data-win]")) b.addEventListener("click", winAct[b.dataset.win]);
// Maximized, the middle button restores.
async function paintMaximized() {
  const max = await appWindow?.isMaximized?.().catch(() => false);
  const b = document.querySelector('.winctl [data-win="max"]');
  b.querySelector("use").setAttribute("href", max ? "#i-win-restore" : "#i-win-max");
  b.setAttribute("aria-label", max ? "Restore" : "Maximize"); b.title = max ? "Restore" : "Maximize";
}
appWindow?.onResized?.(paintMaximized);
paintMaximized();
$("search-kbd").textContent = OS === "mac" ? "⌘K" : "Ctrl K";

let searchTimer = null, searchSeq = 0, searchCursor = -1;
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !$("omnibox").hidden) { e.preventDefault(); $("search").focus(); $("search").select(); }
});
$("search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 120); });
$("search").addEventListener("focus", () => { if ($("search").value.trim()) runSearch(); });
$("search").addEventListener("blur", () => setTimeout(() => show("search-results", false), 150));
$("search").addEventListener("keydown", (e) => {
  const items = [...$("search-results").querySelectorAll(".sr-item")];
  if (e.key === "Escape") { $("search").value = ""; show("search-results", false); $("search").blur(); return; }
  if (!items.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    searchCursor = (searchCursor + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((b, k) => b.classList.toggle("on", k === searchCursor));
    items[searchCursor].scrollIntoView({ block: "nearest" });
  }
  if (e.key === "Enter") { e.preventDefault(); (items[searchCursor] || items[0]).click(); }
});
function highlight(text, q) {
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return [text];
  const start = Math.max(0, at - 30);
  return [(start ? "…" : "") + text.slice(start, at), el("mark", { text: text.slice(at, at + q.length) }), text.slice(at + q.length, at + q.length + 80)];
}
function whereOf(c) {
  if (!c) return "";
  if (c.kind === "dm") return "Direct";
  const sp = spaces.find((x) => x.id === c.space);
  return sp ? `${sp.name} · ${c.desk ? c.name : `#${c.name}`}` : c.name;
}
async function runSearch() {
  const q = $("search").value.trim();
  const box = $("search-results");
  if (!q) { show(box, false); return; }
  const seq = ++searchSeq;
  const lower = q.toLowerCase();
  const places = [
    ...spaces.filter((sp) => sp.name.toLowerCase().includes(lower)).map((sp) => ({ label: sp.name, sub: KIND_LABEL[sp.kind] || "Space", go: () => openSpace(sp), tile: sp })),
    ...channels.filter((c) => c.name.toLowerCase().includes(lower) || (c.peer?.handle || "").includes(lower)).map((c) => ({ label: c.kind === "dm" ? c.name : c.desk ? c.name : `#${c.name}`, sub: c.kind === "dm" ? (c.peer?.handle ? `@${c.peer.handle}` : "Direct") : whereOf(c), go: () => goTo(c.id), c })),
  ].slice(0, 6);
  let hits = [];
  try { hits = await invoke("search", { query: q }); } catch (e) { console.warn(e); }
  if (seq !== searchSeq) return;
  const msgs = hits.filter((h) => h.what === "message").slice(0, 8);
  const recs = hits.filter((h) => h.what === "record").slice(0, 6);
  const rows = [];
  const item = (lead, lines, where, go) => el("button", { class: "sr-item", type: "button", onmousedown: (e) => e.preventDefault(), onclick: () => { show(box, false); $("search").blur(); go(); } }, lead, el("span", { class: "lines" }, ...lines), where ? el("span", { class: "where", text: where }) : null);
  if (places.length) {
    rows.push(el("div", { class: "sr-group", text: "Go to" }));
    for (const p of places) {
      const lead = p.tile ? el("span", { class: "space-tile", "data-color": colorFor(p.tile.id), text: initials(p.tile.name) })
        : p.c.kind === "dm" ? avatarEl(p.c.name, { color: p.c.peer?.color, avatar: p.c.peer?.avatar, size: "sm" }) : el("span", { class: "space-tile" }, icon(p.c.desk ? "receipt" : "chat"));
      rows.push(item(lead, [el("span", {}, ...highlight(p.label, q)), el("small", { text: p.sub })], null, p.go));
    }
  }
  if (recs.length) {
    rows.push(el("div", { class: "sr-group", text: "Records" }));
    for (const h of recs) rows.push(item(el("span", { class: "space-tile" }, icon(h.by === "file" ? "file" : h.by === "folder" ? "folder" : "receipt")), [el("span", {}, ...highlight(h.text, q)), el("small", { text: h.by })], whereOf(channels.find((c) => c.id === h.channel)), () => goTo(h.channel)));
  }
  if (msgs.length) {
    rows.push(el("div", { class: "sr-group", text: "Messages" }));
    for (const h of msgs) rows.push(item(h.by === "You" ? avatarEl(profile?.display_name || "You", { color: profile?.color, avatar: profile?.avatar, sidekick: profile?.sidekick, size: "sm" }) : avatarEl(h.by, { size: "sm" }), [el("small", { text: `${h.by} · ${shortDate.format(h.ts_ms)}` }), el("span", {}, ...highlight(h.text, q))], whereOf(channels.find((c) => c.id === h.channel)), () => goTo(h.channel)));
  }
  if (!rows.length) rows.push(el("p", { class: "sr-empty", text: `Nothing matches "${q}". Search covers what this device can decrypt; the server can't search it for you.` }));
  box.replaceChildren(...rows);
  searchCursor = -1;
  show(box, true);
}
// Opens any conversation or desk, switching to its space (or Home) first.
async function goTo(id) {
  const c = channels.find((x) => x.id === id);
  if (!c) return;
  if (c.kind === "dm") { if (view !== "home") go("home"); }
  else {
    const sp = spaces.find((x) => x.id === c.space);
    if (sp && (currentSpace?.id !== sp.id || view !== "space")) openSpace(sp);
  }
  await openChannel(id);
}

// ---------- desks ----------

const money = (cents) => new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
const moneyShort = (cents) => new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(Math.round(cents / 100));
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const monthName = new Intl.DateTimeFormat(undefined, { month: "short" });
function isoToday() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }
function addDays(iso, n) { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 864e5); }
function asDate(iso) { return new Date(`${iso}T12:00:00`); }

let desk = null; // { channel, items, messages, tab, query, selected:Set }

// Paid, void and draft are what people set; "overdue" and "open" follow from the due date.
function invoiceState(inv, today) {
  if (inv.status === "paid" || inv.status === "void" || inv.status === "draft") return inv.status;
  return inv.due < today ? "overdue" : "open";
}
function invoices() {
  const today = isoToday();
  return desk.items.filter((i) => i.kind === "invoice").map((i) => ({ ...i.data, id: i.id, updated_ms: i.updated_ms, state: invoiceState(i.data, today) }))
    .sort((a, b) => (b.issued || "").localeCompare(a.issued || "") || (b.number || "").localeCompare(a.number || ""));
}

async function openDesk(c) {
  hideMain(); show("view-desk");
  for (const b of document.querySelectorAll(".side-item[data-id]")) b.classList.toggle("active", b.dataset.id === c.id);
  const fresh = !desk || desk.channel !== c.id;
  if (fresh) desk = { channel: c.id, name: c.name, space: c.space, items: [], messages: [], links: {}, linksAt: 0, tab: "all", query: "", selected: new Set(), view: "invoices", clientQuery: "", timeTab: "unbilled", timeSel: new Set() };
  const [items, messages] = await Promise.all([invoke("desk_items", { channel: c.id }), invoke("open_channel", { channel: c.id })]);
  desk.items = items; desk.messages = messages;
  await refreshLinks();
  invoke("channel_members", { channel: c.id }).then((m) => { $("desk-people-count").textContent = String(m.length); });
  if (fresh) $("desk-search").value = "";
  $("desk-kind").textContent = c.name;
  renderDesk();
  renderDeskView();
  refreshChannels();
  pullIntake(true).then((n) => { if (n && desk?.channel === c.id) renderDeskView(); });
}

function renderDesk() {
  const all = invoices();
  const outstanding = all.filter((i) => i.state === "open" || i.state === "overdue");
  const owed = outstanding.reduce((n, i) => n + i.amount, 0);
  const h = $("desk-headline");
  if (!all.length) h.replaceChildren("Nothing billed ", el("span", { class: "soft", text: "yet." }));
  else if (!outstanding.length) h.replaceChildren("Nothing outstanding. ", el("span", { class: "soft", text: (() => { const n = all.filter((i) => i.state === "paid").length; return `${n} ${n === 1 ? "invoice" : "invoices"} paid.`; })() }));
  else h.replaceChildren(`${money(owed)} `, el("span", { class: "soft", text: "outstanding across " }), `${outstanding.length} ${outstanding.length === 1 ? "invoice" : "invoices"}.`);
  renderChart(all);
  const counts = { all: all.length, open: all.filter((i) => i.state === "open").length, overdue: all.filter((i) => i.state === "overdue").length, paid: all.filter((i) => i.state === "paid").length, draft: all.filter((i) => i.state === "draft").length };
  const labels = { all: "All", open: "Open", overdue: "Overdue", paid: "Paid", draft: "Drafts" };
  $("desk-tabs").replaceChildren(...Object.keys(labels).map((k) => el("button", { type: "button", role: "tab", "aria-selected": String(desk.tab === k), onclick: () => { desk.tab = k; renderDesk(); } }, labels[k], el("span", { class: "n", text: String(counts[k]) }))));
  const q = desk.query.toLowerCase();
  const rows = all.filter((i) => (desk.tab === "all" ? i.state !== "void" : i.state === desk.tab)).filter((i) => !q || `${i.number} ${i.customer}`.toLowerCase().includes(q));
  const today = isoToday();
  const stIcon = { paid: "check", overdue: "alert", open: "clock", draft: "pen", void: "x" };
  const stLabel = { paid: "Paid", overdue: "Overdue", open: "Unpaid", draft: "Draft", void: "Void" };
  $("desk-rows").replaceChildren(...rows.map((i) => {
    const d = daysBetween(today, i.due);
    const dueNote = i.state === "overdue" ? el("small", { class: "late", text: `${-d} ${-d === 1 ? "day" : "days"} overdue` })
      : i.state === "open" ? el("small", { text: d === 0 ? "today" : `in ${d} ${d === 1 ? "day" : "days"}` }) : null;
    const check = el("input", { type: "checkbox", "aria-label": `Select ${i.number}`, checked: desk.selected.has(i.id), onclick: (e) => e.stopPropagation(), onchange: (e) => { e.target.checked ? desk.selected.add(i.id) : desk.selected.delete(i.id); renderBulk(); e.target.closest("tr").classList.toggle("selected", e.target.checked); } });
    return el("tr", { class: desk.selected.has(i.id) ? "selected" : "", onclick: () => openInvoice(i) },
      el("td", { class: "c-check" }, check),
      el("td", { class: "inv" }, i.number, linkOf(i) ? el("span", { class: "row-link", title: linkTitle(i) }, icon("link")) : null),
      el("td", {}, el("span", { class: "who" }, el("span", { class: "tile", text: initials(i.customer) }), i.customer)),
      el("td", { class: "c-issued", text: i.issued ? dateFmt.format(asDate(i.issued)) : "" }),
      el("td", { class: "due" }, i.due ? shortDate.format(asDate(i.due)) : "", dueNote),
      el("td", { class: "num", text: money(i.amount) }),
      el("td", {}, el("span", { class: `st ${i.state}` }, icon(stIcon[i.state]), stLabel[i.state]), claimOf(i) ? el("span", { class: "flag-pill warn says-paid", text: "Says paid" }) : null),
      el("td", { class: "c-terms", text: i.terms ? `Net ${i.terms}` : "On receipt" }));
  }));
  show("desk-table", rows.length > 0);
  show("desk-empty", rows.length === 0);
  $("desk-empty-title").textContent = all.length ? "Nothing here" : "No invoices yet";
  $("desk-empty-sub").textContent = all.length ? "No invoices match this view." : "Create the first one. Everyone on this desk sees it, and nobody else, the server included.";
  $("check-all").checked = rows.length > 0 && rows.every((i) => desk.selected.has(i.id));
  renderBulk();
  renderNotes(all);
  deskNeeds.set(desk.channel, all.filter((i) => i.state === "overdue").length + all.filter((i) => claimOf(i)).length);
  renderTabs();
}

function renderBulk() {
  const sel = invoices().filter((i) => desk.selected.has(i.id));
  show("bulk-bar", sel.length > 0);
  $("bulk-count").replaceChildren(`${sel.length} selected`, el("small", { text: `· ${money(sel.reduce((n, i) => n + i.amount, 0))} total` }));
}

// Paid per month (solid) for the last six months, then what's due (dashed) for the next three.
function renderChart(all) {
  const now = new Date();
  const months = [];
  for (let k = -5; k <= 3; k++) months.push(new Date(now.getFullYear(), now.getMonth() + k, 1));
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const paid = months.map((m) => all.filter((i) => i.state === "paid" && (i.paid_on || i.due || "").startsWith(key(m))).reduce((n, i) => n + i.amount, 0));
  const due = months.map((m, k) => (k < 5 ? null : all.filter((i) => (i.state === "open" || i.state === "overdue") && (k === 5 ? i.due <= `${key(m)}-31` : i.due.startsWith(key(m)))).reduce((n, i) => n + i.amount, 0)));
  const max = Math.max(1, ...paid, ...due.filter((v) => v !== null));
  const x = (k) => 10 + (k * 340) / 8;
  const y = (v) => 86 - (v / max) * 72;
  const solid = paid.slice(0, 6).map((v, k) => `${k ? "L" : "M"}${x(k)},${y(v)}`).join(" ");
  const dashed = [5, 6, 7, 8].map((k, j) => `${j ? "L" : "M"}${x(k)},${y(k === 5 ? paid[5] + due[5] : due[k])}`).join(" ");
  const area = `${solid} L${x(5)},90 L${x(0)},90 Z`;
  const svg = $("chart");
  const ns = "http://www.w3.org/2000/svg";
  const path = (d, attrs) => { const p = document.createElementNS(ns, "path"); p.setAttribute("d", d); for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v); return p; };
  const grad = document.createElementNS(ns, "defs");
  grad.innerHTML = '<linearGradient id="fillg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".14"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient>';
  const dot = document.createElementNS(ns, "circle");
  dot.setAttribute("cx", x(5)); dot.setAttribute("cy", y(paid[5])); dot.setAttribute("r", 3); dot.setAttribute("fill", "currentColor");
  svg.replaceChildren(grad, path(area, { fill: "url(#fillg)", stroke: "none" }), path(solid, { fill: "none", stroke: "currentColor", "stroke-width": 2, "vector-effect": "non-scaling-stroke" }),
    path(dashed, { fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-dasharray": "4 4", "vector-effect": "non-scaling-stroke", opacity: .7 }), dot);
  svg.style.color = "var(--ink)";
  $("chart-axis").replaceChildren(...months.map((m) => el("span", { text: monthName.format(m) })));
  const thisMonth = paid[5], lastMonth = paid[4];
  $("chart-total").textContent = money(paid.slice(0, 6).reduce((a, b) => a + b, 0));
  $("chart-sub").textContent = thisMonth ? `${money(thisMonth)} this month` : "";
  $("chart-sub").style.color = thisMonth >= lastMonth ? "var(--sealed)" : "var(--ink-muted)";
}

// Desk notes: worked out on this device from the records. The desk agent will
// write these (and act on them) once the Company Brain exists; until then they're
// plain rules, and they say so.
function renderNotes(all) {
  const today = isoToday();
  const cards = [];
  const overdue = all.filter((i) => i.state === "overdue").sort((a, b) => a.due.localeCompare(b.due));
  const soon = all.filter((i) => i.state === "open" && daysBetween(today, i.due) <= 30);
  const drafts = all.filter((i) => i.state === "draft");
  const meta = (label) => el("div", { class: "note-meta" }, el("span", { class: "orb" }), `${label} · ${timeFmt.format(Date.now())}`);
  const claims = all.filter((i) => claimOf(i));
  for (const i of claims.slice(0, 3)) {
    cards.push(el("div", { class: "note-card" },
      el("div", { class: "note-flag warn" }, el("span", { text: "Client says paid" }), el("span", { class: "amt", text: money(i.amount) })),
      el("div", { class: "note-body" },
        el("strong", { text: `${i.customer} says ${i.number} is paid` }),
        el("p", { text: `They pressed "I've paid" on the payment link ${dateFmt.format(claimOf(i))}. Check your bank before marking it; the link doesn't move money.` }),
        el("div", { class: "note-actions" }, el("button", { class: "btn-ink", type: "button", text: "Mark as paid", onclick: () => markPaid([i]) }),
          el("button", { class: "link", type: "button", text: "Open", onclick: () => openInvoice(i) })))));
  }
  if (overdue.length) {
    const names = overdue.slice(0, 2).map((i) => `${i.customer} (${-daysBetween(today, i.due)} ${-daysBetween(today, i.due) === 1 ? "day" : "days"})`);
    const more = overdue.length > 2 ? ` and ${overdue.length - 2} more` : "";
    const reminded = overdue.filter((i) => i.reminded_on).length;
    cards.push(el("div", {}, meta("Collections"), el("div", { class: "note-card" },
      el("div", { class: "note-flag bad" }, el("span", { text: `${overdue.length} overdue` }), el("span", { class: "amt", text: money(overdue.reduce((n, i) => n + i.amount, 0)) })),
      el("div", { class: "note-body" },
        el("strong", { text: overdue.length === 1 ? `${overdue[0].number} slipped past due` : `${overdue.length} invoices slipped past due` }),
        el("p", { text: `${names.join(" and ")}${more}.${reminded ? ` ${reminded} already had a reminder.` : ""}` }),
        el("div", { class: "note-actions" }, el("button", { class: "btn-ink", type: "button", text: "Draft reminders", onclick: () => { selectOnly(overdue); remindSelected(); } }),
          el("button", { class: "link", type: "button", text: "Show them", onclick: () => { desk.tab = "overdue"; selectOnly(overdue); } }))))));
  }
  if (soon.length) {
    const sum = soon.reduce((n, i) => n + i.amount, 0);
    cards.push(el("div", {}, el("p", { class: "note-text", text: `${money(sum)} is due in the next 30 days, from ${soon.length} ${soon.length === 1 ? "invoice" : "invoices"}.` }),
      el("div", { class: "chips" }, el("button", { class: "chip", type: "button", text: "Show them", onclick: () => { desk.tab = "open"; renderDesk(); } }),
        el("button", { class: "chip", type: "button", text: "Copy aging report", onclick: (e) => copy(agingCsv(all), e.target) }))));
  }
  if (drafts.length) {
    cards.push(el("div", { class: "note-card" }, el("div", { class: "note-flag warn" }, el("span", { text: `${drafts.length} ${drafts.length === 1 ? "draft" : "drafts"}` }), el("span", { class: "amt", text: money(drafts.reduce((n, i) => n + i.amount, 0)) })),
      el("div", { class: "note-body" }, el("strong", { text: "Not sent yet" }), el("p", { text: "Drafts don't count as outstanding until you mark them sent." }),
        el("div", { class: "note-actions" }, el("button", { class: "btn-ink", type: "button", text: "Review", onclick: () => { desk.tab = "draft"; renderDesk(); } })))));
  }
  if (all.length && !overdue.length && !drafts.length && !claims.length) {
    cards.push(el("div", { class: "note-card" }, el("div", { class: "note-flag good" }, el("span", { text: "All caught up" })), el("div", { class: "note-body" }, el("p", { text: "Nothing is overdue and nothing is waiting to be sent." }))));
  }
  if (!all.length) cards.push(el("p", { class: "note-text", text: "Add invoices and this column tells you what needs you: what's late, what's due, what's still a draft." }));
  cards.push(el("p", { class: "fine", text: "These notes are worked out on this device from the desk's records. The desk agent comes with the Company Brain." }));
  // The desk's conversation and its log of who did what.
  const acts = desk.messages.slice(-30).map((m) => el("div", { class: "act" }, avatarEl(m.sender, m.mine ? { color: profile?.color, avatar: profile?.avatar, sidekick: profile?.sidekick, size: "sm" } : { size: "sm" }),
    el("div", {}, el("strong", { text: m.sender }), el("time", { text: timeFmt.format(m.ts_ms) }), el("p", { text: m.text }))));
  if (acts.length) cards.push(el("div", { class: "activity" }, el("p", { class: "block-label", text: "Activity" }), ...acts));
  $("notes-feed").replaceChildren(...cards);
  $("notes-count").textContent = overdue.length ? `${overdue.length} need you` : "";
}

function selectOnly(list) { desk.selected = new Set(list.map((i) => i.id)); renderDesk(); }
function csvCell(v) { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function toCsv(list) {
  const head = ["Number", "Customer", "Email", "Issued", "Due", "Amount (EUR)", "Status"];
  return [head, ...list.map((i) => [i.number, i.customer, i.email, i.issued, i.due, (i.amount / 100).toFixed(2), i.state])].map((r) => r.map(csvCell).join(",")).join("\n");
}
function agingCsv(all) {
  const today = isoToday();
  const open = all.filter((i) => i.state === "open" || i.state === "overdue");
  const bucket = (i) => { const late = -daysBetween(today, i.due); return late <= 0 ? "Current" : late <= 30 ? "1-30" : late <= 60 ? "31-60" : "60+"; };
  return [["Customer", "Number", "Due", "Bucket", "Amount (EUR)"], ...open.map((i) => [i.customer, i.number, i.due, bucket(i), (i.amount / 100).toFixed(2)])].map((r) => r.map(csvCell).join(",")).join("\n");
}

async function putInvoices(list) {
  await invoke("put_items", { channel: desk.channel, items: list.map(({ id, state, updated_ms, ...data }) => ({ id, kind: "invoice", data })) });
}
async function logActivity(text) { try { await invoke("send_message", { channel: desk.channel, text }); } catch (e) { console.warn(e); } }

$("desk-search").addEventListener("input", () => { desk.query = $("desk-search").value; renderDesk(); });
$("check-all").addEventListener("change", () => {
  const today = isoToday();
  const visible = invoices().filter((i) => (desk.tab === "all" ? i.state !== "void" : i.state === desk.tab));
  if ($("check-all").checked) visible.forEach((i) => desk.selected.add(i.id)); else visible.forEach((i) => desk.selected.delete(i.id));
  void today;
  renderDesk();
});
$("bulk-clear").addEventListener("click", () => { desk.selected.clear(); renderDesk(); });
$("bulk-copy").addEventListener("click", (e) => copy(toCsv(invoices().filter((i) => desk.selected.has(i.id))), e.currentTarget));
$("bulk-paid").addEventListener("click", async () => {
  const sel = invoices().filter((i) => desk.selected.has(i.id) && i.state !== "paid");
  if (!sel.length) return;
  desk.selected.clear();
  await markPaid(sel);
});
async function markPaid(list) {
  const today = isoToday();
  const paid = list.map((i) => ({ ...i, status: "paid", paid_on: today }));
  await putInvoices(paid);
  await logActivity(paid.length === 1 ? `Marked ${paid[0].number} (${paid[0].customer}, ${money(paid[0].amount)}) as paid.` : `Marked ${paid.length} invoices as paid: ${paid.map((i) => i.number).join(", ")}.`);
  await syncLinks(paid);
  openChannel(desk.channel);
}
$("bulk-remind").addEventListener("click", remindSelected);
// Drafts one email per invoice in the person's mail app (at most five at once).
async function remindSelected() {
  const today = isoToday();
  const sel = invoices().filter((i) => desk.selected.has(i.id) && (i.state === "open" || i.state === "overdue"));
  const withEmail = sel.filter((i) => i.email).slice(0, 5);
  if (!withEmail.length) { alert(sel.length ? "Add a billing email to these invoices first." : "Pick unpaid invoices to remind."); return; }
  const me = profile?.display_name || "";
  for (const i of withEmail) {
    const late = -daysBetween(today, i.due);
    const body = `Hello,\n\nA reminder that invoice ${i.number} for ${money(i.amount)} ${late > 0 ? `was due on ${dateFmt.format(asDate(i.due))} (${late} ${late === 1 ? "day" : "days"} ago)` : `is due on ${dateFmt.format(asDate(i.due))}`}. ${i.link?.url ? `\n\nDetails and how to pay: ${i.link.url}` : ""}\n\nIf it's already on its way, thank you and please ignore this.\n\nBest,\n${me}`;
    try { await invoke("compose_email", { to: i.email, subject: `Invoice ${i.number}${late > 0 ? " is overdue" : " reminder"}`, body }); }
    catch (err) { alert(String(err)); return; }
  }
  await putInvoices(withEmail.map((i) => ({ ...i, reminded_on: today })));
  await logActivity(`Drafted ${withEmail.length === 1 ? "a reminder" : `${withEmail.length} reminders`} in my mail app: ${withEmail.map((i) => `${i.number} to ${i.customer}`).join(", ")}.`);
  openChannel(desk.channel);
}

// ---------- payment links (DESKS-PLAN "The client side") ----------
// A page for the client, sealed on this device; the key is only in the URL we
// keep in the invoice record (itself end-to-end encrypted in the desk).

function paySettings() { return desk.items.find((i) => i.kind === "settings" && i.id === "payment")?.data || {}; }
function businessName() { return paySettings().from || spaces.find((s) => s.id === desk.space)?.name || profile?.display_name || ""; }
function linkOf(inv) { const l = inv.link && desk.links[inv.link.id]; return l && !l.revoked ? l : null; }
function claimOf(inv) { const l = linkOf(inv); return inv.status !== "paid" && inv.status !== "void" && l?.claimed_paid_at_ms ? l.claimed_paid_at_ms : null; }
function linkTitle(inv) { const l = linkOf(inv); return !l ? "" : l.views ? `Payment link opened ${l.views}×` : "Payment link not opened yet"; }
async function refreshLinks() {
  try { desk.links = Object.fromEntries((await invoke("pay_links", { channel: desk.channel })).map((l) => [l.id, l])); desk.linksAt = Date.now(); }
  catch (e) { console.warn(e); }
}
function linkPage(inv) {
  const p = paySettings();
  return {
    v: 1, from: businessName(), to: inv.customer, number: inv.number, amount: inv.amount, currency: inv.currency || "EUR",
    issued: inv.issued, due: inv.due, status: inv.status === "paid" ? "paid" : "open", paid_on: inv.status === "paid" ? inv.paid_on : undefined,
    pay: { name: p.name || undefined, iban: p.iban || undefined, bic: p.bic || undefined, url: p.url || undefined },
  };
}
// Keeps what clients see in step with the invoice (amount, due date, paid).
async function syncLinks(list) {
  for (const inv of list) {
    if (!linkOf(inv) || !inv.link.url) continue;
    try { await invoke("update_pay_link", { channel: desk.channel, url: inv.link.url, page: linkPage(inv) }); } catch (e) { console.warn(e); }
  }
}
async function createLink(inv) {
  const p = paySettings();
  if (!p.iban && !p.url) { openPayDetails(() => createLink(inv)); return; }
  const day = 864e5;
  const dueMs = inv.due ? asDate(inv.due).getTime() : Date.now();
  const expires = Math.min(Date.now() + 179 * day, Math.max(Date.now() + 30 * day, dueMs + 90 * day));
  try {
    const link = await invoke("create_pay_link", { channel: desk.channel, page: linkPage(inv), expiresAtMs: expires });
    const next = { ...inv, link: { id: link.id, url: link.url, created: isoToday() } };
    await putInvoices([next]);
    await logActivity(`Made a payment link for ${inv.number} (${inv.customer}).`);
    await refreshLinks();
    Object.assign(inv, next);
    if (editing?.id === inv.id) editing = inv;
    await copy(link.url);
    paintLinkSection("Link copied. Paste it in your email or text.");
    [desk.items, desk.messages] = await Promise.all([invoke("desk_items", { channel: desk.channel }), invoke("open_channel", { channel: desk.channel })]);
    renderDesk();
  } catch (err) { setError("invoice-error", String(err)); }
}
async function withdrawLink(inv) {
  if (!confirm(`Withdraw the payment link for ${inv.number}? Anyone opening it will see that it has ended.`)) return;
  try {
    await invoke("revoke_pay_link", { channel: desk.channel, id: inv.link.id });
    await logActivity(`Withdrew the payment link for ${inv.number}.`);
    await refreshLinks();
    paintLinkSection();
    renderDesk();
  } catch (err) { setError("invoice-error", String(err)); }
}
function paintLinkSection(flash) {
  const inv = editing;
  const usable = inv && inv.status !== "draft" && inv.status !== "void";
  show("inv-link", !!usable);
  if (!usable) return;
  const l = linkOf(inv);
  const actions = [];
  let state;
  if (l) {
    const seen = l.views ? `Opened ${l.views} ${l.views === 1 ? "time" : "times"}, last ${dateTimeFmt.format(l.last_viewed_at_ms)}.` : "Not opened yet.";
    state = l.claimed_paid_at_ms && inv.status !== "paid" ? `${seen} They say they paid on ${dateFmt.format(l.claimed_paid_at_ms)}: check your bank.` : seen;
    actions.push(el("button", { class: "btn-ink inline", type: "button", onclick: (e) => copy(inv.link.url, e.currentTarget) }, icon("copy"), el("span", { text: "Copy link" })),
      el("button", { class: "btn-outline", type: "button", text: "Withdraw", onclick: () => withdrawLink(inv) }));
  } else {
    state = inv.link ? "The last link was withdrawn or ended." : "A page your client opens without an account: amount, due date, how to pay, and an \u201cI've paid\u201d button.";
    actions.push(el("button", { class: "btn-ink inline", type: "button", onclick: () => createLink(inv) }, icon("link"), el("span", { text: inv.link ? "Make a new link" : "Make a payment link" })));
  }
  $("inv-link-state").textContent = flash ? `${flash} ${state}` : state;
  $("inv-link-actions").replaceChildren(...actions);
}

let payDetailsThen = null;
function openPayDetails(then) {
  payDetailsThen = then || null;
  const p = paySettings();
  $("pd-from").value = p.from || businessName(); $("pd-name").value = p.name || ""; $("pd-iban").value = p.iban || ""; $("pd-bic").value = p.bic || ""; $("pd-url").value = p.url || "";
  setError("paydetails-error", "");
  $("dlg-paydetails").showModal();
}
$("desk-paydetails").addEventListener("click", () => openPayDetails());
$("paydetails-cancel").addEventListener("click", () => $("dlg-paydetails").close());
$("paydetails-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const iban = $("pd-iban").value.replace(/\s+/g, "").toUpperCase();
  const url = $("pd-url").value.trim();
  if (iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return setError("paydetails-error", "That IBAN doesn't look right.");
  if (url && !/^https:\/\/\S+$/i.test(url)) return setError("paydetails-error", "Use a link that starts with https://");
  if (!iban && !url) return setError("paydetails-error", "Add an IBAN or an online payment page, so clients know how to pay.");
  const data = { from: $("pd-from").value.trim(), name: $("pd-name").value.trim(), iban: iban.replace(/(.{4})/g, "$1 ").trim(), bic: $("pd-bic").value.trim().toUpperCase(), url };
  try {
    await invoke("put_items", { channel: desk.channel, items: [{ id: "payment", kind: "settings", data }] });
    await logActivity("Updated the payment details clients see.");
    [desk.items, desk.messages] = await Promise.all([invoke("desk_items", { channel: desk.channel }), invoke("open_channel", { channel: desk.channel })]);
    renderDesk();
    $("dlg-paydetails").close();
    // Open links show the new details too.
    await syncLinks(invoices());
    const then = payDetailsThen; payDetailsThen = null;
    if (then) then();
  } catch (err) { setError("paydetails-error", String(err)); }
});

// New or edited invoice.
let editing = null;
function openInvoice(inv) {
  editing = inv || null;
  const all = invoices();
  const next = Math.max(1000, ...all.map((i) => parseInt(String(i.number).replace(/\D/g, ""), 10) || 0)) + 1;
  $("dlg-invoice-title").textContent = inv ? `Invoice ${inv.number}` : "New invoice";
  $("inv-customer").value = inv?.customer || "";
  $("inv-email").value = inv?.email || "";
  $("inv-amount").value = inv ? (inv.amount / 100).toFixed(2) : "";
  $("inv-number").value = inv?.number || `INV-${next}`;
  $("inv-issued").value = inv?.issued || isoToday();
  $("inv-terms").value = String(inv?.terms ?? 30);
  $("inv-status").value = inv?.status || "sent";
  $("invoice-save").textContent = inv ? "Save changes" : "Save invoice";
  $("inv-clients").replaceChildren(...clients().map((c) => el("option", { value: c.name })));
  const lines = inv?.lines || [];
  show("inv-lines", lines.length > 0);
  if (lines.length) $("inv-lines").textContent = `From tracked time: ${lines.map((l) => `${l.what || "work"} ${hoursFmt(l.minutes)}`).join(", ")}.`;
  paintLinkSection();
  setError("invoice-error", "");
  $("dlg-invoice").showModal();
  $("inv-customer").focus();
}
$("new-invoice").addEventListener("click", () => openInvoice(null));
$("invoice-cancel").addEventListener("click", () => $("dlg-invoice").close());
$("invoice-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const customer = $("inv-customer").value.trim();
  const amount = Math.round(parseFloat($("inv-amount").value.replace(/\s/g, "").replace(",", ".")) * 100);
  const email = $("inv-email").value.trim();
  if (!customer) return setError("invoice-error", "Who's it for?");
  if (!Number.isFinite(amount) || amount <= 0) return setError("invoice-error", "Enter an amount, like 1200 or 1200.50.");
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setError("invoice-error", "That email doesn't look right.");
  const issued = $("inv-issued").value || isoToday();
  const terms = Number($("inv-terms").value);
  const status = $("inv-status").value;
  const inv = {
    ...(editing || {}), id: editing?.id || crypto.randomUUID(), number: $("inv-number").value.trim() || `INV-${Date.now() % 100000}`,
    customer, email, amount, currency: "EUR", issued, terms, due: addDays(issued, terms), status,
    client_id: clientByName(customer)?.id || editing?.client_id,
    paid_on: status === "paid" ? (editing?.paid_on || isoToday()) : undefined,
  };
  await busy($("invoice-save"), "Saving…", async () => {
    try {
      await putInvoices([inv]);
      const verb = !editing ? "Added" : editing.status !== status ? `Set ${status === "sent" ? "as sent" : `to ${status}`}` : "Updated";
      await logActivity(`${verb} ${inv.number}: ${customer}, ${money(amount)}.`);
      await syncLinks([inv]);
      $("dlg-invoice").close();
      openChannel(desk.channel);
    } catch (err) { setError("invoice-error", String(err)); }
  });
});


$("inv-customer").addEventListener("change", () => {
  const c = clientByName($("inv-customer").value);
  if (c?.email && !$("inv-email").value) $("inv-email").value = c.email;
});

// ---------- Collections: clients and time ----------
// Clients (a light CRM) and time entries are records in the same desk channel
// as the invoices, so an invoice made from hours is one encrypted write, and
// everyone on the desk, and only them, can see who the clients are.

const hoursFmt = (min) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? `${h} h${m ? ` ${pad2(m)}` : ""}` : `${m} min`; };
const moneyIn = (v) => { const n = parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };
function clients() {
  return desk.items.filter((i) => i.kind === "client" && !i.data.deleted).map((i) => ({ id: i.id, ...i.data })).sort((a, b) => a.name.localeCompare(b.name));
}
function clientByName(name) { const n = String(name || "").trim().toLowerCase(); return n ? clients().find((c) => c.name.toLowerCase() === n) : null; }
function clientOf(inv) { return inv.client_id ? clients().find((c) => c.id === inv.client_id) : clientByName(inv.customer); }
function timeEntries() {
  return desk.items.filter((i) => i.kind === "time" && !i.data.deleted).map((i) => ({ id: i.id, ...i.data })).sort((a, b) => (b.start || 0) - (a.start || 0));
}
const entryMinutes = (t) => (t.end ? t.minutes ?? Math.round((t.end - t.start) / 60e3) : Math.round((Date.now() - t.start) / 60e3));
const entryValue = (t) => Math.round((entryMinutes(t) / 60) * (t.rate || 0));
function myTimer() { return timeEntries().find((t) => !t.end && t.who === profile?.user_id); }
async function putRecords(recs) {
  await invoke("put_items", { channel: desk.channel, items: recs });
  desk.items = await invoke("desk_items", { channel: desk.channel });
}

function renderDeskView() {
  if (!desk) return;
  for (const b of document.querySelectorAll("#desk-views button")) b.setAttribute("aria-selected", String(b.dataset.v === desk.view));
  show("desk-invoices", desk.view === "invoices");
  show("desk-clients", desk.view === "clients");
  show("desk-time", desk.view === "time");
  if (desk.view === "clients") renderClients();
  if (desk.view === "time") renderTime();
  paintTimerPill();
  paintViewCounts();
}
for (const b of document.querySelectorAll("#desk-views button")) b.addEventListener("click", () => { desk.view = b.dataset.v; renderDeskView(); });
// New requests show as a count on the Clients view.
function paintViewCounts() {
  const n = requests().filter((r) => r.status === "new").length;
  const b = document.querySelector('#desk-views button[data-v="clients"]');
  b.replaceChildren("Clients", n ? el("span", { class: "n", text: String(n) }) : "");
}

function renderClients() {
  const all = clients();
  const inv = invoices();
  const today = isoToday();
  const stats = (c) => {
    const mine = inv.filter((i) => clientOf(i)?.id === c.id);
    const open = mine.filter((i) => i.state === "open" || i.state === "overdue");
    const unbilled = timeEntries().filter((t) => t.client === c.id && t.end && !t.billed);
    return { invoices: mine, owed: open.reduce((n, i) => n + i.amount, 0), late: mine.filter((i) => i.state === "overdue").length,
      paid: mine.filter((i) => i.state === "paid").reduce((n, i) => n + i.amount, 0), unbilledMin: unbilled.reduce((n, t) => n + entryMinutes(t), 0), last: mine[0]?.issued };
  };
  const withOwed = all.map((c) => ({ c, st: stats(c) }));
  const owing = withOwed.filter((x) => x.st.owed > 0);
  $("clients-headline").replaceChildren(...(all.length
    ? [`${all.length} ${all.length === 1 ? "client" : "clients"}. `, el("span", { class: "soft", text: owing.length ? `${owing.length} ${owing.length === 1 ? "owes" : "owe"} you ${money(owing.reduce((n, x) => n + x.st.owed, 0))}.` : "Nobody owes you anything." })]
    : ["No clients ", el("span", { class: "soft", text: "yet." })]));
  const q = desk.clientQuery.toLowerCase();
  const shown = withOwed.filter(({ c }) => !q || `${c.name} ${c.contact || ""} ${c.email || ""}`.toLowerCase().includes(q));
  show("clients-empty", all.length === 0);
  // Customers on invoices who have no card yet: one click makes one.
  const loose = [...new Set(inv.map((i) => i.customer).filter((n) => n && !clientByName(n)))];
  renderRequests();
  $("client-grid").replaceChildren(...shown.map(({ c, st }) => el("button", { class: "client-card", type: "button", onclick: () => openClient(c) },
    el("span", { class: "cc-top" }, avatarEl(c.name, { size: "sm" }), el("span", { class: "lines" }, el("strong", { text: c.name }), el("small", { text: [c.contact, c.email].filter(Boolean).join(" · ") || "No contact yet" }))),
    el("span", { class: "cc-figs" },
      el("span", {}, el("small", { text: "Owes" }), el("b", { class: st.late ? "late" : "", text: st.owed ? money(st.owed) : "None" })),
      el("span", {}, el("small", { text: "Paid" }), el("b", { text: st.paid ? moneyShort(st.paid) : "None" })),
      el("span", {}, el("small", { text: "Unbilled" }), el("b", { text: st.unbilledMin ? hoursFmt(st.unbilledMin) : "None" }))),
    el("span", { class: "cc-foot fine", text: st.late ? `${st.late} overdue` : st.last ? `Last invoice ${shortDay(st.last)}` : c.rate ? `${money(c.rate)} an hour` : "No invoices yet" }))),
    ...(loose.length && !q ? [el("div", { class: "client-loose" }, el("p", { class: "fine", text: "On invoices, without a card:" }), ...loose.slice(0, 8).map((n) => el("button", { class: "chip", type: "button", onclick: () => openClient(null, { name: n, email: inv.find((i) => i.customer === n)?.email || "" }) }, icon("plus"), n)))] : []));
  void today;
}
$("client-search").addEventListener("input", () => { desk.clientQuery = $("client-search").value; renderClients(); });

let editingClient = null;
let clientPreset = {};
function openClient(c, preset = {}) {
  editingClient = c || null;
  clientPreset = preset;
  const v = c || preset;
  $("dlg-client-title").textContent = c ? c.name : "New client";
  $("cl-name").value = v.name || ""; $("cl-contact").value = v.contact || ""; $("cl-email").value = v.email || "";
  $("cl-phone").value = v.phone || ""; $("cl-address").value = v.address || ""; $("cl-notes").value = v.notes || "";
  $("cl-rate").value = v.rate ? (v.rate / 100).toString() : "";
  show("client-delete", !!c);
  setError("client-error", "");
  // What's happened with them: invoices and unbilled time, newest first.
  const hist = $("cl-history");
  if (c) {
    const inv = invoices().filter((i) => clientOf(i)?.id === c.id);
    const time = timeEntries().filter((t) => t.client === c.id && t.end && !t.billed);
    hist.replaceChildren(
      el("p", { class: "block-label", text: "Invoices" }),
      ...(inv.length ? inv.slice(0, 6).map((i) => el("button", { class: "hist-row", type: "button", onclick: () => { $("dlg-client").close(); desk.view = "invoices"; renderDeskView(); openInvoice(i); } },
        el("span", { class: "mono", text: i.number }), el("span", { text: shortDay(i.issued) }), el("span", { class: `st ${i.state}`, text: i.state }), el("b", { text: money(i.amount) }))) : [el("p", { class: "fine", text: "None yet." })]),
      el("p", { class: "block-label", text: "Unbilled time" }),
      el("p", { class: "fine", text: time.length ? `${hoursFmt(time.reduce((n, t) => n + entryMinutes(t), 0))}, worth ${money(time.reduce((n, t) => n + entryValue(t), 0))}.` : "None." }));
  }
  show("cl-history", !!c);
  $("dlg-client").showModal();
  $("cl-name").focus();
}
$("new-client").addEventListener("click", () => openClient(null));
$("client-cancel").addEventListener("click", () => $("dlg-client").close());
$("client-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("cl-name").value.trim();
  const email = $("cl-email").value.trim();
  if (!name) return setError("client-error", "A client needs a name.");
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setError("client-error", "That email doesn't look right.");
  const clash = clientByName(name);
  if (clash && clash.id !== editingClient?.id) return setError("client-error", `${clash.name} already has a card.`);
  const rateRaw = $("cl-rate").value.trim();
  const rate = rateRaw ? moneyIn(rateRaw) : null;
  if (rateRaw && rate == null) return setError("client-error", "Enter a rate like 80 or 92.50.");
  const { id: _id, ...prev } = editingClient || { fromRequest: clientPreset.fromRequest }; void _id;
  const data = { ...prev, name, contact: $("cl-contact").value.trim(), email, phone: $("cl-phone").value.trim(), address: $("cl-address").value.trim(), notes: $("cl-notes").value.trim(), rate, added: editingClient?.added || Date.now() };
  await busy($("client-save"), "Saving…", async () => {
    try {
      const { fromRequest, ...clean } = data;
      const cid = editingClient?.id || crypto.randomUUID();
      await putRecords([{ id: cid, kind: "client", data: clean }]);
      const req = fromRequest && requests().find((x) => x.id === fromRequest);
      if (req) { const { id: rid, ...rd } = req; await putRecords([{ id: rid, kind: "request", data: { ...rd, status: "client", client: cid } }]); }
      await logActivity(editingClient ? `Updated the client card for ${name}.` : `Added ${name} as a client.`);
      $("dlg-client").close();
      renderDeskView();
    } catch (err) { setError("client-error", String(err)); }
  });
});
$("client-delete").addEventListener("click", async () => {
  const c = editingClient;
  if (!c || !confirm(`Delete the card for ${c.name}? Their invoices and time stay.`)) return;
  const { id, ...data } = c;
  await putRecords([{ id, kind: "client", data: { ...data, deleted: true } }]);
  await logActivity(`Deleted the client card for ${c.name}.`);
  $("dlg-client").close();
  renderDeskView();
});


// ---------- intake forms ----------
// One form per Collections desk. Its private key lives in the desk's records
// (end-to-end encrypted); the public key goes to the page. Answers wait on the
// server sealed to that key; a member's device opens them, saves them as
// "request" records and deletes them from the server.

const FIELD_TYPES = [["text", "Short answer"], ["longtext", "Long answer"], ["email", "Email"], ["phone", "Phone"], ["choice", "Pick one"]];
const DEFAULT_FIELDS = [
  { id: "name", label: "Your name", type: "text", required: true },
  { id: "company", label: "Company", type: "text", required: false },
  { id: "email", label: "Email", type: "email", required: true },
  { id: "phone", label: "Phone", type: "phone", required: false },
  { id: "need", label: "What do you need?", type: "longtext", required: true },
];
function intakeForm() { const r = desk.items.find((i) => i.kind === "form" && i.id === "intake"); return r ? { ...r.data } : null; }
function requests() { return desk.items.filter((i) => i.kind === "request" && !i.data.deleted).map((i) => ({ id: i.id, ...i.data })).sort((a, b) => b.at - a.at); }
let fmDraft = null;
function openIntakeForm() {
  const f = intakeForm();
  fmDraft = { title: f?.title || "Start a project", intro: f?.intro || "", fields: (f?.fields || DEFAULT_FIELDS).map((x) => ({ ...x })) };
  $("fm-title").value = fmDraft.title; $("fm-intro").value = fmDraft.intro;
  renderFmFields();
  const live = f?.link && f.status !== "closed";
  show("fm-link", !!live); show("form-withdraw", !!live);
  if (live) {
    $("fm-link-state").textContent = `Open until ${shortDay(isoOf(new Date(f.link.expires)))}. ${requests().length} ${requests().length === 1 ? "request" : "requests"} so far.`;
    $("fm-link-actions").replaceChildren(el("button", { class: "btn-ink inline sm", type: "button", onclick: (e) => copyText(f.link.url, e.currentTarget) }, icon("copy"), "Copy link"));
  }
  $("form-save").textContent = live ? "Save changes" : "Publish";
  setError("form-error", "");
  $("dlg-form").showModal();
}
async function copyText(text, btn) { try { await navigator.clipboard.writeText(text); const t = btn.lastChild.textContent; btn.lastChild.textContent = "Copied"; setTimeout(() => { btn.lastChild.textContent = t; }, 1500); } catch { prompt("Copy the link:", text); } }
function renderFmFields() {
  $("fm-fields").replaceChildren(...fmDraft.fields.map((q, k) => el("div", { class: "fm-row" },
    el("input", { class: "text-input", value: q.label, maxlength: "80", "aria-label": "Question", oninput: (e) => { q.label = e.target.value; } }),
    (() => { const sel = el("select", { class: "text-input", "aria-label": "Kind of answer", onchange: (e) => { q.type = e.target.value; renderFmFields(); } }, ...FIELD_TYPES.map(([v, l]) => el("option", { value: v, text: l }))); sel.value = q.type; return sel; })(),
    el("label", { class: "fm-req" }, el("input", { type: "checkbox", checked: !!q.required, onchange: (e) => { q.required = e.target.checked; } }), "Needed"),
    el("button", { class: "icon-btn", type: "button", title: "Remove", "aria-label": "Remove", disabled: fmDraft.fields.length <= 1, onclick: () => { fmDraft.fields.splice(k, 1); renderFmFields(); } }, icon("x")),
    q.type === "choice" ? el("input", { class: "text-input fm-options", value: (q.options || []).join(", "), placeholder: "Options, separated by commas", "aria-label": "Options", oninput: (e) => { q.options = e.target.value.split(",").map((o) => o.trim()).filter(Boolean); } }) : null)));
}
$("fm-add").addEventListener("click", () => { if (fmDraft.fields.length >= 30) return; fmDraft.fields.push({ id: crypto.randomUUID().slice(0, 8), label: "", type: "text", required: false }); renderFmFields(); $("fm-fields").lastElementChild?.querySelector("input")?.focus(); });
$("intake-open").addEventListener("click", openIntakeForm);
$("form-cancel").addEventListener("click", () => $("dlg-form").close());
$("form-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  fmDraft.title = $("fm-title").value.trim(); fmDraft.intro = $("fm-intro").value.trim();
  if (!fmDraft.title) return setError("form-error", "Give the form a title.");
  if (fmDraft.fields.some((q) => !q.label.trim())) return setError("form-error", "Every question needs a label.");
  if (fmDraft.fields.some((q) => q.type === "choice" && !(q.options || []).length)) return setError("form-error", "\"Pick one\" questions need options.");
  const prev = intakeForm();
  await busy($("form-save"), "Publishing…", async () => {
    try {
      const keys = prev?.private_key && prev.status !== "closed" ? { public_key: prev.public_key, private_key: prev.private_key } : await invoke("new_form_keys");
      const fields = fmDraft.fields.map((q) => ({ id: q.id, label: q.label.trim(), type: q.type, required: !!q.required, ...(q.type === "choice" ? { options: q.options } : {}) }));
      const page = { v: 1, from: businessName(), title: fmDraft.title, intro: fmDraft.intro, fields, public_key: keys.public_key };
      let link = prev?.status !== "closed" ? prev?.link : null;
      if (link) await invoke("update_form", { channel: desk.channel, url: link.url, form: page });
      else {
        const expires = Date.now() + 365 * 864e5;
        const made = await invoke("create_form", { channel: desk.channel, form: page, expiresAtMs: expires });
        link = { id: made.id, url: made.url, expires };
      }
      await putRecords([{ id: "intake", kind: "form", data: { title: fmDraft.title, intro: fmDraft.intro, fields, ...keys, link, status: "open", created: prev?.created || Date.now() } }]);
      await logActivity(prev?.link && prev.status !== "closed" ? "Updated the intake form." : "Published an intake form.");
      openIntakeForm();
    } catch (err) { setError("form-error", String(err)); }
  });
});
$("form-withdraw").addEventListener("click", async () => {
  const f = intakeForm();
  if (!f?.link || !confirm("Close the form? The link stops working. Requests already in stay here.")) return;
  try {
    await invoke("revoke_form", { channel: desk.channel, id: f.link.id });
    await putRecords([{ id: "intake", kind: "form", data: { ...f, status: "closed" } }]);
    await logActivity("Closed the intake form.");
    $("dlg-form").close();
    renderDeskView();
  } catch (err) { setError("form-error", String(err)); }
});

// Picks answers up from the server: save first, then delete there.
let intakeAt = 0;
async function pullIntake(force = false) {
  const f = desk && intakeForm();
  if (!f?.link || f.status === "closed" || (!force && Date.now() - intakeAt < 30000)) return 0;
  intakeAt = Date.now();
  const ch = desk.channel;
  let got;
  try { got = await invoke("form_answers", { channel: ch, id: f.link.id, privateKey: f.private_key }); } catch (e) { console.warn(e); return 0; }
  if (!got.length || desk?.channel !== ch) return 0;
  await putRecords(got.map((a) => ({ id: `req-${f.link.id}-${a.sub}`, kind: "request", data: { at: a.at_ms, answers: a.data.answers || {}, labels: a.data.labels || {}, status: "new" } })));
  for (const a of got) await invoke("forget_form_answer", { channel: ch, id: f.link.id, sub: a.sub }).catch(() => {});
  await logActivity(`${got.length} new ${got.length === 1 ? "request" : "requests"} from the intake form.`);
  return got.length;
}
// The answer whose question looks like `kind` (by type first, then by label).
function answerOf(r, kind) {
  const f = intakeForm();
  const fields = f?.fields || [];
  const byType = { email: "email", phone: "phone" }[kind];
  const match = fields.find((q) => byType && q.type === byType) || fields.find((q) => ({ name: /name|nom/i, company: /company|business|société|entreprise/i, need: /need|project|message|besoin/i }[kind] || /$^/).test(q.label));
  return match ? (r.answers[match.id] || "").trim() : "";
}
function renderRequests() {
  const list = requests().filter((r) => r.status === "new");
  show("requests", list.length > 0);
  if (!list.length) return;
  $("requests").replaceChildren(el("p", { class: "block-label", text: `New requests · ${list.length}` }), ...list.map((r) => {
    const name = answerOf(r, "company") || answerOf(r, "name") || "Someone";
    return el("div", { class: "request" },
      el("div", { class: "req-top" }, el("strong", { text: name }), el("small", { class: "fine", text: sinceFmt(r.at) })),
      el("dl", { class: "req-answers" }, ...Object.entries(r.answers).filter(([, v]) => v).map(([k, v]) => el("div", {}, el("dt", { text: r.labels[k] || k }), el("dd", { text: v })))),
      el("div", { class: "row-actions" },
        el("button", { class: "btn-ink inline sm", type: "button", onclick: () => requestToClient(r) }, icon("plus"), "Make a client card"),
        el("button", { class: "btn-outline inline sm", type: "button", onclick: () => setRequest(r, "dismissed") }, "Dismiss")));
  }));
}
async function setRequest(r, status, extra = {}) {
  const { id, ...data } = r;
  await putRecords([{ id, kind: "request", data: { ...data, status, ...extra } }]);
  renderClients();
}
function requestToClient(r) {
  const company = answerOf(r, "company"), person = answerOf(r, "name");
  const need = answerOf(r, "need");
  openClient(null, { name: company || person, contact: company ? person : "", email: answerOf(r, "email"), phone: answerOf(r, "phone"), notes: need ? `From the intake form: ${need}` : "", fromRequest: r.id });
}

// Time: a running timer is a record with no end, so it shows on every device;
// only the person who started it sees the Stop button.
function clientOptions(sel, value) {
  sel.replaceChildren(el("option", { value: "", text: "No client" }), ...clients().map((c) => el("option", { value: c.id, text: c.name })));
  sel.value = value || "";
}
function renderTime() {
  const all = timeEntries();
  const done = all.filter((t) => t.end);
  const unbilled = done.filter((t) => !t.billed);
  const umin = unbilled.reduce((n, t) => n + entryMinutes(t), 0);
  const weekAgo = Date.now() - 7 * 864e5;
  const wmin = done.filter((t) => t.start >= weekAgo).reduce((n, t) => n + entryMinutes(t), 0);
  $("time-headline").replaceChildren(...(done.length
    ? [`${hoursFmt(umin)} unbilled`, el("span", { class: "soft", text: `, worth ${money(unbilled.reduce((n, t) => n + entryValue(t), 0))}. ${hoursFmt(wmin)} this week.` })]
    : ["No time ", el("span", { class: "soft", text: "tracked yet." })]));
  const run = myTimer();
  if (document.activeElement !== $("tm-client")) clientOptions($("tm-client"), run?.client ?? $("tm-client").value);
  if (run && document.activeElement !== $("tm-what")) $("tm-what").value = run.what || "";
  $("tm-toggle").lastElementChild.textContent = run ? "Stop" : "Start";
  $("tm-toggle").classList.toggle("running", !!run);
  tickClock();
  const counts = { unbilled: unbilled.length, billed: done.length - unbilled.length, all: all.length };
  const labels = { unbilled: "Unbilled", billed: "Billed", all: "All" };
  $("time-tabs").replaceChildren(...Object.keys(labels).map((k) => el("button", { type: "button", role: "tab", "aria-selected": String(desk.timeTab === k), onclick: () => { desk.timeTab = k; desk.timeSel.clear(); renderTime(); } }, labels[k], el("span", { class: "n", text: String(counts[k]) }))));
  const rows = all.filter((t) => desk.timeTab === "all" || (desk.timeTab === "billed" ? t.billed : !t.billed));
  show("time-empty", all.length === 0);
  const byDay = new Map();
  for (const t of rows) { const k = isoOf(new Date(t.start)); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(t); }
  const cname = (id) => clients().find((c) => c.id === id)?.name;
  $("time-list").replaceChildren(...[...byDay.entries()].map(([day, list]) => el("section", { class: "time-day" },
    el("header", {}, el("strong", { text: day === isoToday() ? "Today" : asDate(day).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) }), el("span", { class: "fine", text: hoursFmt(list.reduce((n, t) => n + entryMinutes(t), 0)) })),
    ...list.map((t) => {
      const running = !t.end;
      const check = !running && !t.billed ? el("input", { type: "checkbox", "aria-label": "Select", checked: desk.timeSel.has(t.id), onclick: (e) => e.stopPropagation(), onchange: (e) => { e.target.checked ? desk.timeSel.add(t.id) : desk.timeSel.delete(t.id); paintTimeInvoice(); } }) : el("span", { class: "chk-gap" });
      return el("div", { class: `time-row${running ? " running" : ""}`, role: "button", tabindex: "0", onclick: () => !running && openTimeEntry(t) },
        check, el("span", { class: "what", text: t.what || "Untitled work" }), el("span", { class: "who fine", text: cname(t.client) || "No client" }),
        el("span", { class: "fine", text: running ? `running · ${t.who_name || ""}` : t.billed ? "Billed" : t.rate ? `${money(t.rate)}/h` : "No rate" }),
        el("b", { class: "mono", text: hoursFmt(entryMinutes(t)) }), el("b", { class: "num", text: t.rate ? money(entryValue(t)) : "None" }));
    }))));
  paintTimeInvoice();
}
function paintTimeInvoice() {
  const sel = timeEntries().filter((t) => desk.timeSel.has(t.id));
  const clientsIn = new Set(sel.map((t) => t.client || ""));
  const b = $("time-invoice");
  b.disabled = !sel.length || clientsIn.size !== 1 || clientsIn.has("");
  b.title = !sel.length ? "Select unbilled entries first" : clientsIn.has("") ? "Give these entries a client first" : clientsIn.size > 1 ? "One invoice is for one client" : "";
  b.lastChild.textContent = sel.length ? `Invoice ${hoursFmt(sel.reduce((n, t) => n + entryMinutes(t), 0))}` : "Invoice selected";
}
function tickClock() {
  const run = desk && myTimer();
  const secs = run ? Math.max(0, Math.floor((Date.now() - run.start) / 1000)) : 0;
  $("tm-clock").textContent = `${Math.floor(secs / 3600)}:${pad2(Math.floor(secs / 60) % 60)}:${pad2(secs % 60)}`;
  paintTimerPill();
}
function paintTimerPill() {
  const run = desk && myTimer();
  show("timer-pill", !!run && desk.view !== "time");
  if (run) $("timer-pill").replaceChildren(el("span", { class: "rec" }), `${run.what || "Timer"} · ${$("tm-clock").textContent}`);
}
$("timer-pill").addEventListener("click", () => { desk.view = "time"; renderDeskView(); });
setInterval(() => { if (desk && !$("view-desk").hidden && myTimer()) tickClock(); }, 1000);
$("timer-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const run = myTimer();
  const client = $("tm-client").value || null;
  const c = clients().find((x) => x.id === client);
  try {
    if (run) {
      const end = Date.now();
      const { id, ...data } = run;
      const minutes = Math.max(1, Math.round((end - run.start) / 60e3));
      await putRecords([{ id, kind: "time", data: { ...data, what: $("tm-what").value.trim() || data.what, client: client ?? data.client, rate: data.rate ?? c?.rate ?? null, end, minutes } }]);
      await logActivity(`Tracked ${hoursFmt(minutes)}${c ? ` for ${c.name}` : ""}: ${$("tm-what").value.trim() || "work"}.`);
      $("tm-what").value = "";
    } else {
      await putRecords([{ id: crypto.randomUUID(), kind: "time", data: { what: $("tm-what").value.trim(), client, rate: c?.rate ?? null, start: Date.now(), end: null, who: profile?.user_id, who_name: profile?.display_name || "" } }]);
    }
    renderTime();
  } catch (err) { alert(String(err)); }
});

let editingTime = null;
function openTimeEntry(t) {
  editingTime = t || null;
  $("dlg-time-title").textContent = t ? "Time entry" : "Add time";
  $("te-what").value = t?.what || "";
  clientOptions($("te-client"), t?.client || $("tm-client").value);
  $("te-date").value = t ? isoOf(new Date(t.start)) : isoToday();
  const m = t ? entryMinutes(t) : 0;
  $("te-hours").value = t ? `${Math.floor(m / 60)}:${pad2(m % 60)}` : "";
  const c = clients().find((x) => x.id === $("te-client").value);
  $("te-rate").value = t?.rate != null ? String(t.rate / 100) : c?.rate ? String(c.rate / 100) : "";
  show("te-billed", !!t?.billed);
  if (t?.billed) $("te-billed").textContent = `Billed on ${invoices().find((i) => i.id === t.billed)?.number || "an invoice"}. Changing it here doesn't change the invoice.`;
  show("time-delete", !!t);
  setError("time-error", "");
  $("dlg-time").showModal();
  $("te-what").focus();
}
$("te-client").addEventListener("change", () => { const c = clients().find((x) => x.id === $("te-client").value); if (c?.rate && !$("te-rate").value) $("te-rate").value = String(c.rate / 100); });
$("tm-manual").addEventListener("click", () => openTimeEntry(null));
$("time-cancel").addEventListener("click", () => $("dlg-time").close());
function parseHours(v) {
  const s = String(v).trim();
  let m;
  if ((m = /^(\d+):([0-5]?\d)$/.exec(s))) return Number(m[1]) * 60 + Number(m[2]);
  const n = parseFloat(s.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 60) : null;
}
$("time-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const minutes = parseHours($("te-hours").value);
  if (!minutes || minutes > 24 * 60) return setError("time-error", "Enter the time like 1:30 or 1.5 (up to 24 hours).");
  const rateRaw = $("te-rate").value.trim();
  const rate = rateRaw ? moneyIn(rateRaw) : null;
  if (rateRaw && rate == null) return setError("time-error", "Enter a rate like 80 or 92.50.");
  const day = $("te-date").value || isoToday();
  const start = editingTime && isoOf(new Date(editingTime.start)) === day ? editingTime.start : new Date(`${day}T09:00`).getTime();
  const { id: _i, ...prev } = editingTime || {}; void _i;
  const data = { ...prev, what: $("te-what").value.trim(), client: $("te-client").value || null, rate, start, end: start + minutes * 60e3, minutes, who: prev.who || profile?.user_id, who_name: prev.who_name || profile?.display_name || "" };
  await busy($("time-save"), "Saving…", async () => {
    try {
      await putRecords([{ id: editingTime?.id || crypto.randomUUID(), kind: "time", data }]);
      if (!editingTime) await logActivity(`Added ${hoursFmt(minutes)} of time: ${data.what || "work"}.`);
      $("dlg-time").close();
      renderTime();
    } catch (err) { setError("time-error", String(err)); }
  });
});
$("time-delete").addEventListener("click", async () => {
  const t = editingTime;
  if (!t || !confirm("Delete this time entry?")) return;
  const { id, ...data } = t;
  await putRecords([{ id, kind: "time", data: { ...data, deleted: true } }]);
  desk.timeSel.delete(id);
  $("dlg-time").close();
  renderTime();
});

// Selected hours become a draft invoice for their client; the entries are
// marked billed with that invoice in the same write.
$("time-invoice").addEventListener("click", async () => {
  const sel = timeEntries().filter((t) => desk.timeSel.has(t.id) && t.end && !t.billed);
  const c = clients().find((x) => x.id === sel[0]?.client);
  if (!sel.length || !c) return;
  if (sel.some((t) => !t.rate) && !confirm("Some entries have no rate and count as €0. Make the invoice anyway?")) return;
  const all = invoices();
  const next = Math.max(1000, ...all.map((i) => parseInt(String(i.number).replace(/\D/g, ""), 10) || 0)) + 1;
  const id = crypto.randomUUID();
  const issued = isoToday();
  const amount = sel.reduce((n, t) => n + entryValue(t), 0);
  const inv = { number: `INV-${next}`, customer: c.name, client_id: c.id, email: c.email || "", amount, currency: "EUR", issued, terms: 30, due: addDays(issued, 30), status: "draft",
    lines: sel.map((t) => ({ what: t.what, minutes: entryMinutes(t), rate: t.rate || 0 })) };
  try {
    await putRecords([{ id, kind: "invoice", data: inv }, ...sel.map(({ id: tid, ...data }) => ({ id: tid, kind: "time", data: { ...data, billed: id } }))]);
    await logActivity(`Drafted ${inv.number} for ${c.name} from ${hoursFmt(sel.reduce((n, t) => n + entryMinutes(t), 0))} of time: ${money(amount)}.`);
    desk.timeSel.clear();
    desk.view = "invoices";
    renderDesk(); renderDeskView();
    openInvoice(invoices().find((i) => i.id === id));
  } catch (err) { alert(String(err)); }
});

$("notes-input").addEventListener("input", () => { $("notes-send").disabled = !$("notes-input").value.trim(); });
$("notes-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("notes-composer").requestSubmit(); } });
$("notes-composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("notes-input").value.trim();
  if (!text) return;
  $("notes-input").value = ""; $("notes-send").disabled = true;
  await logActivity(text);
  openChannel(desk.channel);
});
$("notes-brief").addEventListener("click", () => {
  const all = invoices();
  const paidMonth = all.filter((i) => i.state === "paid" && (i.paid_on || "").slice(0, 7) === isoToday().slice(0, 7));
  const open = all.filter((i) => i.state === "open" || i.state === "overdue");
  const lines = [
    `${money(open.reduce((n, i) => n + i.amount, 0))} outstanding on ${open.length} ${open.length === 1 ? "invoice" : "invoices"}.`,
    `${money(paidMonth.reduce((n, i) => n + i.amount, 0))} collected this month.`,
    (() => { const o = all.filter((i) => i.state === "overdue").length, d = all.filter((i) => i.state === "draft").length; return `${o} overdue, ${d} ${d === 1 ? "draft" : "drafts"}.`; })(),
  ];
  $("notes-feed").prepend(el("div", { class: "note-card" }, el("div", { class: "note-flag good" }, el("span", { text: "Today's brief" })), el("div", { class: "note-body" }, ...lines.map((l) => el("p", { text: l })))));
});
$("desk-people").addEventListener("click", () => openPeople(true));

// New desk.
let newDeskKind = "collections";
function openNewDesk() { pickDeskKind("collections"); setError("desk-error", ""); $("dlg-desk").showModal(); $("desk-new-name").select(); }
function pickDeskKind(kind) {
  newDeskKind = kind;
  for (const b of document.querySelectorAll("#dlg-desk .kind[data-kind]")) b.setAttribute("aria-checked", String(b.dataset.kind === kind));
  $("desk-new-name").value = KIND_OF_DESK[kind] || "Desk";
}
for (const b of document.querySelectorAll("#dlg-desk .kind[data-kind]")) b.addEventListener("click", () => pickDeskKind(b.dataset.kind));

$("space-empty-desk").addEventListener("click", openNewDesk);
$("desk-cancel").addEventListener("click", () => $("dlg-desk").close());
$("desk-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await busy($("desk-create"), "Creating…", async () => {
    try {
      const id = await invoke("create_desk", { space: currentSpace?.id ?? null, name: $("desk-new-name").value, kind: newDeskKind });
      $("dlg-desk").close();
      await refreshChannels();
      await openChannel(id);
    } catch (err) { setError("desk-error", String(err)); }
  });
});

// Direct messages

async function startDm(handle, errorId, button) {
  setError(errorId, "");
  try {
    const id = await busy(button, "Opening…", () => invoke("start_dm", { handle }));
    await refreshChannels();
    if (view !== "home") go("home");
    await openChannel(id);
    composer.focus();
    return true;
  } catch (err) { setError(errorId, String(err)); return false; }
}
$("new-dm").addEventListener("click", () => { $("dm-handle").value = ""; setError("dm-error", ""); $("dlg-dm").showModal(); $("dm-handle").focus(); });
$("dm-cancel").addEventListener("click", () => $("dlg-dm").close());
$("dm-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (await startDm($("dm-handle").value, "dm-error", $("dm-open"))) $("dlg-dm").close();
});
$("start-dm-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (await startDm($("start-dm").value, "start-dm-error", e.submitter || $("start-dm-form").querySelector("button"))) $("start-dm").value = "";
});

// Spaces

function openSpaceDialog(tab) {
  $("space-new-name").value = ""; $("space-code").value = "";
  const kind = USAGE_KIND[profile?.usage] || "personal";
  for (const r of document.querySelectorAll("input[name=space-kind]")) r.checked = r.value === kind;
  setError("space-error", "");
  spaceTab(tab);
  $("dlg-space").showModal();
  (tab === "join" ? $("space-code") : $("space-new-name")).focus();
}
function spaceTab(tab) {
  for (const t of document.querySelectorAll("#dlg-space .tab")) t.setAttribute("aria-selected", String(t.dataset.tab === tab));
  for (const p of document.querySelectorAll("#dlg-space [data-pane]")) show(p, p.dataset.pane === tab);
  $("space-submit").textContent = tab === "join" ? "Join space" : "Create space";
  $("dlg-space").dataset.tab = tab;
}
for (const t of document.querySelectorAll("#dlg-space .tab")) t.addEventListener("click", () => spaceTab(t.dataset.tab));
$("rail-add").addEventListener("click", () => {
  // Spaces live on a server: a local account connects one first (D38).
  if (status.local) { if (confirm("Spaces are shared with other people, so they live on a server. Connect one now? Everything you've made on this computer comes with you.")) connectServer(); return; }
  openSpaceDialog("create");
});
$("me-connect").addEventListener("click", () => { toggleMe(false); connectServer(); });
$("start-create").addEventListener("click", () => openSpaceDialog("create"));
$("start-join").addEventListener("click", () => openSpaceDialog("join"));
$("space-cancel").addEventListener("click", () => $("dlg-space").close());
$("space-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const join = $("dlg-space").dataset.tab === "join";
  await busy($("space-submit"), join ? "Joining…" : "Creating…", async () => {
    try {
      const s = join
        ? await invoke("join_space", { code: parseInvite($("space-code").value).code })
        : await invoke("create_space", { name: $("space-new-name").value, kind: document.querySelector("input[name=space-kind]:checked")?.value || "personal" });
      $("dlg-space").close();
      spaces = await invoke("spaces");
      openSpace(spaces.find((x) => x.id === s.id) || s);
    } catch (err) { setError("space-error", String(err)); }
  });
});

function openInvite() {
  $("invite-space-name").textContent = currentSpace.name;
  show("sp-result", false); show("sp-copy", false); show("sp-create");
  setError("sp-error", "");
  $("dlg-invite").showModal();
}
$("space-invite").addEventListener("click", openInvite);
$("space-empty-invite").addEventListener("click", openInvite);
$("sp-close").addEventListener("click", () => $("dlg-invite").close());
$("sp-copy").addEventListener("click", () => copy($("sp-code").textContent, $("sp-copy")));
$("space-invite-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const inv = await invoke("create_space_invite", { space: currentSpace.id, hours: Number($("sp-hours").value), maxUses: Number($("sp-uses").value) });
    $("sp-code").textContent = `${status.session?.server || workspace?.server || ""}/i/${inv.code}`;
    $("sp-meta").textContent = `Works until ${dateTimeFmt.format(inv.expires_at_ms)}, ${inv.max_uses === 1 ? "once" : `${inv.max_uses} times`}. New people paste the link when they sign up; people with an account use "Join with a code" on Home.`;
    show("sp-result"); show("sp-copy"); show("sp-create", false);
  } catch (err) { setError("sp-error", String(err)); }
});

// New channel

function openNewChannel() {
  $("ch-new-name").value = ""; $("ch-new-topic").value = "";
  for (const r of document.querySelectorAll("input[name=trust]")) r.checked = false;
  $("channel-create").disabled = true;
  setError("channel-error", "");
  $("dlg-channel").showModal();
  $("ch-new-name").focus();
}
$("new-channel").addEventListener("click", openNewChannel);
$("space-empty-channel").addEventListener("click", openNewChannel);
function channelFormReady() { $("channel-create").disabled = !$("ch-new-name").value.trim() || !document.querySelector("input[name=trust]:checked"); }
$("channel-form").addEventListener("input", channelFormReady);
$("channel-form").addEventListener("change", channelFormReady);
$("channel-cancel").addEventListener("click", () => $("dlg-channel").close());
$("channel-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const trust = document.querySelector("input[name=trust]:checked")?.value;
  if (!trust) return;
  await busy($("channel-create"), "Creating…", async () => {
    try {
      const id = await invoke("create_channel", { space: currentSpace?.id ?? null, name: $("ch-new-name").value, topic: $("ch-new-topic").value, trust });
      $("dlg-channel").close();
      await refreshChannels();
      await openChannel(id);
      composer.focus();
    } catch (err) { setError("channel-error", String(err)); }
  });
});

// People in a channel

let peopleCache = [];
async function openPeople(addMode) {
  const c = channels.find((x) => x.id === current);
  $("people-channel").textContent = `#${c.name}`;
  setError("people-error", "");
  $("people-filter").value = "";
  show("people-add", addMode);
  $("dlg-people").showModal();
  try {
    peopleCache = addMode ? await invoke("people", { channel: current })
      : (await invoke("channel_members", { channel: current })).map((m) => ({ ...m, in_channel: true, can_be_added: false }));
  } catch (err) { setError("people-error", String(err)); peopleCache = []; }
  renderPeople(addMode);
  $("people-filter").focus();
}
function renderPeople(addMode) {
  const q = $("people-filter").value.toLowerCase();
  const rows = peopleCache
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.handle || "").includes(q))
    .map((p) => {
      const note = p.me ? "You" : p.in_channel ? (addMode ? "Already here" : p.is_guest ? "Guest" : "Member")
        : p.can_be_added ? (p.handle ? `@${p.handle}` : "") : "Hasn't signed in on a device yet";
      const right = addMode
        ? el("input", { type: "checkbox", value: p.user_id, "aria-label": `Add ${p.name}`, disabled: p.in_channel || !p.can_be_added || p.me })
        : (!p.me && !profile?.is_guest ? el("button", { class: "btn-outline sm", type: "button", text: "Remove", onclick: () => removePerson(p) }) : el("span"));
      return el("label", { class: "person" }, avatarEl(p.name, { size: "sm" }), el("span", { class: "grow" }, el("span", { text: p.name }), el("small", { text: note })), right);
    });
  $("people-list").replaceChildren(...(rows.length ? rows : [el("p", { class: "fine", text: "Nobody here yet. Invite people to the space first." })]));
  $("people-add").disabled = true;
}
$("people-filter").addEventListener("input", () => renderPeople(!$("people-add").hidden));
$("people-list").addEventListener("change", () => { $("people-add").disabled = !$("people-list").querySelector("input:checked"); });
$("convo-add").addEventListener("click", () => openPeople(true));
$("convo-members").addEventListener("click", () => openPeople(false));
$("people-cancel").addEventListener("click", () => $("dlg-people").close());
$("people-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const users = [...$("people-list").querySelectorAll("input:checked")].map((i) => i.value);
  await busy($("people-add"), "Adding…", async () => {
    try {
      const notReady = await invoke("add_people", { channel: current, users });
      if (notReady.length) return setError("people-error", `Added. ${notReady.join(", ")} can't be added until they sign in on a device.`);
      $("dlg-people").close();
      openChannel(current);
    } catch (err) { setError("people-error", String(err)); }
  });
});
async function removePerson(p) {
  try { await invoke("remove_person", { channel: current, user: p.user_id }); await openPeople(false); openChannel(current); }
  catch (err) { setError("people-error", String(err)); }
}


// ---------- to-dos, reminders and notifications ----------
// All worked out on this device from records it can already decrypt: the
// agenda, task boards and Collections desks. Nothing about them goes to the
// server. Read state and "already reminded" are kept in local storage.

let todos = [];
async function loadTodos() {
  const out = [];
  for (const d of channels.filter((c) => c.desk === "tasks")) {
    const items = await invoke("desk_items", { channel: d.id }).catch(() => []);
    const done = new Set(boardColumns(items).filter((c) => c.done).map((c) => c.id));
    for (const i of items) if (i.kind === "card" && !i.data.deleted && !done.has(i.data.column)) out.push({ id: i.id, ...i.data, desk: d });
  }
  // Late first, then by due date, then undated in board order.
  out.sort((a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1) || (a.due || "").localeCompare(b.due || "") || (a.order ?? 0) - (b.order ?? 0));
  todos = out;
}
function todosHere() {
  return todos.filter((t) => view === "space" ? t.desk.space === currentSpace?.id : true);
}
function renderTodos() {
  const list = todosHere();
  const today = isoToday();
  const rows = list.slice(0, 8).map((t) => el("button", { class: `todo${t.due && t.due < today ? " late" : ""}`, type: "button", title: `${t.title} · ${t.desk.kind === "personal" ? "My tasks" : t.desk.name}`, onclick: () => openTodo(t) },
    el("span", { class: "tick" }), el("span", { class: "t", text: t.title }), t.due ? el("small", { text: t.due < today ? "Late" : t.due === today ? "Today" : shortDay(t.due) }) : null));
  const boards = [...new Set(list.map((t) => t.desk))];
  for (const box of document.querySelectorAll("[data-todo]")) {
    box.replaceChildren(...(list.length ? [el("div", { class: "todo-head" }, el("span", { text: `To do · ${list.length}` }),
      boards.length === 1 ? el("button", { class: "link", type: "button", text: "Board", onclick: () => openChannel(boards[0].id) }) : null), ...rows] : []));
  }
}
const shortDay = (iso) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
async function openTodo(t) {
  await openBoard(t.desk);
  const c = boardCards().find((x) => x.id === t.id);
  if (c) openCard(c);
}

// Notifications: reminders that are due, then activity (new messages, what desks need).
let reminded = readStore("anarchy.reminded", {});
let notifRead = readStore("anarchy.notifRead", {});
function mentionsMe(text) {
  const t = String(text || "").toLowerCase();
  const names = [profile?.username, profile?.display_name?.split(" ")[0]].filter(Boolean).map((n) => `@${n.toLowerCase()}`);
  return names.some((n) => t.includes(n));
}
function notifItems() {
  const now = new Date(), today = isoOf(now), soon = new Date(now.getTime() + 24 * 3600e3);
  const out = [];
  for (const e of events()) {
    if (e.all_day || !e.start) { if (e.date === today) out.push({ key: `ev:${e.id}:${e.date}`, kind: "event", icon: "calendar", title: e.title, sub: "Today", at: `${e.date}T00:00`, go: () => openAgenda() }); continue; }
    const at = new Date(`${e.date}T${e.start}`);
    if (at >= new Date(now.getTime() - 3600e3) && at <= soon) out.push({ key: `ev:${e.id}:${e.date}:${e.start}`, kind: "event", icon: "calendar", title: e.title, sub: `${at.toDateString() === now.toDateString() ? "Today" : "Tomorrow"} at ${e.start}${e.where ? ` · ${e.where}` : ""}`, at: `${e.date}T${e.start}`, start: at, go: () => openAgenda() });
  }
  for (const d of agenda.dues) {
    if (d.date > today) continue;
    const late = d.date < today;
    out.push({ key: `due:${d.channel}:${d.title}:${d.date}`, kind: "due", channel: d.channel, icon: d.task ? "board" : "receipt", late, title: d.title, sub: late ? `Was due ${shortDay(d.date)}` : "Due today", at: `${d.date}T09:00`, go: () => openChannel(d.channel) });
  }
  for (const c of channels) {
    if (!c.unread || c.id === current || c.kind === "personal") continue;
    const mention = mentionsMe(c.last_text);
    out.push({ key: `msg:${c.id}:${c.last_ts || 0}`, kind: mention ? "mention" : "msg", channel: c.id, icon: mention ? "at" : c.kind === "dm" ? "chat" : "thread", title: c.kind === "dm" ? c.name : `#${c.name}`, sub: c.last_text || "New messages", at: new Date(c.last_ts || Date.now()).toISOString(), go: () => goTo(c.id) });
  }
  for (const [id, n] of deskNeeds) {
    const c = channels.find((x) => x.id === id);
    if (c && n) out.push({ key: `desk:${id}:${n}:${today}`, kind: "desk", channel: id, icon: "receipt", late: true, title: c.name, sub: `${n} ${n === 1 ? "thing needs" : "things need"} you`, at: `${today}T09:00`, go: () => openChannel(id) });
  }
  return out.sort((a, b) => (b.late ? 1 : 0) - (a.late ? 1 : 0) || b.at.localeCompare(a.at));
}
function renderNotifs() {
  const items = notifItems();
  show("notif-dot", items.some((n) => !notifRead[n.key]));
  // On Home, the newest few (D45); the full list is the Inbox.
  const fresh = items.filter((n) => !notifRead[n.key]).slice(0, 6);
  $("home-notif-list").replaceChildren(...(fresh.length ? fresh.map((n) => el("button", { class: `notif unread${n.late ? " late" : ""}`, type: "button", onclick: () => { markRead([n.key]); n.go(); } },
    icon(n.icon), el("strong", { text: n.title }), el("small", { text: n.sub }))) : [el("p", { class: "notif-empty", text: "You're all caught up." })]));
  show("home-notifs-read", fresh.length > 0);
  if ($("drawer-notifs").hidden) return;
  $("notif-list").replaceChildren(...(items.length ? items.map((n) => el("button", { class: `notif${notifRead[n.key] ? "" : " unread"}${n.late ? " late" : ""}`, type: "button", onclick: () => { markRead([n.key]); n.go(); } },
    icon(n.icon), el("strong", { text: n.title }), el("small", { text: n.sub }))) : [el("p", { class: "notif-empty", text: "Nothing right now. Reminders for events, due invoices and tasks show up here." })]));
}
function markRead(keys) {
  for (const k of keys) notifRead[k] = Date.now();
  // Forget read marks older than 30 days.
  for (const [k, t] of Object.entries(notifRead)) if (Date.now() - t > 30 * 864e5) delete notifRead[k];
  writeStore("anarchy.notifRead", notifRead);
  renderNotifs();
  renderInbox();
}
$("notifs-read").addEventListener("click", () => markRead(notifItems().map((n) => n.key)));
$("home-notifs-read").addEventListener("click", () => markRead(notifItems().map((n) => n.key)));

// ---------- inbox (D37) ----------
// Email and what happens in the app, in one list, read like mail: folders on
// the left, the list in the middle, the message on the right with what you
// can do about it. Mail stays on this device (see anarchy-mail); app events
// are worked out here, as before. Archive and snooze are yours and sync with
// your folders.
let mails = [], mailAcct = null, inboxSel = null, inboxFolderSel = "all", inboxQuery = "", mailBusy = false;
const IBX_FOLDERS = [["all", "Everything", "bell"], ["mail", "Mail", "mail"], ["mention", "Mentions", "at"], ["msg", "Conversations", "chat"], ["due", "Due", "clock"], ["desk", "Desks", "receipt"], ["event", "Agenda", "calendar"], ["snoozed", "Snoozed", "clock"], ["archived", "Archived", "check"]];
function ibxState() { org.inbox ??= { archived: {}, snoozed: {} }; return org.inbox; }
function mailItem(m) {
  return { key: `mail:${m.uid}`, kind: "mail", mail: m, icon: "mail", from: m.from_name || m.from_addr || "Unknown sender", title: m.subject || "(no subject)", sub: (m.text || "").replace(/\s+/g, " ").slice(0, 160), atMs: m.date_ms, unread: !m.seen };
}
function appItem(n) {
  const c = n.channel ? channels.find((x) => x.id === n.channel) : null;
  const from = n.kind === "msg" || n.kind === "mention" ? (c?.kind === "dm" ? c.name : `#${c?.name || n.title}`) : n.kind === "due" ? "Due" : n.kind === "desk" ? (c?.name || "Desk") : "Agenda";
  const desk = n.kind === "desk";
  return { ...n, from, title: desk ? n.sub : n.title, sub: desk ? "Open the desk to see what's waiting." : n.sub, atMs: Date.parse(n.at) || Date.now(), unread: !notifRead[n.key], channelObj: c };
}
// Everything, newest first; `scope` narrows app events to the space you're in.
function inboxAll() {
  const sp = view === "space" ? currentSpace?.id : null;
  const apps = notifItems().filter((n) => !sp || (n.channel && channels.find((c) => c.id === n.channel)?.space === sp)).map(appItem);
  const eod = new Date(); eod.setHours(23, 59, 59, 999);
  const later = (x) => x.atMs > eod.getTime();
  // What's coming up comes first, soonest first; then everything else, newest first.
  return [...(sp ? [] : mails.map(mailItem)), ...apps].sort((a, b) => (later(b) - later(a)) || (later(a) ? a.atMs - b.atMs : b.atMs - a.atMs));
}
function inboxItems() {
  const st = ibxState(), now = Date.now();
  return inboxAll().filter((x) => !st.archived[x.key] && !((st.snoozed[x.key] || 0) > now));
}
function inboxShown() {
  const st = ibxState(), now = Date.now(), all = inboxAll();
  let list = inboxFolderSel === "archived" ? all.filter((x) => st.archived[x.key])
    : inboxFolderSel === "snoozed" ? all.filter((x) => (st.snoozed[x.key] || 0) > now)
    : inboxItems().filter((x) => inboxFolderSel === "all" || x.kind === inboxFolderSel);
  const q = inboxQuery.trim().toLowerCase();
  if (q) list = list.filter((x) => `${x.from} ${x.title} ${x.sub}`.toLowerCase().includes(q));
  return list;
}
function inboxFolder() {
  const n = inboxItems().filter((x) => x.unread).length;
  return { key: "inbox", label: "Inbox", icon: "bell", n };
}
async function openInbox() {
  current = null; invoke("blur");
  hideMain(); show("view-inbox");
  renderFolders(); renderTabs();
  renderInbox();
  syncMail();
}
const ibxDay = (ms) => { const d = new Date(ms), t = new Date(); const eod = new Date(t); eod.setHours(23, 59, 59, 999); if (ms > eod.getTime()) return "Coming up"; const y = new Date(t); y.setDate(t.getDate() - 1); return d.toDateString() === t.toDateString() ? "Today" : d.toDateString() === y.toDateString() ? "Yesterday" : d > new Date(t.getTime() - 6 * 864e5) ? "This week" : "Earlier"; };
const ibxTime = (ms) => { const d = new Date(ms); return d.toDateString() === new Date().toDateString() ? timeFmt.format(d) : d.toLocaleDateString(undefined, { day: "numeric", month: "short" }); };
function renderInbox() {
  if ($("view-inbox").hidden) return;
  const live = inboxItems(), all = inboxAll(), st = ibxState(), now = Date.now();
  const count = (k) => k === "archived" ? all.filter((x) => st.archived[x.key]).length : k === "snoozed" ? all.filter((x) => (st.snoozed[x.key] || 0) > now).length : live.filter((x) => (k === "all" || x.kind === k) && x.unread).length;
  $("ibx-nav").replaceChildren(...IBX_FOLDERS.filter(([k]) => k !== "mail" || mailAcct || view !== "space").map(([k, label, ic]) => {
    const n = count(k);
    return el("button", { class: `ibx-folder${inboxFolderSel === k ? " on" : ""}`, type: "button", onclick: () => { inboxFolderSel = k; inboxSel = null; renderInbox(); } }, icon(ic), el("span", { text: label }), n ? el("span", { class: "n", text: String(n) }) : null);
  }));
  $("ibx-acct").replaceChildren(...(mailAcct
    ? [el("p", { class: "fine" }, icon("mail"), el("span", { text: mailAcct }), mailBusy ? el("span", { class: "soft", text: " · checking…" }) : null), el("button", { class: "link", type: "button", text: "Disconnect", onclick: disconnectMail })]
    : [el("p", { class: "fine", text: "Bring your email in next to what happens here." }), el("button", { class: "btn-outline sm", type: "button", onclick: openMailDialog }, icon("mail"), "Connect email")]));
  const shown = inboxShown();
  const unread = shown.filter((x) => x.unread).length;
  $("ibx-sub").textContent = shown.length ? `${shown.length} ${shown.length === 1 ? "item" : "items"}${unread ? `, ${unread} unread` : ""}` : "";
  if (inboxSel && !shown.some((x) => x.key === inboxSel)) inboxSel = null;
  const rows = []; let day = "";
  for (const x of shown) {
    const d = ibxDay(x.atMs);
    if (d !== day) { rows.push(el("p", { class: "ibx-day", text: d })); day = d; }
    rows.push(el("button", { class: `ibx-row${x.unread ? " unread" : ""}${x.late ? " late" : ""}${inboxSel === x.key ? " on" : ""}`, type: "button", role: "option", "aria-selected": String(inboxSel === x.key), "data-key": x.key, onclick: () => selectInbox(x.key) },
      x.kind === "mail" ? avatarEl(x.from, { size: "sm" }) : el("span", { class: `ibx-kind k-${x.kind}` }, icon(x.icon)),
      el("span", { class: "ibx-lines" },
        el("span", { class: "ibx-top" }, el("strong", { class: "ibx-from", text: x.from }), el("time", { text: ibxTime(x.atMs) })),
        el("span", { class: "ibx-title", text: x.title }),
        el("span", { class: "ibx-snip", text: x.sub })),
      x.unread ? el("span", { class: "unread-dot", "aria-label": "unread" }) : null));
  }
  $("ibx-rows").replaceChildren(...(rows.length ? rows : [el("div", { class: "inbox-empty" }, icon("check"), el("strong", { text: inboxQuery ? "Nothing matches" : "All clear" }), el("p", { class: "fine", text: inboxFolderSel === "archived" ? "Archived things wait here." : inboxFolderSel === "snoozed" ? "Snoozed things come back when it's time." : "Mail, mentions, unread conversations, things due and what desks need show up here." }))]));
  renderInboxRead(shown.find((x) => x.key === inboxSel));
}
async function selectInbox(key) {
  inboxSel = key;
  const x = inboxAll().find((i) => i.key === key);
  if (x?.kind === "mail" && !x.mail.seen) {
    x.mail.seen = true;
    invoke("mail_seen", { uid: x.mail.uid, seen: true }).catch((e) => console.warn(e));
  } else if (x && x.kind !== "mail") markRead([key]);
  renderInbox();
  renderFolders();
}
function ibxArchive(x, on = true) {
  const st = ibxState();
  if (on) st.archived[x.key] = Date.now(); else delete st.archived[x.key];
  delete st.snoozed[x.key];
  // Keep a month of these; older ones are long gone from the inbox anyway.
  for (const [k, t] of Object.entries(st.archived)) if (Date.now() - t > 60 * 864e5) delete st.archived[k];
  saveOrg(); inboxSel = null; renderInbox(); renderFolders();
}
function ibxSnooze(x, until) { ibxState().snoozed[x.key] = until; saveOrg(); inboxSel = null; renderInbox(); renderFolders(); }
function snoozeTimes() {
  const d = new Date(), at = (h, plus = 0) => { const t = new Date(d); t.setDate(t.getDate() + plus); t.setHours(h, 0, 0, 0); return t.getTime(); };
  const mon = new Date(d); mon.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); mon.setHours(9, 0, 0, 0);
  return [["In an hour", Date.now() + 3600e3], ["This evening", at(18)], ["Tomorrow morning", at(9, 1)], ["Next week", mon.getTime()]].filter(([, t]) => t > Date.now() + 10 * 60e3);
}
async function renderInboxRead(x) {
  const box = $("ibx-read");
  if (!x) { box.replaceChildren(el("div", { class: "ibx-none" }, icon("mail"), el("p", { class: "fine", text: "Pick something to read. j and k move, e archives, r replies." }))); return; }
  const st = ibxState();
  const archived = !!st.archived[x.key];
  const acts = el("div", { class: "ibx-acts" },
    el("button", { class: "btn-outline sm", type: "button", title: "Archive (e)", onclick: () => ibxArchive(x, !archived) }, icon(archived ? "undo" : "check"), archived ? "Move to inbox" : "Archive"),
    el("button", { class: "btn-outline sm", type: "button", title: "Snooze", onclick: (e) => openMenu(e.currentTarget, "Snooze until", snoozeTimes().map(([label, t]) => ({ label, go: () => ibxSnooze(x, t) }))) }, icon("clock"), "Snooze"),
    x.kind === "mail" ? el("button", { class: "btn-outline sm", type: "button", onclick: () => { x.mail.seen = false; invoke("mail_seen", { uid: x.mail.uid, seen: false }).catch(() => {}); inboxSel = null; renderInbox(); } }, "Mark unread") : null,
    x.go ? el("button", { class: "btn-ink sm", type: "button", onclick: () => x.go() }, icon("external"), x.kind === "msg" || x.kind === "mention" ? "Open conversation" : x.kind === "event" ? "Open agenda" : "Open") : null);
  if (x.kind === "mail") {
    const m = x.mail;
    const reply = el("textarea", { class: "text-input ibx-reply-text", rows: "4", placeholder: `Reply to ${m.from_name || m.from_addr || "sender"}…`, "aria-label": "Reply" });
    const sendBtn = el("button", { class: "btn-ink sm", type: "button" }, icon("send"), "Send");
    const err = el("p", { class: "error", hidden: "" });
    sendBtn.addEventListener("click", () => busy(sendBtn, "Sending…", async () => {
      const text = reply.value.trim();
      if (!text) return;
      try {
        await invoke("mail_send", { out: { to: m.from_addr, subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`, text, in_reply_to: m.message_id, references: [...(m.references || []), ...(m.message_id ? [m.message_id] : [])] } });
        reply.value = ""; err.hidden = true;
        box.querySelector(".ibx-sent")?.remove();
        box.querySelector(".ibx-reply").before(el("p", { class: "ibx-sent fine", text: `Sent to ${m.from_addr}.` }));
      } catch (e) { err.textContent = String(e); err.hidden = false; }
    }));
    box.replaceChildren(acts,
      el("h2", { class: "ibx-subject", text: m.subject }),
      el("div", { class: "ibx-meta" }, avatarEl(x.from), el("span", { class: "lines" }, el("strong", { text: m.from_name || m.from_addr }), el("small", { text: `${m.from_addr || ""}${m.to?.length ? ` → ${m.to.join(", ")}` : ""}` })), el("time", { text: dateTimeFmt.format(m.date_ms) })),
      upgradeStrip(m),
      el("div", { class: "ibx-body", text: m.text || "(no text)" }),
      el("p", { class: "fine ibx-plain", text: "Shown as plain text: no remote images, no scripts." }),
      el("div", { class: "ibx-reply" }, reply, el("div", { class: "ibx-reply-bar" }, err, sendBtn)));
    return;
  }
  // App events: what it is, a little context, and a reply where that makes sense.
  const body = el("div", { class: "ibx-ctx" });
  box.replaceChildren(acts, el("h2", { class: "ibx-subject", text: x.title }), el("div", { class: "ibx-meta" }, el("span", { class: `ibx-kind k-${x.kind}` }, icon(x.icon)), el("span", { class: "lines" }, el("strong", { text: x.from }), el("small", { text: x.sub })), el("time", { text: dateTimeFmt.format(x.atMs) })), body);
  if ((x.kind === "msg" || x.kind === "mention") && x.channelObj) {
    const c = x.channelObj;
    let msgs = [];
    try { msgs = await invoke("open_channel", { channel: c.id }); invoke("blur"); } catch { /* offline */ }
    if (inboxSel !== x.key) return;
    body.replaceChildren(...msgs.slice(-6).map((m) => el("div", { class: "ibx-msg" }, avatarEl(m.sender, m.look || {}), el("div", {}, el("p", { class: "ibx-msg-head" }, el("strong", { text: m.sender }), el("time", { text: timeFmt.format(m.ts_ms) })), el("p", { text: m.text })))));
    const reply = el("textarea", { class: "text-input ibx-reply-text", rows: "3", placeholder: c.kind === "dm" ? `Message ${c.name}` : `Message #${c.name}`, "aria-label": "Reply" });
    const sendBtn = el("button", { class: "btn-ink sm", type: "button" }, icon("send"), "Send");
    sendBtn.addEventListener("click", () => busy(sendBtn, "Sending…", async () => {
      const text = reply.value.trim(); if (!text) return;
      try { await invoke("send_message", { channel: c.id, text, thread: null }); reply.value = ""; await refreshChannels(); renderInboxRead({ ...x }); } catch (e) { alert(String(e)); }
    }));
    box.append(el("div", { class: "ibx-reply" }, reply, el("div", { class: "ibx-reply-bar" }, el("span"), sendBtn)));
  } else {
    body.replaceChildren(el("p", { class: "fine", text: { due: "Open it to update it or mark it done.", event: "From your agenda." }[x.kind] || "" }));
  }
}
// Keyboard, like a mail app: j/k move, e archive, r reply, u unread.
document.addEventListener("keydown", (e) => {
  if ($("view-inbox").hidden || e.target.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
  const shown = inboxShown(), at = shown.findIndex((x) => x.key === inboxSel);
  if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); const n = shown[Math.min(shown.length - 1, at + 1)]; if (n) selectInbox(n.key); }
  else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); const n = shown[Math.max(0, at - 1)]; if (n) selectInbox(n.key); }
  else if (e.key === "e" && at >= 0) { e.preventDefault(); const next = shown[at + 1]; ibxArchive(shown[at], !ibxState().archived[shown[at].key]); if (next) selectInbox(next.key); }
  else if (e.key === "r" && at >= 0) { e.preventDefault(); $("ibx-read").querySelector(".ibx-reply-text")?.focus(); }
  else if (e.key === "u" && at >= 0 && shown[at].kind === "mail") { const m = shown[at].mail; m.seen = false; invoke("mail_seen", { uid: m.uid, seen: false }).catch(() => {}); renderInbox(); }
});
$("ibx-search").addEventListener("input", () => { inboxQuery = $("ibx-search").value; renderInbox(); });
$("ibx-refresh").addEventListener("click", () => syncMail(true));
$("ibx-allread").addEventListener("click", () => {
  const shown = inboxShown();
  markRead(shown.filter((x) => x.kind !== "mail").map((x) => x.key));
  for (const x of shown) if (x.kind === "mail" && !x.mail.seen) { x.mail.seen = true; invoke("mail_seen", { uid: x.mail.uid, seen: true }).catch(() => {}); }
  renderInbox(); renderFolders();
});

// ---------- email threads that upgrade (D39) ----------
// You ask whether a sender is on Anarchy (a lookup tells the server who you
// write to, so it never happens on its own). If they are, the thread goes on
// in an encrypted conversation, and later mail from them says so.
let mailLinks = {};
function upgradeStrip(m) {
  const addr = (m.from_addr || "").toLowerCase();
  const who = m.from_name || m.from_addr || "They";
  const strip = el("div", { class: "upgrade" });
  if (!addr || tour) return strip;
  const linked = mailLinks[addr];
  if (linked) {
    strip.replaceChildren(icon("lock"), el("span", { text: `You talk to ${who} on Anarchy too, end-to-end encrypted.` }),
      el("button", { class: "btn-ink sm", type: "button", onclick: () => continueIn(linked, m) }, "Open conversation"));
    return strip;
  }
  if (status.local) return strip;
  const ask = el("button", { class: "link", type: "button", text: `Is ${who} on Anarchy?` });
  ask.addEventListener("click", async () => {
    ask.disabled = true; ask.textContent = "Checking…";
    try {
      const p = await invoke("mail_find", { email: addr });
      if (!p) { strip.replaceChildren(icon("mail"), el("span", { class: "soft", text: `${who} isn't someone you can message here, so email it is.` })); return; }
      strip.replaceChildren(avatarEl(p.name, { color: p.color, avatar: p.avatar, sidekick: p.sidekick, size: "sm" }),
        el("span", {}, el("strong", { text: `${p.name} is on Anarchy` }), p.handle ? el("span", { class: "soft", text: ` as @${p.handle}` }) : null, el("span", { text: ". Continue there: end-to-end encrypted, with threads and desks." })),
        el("button", { class: "btn-ink sm", type: "button", onclick: async (e) => {
          await busy(e.currentTarget, "Opening…", async () => {
            try { const id = await invoke("mail_continue", { email: addr }); mailLinks[addr] = id; await continueIn(id, m); }
            catch (err) { alert(String(err)); }
          });
        } }, icon("lock"), "Continue in Anarchy"));
    } catch (err) { ask.disabled = false; ask.textContent = `Is ${who} on Anarchy?`; alert(String(err)); }
  });
  strip.replaceChildren(icon("lock"), ask);
  return strip;
}
async function continueIn(channel, m) {
  await refreshChannels();
  await openChannel(channel);
  // Pick up where the email left off.
  if (!composer.value.trim()) { composer.value = `Re: ${m.subject.replace(/^re:\s*/i, "")}\n`; fitComposer(); }
  composer.focus();
}

// ---------- mail account ----------
async function loadMail() {
  try { const st = await invoke("mail_status"); mailAcct = st.email; mails = await invoke("mail_list"); mailLinks = await invoke("mail_links").catch(() => ({})); } catch { mailAcct = null; mails = []; }
  renderInbox(); renderFolders();
}
async function syncMail(loud = false) {
  if (!mailAcct || mailBusy) return;
  mailBusy = true; renderInbox();
  try {
    const known = new Set(mails.map((m) => m.uid));
    mails = await invoke("mail_sync");
    // A desktop alert for new unread mail, unless you're busy or looking at it.
    const fresh = mails.filter((m) => !m.seen && !known.has(m.uid));
    if (known.size && fresh.length && profile?.presence !== "busy" && ($("view-inbox").hidden || document.hidden)) invoke("notify", { title: fresh.length === 1 ? (fresh[0].from_name || fresh[0].from_addr || "New mail") : `${fresh.length} new emails`, body: fresh.length === 1 ? fresh[0].subject : fresh.map((m) => m.subject).slice(0, 3).join(" · ") }).catch(() => {});
  } catch (e) { if (loud) alert(String(e)); else console.warn(e); }
  mailBusy = false;
  renderInbox(); renderFolders();
}
setInterval(() => syncMail(), 3 * 60e3);
function openMailDialog() {
  for (const id of ["mail-email", "mail-pass", "mail-imap", "mail-imap-port", "mail-smtp", "mail-smtp-port", "mail-user"]) $(id).value = "";
  $("mail-name").value = profile?.display_name || "";
  $("mail-sec").value = "tls"; show("mail-note", false); setError("mail-error", "");
  $("dlg-mail").showModal(); $("mail-email").focus();
}
$("mail-email").addEventListener("change", async () => {
  const p = await invoke("mail_preset", { email: $("mail-email").value.trim() }).catch(() => null);
  if (!p) return;
  $("mail-imap").value = p.imap_host; $("mail-imap-port").value = p.imap_port; $("mail-smtp").value = p.smtp_host; $("mail-smtp-port").value = p.smtp_port; $("mail-sec").value = p.security;
  $("mail-note").textContent = p.note || ""; show("mail-note", !!p.note);
});
$("mail-cancel").addEventListener("click", () => $("dlg-mail").close());
$("mail-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("mail-email").value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setError("mail-error", "Enter your email address.");
  if (!$("mail-pass").value) return setError("mail-error", "Enter the password (or app password).");
  if (!$("mail-imap").value) $("mail-email").dispatchEvent(new Event("change"));
  const account = { email, name: $("mail-name").value.trim() || null, imap_host: $("mail-imap").value.trim(), imap_port: +$("mail-imap-port").value || 993, smtp_host: $("mail-smtp").value.trim(), smtp_port: +$("mail-smtp-port").value || 465, username: $("mail-user").value.trim() || email, password: $("mail-pass").value, security: $("mail-sec").value };
  await busy($("mail-save"), "Signing in…", async () => {
    try { await invoke("mail_connect", { account }); $("dlg-mail").close(); mailAcct = email; await syncMail(true); }
    catch (err) { setError("mail-error", String(err)); }
  });
});
async function disconnectMail() {
  if (!confirm(`Disconnect ${mailAcct}? The mail kept on this computer is deleted; nothing changes in your mailbox.`)) return;
  await invoke("mail_disconnect"); mailAcct = null; mails = []; renderInbox(); renderFolders();
}

// Desktop reminders: 15 minutes before a timed event, and from 9:00 on the day
// something falls due (once a day while it stays late). Each fires once.
async function remind() {
  try { await loadAgenda(); await loadTodos(); } catch { return; }
  renderTodos();
  const now = new Date(), today = isoOf(now);
  const fire = (key, title, body) => {
    if (reminded[key]) return;
    reminded[key] = Date.now();
    invoke("notify", { title, body }).catch(() => {});
  };
  for (const e of events()) {
    if (e.all_day || !e.start) continue;
    const at = new Date(`${e.date}T${e.start}`);
    const mins = (at - now) / 60e3;
    if (mins <= 15 && mins > -5) fire(`ev:${e.id}:${e.date}:${e.start}`, e.title, `Starts at ${e.start}${e.where ? ` · ${e.where}` : ""}`);
  }
  if (now.getHours() >= 9) for (const d of agenda.dues) {
    if (d.date > today) continue;
    fire(`due:${d.channel}:${d.title}:${today}`, d.task ? "Task due" : "Invoice due", d.date < today ? `${d.title} (was due ${shortDay(d.date)})` : d.title);
  }
  for (const [k, t] of Object.entries(reminded)) if (Date.now() - t > 14 * 864e5) delete reminded[k];
  writeStore("anarchy.reminded", reminded);
  renderNotifs();
}
let remindTimer = null;
function startReminders() { if (!remindTimer) { remind(); remindTimer = setInterval(remind, 60e3); } }

// ---------- space settings ----------
// Name, members, leaving. Integrations are listed honestly: each one needs its
// own connector, and the ones that send data to a model provider need a policy
// decision, so none of them is switched on from here yet.

const INTEGRATIONS = [
  { name: "Linear", color: "#5e6ad2", mark: "L", text: "Turn a message or task card into a Linear issue, and show its status on the card. Needs an OAuth connector; issue titles would leave the device." },
  { name: "GitHub", color: "#24292f", mark: "GH", text: "Link pull requests and issues to channels and cards. Same connector model as Linear." },
  { name: "AI models", color: "#10a37f", mark: "AI", text: "Let Ask answer with a model (a local one, or OpenAI, Anthropic, Mistral). The space owner decides which channels a model may read; Sealed channels never." },
  { name: "Calendars", color: "#1a73e8", mark: "31", text: "Show Google or Microsoft calendars in the agenda (read-only first), and send invites." },
  { name: "Stripe", color: "#635bff", mark: "S", text: "Card payments on pay links, marked paid automatically. Needs the space's own Stripe account." },
  { name: "Mail", color: "#c2410c", mark: "@", text: "Send desk reminders from your own address (IMAP/SMTP, then Gmail and Microsoft)." },
];
function openSpaceSettings() {
  if (thread) closeThread();
  current = null; invoke("blur");
  closeDrawers();
  hideMain(); show("view-spaceset");
  renderSpaceSettings(); renderFolders(); renderTabs();
}
async function renderSpaceSettings() {
  const sp = currentSpace;
  if (!sp) return;
  const owner = sp.role === "owner";
  $("ss-title").textContent = `${sp.name} settings`;
  $("ss-name").value = sp.name;
  $("ss-name").disabled = !owner; $("ss-save").hidden = !owner;
  show("ss-saved", false); setError("ss-error", "");
  $("ss-kind").textContent = KIND_LABEL[sp.kind] || "Space";
  $("ss-role").textContent = owner ? "Owner" : "Member";
  $("ss-members").textContent = String(sp.members);
  $("ss-leave").disabled = sp.is_default;
  $("ss-leave").title = sp.is_default ? "Everyone in the organisation is in this space." : "";
  $("integ-list").replaceChildren(...INTEGRATIONS.map((g) => el("div", { class: "integ" },
    el("span", { class: "mark", style: `background:${g.color}`, text: g.mark }),
    el("strong", {}, g.name, el("span", { class: "soon", text: "Not connected yet" })), el("small", { text: g.text }))));
}
$("spaceset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("ss-name").value.trim();
  if (!name) return setError("ss-error", "A space needs a name.");
  try {
    const sp = await invoke("rename_space", { space: currentSpace.id, name });
    spaces = spaces.map((x) => (x.id === sp.id ? sp : x));
    currentSpace = sp;
    show("ss-saved", true);
    renderRail(); renderFolders(); refreshChannels();
  } catch (err) { setError("ss-error", String(err)); }
});
$("ss-leave").addEventListener("click", async () => {
  const sp = currentSpace;
  if (!sp || !confirm(`Leave ${sp.name}? It leaves your account; channels you're in stay until a member removes you.`)) return;
  try {
    await invoke("leave_space", { space: sp.id });
    spaces = await invoke("spaces");
    renderRail(); go("home"); refreshChannels();
  } catch (err) { setError("ss-error", String(err)); }
});

// Polling (WebSocket push comes later)

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (syncing || document.hidden) return;
    syncing = true;
    try {
      const r = await invoke("sync_all");
      if (r.new_messages || r.joined || r.removed) {
        await refreshChannels();
        renderNotifs();
        if (current && (!$("view-convo").hidden || !$("view-desk").hidden)) await openChannel(current);
      }
      if (desk && !$("view-desk").hidden && Date.now() - desk.linksAt > 15000) {
        const before = JSON.stringify(desk.links);
        await refreshLinks();
        if (JSON.stringify(desk.links) !== before) renderDesk();
      }
      if (desk && !$("view-desk").hidden && await pullIntake()) renderDeskView();
      // Files can change from the file manager, or from others, without a text message.
      if (drive && !$("view-drive").hidden) {
        const items = await invoke("desk_items", { channel: drive.channel });
        const sig = (xs) => xs.map((x) => `${x.id}:${x.seq}`).join();
        if (sig(items) !== sig(drive.items)) { drive.items = items; renderDrive(); }
      }
    } catch (err) {
      if (/signed out|sign in required/i.test(String(err))) { status = await invoke("status"); if (!status.session && !status.local) showAuth(); }
    } finally { syncing = false; }
  }, POLL_MS);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

// ---------- settings ----------

function settingsPage(page) {
  for (const p of document.querySelectorAll(".page")) show(p, p.dataset.page === page);
  settingsAt = page;
  renderFolders();
  ({ profile: loadProfile, privacy: loadPrivacy, account: loadAccount, notifications: loadNotifications, files: loadMount, agents: loadBridge, devices: loadDevices, appearance: () => {}, invites: () => { show("invite-result", false); setError("invite-error", ""); } })[page]();
}

let edit = {};
function loadProfile() {
  edit = { ...profile };
  $("p-name").value = edit.display_name; $("p-user").value = edit.username;
  $("p-tag").textContent = `#${String(edit.tag).padStart(4, "0")}`;
  mountPickers($("p-avatar"), $("p-color"), () => edit, (c) => { Object.assign(edit, c); paintProfile(); });
  edit.sidekick = profile.sidekick ? { ...profile.sidekick } : null;
  $("ps-name").value = edit.sidekick?.name || "";
  const skDraft = () => edit.sidekick || (edit.sidekick = defaultSidekick(edit));
  show("ps-maker", false);
  $("ps-design").textContent = edit.sidekick ? "Change its look" : "Design one";
  $("ps-design").onclick = () => {
    if ($("ps-maker").hidden) {
      const sk = skDraft();
      if (!$("ps-name").value) $("ps-name").value = sk.name;
      mountSidekickMaker($("ps-maker"), skDraft, (look) => { skDraft().look = look; paintProfile(); });
    }
    show("ps-maker", $("ps-maker").hidden);
    $("ps-design").textContent = $("ps-maker").hidden ? "Change its look" : "Done designing";
  };
  paintProfile();
  show("p-saved", false); setError("p-error", "");
}
function paintProfile() {
  edit.display_name = $("p-name").value; edit.username = $("p-user").value.toLowerCase();
  syncPickers($("p-avatar"), $("p-color"), edit);
  if (edit.sidekick) edit.sidekick.name = $("ps-name").value;
  paintCard("p-", { ...edit, sidekick: edit.sidekick?.name?.trim() ? edit.sidekick : null });
}
$("p-name").addEventListener("input", paintProfile);
$("p-user").addEventListener("input", paintProfile);
$("ps-name").addEventListener("input", () => { if (!edit.sidekick && $("ps-name").value) edit.sidekick = { ...defaultSidekick(edit), name: $("ps-name").value }; paintProfile(); });
$("profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("p-error", "");
  try {
    profile = await invoke("update_profile", { update: { display_name: edit.display_name.trim(), username: edit.username.trim(), color: edit.color, avatar: edit.avatar || "",
      sidekick: edit.sidekick?.name?.trim() ? { name: edit.sidekick.name.trim(), look: edit.sidekick.look } : profile.sidekick ? { name: "", look: "" } : undefined } });
    loadProfile(); paintMe(); show("p-saved");
  } catch (err) { setError("p-error", String(err)); }
});

function loadPrivacy() {
  for (const r of document.querySelectorAll("input[name=dm-policy]")) r.checked = r.value === profile.dm_policy;
  $("humans-only").checked = profile.dm_humans_only;
  show("privacy-saved", false);
}
async function savePrivacy(update) {
  try { profile = await invoke("update_profile", { update }); paintMe(); show("privacy-saved"); }
  catch (err) { alert(String(err)); loadPrivacy(); }
}
for (const r of document.querySelectorAll("input[name=dm-policy]")) r.addEventListener("change", () => savePrivacy({ dm_policy: r.value }));
$("humans-only").addEventListener("change", () => savePrivacy({ dm_humans_only: $("humans-only").checked }));

async function loadAccount() {
  status = await invoke("status");
  const p = status.profile || profile;
  const s = status.session;
  $("acc-method").textContent = p.is_anonymous ? "Anonymous (no email)" : p.is_guest ? "Guest invite" : p.email ? `Email · ${p.email}` : "Single sign-on";
  $("acc-server").textContent = hostOf(s.server);
  show("acc-guest-row", p.is_guest);
  if (p.is_guest) $("acc-guest-until").textContent = dateTimeFmt.format(s.expires_at_ms);
  const st = status.storage;
  $("acc-lock").textContent = st.kind === "temporary" ? `Temporary: forgotten when you quit (${st.reason})`
    : st.lock === "passphrase" ? "Encrypted, locked with your passphrase" : "Encrypted, key in your system keychain";
  show("acc-pass-form", !(st.kind === "saved" && st.lock === "passphrase"));
  show("acc-anon", p.is_anonymous);
  $("sign-out-note").textContent = p.is_anonymous ? "There's no way back into an anonymous account after signing out." : "Signing out keeps this device's keys and history here, so signing back in picks up where you left off.";
}
$("acc-pass-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p1 = $("acc-pass1").value, p2 = $("acc-pass2").value;
  if (p1.length < 8) return setError("acc-pass-error", "Use at least 8 characters.");
  if (p1 !== p2) return setError("acc-pass-error", "The two don't match.");
  try { await invoke("set_passphrase", { passphrase: p1 }); $("acc-pass1").value = ""; $("acc-pass2").value = ""; setError("acc-pass-error", ""); loadAccount(); }
  catch (err) { setError("acc-pass-error", String(err)); }
});
$("sign-out").addEventListener("click", async () => {
  if (profile?.is_anonymous && !confirm("Sign out of an anonymous account? You won't be able to get back in.")) return;
  await invoke("sign_out");
  current = null; profile = null;
  status = await invoke("status");
  showAuth();
});

function loadNotifications() {
  const n = status.notifications;
  $("n-desktop").checked = n.desktop; $("n-mentions").checked = n.mentions_only; $("n-previews").checked = n.previews;
  $("n-handle").textContent = profile?.username || "you";
  syncToggles();
}
function syncToggles() {
  for (const id of ["n-mentions", "n-previews"]) { $(id).disabled = !$("n-desktop").checked; $(id).closest(".toggle").classList.toggle("disabled", !$("n-desktop").checked); }
}
for (const id of ["n-desktop", "n-mentions", "n-previews"]) {
  $(id).addEventListener("change", async () => {
    syncToggles();
    const prefs = { desktop: $("n-desktop").checked, mentions_only: $("n-mentions").checked, previews: $("n-previews").checked };
    status.notifications = prefs;
    await invoke("set_notifications", { prefs });
  });
}

// ---------- files on this computer (local WebDAV share) ----------

for (const n of document.querySelectorAll(".os-files")) n.textContent = { mac: "Finder", windows: "File Explorer", linux: "Files" }[OS];
const MOUNT_HOW = {
  mac: "Finder mounts it as \u201cAnarchy\u201d under Locations. To add it by hand: Go \u2192 Connect to Server (\u2318K), paste the address.",
  windows: "Explorer opens it by address. To give it a drive letter: This PC \u2192 Map network drive, paste the address. Files up to 50 MB unless you raise Windows' WebClient limit.",
  linux: "Files (GNOME) and Dolphin open it as a network location. Other file managers: connect to the address with dav:// in place of http://.",
};
let mount = null;
function paintMount() {
  $("m-enabled").checked = !!mount?.enabled;
  show("m-box", !!mount?.running);
  $("m-url").textContent = mount?.url || "";
  $("m-win").textContent = mount?.windows || "";
  show("m-win-row", OS === "windows");
  $("m-how").textContent = MOUNT_HOW[OS];
}
// Agents on this computer (D43).
let bridgeInfo = null;
const TOOL_SAYS = { anarchy_get_context: "Read your context", anarchy_search: "Searched", anarchy_today: "Read your day", anarchy_list_tasks: "Listed tasks", anarchy_create_tasks: "Added", anarchy_update_task: "Moved a task", anarchy_desks: "Listed desks", anarchy_desk_items: "Read", anarchy_draft: "Drafted" };
function paintBridge() {
  const b = bridgeInfo;
  $("b-enabled").checked = !!b?.enabled;
  show("b-box", !!b?.running);
  if (!b?.running) return;
  const claude = `claude mcp add --transport http anarchy ${b.url} --header "Authorization: Bearer ${b.token}"`;
  $("b-claude").textContent = claude;
  $("b-cmd").textContent = b.command;
  $("b-url").textContent = b.url;
  $("b-calls").replaceChildren(...(b.calls.length ? b.calls.slice(0, 12).map((c) => el("div", { class: "list-row" },
    el("span", { class: "grow" }, el("span", { text: `${TOOL_SAYS[c.tool] || c.tool} ${c.about}`.trim() }), el("small", { text: dateTimeFmt.format(c.at_ms) })),
    c.ok ? null : el("span", { class: "tag", text: "Refused" })))
    : [el("p", { class: "fine", text: "Nothing yet. Requests show here as agents make them." })]));
}
async function loadBridge() {
  setError("b-error", ""); show("b-copied", false);
  try { bridgeInfo = await invoke("bridge_info"); } catch (err) { setError("b-error", String(err)); }
  paintBridge();
}
async function setBridge(enabled, newToken = false) {
  setError("b-error", "");
  try { bridgeInfo = await invoke("set_bridge", { enabled, newToken }); } catch (err) { setError("b-error", String(err)); }
  paintBridge();
}
$("b-enabled").addEventListener("change", () => setBridge($("b-enabled").checked));
$("b-rotate").addEventListener("click", () => setBridge(true, true));
$("b-copy").addEventListener("click", async () => { await navigator.clipboard.writeText($("b-claude").textContent); show("b-copied", true); });
// An agent drafted something: open that conversation with the draft in the composer, unsent.
tauri?.event?.listen?.("bridge-draft", async ({ payload }) => {
  await refreshChannels();
  await openChannel(payload.channel);
  if (composer.value.trim() && !confirm("An agent drafted a message here. Replace what you're writing?")) return;
  composer.value = payload.text; fitComposer(); composer.focus();
});

async function loadMount() {
  setError("m-error", ""); show("m-copied", false);
  try { mount = await invoke("mount_info"); } catch (err) { setError("m-error", String(err)); }
  paintMount();
}
async function setMount(enabled, newAddress = false) {
  setError("m-error", "");
  try { mount = await invoke("set_mount", { enabled, newAddress }); } catch (err) { setError("m-error", String(err)); }
  paintMount();
}
async function openMount() {
  try { await invoke("open_mount"); } catch (err) { alert(`Couldn't open it: ${err}\n\nAddress: ${mount?.url || ""}`); }
}
$("m-enabled").addEventListener("change", () => setMount($("m-enabled").checked));
$("m-rotate").addEventListener("click", () => setMount(true, true));
$("m-open").addEventListener("click", openMount);
$("m-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(OS === "windows" ? mount.windows : mount.url);
  show("m-copied", true);
});
$("drive-mount").addEventListener("click", async () => {
  if (!mount?.running) {
    await setMount(true);
    if (!mount?.running) return;
  }
  openMount();
});

async function loadDevices() {
  setError("device-error", "");
  try {
    const list = await invoke("devices");
    $("device-list").replaceChildren(...list.map((d) => el("div", { class: "list-row" },
      el("span", { class: "grow" }, el("code", { text: d.device_id.slice(0, 8) }), el("small", { text: `Added ${dateTimeFmt.format(d.created_at_ms)}` })),
      d.this_device ? el("span", { class: "tag good", text: "This computer" })
        : d.revoked ? el("span", { class: "tag", text: "Revoked" })
        : el("button", { class: "btn-outline sm", text: "Revoke", onclick: () => revoke(d.device_id) }))));
  } catch (err) { setError("device-error", String(err)); }
}
// Linking a phone (D42): show a code, wait for a phone to claim it, approve it.
let phoneLink = null, phoneTimer = 0;
function paintQr(svg, width, dark) {
  const q = 2; // quiet zone, in modules
  let d = "";
  dark.forEach((on, k) => { if (on) d += `M${(k % width) + q} ${Math.floor(k / width) + q}h1v1h-1z`; });
  const side = width + q * 2, ns = "http://www.w3.org/2000/svg";
  const bg = document.createElementNS(ns, "rect"), marks = document.createElementNS(ns, "path");
  for (const [k, v] of [["width", side], ["height", side]]) bg.setAttribute(k, v);
  marks.setAttribute("d", d);
  svg.setAttribute("viewBox", `0 0 ${side} ${side}`);
  svg.replaceChildren(bg, marks);
}
function phoneStep(step, label) {
  show("phone-wait", step === "wait");
  show("phone-ask", step === "ask");
  show("phone-done", step === "done" || step === "ended");
  show("phone-approve", step === "ask");
  show("phone-deny", step === "ask");
  if (label) $("phone-label").textContent = label;
  if (step === "done") $("phone-done").textContent = "Linked. The phone is signed in as you, and shows up in your devices once it registers.";
  if (step === "ended") $("phone-done").textContent = "This code has ended. Close and show a new one to try again.";
}
async function pollPhone() {
  if (!phoneLink || !$("dlg-phone").open) return;
  try {
    const st = await invoke("phone_link_status", { id: phoneLink.id });
    const left = Math.max(0, Math.round((st.expires_at_ms - Date.now()) / 60000));
    $("phone-ttl").textContent = `Works for ${left < 1 ? "less than a minute" : `${left} more ${left === 1 ? "minute" : "minutes"}`}, once.`;
    if (st.state === "claimed") phoneStep("ask", st.label);
    else if (st.state === "done") { phoneStep("done"); loadDevices(); return; }
    else if (st.state === "ended") { phoneStep("ended"); return; }
  } catch (err) { setError("phone-error", String(err)); }
  phoneTimer = setTimeout(pollPhone, 2000);
}
$("phone-link").addEventListener("click", async () => {
  setError("phone-error", "");
  try {
    phoneLink = await busy($("phone-link"), "Making a code…", () => invoke("phone_link_start"));
    paintQr($("phone-qr"), phoneLink.width, phoneLink.dark);
    phoneStep("wait");
    $("dlg-phone").showModal();
    pollPhone();
  } catch (err) { setError("device-error", String(err)); }
});
$("phone-approve").addEventListener("click", async () => {
  try { await invoke("phone_link_approve", { id: phoneLink.id }); $("phone-ask").hidden = true; show("phone-approve", false); show("phone-deny", false); } catch (err) { setError("phone-error", String(err)); }
});
$("phone-deny").addEventListener("click", async () => {
  try { await invoke("phone_link_end", { id: phoneLink.id }); phoneStep("ended"); } catch (err) { setError("phone-error", String(err)); }
});
// Closing before a phone is through ends the code: it shouldn't outlive the dialog.
$("dlg-phone").addEventListener("close", () => {
  clearTimeout(phoneTimer);
  if (phoneLink) invoke("phone_link_status", { id: phoneLink.id }).then((st) => { if (st.state === "open" || st.state === "claimed") invoke("phone_link_end", { id: phoneLink.id }); }).catch(() => {});
});
$("phone-close").addEventListener("click", () => $("dlg-phone").close());
async function revoke(id) {
  try { await invoke("revoke_device", { device: id }); await loadDevices(); } catch (err) { setError("device-error", String(err)); }
}

$("invite-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("invite-error", "");
  try {
    const inv = await invoke("create_invite", { hours: Number($("invite-hours").value), maxUses: Number($("invite-uses").value) });
    $("invite-code-out").textContent = inv.code;
    $("invite-meta").textContent = `Works until ${dateTimeFmt.format(inv.expires_at_ms)}, ${inv.max_uses === 1 ? "once" : `${inv.max_uses} times`}. Guests pick "I have a guest invite" when signing in.`;
    show("invite-result");
  } catch (err) { setError("invite-error", String(err)); }
});
$("invite-copy").addEventListener("click", () => copy($("invite-code-out").textContent, $("invite-copy")));

// ---------- start ----------

async function route() {
  status = await invoke("status"); // waits until the engine has opened the device
  if (status.locked) {
    show("starting", false); show("auth", false); show("app", false); show("lock");
    requestAnimationFrame(() => $("lock-pass").focus());
    return;
  }
  appearance = status.appearance;
  applyAppearance();
  profile = status.profile;
  // A local account (D38) opens straight into the app, like a signed-in one.
  if (!status.session && !status.local) return showAuth();
  if (profile && !profile.onboarded) {
    show("starting", false); show("lock", false); show("auth");
    return afterSignIn();
  }
  showApp();
}

async function start() {
  mountAppearance($("settings-appearance"));
  if (!tauri?.core) { $("starting").textContent = "Open this inside the Anarchy desktop app (or run ui-preview.mjs)."; return; }
  applyAppearance();
  await route();
}

start();
