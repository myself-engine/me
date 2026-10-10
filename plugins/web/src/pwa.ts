// Add-to-home-screen basics: a web manifest and SVG icons. No service worker; API data is never cached.
// Colors mirror the tokens in ui/app.css (--bg, --accent, --accent-text and their dark variants).

export const COLORS = {
  bg: "#f7f7f5",
  bgDark: "#161615",
  accent: "#3b5bdb",
  accentText: "#ffffff",
} as const;

export const manifest = {
  name: "me",
  short_name: "me",
  start_url: "/",
  scope: "/",
  display: "standalone",
  lang: "ko",
  background_color: COLORS.bg,
  theme_color: COLORS.bg,
  icons: [
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
  ],
};

// "any": rounded tile. "maskable": full-bleed so the platform mask never cuts the glyph (it sits in the 80% safe zone).
const glyph = `<text x="256" y="300" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="200" font-weight="700" fill="${COLORS.accentText}">me</text>`;
export const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="${COLORS.accent}"/>${glyph}</svg>`;
export const maskableIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${COLORS.accent}"/>${glyph}</svg>`;

/** Static PWA files by path, or null when the path is not one of them. */
export function pwaResponse(pathname: string): Response | null {
  const headers = { "cache-control": "no-cache" };
  if (pathname === "/manifest.webmanifest")
    return new Response(JSON.stringify(manifest), { headers: { ...headers, "content-type": "application/manifest+json" } });
  if (pathname === "/icon.svg") return new Response(iconSvg, { headers: { ...headers, "content-type": "image/svg+xml" } });
  if (pathname === "/icon-maskable.svg") return new Response(maskableIconSvg, { headers: { ...headers, "content-type": "image/svg+xml" } });
  return null;
}
