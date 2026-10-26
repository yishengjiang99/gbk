// iOS app web view (window.gbkNative): publish without the web sign-in gate (docs/social-api.md "Guest publish").
// The app injects window.gbkNative = { deviceId: "<Keychain UUID v4>", guestName: "MellowFox", ... } and may register
// webkit.messageHandlers.publish for its own native publish sheet.
type NativeWin = { gbkNative?: { deviceId?: unknown; guestName?: unknown }; webkit?: { messageHandlers?: Record<string, { postMessage: (m: unknown) => void } | undefined> } };
const w = () => window as unknown as NativeWin;
export const inNativeApp = () => typeof w().gbkNative === "object" && w().gbkNative !== null;
export interface NativePublish { projectId: string; title: string; labels: string[]; tags: string[] }
/** Hands publishing to the app's native sheet. False when not in the app or the handler is missing (use the web sheet). */
export function nativePublish(m: NativePublish): boolean {
  const h = inNativeApp() ? w().webkit?.messageHandlers?.publish : undefined;
  if (!h || typeof h.postMessage !== "function") return false;
  try { h.postMessage(m); return true; } catch { return false; }
}
/** Gets a cookie session for this device's guest account. Resolves to the final handle, or throws a user-facing Error. */
export async function ensureGuestSession(): Promise<string> {
  const n = w().gbkNative ?? {};
  if (typeof n.deviceId !== "string" || typeof n.guestName !== "string") throw new Error("Open the app's Profile tab once to get your username, then publish again.");
  const r = await fetch("/api/auth/guest/web", { method: "POST", credentials: "same-origin", headers: { "x-gbk-device": n.deviceId, "x-gbk-guest-name": n.guestName } });
  const b = await r.json().catch(() => ({})) as { me?: { handle?: string }; message?: string };
  if (!r.ok || !b.me?.handle) throw new Error(r.status === 429 ? "Too many tries. Wait a bit and publish again." : b.message ?? "Couldn't set up your guest account.");
  return b.me.handle;
}
