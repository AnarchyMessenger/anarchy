// Open demo.html straight from disk; no server or build needed.
const hero = Buddy.live(Buddy.format(Buddy.DEFAULT));
hero.classList.add("hero");
document.getElementById("hero").append(hero);
for (let i = 0; i < 24; i++) document.getElementById("crowd").append(Buddy.svg(Buddy.format(Buddy.random())));
for (const s of Object.keys(Buddy.STATES)) {
  const f = document.createElement("figure");
  const cap = document.createElement("figcaption");
  cap.textContent = Buddy.STATES[s].label;
  f.append(Buddy.live(Buddy.format(Buddy.DEFAULT), s, { track: false }), cap);
  document.getElementById("states").append(f);
}
let look = Buddy.format(Buddy.DEFAULT);
Buddy.maker(document.getElementById("maker"), () => ({ look }), (next) => { look = next; Buddy.patch(hero, next); });
