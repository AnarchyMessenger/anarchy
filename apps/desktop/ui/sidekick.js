// Sidekicks: how they look, and the maker people design them with (D34).
//
// A sidekick is a body (a shape in a colour) with a face (eyes, maybe brows)
// and a state it's in: idle, listening, thinking, writing, success, alert,
// error or asleep. Its look is one short string so it fits the account
// (`sidekick_look`) and other people's apps can draw it:
//
//   s2.<shape>.<face>.<rrggbb>.<eye size %>.<eye spacing %>.<tilt °>.<ink a|b|w>
//
// Looks from before (`orb-ocean`) still draw, as an orb in that colour.
"use strict";

const SK_NS = "http://www.w3.org/2000/svg";
const SK_INK = "#1d1b18";

// Bodies in a 100×100 box. Each is filled and stroked in its colour with round
// joins, so corners come out soft. `fy` is where the eyes sit, `fw` how far
// apart they may go.
const SK_BODIES = {
  orb: { label: "Orb", fy: 54, fw: 1, d: "M50 14a38 38 0 1 1 0 76a38 38 0 1 1 0-76z" },
  drop: { label: "Drop", fy: 62, fw: .9, d: "M50 10C62 30 82 44 82 62a32 30 0 0 1-64 0C18 44 38 30 50 10z" },
  star: { label: "Star", fy: 56, fw: .8, d: "M50 12l10.6 23.4 25.4 2.6-19 17.2 5.4 25L50 67.4 27.6 80.2l5.4-25-19-17.2 25.4-2.6z" },
  peak: { label: "Peak", fy: 66, fw: .85, d: "M50 16L86 82H14z" },
  tile: { label: "Tile", fy: 54, fw: 1, d: "M24 18h52a8 8 0 0 1 8 8v52a8 8 0 0 1-8 8H24a8 8 0 0 1-8-8V26a8 8 0 0 1 8-8z" },
  heart: { label: "Heart", fy: 48, fw: .95, d: "M50 84C26 68 12 54 12 38a18 18 0 0 1 38-8a18 18 0 0 1 38 8c0 16-14 30-38 46z" },
  case: { label: "Briefcase", fy: 62, fw: 1, d: "M14 36h72a4 4 0 0 1 4 4v40a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V40a4 4 0 0 1 4-4z", extra: "M38 36v-8a4 4 0 0 1 4-4h16a4 4 0 0 1 4 4v8" },
  cloud: { label: "Cloud", fy: 60, fw: 1, d: "M30 80a18 18 0 0 1-2-35.8A22 22 0 0 1 70 38a20 20 0 0 1 2 42z" },
};

// Faces: eyes, brows, and where the eyes look. Shown as a ring in the maker.
const SK_FACES = {
  calm: { eyes: "dot" },
  grumpy: { eyes: "dot", brows: "angry" },
  open: { eyes: "hollow" },
  surprised: { eyes: "hollow", brows: "raised" },
  happy: { eyes: "caret" },
  glee: { eyes: "caret", brows: "raised" },
  plus: { eyes: "plus" },
  flat: { eyes: "line" },
  sly: { eyes: "slash" },
  squint: { eyes: "angle" },
  wide: { eyes: "ring" },
  side: { eyes: "ring", look: [1, 0] },
  peek: { eyes: "dot", look: [1, 0] },
  worried: { eyes: "ring", brows: "worried" },
  focused: { eyes: "ring", brows: "flat" },
  stern: { eyes: "ring", brows: "angry" },
  bean: { eyes: "tall" },
  wink: { eyes: "wink" },
  up: { eyes: "ring", look: [.6, -1] },
  oops: { eyes: "x" },
};

// What each state does to the face, and how it moves (see app.css, .sk-svg).
const SK_STATES = {
  idle: { label: "Idle" },
  listening: { label: "Listening", face: { eyes: "ring", look: [-1, 0] } },
  thinking: { label: "Thinking", face: { eyes: "ring", look: [.7, -1], brows: "flat" } },
  writing: { label: "Writing", face: { eyes: "dot", look: [0, 1] } },
  success: { label: "Success", face: { eyes: "caret", brows: "raised" } },
  alert: { label: "Alert", face: { eyes: "hollow", brows: "raised" } },
  error: { label: "Error", face: { eyes: "x" } },
  asleep: { label: "Asleep", face: { eyes: "line" } },
};

// Old looks named a frame colour; these are those colours' middle shades.
const SK_OLD_COLORS = { ember: "f2b48c", cobalt: "8c9dff", spring: "86dca0", summer: "ffcc4d", autumn: "ff9450", winter: "8fcaff", coral: "ff8066", ocean: "52c2ca", forest: "7fbd93", dusk: "c9a3ec" };
const SK_PALETTE = ["b07150", "f15a4a", "ff9450", "ffcc4d", "86dca0", "2fc4b2", "52c2ca", "3d8bff", "8c9dff", "a970ff", "ff7eb6", "6b6359"];

const SK_PRESETS = [
  { shape: "drop", face: "grumpy", color: "f15a4a" },
  { shape: "star", face: "calm", color: "ffcc4d" },
  { shape: "case", face: "stern", color: "b07150" },
  { shape: "peak", face: "peek", color: "3d8bff" },
  { shape: "orb", face: "focused", color: "2fc4b2" },
  { shape: "heart", face: "happy", color: "a970ff" },
  { shape: "cloud", face: "bean", color: "8fcaff" },
  { shape: "tile", face: "sly", color: "86dca0" },
];

const SK_DEFAULT = { shape: "orb", face: "calm", color: "52c2ca", size: 100, gap: 100, tilt: 0, ink: "a" };

function skParse(look) {
  const s = String(look || "");
  if (s.startsWith("s2.")) {
    const [, shape, face, color, size, gap, tilt, ink] = s.split(".");
    return {
      shape: SK_BODIES[shape] ? shape : "orb",
      face: SK_FACES[face] ? face : "calm",
      color: /^[0-9a-f]{6}$/.test(color) ? color : SK_DEFAULT.color,
      size: skClamp(+size, 60, 160, 100),
      gap: skClamp(+gap, 60, 160, 100),
      tilt: skClamp(+tilt, -20, 20, 0),
      ink: ["a", "b", "w"].includes(ink) ? ink : "a",
    };
  }
  const [, color] = s.split("-");
  return { ...SK_DEFAULT, color: SK_OLD_COLORS[color] || SK_DEFAULT.color };
}
function skClamp(v, lo, hi, dflt) { return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt; }
function skLook(p) { return ["s2", p.shape, p.face, p.color, p.size, p.gap, p.tilt, p.ink].join("."); }

// Dark ink on light bodies, white on dark ones.
function skInk(p) {
  if (p.ink === "b") return SK_INK;
  if (p.ink === "w") return "#ffffff";
  const n = parseInt(p.color, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => { c /= 255; return c <= .04 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b > .3 ? SK_INK : "#ffffff";
}

function skNode(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SK_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  for (const k of kids) if (k) n.append(k);
  return n;
}

// One eye at (0, 0); `side` is -1 for the left eye, 1 for the right.
function skEye(kind, u, ink, look, side) {
  const [lx, ly] = look || [0, 0];
  const line = (d) => skNode("path", { d, fill: "none", stroke: ink, "stroke-width": u * .42, "stroke-linecap": "round", "stroke-linejoin": "round" });
  switch (kind) {
    case "ring": return skNode("g", {}, skNode("circle", { r: u * 1.15, fill: "#fff" }), skNode("circle", { class: "sk-pupil", cx: lx * u * .42, cy: ly * u * .42, r: u * .62, fill: SK_INK }));
    case "hollow": return skNode("circle", { r: u * .62, fill: "none", stroke: ink, "stroke-width": u * .36 });
    case "caret": return line(`M${-u * .7} ${u * .35}L0 ${-u * .35}L${u * .7} ${u * .35}`);
    case "line": return line(`M${-u * .7} 0H${u * .7}`);
    case "plus": return line(`M${-u * .65} 0H${u * .65}M0 ${-u * .65}V${u * .65}`);
    case "slash": return line(`M${-u * .5} ${u * .6}L${u * .5} ${-u * .6}`);
    case "angle": return line(side < 0 ? `M${u * .45} ${-u * .6}L${-u * .45} 0L${u * .45} ${u * .6}` : `M${-u * .45} ${-u * .6}L${u * .45} 0L${-u * .45} ${u * .6}`);
    case "x": return line(`M${-u * .55} ${-u * .55}L${u * .55} ${u * .55}M${u * .55} ${-u * .55}L${-u * .55} ${u * .55}`);
    case "tall": return skNode("rect", { x: -u * .32, y: -u * .8, width: u * .64, height: u * 1.6, rx: u * .32, fill: ink });
    case "wink": return side < 0 ? skNode("circle", { cx: lx * u * .3, cy: ly * u * .3, r: u * .6, fill: ink }) : line(`M${-u * .7} 0H${u * .7}`);
    default: return skNode("circle", { cx: lx * u * .3, cy: ly * u * .3, r: u * .6, fill: ink });
  }
}
function skBrow(kind, u, ink, side) {
  if (!kind) return null;
  const y = -u * 2;
  const d = {
    // Angry brows drop toward the middle of the face, worried ones rise there.
    angry: `M${u * .9 * side} ${y - u * .35}L${-u * .7 * side} ${y + u * .3}`,
    worried: `M${u * .9 * side} ${y + u * .3}L${-u * .7 * side} ${y - u * .35}`,
    flat: `M${-u * .8} ${y}H${u * .8}`,
    raised: `M${-u * .8} ${y + u * .1}Q0 ${y - u * .7} ${u * .8} ${y + u * .1}`,
  }[kind];
  return skNode("path", { d, fill: "none", stroke: ink, "stroke-width": u * .42, "stroke-linecap": "round" });
}

// The sidekick as an <svg>. `state` changes its face; animation is CSS (only
// where the element is `.live`, so the badges next to names stay still).
function skSvg(look, state = "idle") {
  const p = typeof look === "string" || !look ? skParse(look) : look;
  const body = SK_BODIES[p.shape];
  const face = { ...SK_FACES[p.face], ...(SK_STATES[state]?.face || {}) };
  const ink = skInk(p);
  const fill = `#${p.color}`;
  const u = 5.2 * (p.size / 100);
  const gap = 12.5 * (p.gap / 100) * body.fw;
  const eyes = [-1, 1].map((side) => skNode("g", { transform: `translate(${side * gap} 0)` }, skBrow(face.brows, u, ink, side), skEye(face.eyes, u, ink, face.look, side)));
  const svg = skNode("svg", { viewBox: "0 0 100 100", class: "sk-svg", "data-state": state, "aria-hidden": "true" },
    skNode("g", { class: "sk-body" },
      skNode("path", { d: body.d, fill, stroke: fill, "stroke-width": 9, "stroke-linejoin": "round" }),
      body.extra ? skNode("path", { d: body.extra, fill: "none", stroke: fill, "stroke-width": 7, "stroke-linecap": "round" }) : null,
      skNode("g", { transform: `translate(50 ${body.fy}) rotate(${p.tilt})` }, skNode("g", { class: "sk-eyes" }, ...eyes))),
    state === "asleep" ? skNode("text", { class: "sk-z", x: 74, y: 22, fill: SK_INK }, "z") : null,
    state === "thinking" ? skNode("g", { class: "sk-dots", fill: SK_INK }, ...[0, 1, 2].map((k) => skNode("circle", { cx: 70 + k * 8, cy: 12, r: 2.6, style: `animation-delay:${k * .18}s` }))) : null);
  return svg;
}

function skRandom() {
  const pick = (o) => o[Math.floor(Math.random() * o.length)];
  return {
    shape: pick(Object.keys(SK_BODIES)), face: pick(Object.keys(SK_FACES)), color: pick(SK_PALETTE),
    size: 80 + Math.floor(Math.random() * 6) * 10, gap: 80 + Math.floor(Math.random() * 5) * 10,
    tilt: pick([0, 0, 0, -8, 8, -4, 4]), ink: "a",
  };
}

// ---------- the maker ----------
// Mounted in onboarding and in Profile settings. `get()` returns the sidekick
// ({ name, look }); `set(look)` is called on every change.
function mountSidekickMaker(root, get, set) {
  let p = skParse(get().look);
  let state = "idle";
  const h = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "text") n.textContent = v;
      else if (v != null) n.setAttribute(k, v);
    }
    for (const c of kids) if (c) n.append(c);
    return n;
  };
  const change = (next) => { p = { ...p, ...next }; set(skLook(p)); paint(); };

  const hero = h("div", { class: "skm-hero" });
  const ring = h("div", { class: "skm-ring", role: "radiogroup", "aria-label": "Face" });
  const shapes = h("div", { class: "skm-shapes", role: "radiogroup", "aria-label": "Body" });
  const shapeName = h("p", { class: "skm-shape-name" });
  const colorBtn = h("button", { class: "skm-color", type: "button", "aria-label": "Colour", "aria-haspopup": "true" });
  const colorPop = h("div", { class: "skm-color-pop panel", hidden: "" });
  const states = h("div", { class: "skm-states", role: "radiogroup", "aria-label": "State" });
  const slider = (label, key, min, max, unit) => {
    const out = h("output", { class: "skm-val" });
    const input = h("input", { type: "range", min, max, step: 1, "aria-label": label, oninput: (e) => { change({ [key]: +e.target.value }); } });
    return { row: h("label", { class: "skm-row" }, h("span", { text: label }), input, out), input, out, key, unit };
  };
  const sliders = [slider("Eye size", "size", 60, 160, " %"), slider("Eye spacing", "gap", 60, 160, " %"), slider("Tilt", "tilt", -20, 20, "°")];
  const ink = h("div", { class: "skm-seg", role: "radiogroup", "aria-label": "Ink" });
  const sizes = h("div", { class: "skm-sizes" });
  const presets = h("div", { class: "skm-presets", role: "group", "aria-label": "Start from a preset" });

  root.replaceChildren(h("div", { class: "skm" },
    h("div", { class: "skm-stage" },
      h("div", { class: "skm-orbit" }, ring, hero),
      shapes, shapeName,
      h("div", { class: "skm-bar" }, h("div", { class: "skm-color-wrap" }, colorBtn, colorPop), states),
      h("button", { class: "btn-ink inline skm-surprise", type: "button", onclick: () => change(skRandom()) }, "Surprise me")),
    h("div", { class: "skm-panel" },
      h("p", { class: "skm-head", text: "Face" }), ...sliders.map((s) => s.row),
      h("div", { class: "skm-row" }, h("span", { text: "Ink" }), ink),
      h("p", { class: "skm-head", text: "Actual sizes" }), sizes,
      h("p", { class: "skm-head", text: "Start from a preset" }), presets)));

  // Static pieces.
  const faces = Object.keys(SK_FACES);
  faces.forEach((f, k) => {
    const a = (k / faces.length) * Math.PI * 2 - Math.PI / 2;
    const b = h("button", { type: "button", role: "radio", class: "skm-face", title: f[0].toUpperCase() + f.slice(1), "aria-label": `Face: ${f}`, "data-face": f, style: `left:${50 + 44 * Math.cos(a)}%;top:${50 + 44 * Math.sin(a)}%`, onclick: () => change({ face: f }) });
    ring.append(b);
  });
  for (const s of Object.keys(SK_BODIES)) shapes.append(h("button", { type: "button", role: "radio", class: "skm-shape", "data-shape": s, "aria-label": SK_BODIES[s].label, onclick: () => change({ shape: s }) }));
  for (const c of SK_PALETTE) colorPop.append(h("button", { type: "button", class: "skm-swatch", style: `background:#${c}`, "aria-label": `#${c}`, "data-c": c, onclick: () => { change({ color: c }); colorPop.hidden = true; } }));
  const custom = h("input", { type: "color", class: "skm-custom", "aria-label": "Any colour", oninput: (e) => change({ color: e.target.value.slice(1).toLowerCase() }) });
  colorPop.append(h("label", { class: "skm-custom-row" }, custom, h("span", { text: "Any colour" })));
  colorBtn.addEventListener("click", (e) => { e.stopPropagation(); colorPop.hidden = !colorPop.hidden; });
  document.addEventListener("click", (e) => { if (!colorPop.hidden && !colorPop.contains(e.target)) colorPop.hidden = true; });
  for (const s of Object.keys(SK_STATES)) states.append(h("button", { type: "button", role: "radio", class: "skm-state", "data-state": s, onclick: () => { state = s; paint(); } }, h("span", { class: "skm-state-face" }), h("span", { text: SK_STATES[s].label })));
  for (const [v, label] of [["a", "Auto"], ["b", "Black"], ["w", "White"]]) ink.append(h("button", { type: "button", role: "radio", "data-ink": v, onclick: () => change({ ink: v }) }, label));
  for (const pr of SK_PRESETS) presets.append(h("button", { type: "button", class: "skm-preset", "aria-label": `${SK_BODIES[pr.shape].label}, ${pr.face}`, onclick: () => change({ ...SK_DEFAULT, ...pr }) }, skSvg({ ...SK_DEFAULT, ...pr })));

  function paint() {
    hero.replaceChildren(skSvg(p, state));
    hero.firstChild.classList.add("live");
    for (const b of ring.children) { b.replaceChildren(skSvg({ ...p, face: b.dataset.face, tilt: 0 })); b.setAttribute("aria-checked", String(b.dataset.face === p.face)); }
    for (const b of shapes.children) { b.replaceChildren(skSvg({ ...p, shape: b.dataset.shape, tilt: 0 })); b.setAttribute("aria-checked", String(b.dataset.shape === p.shape)); }
    shapeName.textContent = SK_BODIES[p.shape].label;
    colorBtn.style.setProperty("--c", `#${p.color}`);
    for (const b of colorPop.querySelectorAll(".skm-swatch")) b.setAttribute("aria-checked", String(b.dataset.c === p.color));
    custom.value = `#${p.color}`;
    for (const b of states.children) { b.firstChild.replaceChildren(skSvg(p, b.dataset.state)); b.setAttribute("aria-checked", String(b.dataset.state === state)); }
    for (const s of sliders) { s.input.value = p[s.key]; s.out.textContent = `${p[s.key]}${s.unit}`; }
    for (const b of ink.children) b.setAttribute("aria-checked", String(b.dataset.ink === p.ink));
    sizes.replaceChildren(...[44, 24, 14].map((px) => { const n = skSvg(p); n.style.width = n.style.height = `${px}px`; return n; }));
  }
  paint();
  return { reload() { p = skParse(get().look); paint(); } };
}
