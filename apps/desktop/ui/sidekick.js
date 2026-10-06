// The app's names for the Buddy package (packages/buddy, loaded before this
// as buddy/buddy.js). Everything about how a sidekick looks and moves lives
// there; this file only maps the names app.js and summon.js use.
"use strict";

const { svg: skSvg, live: skLive, patch: skPatch, format: skLook, parse: skParse, kick: skKick, random: skRandom, maker: mountSidekickMaker } = Buddy;
const SK_DEFAULT = Buddy.DEFAULT;
// What a new sidekick starts as: a white Buddy with cat ears.
const SK_BUDDY = Buddy.DEFAULT;
