// Anarchy desktop UI: lock, sign-up and onboarding, Home (chats), spaces, settings.
// Talks to the Rust engine through Tauri commands (src-tauri/src/main.rs).
// Everything people type or receive goes in through textContent, never as HTML.

const $ = (id) => document.getElementById(id);
const tauri = window.__TAURI__;
const invoke = (cmd, args) => tauri.core.invoke(cmd, args);
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
function avatarEl(name, { color, avatar, size } = {}) {
  const a = el("span", { class: `avatar${size ? ` ${size}` : ""}${avatar ? " emoji" : ""}`, "data-color": color || colorFor(name) });
  a.textContent = avatar || initials(name);
  return a;
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
  const old = button.innerHTML;
  button.disabled = true;
  button.textContent = label;
  try { return await fn(); } finally { button.disabled = false; button.innerHTML = old; }
}
async function copy(text, button) {
  try { await navigator.clipboard.writeText(text); } catch { return; }
  if (button) { const old = button.innerHTML; button.textContent = "Copied"; setTimeout(() => { button.innerHTML = old; }, 1400); }
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
function authStep(id) {
  for (const s of document.querySelectorAll(".auth-step")) show(s, s.id === id);
  const at = FLOW.indexOf(["s-anon", "s-guest", "s-invite", "s-server"].includes(id) ? "s-account" : id);
  $("steps").replaceChildren(...(at < 0 ? [] : FLOW.map((_, i) => el("i", { class: i <= at ? "on" : "" }))));
  const focus = { "s-server": "server", "s-invite": "invite-link", "s-guest": "invite-code", "s-anon": "anon-name", "s-lock": "pass1", "s-card": "card-name" }[id];
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
  authStep("s-account");
  // No address to type first: the server you used last, or the public one.
  connect(status.last_server || status.default_server);
}

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
    setError("account-error", `${err} You can use a different server, or an invite.`);
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
  $("account-title").textContent = c.open_signup ? "Welcome to Anarchy" : `Sign in to ${c.org_name}`;
  $("account-sub").textContent = c.open_signup
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
  status = await invoke("status");
  profile = status.profile;
  if (profile?.onboarded) return showApp();
  draft = { usage: profile?.usage || null, display_name: profile?.display_name || "", username: profile?.username || "", tag: profile?.tag || 0, color: profile?.color || "ember", avatar: profile?.avatar || "" };
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
  $("card-tag").textContent = `#${String(draft.tag).padStart(4, "0")}`;
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
        avatar: draft.avatar || "", usage: draft.usage || undefined, onboarded: true,
      } });
      await setAppearance({ frame: draft.color });
      status = await invoke("status");
      showApp();
    } catch (err) { setError("card-error", String(err)); }
  });
});

// ---------- app ----------

async function showApp() {
  profile = status.profile || profile;
  show("starting", false); show("lock", false); show("auth", false); show("app");
  show("omnibox");
  paintMe();
  try { spaces = await invoke("spaces"); } catch { spaces = []; }
  renderRail();
  go("home");
  await refreshChannels();
  startPolling();
  if (pendingSpaceCode) {
    const code = pendingSpaceCode; pendingSpaceCode = null; pendingNote = "";
    try { const sp = await invoke("join_space", { code }); spaces = await invoke("spaces"); openSpace(spaces.find((x) => x.id === sp.id) || sp); }
    catch (err) { alert(`Couldn't join with that invite: ${err}`); }
  }
  refreshDeskNeeds().then(renderTabs);
  // Brings the local file share back up if it was on.
  invoke("mount_info").then((m) => { mount = m; }).catch(() => {});
}

function paintMe() {
  const p = profile || { display_name: status.session?.display_name || "You" };
  const name = p.display_name || "You";
  $("rail-me").replaceChildren(avatarEl(name, { color: p.color, avatar: p.avatar }));
  $("share-handle").textContent = handleOf(p) ? `@${handleOf(p)}` : "";
  $("me-name").textContent = name;
  $("me-avatar").replaceChildren(avatarEl(name, { color: p.color, avatar: p.avatar }));
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
  $("rail-settings").classList.toggle("active", view === "settings");
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
  for (const v of ["view-start", "view-convo", "view-space-empty", "view-desk", "view-drive", "view-settings", "view-agenda", "view-notes"]) show(v, false);
  show("view-desks", false);
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
$("rail-settings").addEventListener("click", () => go("settings"));
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
      avatarEl(c.name, { color: c.peer?.color, avatar: c.peer?.avatar }),
      el("span", { class: "lines" }, el("strong", { text: c.name }), el("small", { text: c.last_text || (c.peer?.handle ? `@${c.peer.handle}` : "") })),
      unread ? el("span", { class: "unread-dot", "aria-label": "unread" }) : null);
  }));
  show("no-dms", dms.length === 0);
  if (view === "space" && currentSpace) {
    const desks = channels.filter((c) => c.kind === "channel" && c.space === currentSpace.id && c.desk && c.desk !== "files");
    const list = channels.filter((c) => c.kind === "channel" && c.space === currentSpace.id && !c.desk);
    $("channel-list").replaceChildren(...list.map((c) => {
      const unread = c.unread && c.id !== current;
      return el("button", { class: `side-item${c.id === current ? " active" : ""}${unread ? " unread" : ""}`, "data-id": c.id, onclick: () => openChannel(c.id).then(() => composer.focus()) },
        el("span", { class: "hash", text: "#" }), el("span", { class: "name", text: c.name }), unread ? el("span", { class: "unread-dot" }) : null);
    }));
    show("no-channels", list.length === 0);
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
  if (c.desk) return openDesk(c);
  hideMain(); show("view-convo");
  const dm = c.kind === "dm";
  show("convo-avatar", dm);
  if (dm) fillAvatar($("convo-avatar"), c.name, c.peer?.color, c.peer?.avatar);
  $("convo-name").textContent = dm ? c.name : `# ${c.name}`;
  $("convo-topic").textContent = dm ? (c.peer?.handle ? `@${c.peer.handle}` : "") : c.topic;
  const trust = $("convo-trust");
  if (dm) { trust.className = "ax-seal sealed"; trust.replaceChildren(icon("lock"), "Only you two"); }
  else { trust.className = `ax-seal ${c.trust === "company" ? "server" : "sealed"}`; trust.replaceChildren(icon(c.trust === "company" ? "building" : "lock"), c.trust === "company" ? "Company" : "Sealed"); }
  show("convo-add", !dm && !profile?.is_guest);
  show("convo-members", !dm);
  composer.placeholder = dm ? `Message ${c.name}` : `Message #${c.name}`;
  fitComposer();
  for (const b of document.querySelectorAll(".side-item[data-id]")) b.classList.toggle("active", b.dataset.id === id);
  const messages = await invoke("open_channel", { channel: id });
  if (!dm) invoke("channel_members", { channel: id }).then((m) => { $("convo-count").textContent = String(m.length); });
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
    const look = m.mine ? { color: profile?.color, avatar: profile?.avatar } : c.kind === "dm" ? { color: c.peer?.color, avatar: c.peer?.avatar } : {};
    const row = el("div", { class: `msg${cont ? " cont" : ""}`, "data-seq": String(m.seq) },
      avatarEl(m.sender, look),
      el("div", {},
        cont ? null : el("header", {}, el("strong", { text: m.sender }), el("time", { text: timeFmt.format(m.ts_ms) })),
        el("div", { class: "body" }, ...mentionChips(m.text)),
        ...deskCards(m.text),
        threads.has(m.seq) ? threadSummary(c, m.seq, threads.get(m.seq)) : null),
      el("div", { class: "msg-acts" }, el("button", { class: "icon-btn sm", type: "button", title: "Reply in thread", "aria-label": "Reply in thread", onclick: () => openThread(c.id, m.seq) }, icon("thread"))));
    rows.push(row);
    lastSender = threads.has(m.seq) ? "" : m.sender; lastTs = m.ts_ms;
  }
  if (!messages.length) {
    rows.push(c.kind === "dm"
      ? el("div", { class: "transcript-empty" }, avatarEl(c.name, { color: c.peer?.color, avatar: c.peer?.avatar }), el("strong", { text: c.name }),
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
    el("span", { class: "who" }, ...who.map((r) => avatarEl(r.sender, r.mine ? { color: profile?.color, avatar: profile?.avatar, size: "sm" } : { size: "sm" }))),
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
    avatarEl(m.sender, m.mine ? { color: profile?.color, avatar: profile?.avatar, size: big ? undefined : "sm" } : c.kind === "dm" && !m.mine ? { color: c.peer?.color, avatar: c.peer?.avatar, size: big ? undefined : "sm" } : { size: big ? undefined : "sm" }),
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
$("thread-input").addEventListener("blur", () => setTimeout(closeMention, 120));
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
function writeStore(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: fine */ } }
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
      deskNeeds.set(c.id, late + claims);
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
      lead = avatarEl(c.name, { color: c.peer?.color, avatar: c.peer?.avatar, size: "xs" });
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
const SETTINGS_PAGES = [["profile", "Profile"], ["privacy", "Privacy"], ["account", "Account & device"], ["appearance", "Appearance"], ["notifications", "Notifications"], ["files", "Files on this computer"], ["devices", "Devices"], ["invites", "Guest invites"]];
// Set when you pick Chats with no conversation open, so the list still shows.
let chatsHint = false;
function sectionNow() {
  const cur = channels.find((c) => c.id === current);
  if (!cur && chatsHint && (view === "home" || view === "space")) return "chats";
  if (!$("view-desks").hidden) return "desks";
  if (!$("view-agenda").hidden) return "agenda";
  if (!$("view-notes").hidden) return note?.file ? "files" : "notes";
  if (!cur) return "overview";
  if (cur.desk === "files") return "files";
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
      ? [{ key: "overview", label: "Overview", icon: "home" }, { key: "chats", label: "Chats", icon: "chat", dot: unread }, { key: "agenda", label: "Agenda", icon: "calendar" }, { key: "notes", label: "Notes", icon: "note" }]
      : [{ key: "overview", label: "Overview", icon: "home" }, { key: "chats", label: "Channels", icon: "chat", dot: unread }, { key: "files", label: "Files", icon: "folder" }, { key: "desks", label: "Desks", icon: "receipt", n: [...deskNeeds.entries()].filter(([id]) => channels.find((c) => c.id === id)?.space === currentSpace?.id).reduce((a, [, n]) => a + n, 0) }];
    folders = folders.map((f) => ({ ...f, active: f.key === now, go: () => openSection(f.key) }));
  }
  $("folder-tabs").replaceChildren(...folders.map((f) => el("button", { class: `folder${f.active ? " active" : ""}`, type: "button", role: "tab", "aria-selected": String(!!f.active), onclick: f.go },
    f.icon ? icon(f.icon) : null, el("span", { text: f.label }),
    f.n ? el("span", { class: "tab-badge warn", text: String(f.n) }) : f.dot ? el("span", { class: "unread-dot", "aria-label": "unread" }) : null)));
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
  if (key === "files") return openDriveOf(currentSpace);
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
  $("desks-grid").replaceChildren(...cards, el("button", { class: "ov-desk add", type: "button", onclick: openNewDesk }, el("span", { class: "top" }, icon("plus"), "Set up a desk"), el("span", { class: "fine", text: "Front desk, help desk, dispatch and more are on the way." })));
}
$("desks-new").addEventListener("click", () => openNewDesk());

// ---------- drawers: chats and people pop over from the left ----------

let drawer = null; // "chats" | "people" | null
let pinned = readStore("anarchy.chatsPinned", true);
function toggleDrawer(name, force) {
  const open = force ?? drawer !== name;
  if (open && name !== "chats" && pinned) { /* the pinned list stays; the other panel opens over the canvas */ }
  drawer = open ? name : null;
  if (open) openAsk(false);
  if (open && name === "people" && thread) closeThread();
  paintDrawers();
  if (open && name === "people") renderPeopleDrawer();
}
function closeDrawers() { drawer = null; paintDrawers(); }
function paintDrawers() {
  // The sidebar belongs to conversations only: Chats on Home, Channels in a space.
  const chatSection = view !== "settings" && sectionNow() === "chats";
  const chatsOn = chatSection && (pinned || drawer === "chats");
  show("drawer-chats", chatsOn);
  show("drawer-people", drawer === "people");
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
      avatarEl(c.name, { color: c.peer?.color, avatar: c.peer?.avatar }), el("span", { class: "lines" }, el("strong", { text: c.name }), el("small", { text: c.peer?.handle ? `@${c.peer.handle}` : "" })))) : [el("p", { class: "fine", text: "Nobody yet. Message someone by their handle." })]));
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
    return el("div", { class: "person-row" }, avatarEl(m.name, { color: m.color, avatar: m.avatar }),
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
composer.addEventListener("blur", () => setTimeout(closeMention, 120));
$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = composer.value.trim();
  if (!text || !current) return;
  composer.value = ""; fitComposer();
  $("transcript").append(el("div", { class: "msg pending" }, avatarEl(profile?.display_name || "You", { color: profile?.color, avatar: profile?.avatar }), el("div", {}, el("div", { class: "body", text }))));
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

const DESK_ICON = { collections: "receipt", files: "folder", agenda: "calendar", notes: "note" };
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
// Arrow keys, Enter/Tab and Escape while the picker is open. True if handled.
function mentionKey(e) {
  if (!mention) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); mention.cursor = (mention.cursor + (e.key === "ArrowDown" ? 1 : -1) + mention.items.length) % mention.items.length; paintMention(); return true; }
  if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(mention.cursor); return true; }
  if (e.key === "Escape") { e.preventDefault(); closeMention(); return true; }
  return false;
}
const KIND_OF_DESK = { collections: "Collections", files: "Files" };

// ---------- Ask ----------
// The pull-out panel where the AI will live. Until a model is connected it's
// honest about being search: it looks through what this device can decrypt and
// answers desk questions from their records. It never sends anything anywhere.

const STOP = new Set("the a an and or of to in on for with is are was were be what who when where which how much many my our your me i we you it this that there any all do does did have has from about show find tell please status check update latest new give list".split(" "));
function openAsk(on = true) {
  if (on && thread) closeThread();
  if (on) { drawer = null; paintDrawers(); }
  show("ask", on);
  $("tool-ask").setAttribute("aria-expanded", String(on));
  syncDock();
  document.querySelector(".main")?.classList.toggle("with-ask", on);
  if (!on) return;
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
  for (const e of evs) out.push(el("button", { class: "ask-hit", type: "button", onclick: () => openAgenda().then(() => openEvent(e)) }, el("small", { text: e.all_day ? "All day" : `${e.start}${e.end ? `–${e.end}` : ""}${e.where ? ` · ${e.where}` : ""}` }), el("span", { text: e.title })));
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
$("ask-input").addEventListener("blur", () => setTimeout(closeMention, 120));
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
  reply.replaceChildren(...(await answer(q)));
  log.scrollTop = log.scrollHeight;
});
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
  const open = !$("ask").hidden || !$("drawer-people").hidden || !$("thread").hidden;
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

}

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
  if (agenda.mode === "month") {
    const first = new Date(c.getFullYear(), c.getMonth(), 1, 12);
    const start = mondayOf(first);
    const cells = [];
    for (let k = 0; k < 42; k++) {
      const d = new Date(start); d.setDate(start.getDate() + k);
      if (k === 35 && d.getMonth() !== c.getMonth()) break;
      const iso = isoOf(d);
      const evs = dayEvents(iso);
      cells.push(el("div", { class: `cal-cell${d.getMonth() !== c.getMonth() ? " out" : ""}${iso === today ? " today" : ""}`, onclick: () => openEvent(null, iso) },
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
      return el("div", { class: `cal-col${iso === today ? " today" : ""}`, onclick: () => openEvent(null, iso) },
        el("div", { class: "cal-col-head" }, el("span", { text: weekdayFmt.format(d) }), el("strong", { text: String(d.getDate()) })),
        ...(evs.length ? evs.map((e) => { const b = chip(e); b.classList.add("big"); if (!e.due && !e.all_day && e.end) b.append(el("span", { class: "ev-range", text: `${e.start}–${e.end}` })); if (e.where) b.append(el("span", { class: "ev-where", text: e.where })); return b; }) : [el("p", { class: "fine cal-free", text: "Free" })]));
    });
    grid.replaceChildren(...cols);
  }
}
function renderAgendaSide() { /* the calendar shows it; no sidebar outside chats */ }
$("agenda-prev").addEventListener("click", () => { const c = agenda.cursor; agenda.cursor = agenda.mode === "month" ? new Date(c.getFullYear(), c.getMonth() - 1, 1, 12) : new Date(c.getTime() - 7 * 864e5); renderAgenda(); });
$("agenda-next-btn").addEventListener("click", () => { const c = agenda.cursor; agenda.cursor = agenda.mode === "month" ? new Date(c.getFullYear(), c.getMonth() + 1, 1, 12) : new Date(c.getTime() + 7 * 864e5); renderAgenda(); });
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
let notesState = { channel: null, items: [], query: "" };
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
async function openNotes(pageId) {
  if (thread) closeThread();
  hideMain(); show("view-notes");
  notesState.channel = await personalDesk("notes").catch((err) => { alert(String(err)); return null; });
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
  if ($("view-notes").hidden) await openNotes();
  renderNote(); saveNoteSoon(0);
  $("note-title").focus();
});
function renderNote() {
  show("note-page", !!note);
  if (!note) {
    $("note-crumbs").replaceChildren(el("span", { text: "Notes" }));
    $("note-blocks").replaceChildren();
    return;
  }
  $("note-crumbs").replaceChildren(...(note.file
    ? [el("button", { class: "link", type: "button", text: "Files", onclick: () => { flushNote(); goTo(note.file.channel); } }), el("span", { text: " / " }), el("span", { text: `${note.file.folder === "/" ? "" : `${note.file.folder.slice(1)} / `}${note.file.name}` })]
    : [el("span", { text: "Notes" }), el("span", { text: " / " }), el("span", { text: note.title || "Untitled" })]));
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
  if (!note || note.file || !confirm(`Delete "${note.title || "Untitled"}"? It's removed from all your devices.`)) return;
  const { id, file, ...data } = note; void file;
  clearTimeout(noteTimer);
  await invoke("put_items", { channel: notesState.channel, items: [{ id, kind: "page", data: { ...data, deleted: true, updated: Date.now() } }] });
  note = null;
  await openNotes();
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
  const n = note;
  try {
    if (n.file) {
      await invoke("save_text_file", { channel: n.file.channel, id: n.file.id, text: toMarkdown(n.blocks) });
    } else {
      const data = { title: n.title, icon: n.icon, blocks: n.blocks.map(({ id, type, text, checked }) => ({ id, type, text, checked })), updated: Date.now() };
      await invoke("put_items", { channel: notesState.channel, items: [{ id: n.id, kind: "page", data }] });
      const at = notesState.items.findIndex((i) => i.id === n.id);
      const rec = { id: n.id, kind: "page", data, seq: 0, updated_ms: data.updated };
      if (at >= 0) notesState.items[at] = rec; else notesState.items.push(rec);
      renderNoteList();
    }
    if (note === n) $("note-saved").textContent = n.file ? "Saved to the drive, encrypted" : "Saved · only your devices can read it";
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

// Home: what's on today, next to your spaces.
async function renderHomeToday() {
  const box = $("home-today");
  if (!box) return;
  let evs = [], recent = [];
  try {
    agenda.channel = await personalDesk("agenda");
    agenda.items = await invoke("desk_items", { channel: agenda.channel });
    evs = dayEvents(isoToday()).filter((e) => !e.due);
    notesState.channel = await personalDesk("notes");
    notesState.items = await invoke("desk_items", { channel: notesState.channel });
    recent = pages().slice(0, 3);
  } catch { /* offline: leave it empty */ }
  $("today-events").replaceChildren(...(evs.length ? evs.map((e) => el("button", { class: "today-row", type: "button", onclick: () => { openAgenda().then(() => openEvent(e)); } },
    el("span", { class: `ev-dot c-${e.color || "ink"}` }), el("strong", { text: e.title }), el("small", { text: e.all_day ? "All day" : `${e.start}${e.end ? `–${e.end}` : ""}` })))
    : [el("button", { class: "today-row empty", type: "button", onclick: () => openAgenda(), text: "Nothing on today. Plan something" })]));
  $("today-notes").replaceChildren(...(recent.length ? recent.map((p) => el("button", { class: "today-row", type: "button", onclick: () => openNotes(p.id) },
    el("span", { class: "note-emoji", text: p.icon || "📝" }), el("strong", { text: p.title || "Untitled" }), el("small", { text: sinceFmt(p.updated || 0) })))
    : [el("button", { class: "today-row empty", type: "button", onclick: () => $("note-new").click(), text: "No pages yet. Start one" })]));
}

// Home: spaces overview

function renderHomeHeadline() {
  const hour = new Date().getHours();
  const hello = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = (profile?.display_name || "").split(" ")[0];
  const unread = channels.filter((c) => c.kind === "dm" && c.unread).length;
  const bits = [unread ? `${unread} unread ${unread === 1 ? "conversation" : "conversations"}` : "nothing unread", spaces.length ? `${spaces.length} ${spaces.length === 1 ? "space" : "spaces"}` : null].filter(Boolean);
  $("home-headline").replaceChildren(`${hello}${first ? `, ${first}` : ""}.`, el("span", { class: "soft", text: ` ${bits.join(", ")[0].toUpperCase()}${bits.join(", ").slice(1)}.` }));
}

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
}
function renderDrive() {
  const files = driveFiles();
  const total = files.reduce((n, f) => n + (f.data.file_key?.size || 0), 0);
  $("drive-kind").textContent = `${currentSpace?.name || ""} · Files`;
  $("drive-headline").replaceChildren(`${files.length} ${files.length === 1 ? "file" : "files"}, ${sizeFmt(total)}.`, el("span", { class: "soft", text: " Only people in this space can open them." }));
  // Breadcrumbs.
  const parts = drive.folder.split("/").filter(Boolean);
  const crumbs = [el("button", { type: "button", text: "Files", onclick: () => { drive.folder = "/"; renderDrive(); } })];
  parts.forEach((p, k) => { crumbs.push(el("span", { class: "sep", text: "/" }), el("button", { type: "button", text: p, onclick: () => { drive.folder = `/${parts.slice(0, k + 1).join("/")}`; renderDrive(); } })); });
  $("drive-crumbs").replaceChildren(...crumbs);
  const q = drive.query.toLowerCase();
  let folders = [], shown = [];
  if (q) shown = files.filter((f) => `${f.data.name} ${f.data.folder}`.toLowerCase().includes(q));
  else {
    const depth = parts.length + 1;
    folders = driveFolders().filter((p) => p.split("/").filter(Boolean).length === depth && p.startsWith(drive.folder === "/" ? "/" : `${drive.folder}/`)).sort();
    shown = files.filter((f) => (f.data.folder || "/") === drive.folder);
  }
  shown.sort((a, b) => (b.data.added || 0) - (a.data.added || 0));
  const rows = [
    ...folders.map((p) => {
      const inside = files.filter((f) => (f.data.folder || "/") === p || (f.data.folder || "").startsWith(`${p}/`)).length;
      return el("tr", { onclick: () => { drive.folder = p; renderDrive(); } },
        el("td", {}, el("span", { class: "fname" }, el("span", { class: "ficon folder" }, icon("folder")), p.split("/").pop())),
        el("td", { class: "num", text: `${inside} ${inside === 1 ? "file" : "files"}` }), el("td", { class: "c-issued" }), el("td", { class: "c-terms" }), el("td", { class: "c-actions" }));
    }),
    ...shown.map((f) => {
      const [ic, cls] = fileIcon(f.data.mime);
      const btns = el("span", { class: "row-btns" },
        el("button", { class: "icon-btn", type: "button", title: "Download", "aria-label": `Download ${f.data.name}`, onclick: (e) => { e.stopPropagation(); downloadFile(f); } }, icon("download")),
        el("button", { class: "icon-btn", type: "button", title: "Rename", "aria-label": `Rename ${f.data.name}`, onclick: (e) => { e.stopPropagation(); renameFile(f); } }, icon("pen")),
        el("button", { class: "icon-btn", type: "button", title: "Delete", "aria-label": `Delete ${f.data.name}`, onclick: (e) => { e.stopPropagation(); deleteFile(f); } }, icon("trash")));
      return el("tr", { onclick: () => previewFile(f) },
        el("td", {}, el("span", { class: "fname" }, el("span", { class: `ficon ${cls}` }, icon(ic)), f.data.name, q && f.data.folder !== "/" ? el("small", { text: f.data.folder }) : null)),
        el("td", { class: "num", text: sizeFmt(f.data.file_key?.size || 0) }),
        el("td", { class: "c-issued", text: f.data.added ? dateFmt.format(f.data.added) : "" }),
        el("td", { class: "c-terms", text: f.data.by || "" }),
        el("td", { class: "c-actions" }, btns));
    }),
  ];
  $("drive-rows").replaceChildren(...rows);
  show("drive-table", rows.length > 0);
  show("drive-empty", rows.length === 0);
  $("drive-empty-title").textContent = q ? "No files match" : drive.folder === "/" ? "Nothing here yet" : "This folder is empty";
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
  if (!confirm(`Delete ${f.data.name} for everyone in this space?`)) return;
  await invoke("put_items", { channel: drive.channel, items: [{ id: f.id, kind: "file", data: { ...f.data, deleted: true } }] });
  await logTo(drive.channel, `Deleted ${f.data.name}.`);
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
    $("ov-people").replaceChildren(...members.map((m) => el("div", { class: "ov-person" }, avatarEl(m.name, { color: m.color, avatar: m.avatar, size: "sm" }),
      el("span", { class: "lines" }, el("span", { text: m.name }), el("small", { text: m.handle ? `@${m.handle}` : "" })))),
      el("button", { class: "link", type: "button", text: "Invite people", onclick: openInvite }));
  } catch { $("ov-people").replaceChildren(el("p", { class: "fine", text: "Couldn't load people." })); }
}

// ---------- window and search ----------

const appWindow = tauri?.window?.getCurrentWindow?.();
$("win-close").addEventListener("click", () => appWindow?.close());
$("win-min").addEventListener("click", () => appWindow?.minimize());
$("win-max").addEventListener("click", () => appWindow?.toggleMaximize());
$("search-kbd").textContent = /Mac/.test(navigator.platform) ? "⌘K" : "Ctrl K";

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
    for (const h of msgs) rows.push(item(h.by === "You" ? avatarEl(profile?.display_name || "You", { color: profile?.color, avatar: profile?.avatar, size: "sm" }) : avatarEl(h.by, { size: "sm" }), [el("small", { text: `${h.by} · ${shortDate.format(h.ts_ms)}` }), el("span", {}, ...highlight(h.text, q))], whereOf(channels.find((c) => c.id === h.channel)), () => goTo(h.channel)));
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
  if (fresh) desk = { channel: c.id, name: c.name, space: c.space, items: [], messages: [], links: {}, linksAt: 0, tab: "all", query: "", selected: new Set() };
  const [items, messages] = await Promise.all([invoke("desk_items", { channel: c.id }), invoke("open_channel", { channel: c.id })]);
  desk.items = items; desk.messages = messages;
  await refreshLinks();
  invoke("channel_members", { channel: c.id }).then((m) => { $("desk-people-count").textContent = String(m.length); });
  if (fresh) $("desk-search").value = "";
  $("desk-kind").textContent = c.name;
  renderDesk();
  refreshChannels();
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
  const acts = desk.messages.slice(-30).map((m) => el("div", { class: "act" }, avatarEl(m.sender, m.mine ? { color: profile?.color, avatar: profile?.avatar, size: "sm" } : { size: "sm" }),
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
function openNewDesk() { $("desk-new-name").value = "Collections"; setError("desk-error", ""); $("dlg-desk").showModal(); $("desk-new-name").select(); }

$("space-empty-desk").addEventListener("click", openNewDesk);
$("desk-cancel").addEventListener("click", () => $("dlg-desk").close());
$("desk-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await busy($("desk-create"), "Creating…", async () => {
    try {
      const id = await invoke("create_desk", { space: currentSpace?.id ?? null, name: $("desk-new-name").value, kind: "collections" });
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
$("rail-add").addEventListener("click", () => openSpaceDialog("create"));
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
        if (current && (!$("view-convo").hidden || !$("view-desk").hidden)) await openChannel(current);
      }
      if (desk && !$("view-desk").hidden && Date.now() - desk.linksAt > 15000) {
        const before = JSON.stringify(desk.links);
        await refreshLinks();
        if (JSON.stringify(desk.links) !== before) renderDesk();
      }
      // Files can change from the file manager, or from others, without a text message.
      if (drive && !$("view-drive").hidden) {
        const items = await invoke("desk_items", { channel: drive.channel });
        const sig = (xs) => xs.map((x) => `${x.id}:${x.seq}`).join();
        if (sig(items) !== sig(drive.items)) { drive.items = items; renderDrive(); }
      }
    } catch (err) {
      if (/signed out|sign in required/i.test(String(err))) { status = await invoke("status"); if (!status.session) showAuth(); }
    } finally { syncing = false; }
  }, POLL_MS);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

// ---------- settings ----------

function settingsPage(page) {
  for (const p of document.querySelectorAll(".page")) show(p, p.dataset.page === page);
  settingsAt = page;
  renderFolders();
  ({ profile: loadProfile, privacy: loadPrivacy, account: loadAccount, notifications: loadNotifications, files: loadMount, devices: loadDevices, appearance: () => {}, invites: () => { show("invite-result", false); setError("invite-error", ""); } })[page]();
}

let edit = {};
function loadProfile() {
  edit = { ...profile };
  $("p-name").value = edit.display_name; $("p-user").value = edit.username;
  $("p-tag").textContent = `#${String(edit.tag).padStart(4, "0")}`;
  mountPickers($("p-avatar"), $("p-color"), () => edit, (c) => { Object.assign(edit, c); paintProfile(); });
  paintProfile();
  show("p-saved", false); setError("p-error", "");
}
function paintProfile() {
  edit.display_name = $("p-name").value; edit.username = $("p-user").value.toLowerCase();
  syncPickers($("p-avatar"), $("p-color"), edit);
  paintCard("p-", edit);
}
$("p-name").addEventListener("input", paintProfile);
$("p-user").addEventListener("input", paintProfile);
$("profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("p-error", "");
  try {
    profile = await invoke("update_profile", { update: { display_name: edit.display_name.trim(), username: edit.username.trim(), color: edit.color, avatar: edit.avatar || "" } });
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

const OS = /Mac/.test(navigator.platform) ? "mac" : /Win/.test(navigator.platform) ? "win" : "linux";
for (const n of document.querySelectorAll(".os-files")) n.textContent = { mac: "Finder", win: "File Explorer", linux: "Files" }[OS];
const MOUNT_HOW = {
  mac: "Finder mounts it as \u201cAnarchy\u201d under Locations. To add it by hand: Go \u2192 Connect to Server (\u2318K), paste the address.",
  win: "Explorer opens it by address. To give it a drive letter: This PC \u2192 Map network drive, paste the address. Files up to 50 MB unless you raise Windows' WebClient limit.",
  linux: "Files (GNOME) and Dolphin open it as a network location. Other file managers: connect to the address with dav:// in place of http://.",
};
let mount = null;
function paintMount() {
  $("m-enabled").checked = !!mount?.enabled;
  show("m-box", !!mount?.running);
  $("m-url").textContent = mount?.url || "";
  $("m-win").textContent = mount?.windows || "";
  show("m-win-row", OS === "win");
  $("m-how").textContent = MOUNT_HOW[OS];
}
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
  await navigator.clipboard.writeText(OS === "win" ? mount.windows : mount.url);
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
  if (!status.session) return showAuth();
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
