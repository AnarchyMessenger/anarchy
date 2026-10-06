// The pure half of the package: looks and seeds. (Drawing needs a DOM; the
// desktop preview covers it.)
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const Buddy = createRequire(import.meta.url)("./buddy.js");

const look = "s2.bot.bean.e9edf2.100.100.0.a.cat";
assert.equal(Buddy.format(Buddy.parse(look)), look, "a look survives a round trip");
assert.equal(Buddy.parse("s2.bot.bean.e9edf2.100.100.0.a").hat, "none", "headwear is optional");
assert.equal(Buddy.parse("s2.orb.calm.52c2ca.100.100.0.a").shape, "bot", "older shapes draw as a Buddy");
assert.equal(Buddy.parse("orb-ocean").color, "52c2ca", "the oldest looks keep their colour");
assert.equal(Buddy.parse("s2.bot.nope.zzzzzz.999.-5.80.q.crown").face, "calm", "unknown parts fall back");
const p = Buddy.parse("s2.bot.bean.e9edf2.999.-5.80.q");
assert.deepEqual([p.size, p.gap, p.tilt, p.ink], [160, 60, 20, "a"], "numbers are clamped");

assert.deepEqual(Buddy.seeds(look), Buddy.seeds(look), "the same look always moves the same way");
assert.notDeepEqual(Buddy.seeds(look), Buddy.seeds(look + "x"), "different looks don't move in step");
for (let i = 0; i < 200; i++) {
  const s = Buddy.seeds(`buddy-${i}`);
  assert.ok(s.blink >= 3500 && s.blink <= 6500 && s.glance >= 4200 && s.glance <= 7600);
  assert.ok(s.blinkPhase <= 0 && -s.blinkPhase <= s.blink, "a loop starts part-way through, never past its end");
}
for (let i = 0; i < 50; i++) {
  const r = Buddy.format(Buddy.random());
  assert.equal(Buddy.format(Buddy.parse(r)), r, "random looks are valid looks");
}
console.log("buddy: ok");
