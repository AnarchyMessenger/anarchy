// Anarchy desktop UI: sign-in, chat and settings.
// Talks to the Rust engine through Tauri commands (src-tauri/src/main.rs).
// Everything people type or receive goes in through textContent, never as HTML.

const $ = (id) => document.getElementById(id);
const tauri = window.__TAURI__;
const invoke = (cmd, args) => tauri.core.invoke(cmd, args);
const media = window.matchMedia("(prefers-color-scheme: dark)");
const POLL_MS = 2500;

let status = null;
let appearance = { display: "system", frame: "cobalt", chosen: false };
let workspace = null; // { server, config } during sign-in
let pendingEmail = "";
let channels = [];
let current = null; // open channel id
let pollTimer = null;
let syncing = false;

// ---------- helpers ----------

function show(el, visible = true) { (typeof el === "string" ? $(el) : el).hidden = !visible; }
function setError(id, message) { $(id).textContent = message || ""; show(id, !!message); }
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
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
  const words = (name || "").split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+/u, "")).filter(Boolean);
  return words.slice(0, 2).map((w) => [...w][0].toUpperCase()).join("") || "?";
}
function hostOf(server) { return (server || "").replace(/^https?:\/\//, ""); }
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
async function busy(button, label, fn) {
  const old = button.innerHTML;
  button.disabled = true;
  button.textContent = label;
  try { return await fn(); } finally { button.disabled = false; button.innerHTML = old; }
}

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

// ---------- sign-in ----------

function authStep(id) {
  for (const s of document.querySelectorAll(".auth-step")) show(s, s.id === id);
  const focus = { "s-workspace": "server", "s-guest": "invite-code", "s-look": "look-done" }[id];
  if (focus) requestAnimationFrame(() => $(focus).focus());
}

function showAuth() {
  stopPolling();
  show("starting", false); show("app", false); show("auth");
  if (status.last_server) $("server").value = hostOf(status.last_server);
  authStep("s-workspace");
}

$("s-workspace").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("server-error", "");
  await busy($("server-continue"), "Checking…", async () => {
    try {
      workspace = await invoke("workspace_info", { server: $("server").value });
      prepareSignIn();
    } catch (err) { setError("server-error", String(err)); }
  });
});

function prepareSignIn() {
  const c = workspace.config;
  for (const id of ["org-name", "sso-org", "guest-org"]) $(id).textContent = c.org_name;
  $("org-initials").textContent = initials(c.org_name);
  $("org-server").textContent = hostOf(workspace.server);
  $("art-title").textContent = `${c.org_name} is ready`;
  $("art-sub").textContent = "Sign in and your channels pick up where you left off.";
  const sso = !!c.issuer;
  show("sso", sso);
  show("email-form", c.email_enabled);
  show("or", sso && c.email_enabled);
  show("code-form", false);
  show("sso-waiting", false);
  show("guest-link-row", c.guests_enabled);
  show("no-method", !sso && !c.email_enabled);
  setError("signin-error", "");
  authStep("s-signin");
  requestAnimationFrame(() => (c.email_enabled && !sso ? $("email") : $("sso")).focus?.());
}

$("change-workspace").addEventListener("click", () => authStep("s-workspace"));

$("sso").addEventListener("click", async () => {
  setError("signin-error", "");
  show("sso", false); show("or", false); show("email-form", false); show("guest-link-row", false);
  show("sso-waiting");
  try {
    await invoke("sign_in_sso", { server: workspace.server });
    await afterSignIn();
  } catch (err) {
    prepareSignIn();
    if (String(err) !== "Sign-in cancelled") setError("signin-error", String(err));
  }
});
$("sso-cancel").addEventListener("click", () => invoke("cancel_sign_in"));
tauri?.event?.listen("sign-in-link", (event) => { $("sso-link").textContent = event.payload; show("sso-link-box"); });
$("sso-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("sso-link").textContent); $("sso-copy").textContent = "Copied"; }
  catch { window.getSelection().selectAllChildren($("sso-link")); }
});

async function sendCode() {
  pendingEmail = $("email").value.trim();
  if (!pendingEmail) return setError("signin-error", "Enter your work email.");
  setError("signin-error", "");
  await invoke("request_email_code", { server: workspace.server, email: pendingEmail });
  $("sent-to").textContent = pendingEmail;
  show("email-form", false); show("sso", false); show("or", false);
  show("code-form");
  $("code").value = "";
  requestAnimationFrame(() => $("code").focus());
}
$("email-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await busy($("email-send"), "Sending…", async () => {
    try { await sendCode(); } catch (err) { setError("signin-error", String(err)); }
  });
});
$("code").addEventListener("input", () => {
  const digits = $("code").value.replace(/\D/g, "").slice(0, 6);
  $("code").value = digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
  if (digits.length === 6) $("code-form").requestSubmit();
});
$("code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("signin-error", "");
  await busy($("code-submit"), "Signing in…", async () => {
    try {
      await invoke("sign_in_email", { server: workspace.server, email: pendingEmail, code: $("code").value });
      await afterSignIn();
    } catch (err) { setError("signin-error", String(err)); $("code").select(); }
  });
});
$("code-resend").addEventListener("click", async () => {
  try { await invoke("request_email_code", { server: workspace.server, email: pendingEmail }); setError("signin-error", ""); $("code").focus(); }
  catch (err) { setError("signin-error", String(err)); }
});
$("code-other").addEventListener("click", prepareSignIn);

$("to-guest").addEventListener("click", () => { setError("guest-error", ""); authStep("s-guest"); });
$("guest-back").addEventListener("click", () => authStep("s-signin"));
$("s-guest").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("invite-code").value.trim();
  const name = $("guest-name").value.trim();
  if (!code) return setError("guest-error", "Enter the invite code you were given.");
  if (!name) return setError("guest-error", "Enter a name so people know who you are.");
  setError("guest-error", "");
  await busy($("guest-join"), "Joining…", async () => {
    try { await invoke("join_as_guest", { server: workspace.server, code, name }); await afterSignIn(); }
    catch (err) { setError("guest-error", String(err)); }
  });
});

async function afterSignIn() {
  status = await invoke("status");
  if (appearance.chosen) return showApp();
  authStep("s-look");
}
$("look-done").addEventListener("click", async () => { await setAppearance({}); showApp(); });

// ---------- app ----------

async function showApp() {
  const s = status.session;
  show("starting", false); show("auth", false); show("app");
  $("sidebar-title").textContent = s.org_name;
  $("rail-org").textContent = initials(s.org_name);
  show("guest-chip", s.is_guest);
  show("nav-invites", !s.is_guest);
  const name = s.display_name || (s.is_guest ? "Guest" : "You");
  $("account-name").textContent = name;
  $("account-avatar").textContent = initials(name);
  $("account-server").textContent = hostOf(s.server);
  view("chat");
  await refreshChannels();
  startPolling();
}

function view(which) {
  show("view-chat", which === "chat");
  show("view-settings", which === "settings");
  show("side-chat", which === "chat");
  show("side-settings", which === "settings");
  for (const b of document.querySelectorAll(".rail-btn")) b.classList.toggle("active", b.dataset.view === which);
  if (which === "settings") { invoke("blur"); settingsPage("account"); }
  else if (current) openChannel(current);
}
for (const b of document.querySelectorAll(".rail-btn")) b.addEventListener("click", () => view(b.dataset.view));

// Channels

async function refreshChannels() {
  channels = await invoke("list_channels");
  const list = $("channel-list");
  list.replaceChildren(...channels.map((c) => el("button", {
    class: `side-item${c.id === current ? " active" : ""}${c.unread && c.id !== current ? " unread" : ""}`,
    "data-id": c.id,
    onclick: () => openChannel(c.id).then(() => composer.focus()),
  }, el("span", { class: "hash", text: "#" }), el("span", { class: "name", text: c.name }),
     ...(c.unread && c.id !== current ? [el("span", { class: "unread-dot", "aria-label": "unread" })] : []))));
  show("no-channels", channels.length === 0);
  if (!current && channels.length) return openChannel(channels[0].id);
  if (!channels.length) { current = null; show("channel", false); show("chat-empty"); }
  if (current && !channels.some((c) => c.id === current)) { current = null; return refreshChannels(); }
}

async function openChannel(id) {
  current = id;
  const c = channels.find((x) => x.id === id);
  if (!c) return;
  show("chat-empty", false); show("channel");
  $("ch-name").textContent = `# ${c.name}`;
  $("ch-topic").textContent = c.topic;
  const trust = $("ch-trust");
  trust.className = `ax-seal ${c.trust === "company" ? "server" : "sealed"}`;
  trust.replaceChildren(icon(c.trust === "company" ? "building" : "lock"), c.trust === "company" ? "Company" : "Sealed");
  $("message").placeholder = `Message #${c.name}`;
  fitComposer();
  for (const b of $("channel-list").children) b.classList.toggle("active", b.dataset.id === id);
  const [messages, members] = await Promise.all([invoke("open_channel", { channel: id }), invoke("channel_members", { channel: id })]);
  $("ch-count").textContent = String(members.length);
  $("ch-add").hidden = status.session.is_guest;
  renderMessages(messages);
  refreshChannels();
}

function renderMessages(messages) {
  const t = $("transcript");
  const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 40;
  const rows = [];
  let lastDay = "", lastSender = "", lastTs = 0;
  for (const m of messages) {
    const day = dayFmt.format(m.ts_ms);
    if (day !== lastDay) { rows.push(el("div", { class: "day", text: day })); lastDay = day; lastSender = ""; }
    const cont = m.sender === lastSender && m.ts_ms - lastTs < 5 * 60 * 1000;
    rows.push(el("div", { class: `msg${cont ? " cont" : ""}` },
      el("span", { class: "avatar", text: initials(m.sender) }),
      el("div", {},
        ...(cont ? [] : [el("header", {}, el("strong", { text: m.sender }), el("time", { text: timeFmt.format(m.ts_ms) }))]),
        el("div", { class: "body", text: m.text }))));
    lastSender = m.sender; lastTs = m.ts_ms;
  }
  if (!messages.length) rows.push(el("p", { class: "transcript-empty", text: "No messages since you joined. Earlier ones stay readable only to the people who were here, so say hello." }));
  t.replaceChildren(...rows);
  if (atBottom || messages.length < 30) t.scrollTop = t.scrollHeight;
}

// Composer

const composer = $("message");
function fitComposer() { composer.style.height = "auto"; composer.style.height = `${Math.min(composer.scrollHeight, 160)}px`; $("send").disabled = !composer.value.trim(); }
composer.addEventListener("input", fitComposer);
composer.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); }
});
$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = composer.value.trim();
  if (!text || !current) return;
  composer.value = ""; fitComposer();
  // Show it straight away, dimmed, until the server has it.
  $("transcript").append(el("div", { class: "msg pending" }, el("span", { class: "avatar", text: "…" }), el("div", {}, el("div", { class: "body", text }))));
  $("transcript").scrollTop = $("transcript").scrollHeight;
  try { await invoke("send_message", { channel: current, text }); }
  catch (err) { composer.value = text; fitComposer(); alertInline(String(err)); }
  openChannel(current);
});
function alertInline(message) {
  $("transcript").append(el("p", { class: "error", text: `Not sent: ${message}` }));
}

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
$("empty-new-channel").addEventListener("click", openNewChannel);
function channelFormReady() {
  $("channel-create").disabled = !$("ch-new-name").value.trim() || !document.querySelector("input[name=trust]:checked");
}
$("channel-form").addEventListener("input", channelFormReady);
$("channel-form").addEventListener("change", channelFormReady);
$("channel-cancel").addEventListener("click", (e) => { e.preventDefault(); $("dlg-channel").close(); });
$("channel-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const trust = document.querySelector("input[name=trust]:checked")?.value;
  await busy($("channel-create"), "Creating…", async () => {
    try {
      const id = await invoke("create_channel", { name: $("ch-new-name").value, topic: $("ch-new-topic").value, trust });
      $("dlg-channel").close();
      current = id;
      await refreshChannels();
      await openChannel(id);
      composer.focus();
    } catch (err) { setError("channel-error", String(err)); }
  });
});

// People

let peopleCache = [];
async function openPeople(addMode) {
  const c = channels.find((x) => x.id === current);
  $("people-channel").textContent = `#${c.name}`;
  setError("people-error", "");
  $("people-filter").value = "";
  $("people-add").hidden = !addMode;
  $("dlg-people").showModal();
  try {
    if (addMode) peopleCache = await invoke("people", { channel: current });
    else peopleCache = (await invoke("channel_members", { channel: current })).map((m) => ({ ...m, in_channel: true, can_be_added: false }));
  } catch (err) { setError("people-error", String(err)); peopleCache = []; }
  renderPeople(addMode);
  $("people-filter").focus();
}
function renderPeople(addMode) {
  const q = $("people-filter").value.toLowerCase();
  const rows = peopleCache
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.email || "").toLowerCase().includes(q))
    .map((p) => {
      const note = p.me ? "You" : p.in_channel ? (addMode ? "Already here" : p.is_guest ? "Guest" : "Member")
        : p.can_be_added ? (p.is_guest ? "Guest" : p.email || "") : "Hasn't signed in on a device yet";
      const right = addMode
        ? el("input", { type: "checkbox", value: p.user_id, "aria-label": `Add ${p.name}`, ...(p.in_channel || !p.can_be_added || p.me ? { disabled: "" } : {}) })
        : (!p.me && !status.session.is_guest ? el("button", { class: "btn-outline sm", type: "button", text: "Remove", onclick: () => removePerson(p) }) : el("span"));
      return el("label", { class: "person" }, el("span", { class: "avatar", text: initials(p.name) }),
        el("span", { class: "grow" }, el("span", { text: p.name }), el("small", { text: note })), right);
    });
  $("people-list").replaceChildren(...(rows.length ? rows : [el("p", { class: "fine", text: "Nobody matches." })]));
  $("people-add").disabled = true;
}
$("people-filter").addEventListener("input", () => renderPeople(!$("people-add").hidden));
$("people-list").addEventListener("change", () => { $("people-add").disabled = !$("people-list").querySelector("input:checked"); });
$("ch-add").addEventListener("click", () => openPeople(true));
$("ch-members").addEventListener("click", () => openPeople(false));
$("people-cancel").addEventListener("click", (e) => { e.preventDefault(); $("dlg-people").close(); });
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
        if (current && !$("view-chat").hidden) await openChannel(current);
      }
    } catch (err) {
      if (/sign in required|signed out/i.test(String(err))) { status = await invoke("status"); if (!status.session) showAuth(); }
    } finally { syncing = false; }
  }, POLL_MS);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

// ---------- settings ----------

function settingsPage(page) {
  for (const p of document.querySelectorAll(".page")) show(p, p.dataset.page === page);
  for (const b of $("side-settings").children) b.classList.toggle("active", b.dataset.page === page);
  ({ account: loadAccount, notifications: loadNotifications, devices: loadDevices, appearance: () => {}, invites: () => { show("invite-result", false); setError("invite-error", ""); } })[page]();
}
for (const b of $("side-settings").children) b.addEventListener("click", () => settingsPage(b.dataset.page));

async function loadAccount() {
  status = await invoke("status");
  const s = status.session;
  $("acc-name").textContent = s.display_name || "—";
  $("acc-email").textContent = s.email || (s.is_guest ? "Guest (no email)" : "From your organisation's sign-in");
  $("acc-workspace").textContent = `${s.org_name} · ${hostOf(s.server)}`;
  show("acc-guest-row", s.is_guest);
  if (s.is_guest) $("acc-guest-until").textContent = dateTimeFmt.format(s.expires_at_ms);
  const saved = status.storage.kind === "saved";
  show("storage-saved", saved); show("storage-temporary", !saved);
  if (!saved) $("storage-reason").textContent = `Anarchy couldn't save this device: ${status.storage.reason}.`;
}
$("sign-out").addEventListener("click", async () => {
  await invoke("sign_out");
  current = null;
  status = await invoke("status");
  showAuth();
});

function loadNotifications() {
  const n = status.notifications;
  $("n-desktop").checked = n.desktop; $("n-mentions").checked = n.mentions_only; $("n-previews").checked = n.previews;
  $("n-handle").textContent = status.session.display_name || "your name";
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
    $("invite-meta").textContent = `Works until ${dateTimeFmt.format(inv.expires_at_ms)}, ${inv.max_uses === 1 ? "once" : `${inv.max_uses} times`}. Guests join from the sign-in screen with "Join as a guest".`;
    show("invite-result");
  } catch (err) { setError("invite-error", String(err)); }
});
$("invite-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("invite-code-out").textContent); $("invite-copy").textContent = "Copied"; }
  catch { window.getSelection().selectAllChildren($("invite-code-out")); }
});

// ---------- start ----------

async function start() {
  mountAppearance($("auth-appearance"));
  mountAppearance($("settings-appearance"));
  if (!tauri?.core) { $("starting").textContent = "Open this inside the Anarchy desktop app (or run ui-preview.mjs)."; return; }
  applyAppearance();
  status = await invoke("status"); // waits until the engine has unlocked the device
  appearance = status.appearance;
  applyAppearance();
  if (status.session) showApp(); else showAuth();
}

start();
