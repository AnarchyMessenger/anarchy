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
  // The Buddy (D40): a glossy helmet with ear pods and a dark visor the eyes glow through.
  bot: { label: "Buddy", fy: 55, fw: .95, top: 20, hw: 24, d: "M44 24h12a26 26 0 0 1 26 26v8a26 26 0 0 1-26 26H44a26 26 0 0 1-26-26v-8a26 26 0 0 1 26-26z" },
  orb: { label: "Orb", fy: 54, fw: 1, top: 10, hw: 22, d: "M50 14a38 38 0 1 1 0 76a38 38 0 1 1 0-76z" },
  drop: { label: "Drop", fy: 62, fw: .9, top: 6, hw: 9, d: "M50 10C62 30 82 44 82 62a32 30 0 0 1-64 0C18 44 38 30 50 10z" },
  star: { label: "Star", fy: 56, fw: .8, top: 8, hw: 8, d: "M50 12l10.6 23.4 25.4 2.6-19 17.2 5.4 25L50 67.4 27.6 80.2l5.4-25-19-17.2 25.4-2.6z" },
  peak: { label: "Peak", fy: 66, fw: .85, top: 12, hw: 10, d: "M50 16L86 82H14z" },
  tile: { label: "Tile", fy: 54, fw: 1, top: 14, hw: 28, d: "M24 18h52a8 8 0 0 1 8 8v52a8 8 0 0 1-8 8H24a8 8 0 0 1-8-8V26a8 8 0 0 1 8-8z" },
  heart: { label: "Heart", fy: 48, fw: .95, top: 18, hw: 24, d: "M50 84C26 68 12 54 12 38a18 18 0 0 1 38-8a18 18 0 0 1 38 8c0 16-14 30-38 46z" },
  case: { label: "Briefcase", fy: 62, fw: 1, top: 20, hw: 30, d: "M14 36h72a4 4 0 0 1 4 4v40a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V40a4 4 0 0 1 4-4z", extra: "M38 36v-8a4 4 0 0 1 4-4h16a4 4 0 0 1 4 4v8" },
  cloud: { label: "Cloud", fy: 60, fw: 1, top: 30, hw: 18, d: "M30 80a18 18 0 0 1-2-35.8A22 22 0 0 1 70 38a20 20 0 0 1 2 42z" },
};

// Headwear (D40): what sets one sidekick apart from the next. Drawn from the
// top of whatever body it sits on (`top`, `hw` in SK_BODIES).
const SK_HATS = {
  none: "None", cat: "Cat ears", dog: "Dog ears", bunny: "Bunny ears", antenna: "Antenna", phones: "Headphones",
  beanie: "Beanie", cap: "Cap", tophat: "Top hat", crown: "Crown", sprout: "Sprout", halo: "Halo",
};
// A Buddy's eyes glow; its "ink" picks the light.
const SK_GLOW = { a: "#5dffb4", b: "#6fd3ff", w: "#ffffff" };

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
  { shape: "bot", face: "bean", color: "e9edf2", hat: "cat" },
  { shape: "bot", face: "calm", color: "ff9450", hat: "antenna", ink: "b" },
  { shape: "bot", face: "happy", color: "2b2d33", hat: "phones" },
  { shape: "bot", face: "peek", color: "8c9dff", hat: "dog", ink: "w" },
  { shape: "drop", face: "grumpy", color: "f15a4a" },
  { shape: "star", face: "calm", color: "ffcc4d" },
  { shape: "case", face: "stern", color: "b07150" },
  { shape: "peak", face: "peek", color: "3d8bff" },
  { shape: "orb", face: "focused", color: "2fc4b2" },
  { shape: "heart", face: "happy", color: "a970ff" },
  { shape: "cloud", face: "bean", color: "8fcaff" },
  { shape: "tile", face: "sly", color: "86dca0" },
];

const SK_DEFAULT = { shape: "orb", face: "calm", color: "52c2ca", size: 100, gap: 100, tilt: 0, ink: "a", hat: "none" };
// What a new sidekick starts as: the Buddy with cat ears.
const SK_BUDDY = { ...SK_DEFAULT, shape: "bot", face: "bean", color: "e9edf2", hat: "cat" };

function skParse(look) {
  const s = String(look || "");
  if (s.startsWith("s2.")) {
    const [, shape, face, color, size, gap, tilt, ink, hat] = s.split(".");
    return {
      shape: SK_BODIES[shape] ? shape : "orb",
      face: SK_FACES[face] ? face : "calm",
      color: /^[0-9a-f]{6}$/.test(color) ? color : SK_DEFAULT.color,
      size: skClamp(+size, 60, 160, 100),
      gap: skClamp(+gap, 60, 160, 100),
      tilt: skClamp(+tilt, -20, 20, 0),
      ink: ["a", "b", "w"].includes(ink) ? ink : "a",
      hat: SK_HATS[hat] ? hat : "none",
    };
  }
  const [, color] = s.split("-");
  return { ...SK_DEFAULT, color: SK_OLD_COLORS[color] || SK_DEFAULT.color };
}
function skClamp(v, lo, hi, dflt) { return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt; }
function skLook(p) { return ["s2", p.shape, p.face, p.color, p.size, p.gap, p.tilt, p.ink, ...(p.hat && p.hat !== "none" ? [p.hat] : [])].join("."); }

// Dark ink on light bodies, white on dark ones.
function skInk(p) {
  if (p.shape === "bot") return SK_GLOW[p.ink] || SK_GLOW.a;
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

// The sidekick as an <svg>. Geometry that people tune (eye size, spacing,
// tilt, colour) is set as CSS on stable groups, so a live sidekick can change
// in place and glide there (see skPatch). `state` changes its face; animation
// is CSS, only where the element is `.live`, so badges next to names stay still.
const SK_U = 5.2;
function skFaceOf(p, state) { return { ...SK_FACES[p.face], ...(SK_STATES[state]?.face || {}) }; }
function skEyesInner(face, ink) {
  return [-1, 1].map((side) => skNode("g", { class: "sk-eye", "data-side": side }, skBrow(face.brows, SK_U, ink, side), skEye(face.eyes, SK_U, ink, face.look, side)));
}
// The Buddy's helmet details: ear pods, a gloss, the visor.
function skDeco(p) {
  if (p.shape !== "bot") return [];
  return [
    ...[14, 86].map((cx) => skNode("g", {}, skNode("circle", { class: "sk-tint sk-dark", cx, cy: 56, r: 9 }), skNode("circle", { cx, cy: 56, r: 4.5, fill: "#2b2d33", opacity: .55 }))),
    skNode("ellipse", { cx: 38, cy: 33, rx: 13, ry: 6, fill: "#fff", opacity: .45, transform: "rotate(-14 38 33)" }),
    skNode("rect", { x: 26, y: 39, width: 48, height: 31, rx: 13, fill: "#16181d" }),
    skNode("path", { d: "M33 42h22", stroke: "#fff", "stroke-width": 2, "stroke-linecap": "round", opacity: .16 }),
  ];
}
function skHat(p) {
  const b = SK_BODIES[p.shape], t = b.top, h = b.hw, back = [], front = [];
  const accent = p.shape === "bot" ? skInk(p) : "#ff5a36";
  const N = (tag, a) => skNode(tag, a);
  switch (p.hat) {
    case "cat":
      for (const s of [-1, 1]) {
        const x = 50 + s * h;
        back.push(N("path", { class: "sk-tint", d: `M${x - s * 2} ${t + 14}L${x + s * 4} ${t - 13}L${x - s * 16} ${t + 4}Z`, "stroke-linejoin": "round", "stroke-width": 4 }));
        back.push(N("path", { d: `M${x} ${t + 8}L${x + s * 2.5} ${t - 6}L${x - s * 9} ${t + 3}Z`, fill: "#ffb3c7" }));
      }
      break;
    case "dog":
      for (const s of [-1, 1]) front.push(N("ellipse", { class: "sk-tint sk-dark", cx: 50 + s * (h + 3), cy: t + 17, rx: 7, ry: 15, transform: `rotate(${s * 24} ${50 + s * (h + 3)} ${t + 17})` }));
      break;
    case "bunny":
      for (const s of [-1, 1]) {
        back.push(N("ellipse", { class: "sk-tint", cx: 50 + s * 10, cy: t - 12, rx: 6.5, ry: 17, transform: `rotate(${s * 10} ${50 + s * 10} ${t - 12})` }));
        back.push(N("ellipse", { cx: 50 + s * 10, cy: t - 11, rx: 3, ry: 12, fill: "#ffb3c7", transform: `rotate(${s * 10} ${50 + s * 10} ${t - 11})` }));
      }
      break;
    case "antenna":
      back.push(N("path", { d: `M50 ${t + 6}L52 ${t - 10}L62 ${t - 16}`, fill: "none", stroke: "#2b2d33", "stroke-width": 2.6, "stroke-linecap": "round", "stroke-linejoin": "round" }));
      front.push(N("circle", { class: "sk-glowball", cx: 63, cy: t - 17, r: 5, fill: accent }));
      break;
    case "phones":
      back.push(N("path", { d: `M${50 - h - 6} ${t + 22}C${50 - h - 6} ${t - 12} ${50 + h + 6} ${t - 12} ${50 + h + 6} ${t + 22}`, fill: "none", stroke: "#2b2d33", "stroke-width": 5, "stroke-linecap": "round" }));
      for (const s of [-1, 1]) front.push(N("rect", { x: 50 + s * (h + 6) - 5, y: t + 16, width: 10, height: 18, rx: 5, fill: "#2b2d33" }), N("rect", { x: 50 + s * (h + 6) - 2.5, y: t + 20, width: 5, height: 10, rx: 2.5, fill: accent }));
      break;
    case "beanie":
      front.push(N("path", { d: `M${50 - h - 3} ${t + 12}Q50 ${t - 24} ${50 + h + 3} ${t + 12}Z`, fill: "#e8574b" }), N("rect", { x: 50 - h - 4, y: t + 8, width: 2 * h + 8, height: 7, rx: 3.5, fill: "#c9443a" }), N("circle", { cx: 50, cy: t - 9, r: 5, fill: "#fff" }));
      break;
    case "cap":
      front.push(N("path", { d: `M${50 - h + 1} ${t + 11}Q50 ${t - 18} ${50 + h - 1} ${t + 11}Z`, fill: "#3d8bff" }), N("path", { d: `M50 ${t + 8}h${h + 14}a3.5 3.5 0 0 1 0 7H50z`, fill: "#2f6fd6" }), N("circle", { cx: 50, cy: t - 3, r: 2, fill: "#2f6fd6" }));
      break;
    case "tophat":
      front.push(N("rect", { x: 31, y: t - 2, width: 38, height: 5, rx: 2.5, fill: "#1d1b18" }), N("rect", { x: 37, y: t - 27, width: 26, height: 26, rx: 3, fill: "#1d1b18" }), N("rect", { x: 37, y: t - 8, width: 26, height: 4, fill: "#e8574b" }));
      break;
    case "crown":
      front.push(N("path", { d: `M36 ${t + 3}L35 ${t - 12}L43 ${t - 4}L50 ${t - 16}L57 ${t - 4}L65 ${t - 12}L64 ${t + 3}Z`, fill: "#ffcc4d", stroke: "#e0a800", "stroke-width": 1.5, "stroke-linejoin": "round" }), N("circle", { cx: 50, cy: t - 2, r: 2.2, fill: "#e8574b" }));
      break;
    case "sprout":
      front.push(N("path", { d: `M50 ${t + 3}V${t - 9}`, stroke: "#3f9a4d", "stroke-width": 2.4, "stroke-linecap": "round" }), N("ellipse", { cx: 44, cy: t - 11, rx: 7, ry: 3.6, fill: "#5fbf6a", transform: `rotate(-25 44 ${t - 11})` }), N("ellipse", { cx: 56, cy: t - 13, rx: 7, ry: 3.6, fill: "#5fbf6a", transform: `rotate(25 56 ${t - 13})` }));
      break;
    case "halo":
      back.push(N("ellipse", { cx: 50, cy: t - 9, rx: 17, ry: 4.5, fill: "none", stroke: "#ffd84d", "stroke-width": 3 }));
      break;
  }
  return { back, front };
}
// Fills what's drawn in the sidekick's colour; makes room above for headwear.
function skDress(svg, p) {
  const { back, front } = skHat(p);
  svg.querySelector(".sk-hat-back").replaceChildren(...back);
  svg.querySelector(".sk-hat-front").replaceChildren(...front);
  svg.querySelector(".sk-deco").replaceChildren(...skDeco(p));
  svg.querySelector(".sk-fit").setAttribute("transform", p.hat && p.hat !== "none" ? "translate(50 60) scale(.84) translate(-50 -60)" : "");
}
function skGeometry(svg, p) {
  const body = SK_BODIES[p.shape];
  const gap = 12.5 * (p.gap / 100) * body.fw;
  const k = p.size / 100;
  const fill = `#${p.color}`;
  for (const n of svg.querySelectorAll(".sk-shape, .sk-extra")) { n.style.fill = n.classList.contains("sk-extra") ? "none" : fill; n.style.stroke = fill; }
  for (const n of svg.querySelectorAll(".sk-tint")) { n.style.fill = fill; n.style.stroke = fill; }
  svg.style.setProperty("--glow", skInk(p));
  svg.querySelector(".sk-anchor").style.transform = `translate(50px, ${body.fy}px) rotate(${p.tilt}deg)`;
  for (const e of svg.querySelectorAll(".sk-eye")) e.style.transform = `translate(${e.dataset.side * gap}px, 0) scale(${k})`;
}
function skSvg(look, state = "idle") {
  const p = typeof look === "string" || !look ? skParse(look) : look;
  const body = SK_BODIES[p.shape];
  const svg = skNode("svg", { viewBox: "0 0 100 100", class: "sk-svg", "data-state": state, "data-shape": p.shape, "aria-hidden": "true" },
    skNode("g", { class: "sk-body" },
      skNode("g", { class: "sk-squash" }, skNode("g", { class: "sk-fit" },
        skNode("g", { class: "sk-hat-back" }),
        skNode("path", { class: "sk-shape", d: body.d, "stroke-width": 9, "stroke-linejoin": "round" }),
        skNode("path", { class: "sk-extra", d: body.extra || "", "stroke-width": 7, "stroke-linecap": "round" }),
        skNode("g", { class: "sk-deco" }),
        skNode("g", { class: "sk-anchor" }, skNode("g", { class: "sk-look" }, skNode("g", { class: "sk-eyes" }, ...skEyesInner(skFaceOf(p, state), skInk(p))))),
        skNode("g", { class: "sk-hat-front" })))),
    skNode("text", { class: "sk-z", x: 74, y: 22, fill: SK_INK }, "z"),
    skNode("g", { class: "sk-dots", fill: SK_INK }, ...[0, 1, 2].map((k) => skNode("circle", { cx: 70 + k * 8, cy: 12, r: 2.6, style: `animation-delay:${k * .18}s` }))));
  svg._sk = { p, state, faceKey: skFaceKey(p, state) };
  skDress(svg, p);
  skGeometry(svg, p);
  return svg;
}
function skFaceKey(p, state) { const f = skFaceOf(p, state); return `${f.eyes}|${f.brows || ""}|${(f.look || []).join(",")}|${skInk(p)}`; }

// Changes a sidekick in place: colour fades, eyes glide, a new face arrives
// behind a blink, a new body squashes in.
function skPatch(svg, look, state = svg._sk.state) {
  const p = typeof look === "string" ? skParse(look) : look;
  const was = svg._sk;
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  svg.dataset.state = state;
  if (p.shape !== was.p.shape) {
    const body = SK_BODIES[p.shape];
    const swap = () => { svg.querySelector(".sk-shape").setAttribute("d", body.d); svg.querySelector(".sk-extra").setAttribute("d", body.extra || ""); svg.dataset.shape = p.shape; skDress(svg, p); skGeometry(svg, p); };
    if (calm) swap(); else { skKick(svg, "sk-pop"); setTimeout(swap, 110); }
  } else if (p.hat !== was.p.hat || (p.shape === "bot" && p.ink !== was.p.ink)) {
    skDress(svg, p);
    if (!calm && p.hat !== was.p.hat) skKick(svg, "sk-squish");
  }
  const key = skFaceKey(p, state);
  if (key !== was.faceKey) {
    const eyes = svg.querySelector(".sk-eyes");
    const swap = () => { eyes.replaceChildren(...skEyesInner(skFaceOf(p, state), skInk(p))); skGeometry(svg, svg._sk.p); };
    if (calm) swap(); else { eyes.classList.add("sk-shut"); setTimeout(() => { swap(); eyes.classList.remove("sk-shut"); }, 90); }
  }
  svg._sk = { p, state, faceKey: key };
  skGeometry(svg, p);
}
// Restarts a one-shot animation class.
function skKick(svg, cls) {
  const g = svg.querySelector(".sk-squash");
  g.classList.remove(cls); void g.getBoundingClientRect(); g.classList.add(cls);
  g.addEventListener("animationend", () => g.classList.remove(cls), { once: true });
}

// A sidekick that's alive: its eyes follow the pointer and wander when nobody
// moves, it squishes under the pointer and hops when clicked (D36).
function skLive(look, state = "idle", { track = true, react = true } = {}) {
  const svg = skSvg(look, state);
  svg.classList.add("live");
  const lookG = svg.querySelector(".sk-look");
  let tx = 0, ty = 0, x = 0, y = 0, lastMove = 0, raf = 0, glance = 0;
  const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const frame = () => {
    raf = 0;
    if (!svg.isConnected) return;
    x += (tx - x) * .18; y += (ty - y) * .18;
    lookG.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
    if (Math.abs(tx - x) + Math.abs(ty - y) > .02) raf = requestAnimationFrame(frame);
  };
  const aim = (nx, ny) => { tx = nx; ty = ny; if (!raf) raf = requestAnimationFrame(frame); };
  const onMove = (e) => {
    if (!svg.isConnected) return removeEventListener("pointermove", onMove);
    if (calm()) return;
    const r = svg.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height * .55);
    const d = Math.hypot(dx, dy) || 1, reach = Math.min(1, d / 260);
    lastMove = Date.now();
    aim((dx / d) * 3.2 * reach, (dy / d) * 2.4 * reach);
  };
  if (track) addEventListener("pointermove", onMove, { passive: true });
  // Left alone, it glances around now and then.
  const wander = () => {
    if (!svg.isConnected) return;
    if (!calm() && Date.now() - lastMove > 2500) {
      const r = Math.random();
      if (r < .55) aim((Math.random() * 2 - 1) * 3, (Math.random() * 2 - 1.2) * 2); else aim(0, 0);
    }
    glance = setTimeout(wander, 1400 + Math.random() * 2600);
  };
  glance = setTimeout(wander, 1800);
  if (react) {
    svg.addEventListener("pointerenter", () => { if (!calm()) skKick(svg, "sk-squish"); });
    svg.addEventListener("click", () => {
      if (calm()) return;
      const s = svg._sk.state, prev = svg._sk.p;
      skKick(svg, "sk-jump");
      if (s === "idle") { skPatch(svg, prev, "success"); setTimeout(() => svg.isConnected && skPatch(svg, prev, "idle"), 900); }
    });
  }
  return svg;
}

function skRandom() {
  const pick = (o) => o[Math.floor(Math.random() * o.length)];
  return {
    shape: pick(Object.keys(SK_BODIES)), face: pick(Object.keys(SK_FACES)), color: pick(SK_PALETTE),
    size: 80 + Math.floor(Math.random() * 6) * 10, gap: 80 + Math.floor(Math.random() * 5) * 10,
    tilt: pick([0, 0, 0, -8, 8, -4, 4]), ink: "a",
    hat: Math.random() < .7 ? pick(Object.keys(SK_HATS).filter((h) => h !== "none")) : "none",
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
  const change = (next, how) => { p = { ...p, ...next }; set(skLook(p)); paint(how); };

  const hero = h("div", { class: "skm-hero" });
  const ring = h("div", { class: "skm-ring", role: "radiogroup", "aria-label": "Face" });
  const shapes = h("div", { class: "skm-shapes", role: "radiogroup", "aria-label": "Body" });
  const shapeName = h("p", { class: "skm-shape-name" });
  const hats = h("div", { class: "skm-hats", role: "radiogroup", "aria-label": "Headwear" });
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
      shapes, shapeName, hats,
      h("div", { class: "skm-bar" }, h("div", { class: "skm-color-wrap" }, colorBtn, colorPop), states),
      h("button", { class: "btn-ink inline skm-surprise", type: "button", onclick: () => { if (heroSvg) skKick(heroSvg, "sk-spin"); change(skRandom()); } }, "Surprise me")),
    h("div", { class: "skm-panel" },
      h("p", { class: "skm-head", text: "Face" }), ...sliders.map((s) => s.row),
      h("div", { class: "skm-row" }, h("span", { text: "Ink" }), ink),
      h("p", { class: "skm-head", text: "Actual sizes" }), sizes,
      h("p", { class: "skm-head", text: "Start from a preset" }), presets)));

  // Static pieces.
  const faces = Object.keys(SK_FACES);
  faces.forEach((f, k) => {
    const a = (k / faces.length) * Math.PI * 2 - Math.PI / 2;
    const b = h("button", { type: "button", role: "radio", class: "skm-face", title: f[0].toUpperCase() + f.slice(1), "aria-label": `Face: ${f}`, "data-face": f, style: `left:${50 + 44 * Math.cos(a)}%;top:${50 + 44 * Math.sin(a)}%;--i:${k}`, onclick: () => change({ face: f }),
      // Hovering a face tries it on.
      onpointerenter: () => heroSvg && skPatch(heroSvg, { ...p, face: f }, state), onpointerleave: () => heroSvg && skPatch(heroSvg, p, state) });
    ring.append(b);
  });
  Object.keys(SK_BODIES).forEach((s, k) => shapes.append(h("button", { type: "button", role: "radio", class: "skm-shape", "data-shape": s, "aria-label": SK_BODIES[s].label, style: `--i:${k}`, onclick: () => change({ shape: s }) })));
  for (const c of SK_PALETTE) colorPop.append(h("button", { type: "button", class: "skm-swatch", style: `background:#${c}`, "aria-label": `#${c}`, "data-c": c, onclick: () => { change({ color: c }); colorPop.hidden = true; } }));
  const custom = h("input", { type: "color", class: "skm-custom", "aria-label": "Any colour", oninput: (e) => change({ color: e.target.value.slice(1).toLowerCase() }) });
  colorPop.append(h("label", { class: "skm-custom-row" }, custom, h("span", { text: "Any colour" })));
  colorBtn.addEventListener("click", (e) => { e.stopPropagation(); colorPop.hidden = !colorPop.hidden; });
  document.addEventListener("click", (e) => { if (!colorPop.hidden && !colorPop.contains(e.target)) colorPop.hidden = true; });
  for (const s of Object.keys(SK_STATES)) states.append(h("button", { type: "button", role: "radio", class: "skm-state", "data-state": s, onclick: () => { state = s; paint(); } }, h("span", { class: "skm-state-face" }), h("span", { text: SK_STATES[s].label })));
  for (const [v, label] of [["a", "Auto"], ["b", "Black"], ["w", "White"]]) ink.append(h("button", { type: "button", role: "radio", "data-ink": v, "data-label": label, onclick: () => change({ ink: v }) }, label));
  Object.keys(SK_HATS).forEach((k, i) => hats.append(h("button", { type: "button", role: "radio", class: "skm-hat", "data-hat": k, title: SK_HATS[k], "aria-label": SK_HATS[k], style: `--i:${i}`, onclick: () => change({ hat: k }),
    onpointerenter: () => heroSvg && skPatch(heroSvg, { ...p, hat: k }, state), onpointerleave: () => heroSvg && skPatch(heroSvg, p, state) })));
  for (const pr of SK_PRESETS) presets.append(h("button", { type: "button", class: "skm-preset", "aria-label": `${SK_BODIES[pr.shape].label}, ${pr.face}`, onclick: () => change({ ...SK_DEFAULT, ...pr }) }, skSvg({ ...SK_DEFAULT, ...pr })));

  let heroSvg = null, thumbs = 0;
  // The big one changes in place; the small ones are redrawn at most once a frame.
  function paint() {
    if (!heroSvg) { heroSvg = skLive(p, state); hero.replaceChildren(heroSvg); } else skPatch(heroSvg, p, state);
    shapeName.textContent = SK_BODIES[p.shape].label;
    colorBtn.style.setProperty("--c", `#${p.color}`);
    for (const b of colorPop.querySelectorAll(".skm-swatch")) b.setAttribute("aria-checked", String(b.dataset.c === p.color));
    custom.value = `#${p.color}`;
    for (const s of sliders) { s.input.value = p[s.key]; s.out.textContent = `${p[s.key]}${s.unit}`; }
    for (const b of ink.children) b.setAttribute("aria-checked", String(b.dataset.ink === p.ink));
    // A Buddy's eyes glow: the same control picks the light.
    const bot = p.shape === "bot";
    ink.previousElementSibling.textContent = bot ? "Glow" : "Ink";
    for (const b of ink.children) b.textContent = bot ? { a: "Mint", b: "Sky", w: "White" }[b.dataset.ink] : b.dataset.label;
    for (const b of hats.children) b.setAttribute("aria-checked", String(b.dataset.hat === p.hat));
    for (const b of ring.children) b.setAttribute("aria-checked", String(b.dataset.face === p.face));
    for (const b of shapes.children) b.setAttribute("aria-checked", String(b.dataset.shape === p.shape));
    for (const b of states.children) b.setAttribute("aria-checked", String(b.dataset.state === state));
    if (!thumbs) thumbs = requestAnimationFrame(paintThumbs);
  }
  function paintThumbs() {
    thumbs = 0;
    for (const b of ring.children) b.replaceChildren(skSvg({ ...p, face: b.dataset.face, tilt: 0 }));
    for (const b of shapes.children) b.replaceChildren(skSvg({ ...p, shape: b.dataset.shape, tilt: 0 }));
    for (const b of hats.children) b.replaceChildren(skSvg({ ...p, hat: b.dataset.hat, tilt: 0 }));
    for (const b of states.children) b.firstChild.replaceChildren(skSvg(p, b.dataset.state));
    sizes.replaceChildren(...[44, 24, 14].map((px) => { const n = skSvg(p); n.style.width = n.style.height = `${px}px`; return n; }));
  }
  paint();
  root.querySelector(".skm").classList.add("enter");
  return { reload() { p = skParse(get().look); paint(); } };
}
