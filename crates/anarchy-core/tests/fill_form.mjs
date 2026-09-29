// Fills in an intake form in a real browser: node fill_form.mjs <url>
// Used by intake_forms.rs when ANARCHY_BROWSER_TEST=1 (needs Playwright).
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 760 } });
const shot = (n) => process.env.FORM_SHOTS && page.screenshot({ path: `${process.env.FORM_SHOTS}/${n}.png`, fullPage: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(process.argv[2]);
await page.waitForSelector("form");
await page.fill("#q0", "Camille Roux");
await page.fill("#q1", "camille@example.fr");
await shot("form-page");
await page.click('button[type="submit"]');
await page.waitForSelector("text=Sent. Thank you.", { timeout: 10000 });
await shot("form-sent");
await browser.close();
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
