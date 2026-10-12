// Push client helpers: capability checks and key conversion. The settings row
// lives in settings.tsx; the worker itself in sw.js.
export type PushSupport = "unsupported" | "insecure" | "supported";

/** Whether this browser can receive pushes, and whether the page may use them. */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    return "unsupported";
  if (!window.isSecureContext) return "insecure";
  return "supported";
}

/** VAPID public keys travel as url-safe base64; PushManager wants bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(base64.replaceAll("-", "+").replaceAll("_", "/") + pad);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
