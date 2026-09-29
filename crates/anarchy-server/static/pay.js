// Pay-this-invoice page. Everything shown comes from content encrypted by the
// sender's device; the key is the part of the link after "#", which browsers
// never send to the server. Nothing here uses innerHTML.
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
function ended(title, text) {
  document.title = title;
  $("sheet").replaceChildren(el("div", { class: "ended" }, el("h1", { text: title }), el("p", { class: "muted", text })));
}
const id = location.pathname.split("/").filter(Boolean)[1] || "";
const key = location.hash.slice(1);

async function open() {
  if (!key || !window.crypto?.subtle) {
    return ended("This link is incomplete", "Copy the whole link from the message you received, including the part after the #.");
  }
  let res;
  try { res = await fetch(`/p/${encodeURIComponent(id)}/sealed`, { cache: "no-store" }); }
  catch { return ended("Can't reach the server", "Check your connection and reload the page."); }
  if (!res.ok) return ended("This link has ended", "It was withdrawn or it expired. Ask whoever sent it for a new one.");
  const { sealed, claimed_paid_at_ms } = await res.json();
  let doc;
  try {
    const bytes = b64(sealed);
    const k = await crypto.subtle.importKey("raw", b64(key), "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, k, bytes.slice(12));
    doc = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return ended("This link is incomplete", "The part after the # is missing or changed. Copy the whole link from the message you received.");
  }
  render(doc, claimed_paid_at_ms);
}

function money(cents, currency) {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "EUR", minimumFractionDigits: whole ? 0 : 2 }).format(cents / 100);
}
const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" });
const asDate = (iso) => new Date(`${iso}T12:00:00`);
function initials(name) { return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join(""); }
function copyBtn(value, label) {
  return el("button", { class: "copy", type: "button", "aria-label": `Copy ${label}`, text: "Copy", onclick: async (e) => {
    try { await navigator.clipboard.writeText(value); e.target.textContent = "Copied"; } catch { e.target.textContent = "Select it"; }
  } });
}
function fact(label, value, copyable) {
  if (!value) return null;
  return el("div", {}, el("dt", { text: label }), el("dd", { class: copyable ? "mono" : "" }, el("span", { text: value }), copyable ? copyBtn(value.replace(/\s+/g, label === "IBAN" ? "" : " "), label) : null));
}

function render(d, claimedAt) {
  const from = d.from || "";
  document.title = `${d.number || "Invoice"} from ${from}`;
  const paid = d.status === "paid";
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const late = d.due && !paid ? Math.round((today - asDate(d.due)) / 864e5) : 0;
  const pay = d.pay || {};
  const kids = [
    el("div", { class: "from" }, el("span", { class: "mark", "aria-hidden": "true", text: initials(from) }),
      el("div", {}, el("strong", { text: from }), el("span", { text: d.to ? `Invoice for ${d.to}` : "Invoice" }))),
    el("p", { class: "label", text: `Invoice ${d.number || ""}`.trim() }),
    el("p", { class: "amount", text: money(d.amount, d.currency) }),
  ];
  if (paid) kids.push(el("p", { class: "due" }, el("span", { class: "pill", text: d.paid_on ? `Paid on ${dateFmt.format(asDate(d.paid_on))}` : "Paid" })));
  else if (d.due) kids.push(el("p", { class: `due${late > 0 ? " late" : ""}`, text: late > 0 ? `Due ${dateFmt.format(asDate(d.due))}, ${late} ${late === 1 ? "day" : "days"} ago` : late === 0 ? "Due today" : `Due ${dateFmt.format(asDate(d.due))}` }));
  kids.push(el("dl", { class: "facts" }, fact("Issued", d.issued ? dateFmt.format(asDate(d.issued)) : ""), fact("Invoice number", d.number)));
  if (!paid) {
    if (pay.iban) {
      kids.push(el("h2", { text: "Pay by bank transfer" }), el("dl", { class: "facts" },
        fact("To", pay.name || from), fact("IBAN", pay.iban, true), fact("BIC", pay.bic, true), fact("Reference", d.number, true), fact("Amount", (d.amount / 100).toFixed(2), true)));
    }
    if (typeof pay.url === "string" && /^https:\/\//i.test(pay.url)) {
      kids.push(el("a", { class: "btn primary", href: pay.url, rel: "noopener noreferrer", target: "_blank", text: "Pay online" }));
    }
    const status = el("div", {});
    const claimed = (at) => status.replaceChildren(el("p", { class: "note", text: `Thanks. You told ${from} it's paid${at ? ` on ${dateFmt.format(new Date(at))}` : ""}; they'll confirm when it arrives.` }));
    if (claimedAt) claimed(claimedAt);
    else {
      const btn = el("button", { class: `btn ${pay.url ? "quiet" : "primary"}`, type: "button", text: "I've paid", onclick: async () => {
        btn.disabled = true; btn.textContent = "Sending…";
        try {
          const r = await fetch(`/p/${encodeURIComponent(id)}/paid`, { method: "POST" });
          if (!r.ok) throw new Error();
          claimed(Date.now());
        } catch { btn.disabled = false; btn.textContent = "I've paid"; alert("That didn't go through. Try again in a moment."); }
      } });
      status.append(btn, el("p", { class: "fine", text: `Tells ${from} you've sent the payment. It doesn't move any money.` }));
    }
    kids.push(status);
  }
  if (d.note) kids.push(el("p", { class: "fine", text: d.note }));
  $("sheet").replaceChildren(...kids);
}

open();
