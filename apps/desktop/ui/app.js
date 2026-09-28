// Anarchy desktop UI: onboarding (workspace → join → look) and the app shell.
// Talks to the Rust side through Tauri commands; see src-tauri/src/main.rs.

const $ = (id) => document.getElementById(id);
const tauri = window.__TAURI__;
const invoke = (cmd, args) => tauri.core.invoke(cmd, args);
const media = window.matchMedia("(prefers-color-scheme: dark)");

let appearance = { display: "system", frame: "cobalt" };
let workspace = null; // { server, config } while onboarding
let status = null;

// ---------- appearance ----------

function applyAppearance() {
  const theme = appearance.display === "system" ? (media.matches ? "dark" : "light") : appearance.display;
  document.documentElement.dataset.theme = theme;
  $("frame").dataset.frame = appearance.frame;
  for (const el of document.querySelectorAll("[data-display]")) {
    el.setAttribute("aria-checked", String(el.dataset.display === appearance.display));
  }
  for (const el of document.querySelectorAll(".swatch[data-frame]")) {
    el.setAttribute("aria-checked", String(el.dataset.frame === appearance.frame));
  }
}

async function setAppearance(change) {
  appearance = { ...appearance, ...change };
  applyAppearance();
  try { await invoke("set_appearance", appearance); } catch (e) { console.warn("appearance not saved:", e); }
}

function mountAppearance(container) {
  container.replaceChildren($("appearance-template").content.cloneNode(true));
  container.addEventListener("click", (e) => {
    const display = e.target.closest("[data-display]");
    const swatch = e.target.closest(".swatch[data-frame]");
    if (display) setAppearance({ display: display.dataset.display });
    if (swatch) setAppearance({ frame: swatch.dataset.frame });
  });
}

media.addEventListener("change", () => { if (appearance.display === "system") applyAppearance(); });

// ---------- onboarding ----------

function showStep(n) {
  for (const step of document.querySelectorAll(".ob-step")) step.hidden = step.dataset.step !== String(n);
  for (const dot of document.querySelectorAll("[data-step-dot]")) {
    const d = Number(dot.dataset.stepDot);
    dot.classList.toggle("current", d === n);
    dot.classList.toggle("done", d < n);
    if (d === n) dot.setAttribute("aria-current", "step"); else dot.removeAttribute("aria-current");
  }
  const focus = { 1: "server", 2: "choose-sso", 3: "finish" }[n];
  requestAnimationFrame(() => $(focus)?.focus());
}

function showError(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
}

function initials(name) {
  const words = name.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+/u, "")).filter(Boolean);
  return words.slice(0, 2).map((w) => [...w][0].toUpperCase()).join("") || "?";
}

function hostOf(server) {
  return server.replace(/^https?:\/\//, "");
}

$("step-1").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("server-error", "");
  const button = $("server-continue");
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    workspace = await invoke("workspace_info", { server: $("server").value });
    const name = workspace.config.org_name;
    $("org-name").textContent = name;
    $("sso-org").textContent = name;
    $("org-initials").textContent = initials(name);
    $("org-server").textContent = hostOf(workspace.server);
    $("choose-guest").hidden = !workspace.config.guests_enabled;
    $("guests-off").hidden = workspace.config.guests_enabled;
    resetJoin();
    showStep(2);
  } catch (err) {
    showError("server-error", String(err));
  } finally {
    button.disabled = false;
    button.textContent = "Continue";
  }
});

function resetJoin() {
  $("join-choices").hidden = false;
  $("sso-waiting").hidden = true;
  $("sso-link-box").hidden = true;
  $("guest-form").hidden = true;
  $("join-footer").hidden = false;
  showError("join-error", "");
}

$("step-2-back").addEventListener("click", () => showStep(1));

$("choose-sso").addEventListener("click", async () => {
  showError("join-error", "");
  $("join-choices").hidden = true;
  $("join-footer").hidden = true;
  $("sso-waiting").hidden = false;
  try {
    await invoke("sign_in_sso", { server: workspace.server });
    await afterJoin();
  } catch (err) {
    resetJoin();
    if (String(err) !== "Sign-in cancelled") showError("join-error", String(err));
  }
});

$("sso-cancel").addEventListener("click", () => invoke("cancel_sign_in"));

tauri?.event?.listen("sign-in-link", (event) => {
  $("sso-link").textContent = event.payload;
  $("sso-link-box").hidden = false;
});

$("sso-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("sso-link").textContent);
    $("sso-copy").textContent = "Copied";
  } catch {
    window.getSelection().selectAllChildren($("sso-link"));
  }
});

$("choose-guest").addEventListener("click", () => {
  $("join-choices").hidden = true;
  $("join-footer").hidden = true;
  $("guest-form").hidden = false;
  showError("join-error", "");
  $("invite-code").focus();
});

$("guest-back").addEventListener("click", resetJoin);

$("guest-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("invite-code").value.trim();
  const name = $("guest-name").value.trim();
  if (!code) return showError("join-error", "Enter the invite code you were given.");
  if (!name) return showError("join-error", "Enter a name so people know who you are.");
  showError("join-error", "");
  const button = $("guest-join");
  button.disabled = true;
  button.textContent = "Joining…";
  try {
    await invoke("join_as_guest", { server: workspace.server, code, name });
    await afterJoin();
  } catch (err) {
    showError("join-error", String(err));
  } finally {
    button.disabled = false;
    button.textContent = "Join as guest";
  }
});

async function afterJoin() {
  status = await invoke("app_status");
  const s = status.session;
  $("signed-in-as").textContent = s.is_guest
    ? `You're a guest in ${s.org_name}`
    : `Signed in to ${s.org_name}`;
  showStep(3);
}

$("finish").addEventListener("click", () => showApp());

// ---------- app shell ----------

function showApp() {
  const s = status.session;
  $("onboarding").hidden = true;
  $("app").hidden = false;
  $("sidebar-title").textContent = s.org_name;
  $("rail-org").textContent = initials(s.org_name);
  $("guest-chip").hidden = !s.is_guest;
  $("guest-banner").hidden = !s.is_guest;
  $("account-name").textContent = s.display_name || (s.is_guest ? "Guest" : "Signed in");
  $("account-avatar").textContent = initials(s.display_name || s.org_name);
  $("account-server").textContent = hostOf(s.server);
  $("device-id").textContent = status.device_id;
  const saved = status.storage.kind === "saved";
  $("storage-saved").hidden = !saved;
  $("storage-temporary").hidden = saved;
  if (!saved) $("storage-reason").textContent = `Anarchy couldn't save this device: ${status.storage.reason}.`;
  if (s.is_guest && s.expires_at_ms) {
    $("guest-until").textContent = new Date(s.expires_at_ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
  showView("home");
}

function showView(view) {
  $("view-home").hidden = view !== "home";
  $("view-settings").hidden = view !== "settings";
  $("side-home").hidden = view !== "home";
  $("side-settings").hidden = view !== "settings";
  for (const b of document.querySelectorAll(".rail-btn")) {
    b.classList.toggle("active", b.dataset.view === view && (view !== "home" || b.getAttribute("aria-label") === "Home"));
  }
}

for (const b of document.querySelectorAll(".rail-btn")) b.addEventListener("click", () => showView(b.dataset.view));

$("sign-out").addEventListener("click", async () => {
  await invoke("sign_out");
  status = await invoke("app_status");
  $("app").hidden = true;
  $("onboarding").hidden = false;
  showStep(1);
});

// ---------- start ----------

async function start() {
  mountAppearance($("ob-appearance"));
  mountAppearance($("settings-appearance"));
  if (!tauri?.core) {
    document.body.textContent = "Open this page inside the Anarchy desktop app (or use ui-preview.mjs).";
    return;
  }
  status = await invoke("app_status");
  appearance = status.appearance;
  applyAppearance();
  if (status.session) {
    showApp();
  } else {
    $("onboarding").hidden = false;
    showStep(1);
  }
}

start();
