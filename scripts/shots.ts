// Screenshots of every screen at 360/390/768/1280px in light and dark (DONE.md item 7).
// Also fails on horizontal page overflow, which a phone user would feel as sideways scrolling.
// Usage: bun run shots [outDir]   (default .shots/<timestamp>)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { READY, VIEWPORTS, launchChrome, screens, startSeededMe } from "./lib/browser.ts";

const out = process.argv[2] ?? join(import.meta.dir, "..", ".shots", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(out, { recursive: true });

const me = await startSeededMe();
const page = await launchChrome();
const overflow: string[] = [];
let count = 0;
try {
  for (const vp of VIEWPORTS) {
    await page.viewport(vp.width, vp.height, vp.mobile);
    for (const scheme of ["light", "dark"] as const) {
      await page.scheme(scheme);
      for (const s of screens(me)) {
        await page.open(me.url + s.hash, READY);
        const wide = await page.eval<number>("document.documentElement.scrollWidth - window.innerWidth");
        if (wide > 0) overflow.push(`${vp.name} ${s.name}: ${wide}px wider than the viewport`);
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
process.exit(overflow.length ? 1 : 0);
