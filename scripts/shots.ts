// Screenshots of every screen at 360/390/768/1280px in light and dark (DONE.md item 7).
// Also fails on horizontal page overflow, which a phone user would feel as sideways scrolling,
// and on touch targets under 44px at the touch (mobile) viewports.
// Usage: bun run shots [outDir]   (default .shots/<timestamp>)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SMALL_TARGETS, VIEWPORTS, launchChrome, screens, show, startSeededMe } from "./lib/browser.ts";

const out = process.argv[2] ?? join(import.meta.dir, "..", ".shots", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(out, { recursive: true });

const me = await startSeededMe();
const page = await launchChrome();
const overflow: string[] = [];
const small: string[] = [];
let count = 0;
try {
  for (const vp of VIEWPORTS) {
    await page.viewport(vp.width, vp.height, vp.mobile);
    for (const scheme of ["light", "dark"] as const) {
      await page.scheme(scheme);
      for (const s of screens(me)) {
        await show(page, me.url, s);
        const wide = await page.eval<number>("document.documentElement.scrollWidth - window.innerWidth");
        if (wide > 0) overflow.push(`${vp.name} ${s.name}: ${wide}px wider than the viewport`);
        if (vp.mobile) for (const t of await page.eval<string[]>(SMALL_TARGETS)) small.push(`${vp.name} ${s.name}: ${t}`);
        writeFileSync(join(out, `${vp.name}-${scheme}-${s.name}.png`), await page.png());
        count++;
      }
    }
  }
} finally {
  await page.close();
  await me.stop();
}

console.log(`${count} screenshots in ${out}`);
for (const o of [...new Set(overflow)]) console.log(`OVERFLOW ${o}`);
for (const t of [...new Set(small)]) console.log(`SMALL TARGET ${t}`);
process.exit(overflow.length || small.length ? 1 : 0);
