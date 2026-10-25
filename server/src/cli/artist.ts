// Admin CLI: provision AI artist accounts and their revocable per-account bearer tokens. Runs ON the server as
// www-data with the service env. The token goes ONLY to stdout when stdout is not a terminal (redirect it straight
// into a 0600 file, see scripts/artist.sh); all other output goes to stderr. Never logs the token.
//   create --handle H --name "Display" --bio "..."   create or update the artist; issue a fresh token (old ones revoked)
//   revoke --handle H                                 revoke every token/session of that artist
//   list                                              artists and whether they have a live token
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { SessionStore } from "../security/authentication.ts";
import { AccountStore } from "../persistence/accounts.ts";
import { ShareStore } from "../persistence/shares.ts";
import { SocialStore } from "../persistence/social.ts";
import { NativeStore } from "../persistence/native.ts";

export const ARTIST_HANDLES = ["lofiluna", "maestroaria", "pixelquest", "novadrift", "drdre"] as const;
export const ARTIST_TOKEN_TTL_MS = 365 * 86400_000;
export interface ArtistStores { sessions: SessionStore; accounts: AccountStore; social: SocialStore; native: NativeStore }
export const artistId = (handle: string) => `ai-${handle}`;

export function provisionArtist(st: ArtistStores, o: { handle: string; name: string; bio: string }): { user: string; token: string } {
  if (!(ARTIST_HANDLES as readonly string[]).includes(o.handle)) throw new Error(`handle must be one of ${ARTIST_HANDLES.join(", ")}`);
  const name = o.name.trim().slice(0, 40), bio = o.bio.trim().slice(0, 300); if (!name) throw new Error("--name required");
  const user = artistId(o.handle);
  st.accounts.ensureLegacy(user, Date.now() - 30 * 86400_000); // established account (not rate-limited as brand new)
  st.social.upsertArtist(user, { handle: o.handle, display_name: name, bio });
  revokeArtist(st, o.handle);
  const s = st.sessions.create(user, ARTIST_TOKEN_TTL_MS);
  return { user, token: st.sessions.cookieValue(s) };
}
export function revokeArtist(st: ArtistStores, handle: string) { const u = artistId(handle); st.sessions.destroyUser(u); st.native.revokeUser(u); }

if (process.argv[1] && /artist\.(ts|mjs)$/.test(process.argv[1])) {
  const cfg = loadConfig(); const dir = cfg.dataDir; const [cmd, ...args] = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? "" : ""; };
  const st: ArtistStores = { sessions: new SessionStore(cfg, Date.now, join(dir, "sessions.sqlite")), accounts: new AccountStore(join(dir, "accounts.sqlite")), social: new SocialStore(new ShareStore(join(dir, "shares.sqlite")).database), native: new NativeStore(join(dir, "native.sqlite")) };
  const err = (o: object) => process.stderr.write(`${JSON.stringify(o)}\n`);
  if (cmd === "create") {
    if (process.stdout.isTTY) { err({ ok: false, error: "refusing to print a token to a terminal; redirect stdout to a 0600 file" }); process.exit(2); }
    const r = provisionArtist(st, { handle: flag("--handle"), name: flag("--name"), bio: flag("--bio") });
    process.stdout.write(r.token); err({ ok: true, user: r.user, handle: flag("--handle") });
  } else if (cmd === "revoke") { revokeArtist(st, flag("--handle")); err({ ok: true, revoked: flag("--handle") }); }
  else if (cmd === "list") { for (const h of ARTIST_HANDLES) { const p = st.social.byHandle(h); err({ handle: h, exists: !!p && p.user_id === artistId(h), badge: p?.badge ?? null }); } }
  else { err({ usage: "artist create --handle H --name N --bio B | revoke --handle H | list" }); process.exit(2); }
}
