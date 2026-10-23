// Origin + CSRF checks shared by HTTP routes and the WebSocket upgrade.
import type { Config } from "../config.ts";

export function originAllowed(cfg: Config, origin: string | undefined): boolean {
  if (!origin) return false;
  return cfg.allowedOrigins.includes(origin.replace(/\/$/, ""));
}
/** Double-submit: header must equal the non-HttpOnly csrf cookie (and, once logged in, the session's token). */
export function csrfOk(header: unknown, cookieToken: string | undefined, sessionToken?: string): boolean {
  if (typeof header !== "string" || !header || header !== cookieToken) return false;
  return sessionToken === undefined || header === sessionToken;
}
