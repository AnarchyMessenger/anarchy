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
  const at = FLOW.indexOf(id === "s-anon" || id === "s-guest" ? "s-account" : id);
  $("steps").replaceChildren(...(at < 0 ? [] : FLOW.map((_, i) => el("i", { class: i <= at ? "on" : "" }))));
  const focus = { "s-server": "server", "s-guest": "invite-code", "s-anon": "anon-name", "s-lock": "pass1", "s-card": "card-name" }[id];
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
  show("starting", false); show("lock", false); show("app", false); show("auth");
  if (status.last_server) $("server").value = hostOf(status.last_server);
  paintArt({});
  authStep("s-server");
}

$("s-server").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("server-error", "");
  await busy($("server-continue"), "Checking…", async () => {
    try { workspace = await invoke("workspace_info", { server: $("server").value }); prepareAccount(); }
    catch (err) { setError("server-error", String(err)); }
  });
});

function prepareAccount() {
  const c = workspace.config;
  const google = /accounts\.google\.com/.test(c.issuer || "");
  $("account-title").textContent = c.open_signup ? "Create your account" : `Sign in to ${c.org_name}`;
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

$("change-server").addEventListener("click", () => authStep("s-server"));

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
  paintMe();
  try { spaces = await invoke("spaces"); } catch { spaces = []; }
  renderRail();
  go("home");
  await refreshChannels();
  startPolling();
}

function paintMe() {
  const p = profile || { display_name: status.session?.display_name || "You" };
  const name = p.display_name || "You";
  $("rail-me").replaceChildren(avatarEl(name, { color: p.color, avatar: p.avatar }));
  fillAvatar($("foot-avatar"), name, p.color, p.avatar);
  $("foot-name").textContent = name;
  $("foot-handle").textContent = handleOf(p) ? `@${handleOf(p)}` : hostOf(status.session?.server);
  $("share-handle").textContent = handleOf(p) ? `@${handleOf(p)}` : "";
  $("share-policy").textContent = p.dm_policy === "anyone" ? "Anyone with it can message you." : "Only people in your spaces can message you.";
  show("nav-invites", isCompanyServer() && !p.is_guest);
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
  show("side-home", which === "home");
  show("side-space", which === "space");
  show("side-settings", which === "settings");
  show("side-foot", which !== "settings");
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
  for (const v of ["view-start", "view-convo", "view-space-empty", "view-desk", "view-settings"]) show(v, false);
  document.querySelector(".workspace").classList.remove("focus");
}
function showStart() {
  hideMain();
  show("view-start", view === "home");
  show("view-space-empty", view === "space");
  if (view === "space") {
    $("space-empty-kind").textContent = `${KIND_LABEL[currentSpace.kind] || "Space"} · ${currentSpace.members} ${currentSpace.members === 1 ? "member" : "members"}`;
    $("space-empty-title").textContent = currentSpace.name;
  }
}
function openSpace(s) {
  currentSpace = s;
  $("space-name").textContent = s.name;
  current = null;
  go("space");
}
$("rail-home").addEventListener("click", () => go("home"));
$("rail-settings").addEventListener("click", () => go("settings"));
$("rail-me").addEventListener("click", () => go("settings"));
$("copy-handle").addEventListener("click", () => copy(`@${handleOf(profile)}`, null));
$("share-copy").addEventListener("click", () => copy(`@${handleOf(profile)}`, $("share-copy")));

// Lists

async function refreshChannels() {
  channels = await invoke("list_channels");
  renderSide();
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
    const desks = channels.filter((c) => c.kind === "channel" && c.space === currentSpace.id && c.desk);
    $("desk-list").replaceChildren(...desks.map((c) => el("button", { class: `side-item${c.id === current ? " active" : ""}`, "data-id": c.id, onclick: () => openChannel(c.id) },
      el("span", { class: "kind-icon" }, icon("receipt")), el("span", { class: "name", text: c.name }))));
    show("no-desks", desks.length === 0);
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
  current = id;
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
  refreshChannels();
}

function renderMessages(messages, c) {
  const t = $("transcript");
  const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 40;
  const rows = [];
  let lastDay = "", lastSender = "", lastTs = 0;
  for (const m of messages) {
    const day = dayFmt.format(m.ts_ms);
    if (day !== lastDay) { rows.push(el("div", { class: "day", text: day })); lastDay = day; lastSender = ""; }
    const cont = m.sender === lastSender && m.ts_ms - lastTs < 5 * 60 * 1000;
    const look = m.mine ? { color: profile?.color, avatar: profile?.avatar } : c.kind === "dm" ? { color: c.peer?.color, avatar: c.peer?.avatar } : {};
    rows.push(el("div", { class: `msg${cont ? " cont" : ""}` },
      avatarEl(m.sender, look),
      el("div", {},
        cont ? null : el("header", {}, el("strong", { text: m.sender }), el("time", { text: timeFmt.format(m.ts_ms) })),
        el("div", { class: "body", text: m.text }))));
    lastSender = m.sender; lastTs = m.ts_ms;
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

const composer = $("message");
function fitComposer() { composer.style.height = "auto"; composer.style.height = `${Math.min(composer.scrollHeight, 160)}px`; $("send").disabled = !composer.value.trim(); }
composer.addEventListener("input", fitComposer);
composer.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); } });
$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = composer.value.trim();
  if (!text || !current) return;
  composer.value = ""; fitComposer();
  $("transcript").append(el("div", { class: "msg pending" }, avatarEl(profile?.display_name || "You", { color: profile?.color, avatar: profile?.avatar }), el("div", {}, el("div", { class: "body", text }))));
  $("transcript").scrollTop = $("transcript").scrollHeight;
  try { await invoke("send_message", { channel: current, text }); }
  catch (err) { composer.value = text; fitComposer(); $("transcript").append(el("p", { class: "error", text: `Not sent: ${err}` })); }
  openChannel(current);
});

// Home: spaces overview

function renderHomeSpaces() {
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
  document.querySelector(".workspace").classList.add("focus");
  for (const b of document.querySelectorAll(".side-item[data-id]")) b.classList.toggle("active", b.dataset.id === c.id);
  const fresh = !desk || desk.channel !== c.id;
  if (fresh) desk = { channel: c.id, name: c.name, items: [], messages: [], tab: "all", query: "", selected: new Set() };
  const [items, messages] = await Promise.all([invoke("desk_items", { channel: c.id }), invoke("open_channel", { channel: c.id })]);
  desk.items = items; desk.messages = messages;
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
  else if (!outstanding.length) h.replaceChildren("Nothing outstanding. ", el("span", { class: "soft", text: `${all.filter((i) => i.state === "paid").length} invoices paid.` }));
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
      el("td", { class: "inv", text: i.number }),
      el("td", {}, el("span", { class: "who" }, el("span", { class: "tile", text: initials(i.customer) }), i.customer)),
      el("td", { text: i.issued ? dateFmt.format(asDate(i.issued)) : "" }),
      el("td", { class: "due" }, i.due ? shortDate.format(asDate(i.due)) : "", dueNote),
      el("td", { class: "num", text: money(i.amount) }),
      el("td", {}, el("span", { class: `st ${i.state}` }, icon(stIcon[i.state]), stLabel[i.state])),
      el("td", { text: i.terms ? `Net ${i.terms}` : "On receipt" }));
  }));
  show("desk-table", rows.length > 0);
  show("desk-empty", rows.length === 0);
  $("desk-empty-title").textContent = all.length ? "Nothing here" : "No invoices yet";
  $("desk-empty-sub").textContent = all.length ? "No invoices match this view." : "Create the first one. Everyone on this desk sees it, and nobody else, the server included.";
  $("check-all").checked = rows.length > 0 && rows.every((i) => desk.selected.has(i.id));
  renderBulk();
  renderNotes(all);
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
  if (all.length && !overdue.length && !drafts.length) {
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
  const today = isoToday();
  const sel = invoices().filter((i) => desk.selected.has(i.id) && i.state !== "paid");
  if (!sel.length) return;
  await putInvoices(sel.map((i) => ({ ...i, status: "paid", paid_on: today })));
  await logActivity(sel.length === 1 ? `Marked ${sel[0].number} (${sel[0].customer}, ${money(sel[0].amount)}) as paid.` : `Marked ${sel.length} invoices as paid: ${sel.map((i) => i.number).join(", ")}.`);
  desk.selected.clear();
  openChannel(desk.channel);
});
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
    const body = `Hello,\n\nA reminder that invoice ${i.number} for ${money(i.amount)} ${late > 0 ? `was due on ${dateFmt.format(asDate(i.due))} (${late} ${late === 1 ? "day" : "days"} ago)` : `is due on ${dateFmt.format(asDate(i.due))}`}. If it's already on its way, thank you and please ignore this.\n\nBest,\n${me}`;
    try { await invoke("compose_email", { to: i.email, subject: `Invoice ${i.number}${late > 0 ? " is overdue" : " reminder"}`, body }); }
    catch (err) { alert(String(err)); return; }
  }
  await putInvoices(withEmail.map((i) => ({ ...i, reminded_on: today })));
  await logActivity(`Drafted ${withEmail.length === 1 ? "a reminder" : `${withEmail.length} reminders`} in my mail app: ${withEmail.map((i) => `${i.number} to ${i.customer}`).join(", ")}.`);
  openChannel(desk.channel);
}

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
$("toggle-side").addEventListener("click", () => document.querySelector(".workspace").classList.toggle("focus"));

// New desk.
function openNewDesk() { $("desk-new-name").value = "Collections"; setError("desk-error", ""); $("dlg-desk").showModal(); $("desk-new-name").select(); }
$("new-desk").addEventListener("click", openNewDesk);
$("no-desks").addEventListener("click", openNewDesk);
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
        ? await invoke("join_space", { code: $("space-code").value })
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
    $("sp-code").textContent = inv.code;
    $("sp-meta").textContent = `Works until ${dateTimeFmt.format(inv.expires_at_ms)}, ${inv.max_uses === 1 ? "once" : `${inv.max_uses} times`}. They use "Join with a code" on Home.`;
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
    } catch (err) {
      if (/signed out|sign in required/i.test(String(err))) { status = await invoke("status"); if (!status.session) showAuth(); }
    } finally { syncing = false; }
  }, POLL_MS);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

// ---------- settings ----------

function settingsPage(page) {
  for (const p of document.querySelectorAll(".page")) show(p, p.dataset.page === page);
  for (const b of $("side-settings").querySelectorAll(".side-item")) b.classList.toggle("active", b.dataset.page === page);
  ({ profile: loadProfile, privacy: loadPrivacy, account: loadAccount, notifications: loadNotifications, devices: loadDevices, appearance: () => {}, invites: () => { show("invite-result", false); setError("invite-error", ""); } })[page]();
}
for (const b of $("side-settings").querySelectorAll(".side-item")) b.addEventListener("click", () => settingsPage(b.dataset.page));

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
