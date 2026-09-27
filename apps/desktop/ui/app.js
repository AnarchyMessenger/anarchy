// Phase 0 UI: theme switching and a round trip to the Rust core.
const THEME_KEY = "anarchy.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(choice) {
  const theme = choice === "system" ? (media.matches ? "dark" : "light") : choice;
  document.documentElement.dataset.theme = theme;
  for (const el of document.querySelectorAll("[data-theme-choice]")) {
    const on = el.dataset.themeChoice === choice;
    el.classList.toggle("on", on);
    el.setAttribute("aria-checked", String(on));
  }
}

function savedTheme() {
  try { return localStorage.getItem(THEME_KEY) || "system"; } catch { return "system"; }
}

for (const el of document.querySelectorAll("[data-theme-choice]")) {
  const pick = () => {
    const choice = el.dataset.themeChoice;
    try { localStorage.setItem(THEME_KEY, choice); } catch {}
    applyTheme(choice);
  };
  el.addEventListener("click", pick);
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
}
media.addEventListener("change", () => { if (savedTheme() === "system") applyTheme("system"); });
applyTheme(savedTheme());

async function loadDevice() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    document.getElementById("device-id").textContent = "not running inside the desktop app";
    return;
  }
  const info = await invoke("device_info");
  document.getElementById("device-id").textContent = info.id;
  document.getElementById("suite").textContent = info.ciphersuite;
  if (info.storage.kind === "saved") {
    document.getElementById("storage-saved").hidden = false;
  } else {
    document.getElementById("storage-reason").textContent =
      `Anarchy couldn't save this device: ${info.storage.reason}.`;
    document.getElementById("storage-temporary").hidden = false;
  }
}
loadDevice();
