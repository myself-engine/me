// Accessibility check of every screen with axe-core at phone and desktop widths (DONE.md item 8).
// Exit code 0 = no violations. Usage: bun run a11y [--json]
import { readFileSync } from "node:fs";
import { VIEWPORTS, launchChrome, screens, show, startSeededMe } from "./lib/browser.ts";

const axe = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const me = await startSeededMe();
const page = await launchChrome();
type Hit = { viewport: string; scheme: string; screen: string; id: string; impact: string; help: string; targets: string[] };
const hits: Hit[] = [];
try {
  for (const vp of VIEWPORTS.filter((v) => v.name === "390" || v.name === "1280")) {
    await page.viewport(vp.width, vp.height, vp.mobile);
    for (const scheme of ["light", "dark"] as const) {
      await page.scheme(scheme);
      for (const s of screens(me)) {
        await show(page, me.url, s);
        await page.eval(axe);
        const violations = await page.eval<any[]>(
          "axe.run(document, { resultTypes: ['violations'] }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 5).map(n => n.target.join(' ')) })))",
        );
        for (const v of violations) hits.push({ viewport: vp.name, scheme, screen: s.name, ...v });
      }
    }
  }
} finally {
  await page.close();
  await me.stop();
}

if (process.argv.includes("--json")) console.log(JSON.stringify(hits, null, 2));
else {
  // Group identical rules so one broken component does not print 16 times.
  const byRule = new Map<string, Hit[]>();
  for (const h of hits) byRule.set(h.id, [...(byRule.get(h.id) ?? []), h]);
  for (const [id, hs] of byRule) {
    console.log(`${hs[0]!.impact?.toUpperCase()}  ${id}: ${hs[0]!.help}`);
    console.log(`  where: ${[...new Set(hs.map((h) => `${h.viewport}/${h.scheme}/${h.screen}`))].join(", ")}`);
    console.log(`  e.g.:  ${[...new Set(hs.flatMap((h) => h.targets))].slice(0, 4).join(" | ")}`);
  }
  console.log(hits.length ? `\n${byRule.size} rule(s) violated` : "no violations");
}
process.exit(hits.length ? 1 : 0);
