// Admin-only CLI for signed-in prod smoke tests. Runs ON the server as www-data with the service env loaded.
//   create  --out FILE         dedicated test user "zz-smoke-<rand>" + 1 h session; token written to FILE (0600), never printed
//   admin-session --out FILE   10-min session for the first COMPOSER_ADMIN_USERS account (admin-queue checks only)
//   revoke  --in FILE          destroy the session whose token is in FILE, then delete FILE
//   delete  USER               delete the test user and all their data (songs, social rows, devices, sessions, account)
//   check   USER               counts of remaining rows for USER (expects all 0 after delete)
// Only "zz-smoke-" users can be created or deleted.
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../config.ts";
import { SessionStore } from "../security/authentication.ts";
import { AccountStore } from "../persistence/accounts.ts";
import { ShareStore } from "../persistence/shares.ts";
import { SocialStore } from "../persistence/social.ts";
import { NativeStore } from "../persistence/native.ts";

const cfg = loadConfig(); const dir = cfg.dataDir;
const [cmd, ...args] = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const PREFIX = "zz-smoke-";
const out = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);
const stores = () => ({ sessions: new SessionStore(cfg, Date.now, join(dir, "sessions.sqlite")), accounts: new AccountStore(join(dir, "accounts.sqlite")), shares: new ShareStore(join(dir, "shares.sqlite")), native: new NativeStore(join(dir, "native.sqlite")) });
const writeSecret = (file: string, v: string) => writeFileSync(file, v, { mode: 0o600 });

if (cmd === "create") {
  const file = flag("--out"); if (!file) throw new Error("--out FILE required");
  const st = stores(); const user = `${PREFIX}${randomBytes(4).toString("hex")}`;
  st.accounts.ensureLegacy(user, Date.now() - 30 * 86400_000);
  new SocialStore(st.shares.database).ensureProfile(user, "Smoke Test");
  const s = st.sessions.create(user, 3_600_000); writeSecret(file, st.sessions.cookieValue(s));
  out({ ok: true, user });
} else if (cmd === "admin-session") {
  const file = flag("--out"); if (!file) throw new Error("--out FILE required");
  const admin = cfg.adminUsers[0]; if (!admin) throw new Error("no COMPOSER_ADMIN_USERS");
  const st = stores(); const s = st.sessions.create(admin, 600_000); writeSecret(file, st.sessions.cookieValue(s));
  out({ ok: true, admin: true });
} else if (cmd === "revoke") {
  const file = flag("--in"); if (!file) throw new Error("--in FILE required");
  const st = stores(); const tok = readFileSync(file, "utf8").trim(); const id = st.sessions.idOf(tok);
  if (id) { st.sessions.destroy(id); st.native.revokeSession(id); } unlinkSync(file); out({ ok: true, revoked: !!id });
} else if (cmd === "delete" || cmd === "check") {
  const user = args[0]; if (!user?.startsWith(PREFIX)) throw new Error(`only ${PREFIX}* users`);
  const st = stores();
  if (cmd === "delete") { st.shares.deleteOwner(user); new SocialStore(st.shares.database).purgeUser(user); st.native.purgeUser(user); st.sessions.destroyUser(user); st.accounts.delete(user); }
  const n = (file: string, sql: string, ...p: string[]) => { const db = new DatabaseSync(join(dir, file)); try { return Number((db.prepare(sql).get(...p) as { n: number }).n); } finally { db.close(); } };
  out({ ok: true, user, remaining: {
    account: n("accounts.sqlite", "SELECT COUNT(*) AS n FROM accounts WHERE id = ?", user),
    sessions: n("sessions.sqlite", "SELECT COUNT(*) AS n FROM web_sessions WHERE user = ?", user),
    songs: n("shares.sqlite", "SELECT COUNT(*) AS n FROM shares WHERE owner = ?", user),
    comments: n("shares.sqlite", "SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND deleted_at IS NULL", user),
    ratings: n("shares.sqlite", "SELECT COUNT(*) AS n FROM ratings WHERE user_id = ?", user),
    reports: n("shares.sqlite", "SELECT COUNT(*) AS n FROM reports WHERE reporter = ?", user),
    profile: n("shares.sqlite", "SELECT COUNT(*) AS n FROM profiles WHERE user_id = ?", user),
    devices: n("native.sqlite", "SELECT COUNT(*) AS n FROM push_devices WHERE user_id = ?", user),
    refresh: n("native.sqlite", "SELECT COUNT(*) AS n FROM refresh_tokens WHERE user = ?", user) } });
} else { process.stderr.write("usage: social-test-user create|admin-session|revoke|delete|check\n"); process.exit(2); }
