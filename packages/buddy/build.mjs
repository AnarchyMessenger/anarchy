#!/usr/bin/env node
// Copies the package into the desktop app, which serves its UI as plain
// files (no bundler). CI runs this and fails if the copy differs from what's
// committed, so the app always ships exactly this package.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const into = join(here, "../../apps/desktop/ui/buddy");
mkdirSync(into, { recursive: true });
for (const f of ["buddy.js", "buddy.css"]) copyFileSync(join(here, f), join(into, f));
console.log("buddy → apps/desktop/ui/buddy");
