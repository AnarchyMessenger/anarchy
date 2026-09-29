// Intake form page. The form's definition is decrypted with the key after "#"
// in the link (never sent to the server). Answers are encrypted here to the
// form's public key (ECDH P-256, HKDF-SHA256, AES-256-GCM), so only the desk
// that made the form can read them. Nothing here uses innerHTML.
"use strict";

const $ = (id) => document.getElementById(id);
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) n.append(k);
  return n;
}
function b64(s) {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function toB64(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function ended(title, text) {
  document.title = title;
  $("sheet").replaceChildren(el("div", { class: "ended" }, el("h1", { text: title }), el("p", { class: "muted", text })));
}
function initials(name) { return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join(""); }
const id = location.pathname.split("/").filter(Boolean)[1] || "";
const key = location.hash.slice(1);
const INFO = new TextEncoder().encode("anarchy intake v1");

async function open() {
  if (!key || !window.crypto?.subtle) return ended("This link is incomplete", "Copy the whole link, including the part after the #.");
  let res;
  try { res = await fetch(`/f/${encodeURIComponent(id)}/sealed`, { cache: "no-store" }); }
  catch { return ended("Can't reach the server", "Check your connection and reload the page."); }
  if (!res.ok) return ended("This form is closed", "Whoever shared it withdrew it or it expired.");
  let form;
  try {
    const bytes = b64((await res.json()).sealed);
    const k = await crypto.subtle.importKey("raw", b64(key), "AES-GCM", false, ["decrypt"]);
    form = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, k, bytes.slice(12))));
  } catch { return ended("This link is incomplete", "The part after the # is missing or changed."); }
  render(form);
}

async function seal(answers, publicB64) {
  const recipient = await crypto.subtle.importKey("raw", b64(publicB64), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: recipient }, eph.privateKey, 256);
  const hk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const aes = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: INFO }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(JSON.stringify(answers))));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const out = new Uint8Array(pub.length + iv.length + ct.length);
  out.set(pub, 0); out.set(iv, pub.length); out.set(ct, pub.length + iv.length);
  return toB64(out);
}

const TYPES = { text: "text", email: "email", phone: "tel" };
function render(f) {
  const from = f.from || "";
  document.title = f.title || "Form";
  const inputs = [];
  const fields = (f.fields || []).slice(0, 30).map((q, k) => {
    const fid = `q${k}`;
    const input = q.type === "longtext" ? el("textarea", { id: fid, maxlength: "4000" })
      : q.type === "choice" ? el("select", { id: fid }, el("option", { value: "", text: "Choose…" }), ...(q.options || []).slice(0, 20).map((o) => el("option", { value: o, text: o })))
      : el("input", { id: fid, type: TYPES[q.type] || "text", maxlength: "300", autocomplete: q.type === "email" ? "email" : q.type === "phone" ? "tel" : "off" });
    if (q.required) input.setAttribute("required", "");
    inputs.push({ q, input });
    return el("label", { class: "q", for: fid }, el("span", {}, q.label || "Question", q.required ? el("span", { class: "req", "aria-hidden": "true", text: "*" }) : null), input);
  });
  const trap = el("input", { class: "hp", tabindex: "-1", autocomplete: "off", "aria-hidden": "true", name: "website" });
  const error = el("p", { class: "err", role: "alert" });
  const btn = el("button", { class: "btn primary", type: "submit", text: "Send" });
  const form = el("form", { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    error.textContent = "";
    if (trap.value) return done(from); // bots fill hidden fields; don't tell them
    const answers = {};
    for (const { q, input } of inputs) {
      const v = input.value.trim();
      if (q.required && !v) { error.textContent = `"${q.label}" is needed.`; input.focus(); return; }
      if (v && q.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { error.textContent = "That email doesn't look right."; input.focus(); return; }
      answers[q.id || q.label] = v;
    }
    btn.disabled = true; btn.textContent = "Sending…";
    try {
      const sealed = await seal({ v: 1, answers, labels: Object.fromEntries(inputs.map(({ q }) => [q.id || q.label, q.label])), at: Date.now() }, f.public_key);
      const r = await fetch(`/f/${encodeURIComponent(id)}/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sealed }) });
      if (r.status === 404) return ended("This form is closed", "Whoever shared it withdrew it or it expired.");
      if (!r.ok) throw new Error();
      done(from);
    } catch { btn.disabled = false; btn.textContent = "Send"; error.textContent = "That didn't go through. Try again in a moment."; }
  } }, ...fields, trap, error, btn);
  $("sheet").replaceChildren(...[
    el("div", { class: "from" }, el("span", { class: "mark", "aria-hidden": "true", text: initials(from) }), el("div", {}, el("strong", { text: from }), el("span", { text: f.title || "Form" }))),
    f.intro ? el("p", { class: "intro", text: f.intro }) : null,
    form].filter(Boolean));
}
function done(from) {
  document.title = "Sent";
  $("sheet").replaceChildren(el("div", { class: "ended" }, el("h1", { text: "Sent. Thank you." }), el("p", { class: "muted", text: from ? `${from} has your answers and will get back to you.` : "Your answers were sent." })));
}

open();
