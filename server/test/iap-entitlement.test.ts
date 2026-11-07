import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate, createPrivateKey, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { IapStore, type AppleTx } from "../src/persistence/iap.ts";
import { buildApp } from "../src/app.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";

function row(over: Partial<AppleTx> = {}): AppleTx {
  return { original_tx: "1", last_tx: "1", user: "u", app_token: null, product_id: "com.grepawk.moviefone.pro_monthly", environment: "Production", expires_at: 2_000, revoked_at: null, auto_renew: 1, grace_until: null, updated_at: 1_000, ...over };
}

test("IapStore.active: revoke, expiry, grace, and lifetime; auto_renew is unused", () => {
  const iap = new IapStore(new DatabaseSync(":memory:"), () => 1_000);
  assert.equal(iap.active(row({ expires_at: 2_000 })), true);
  assert.equal(iap.active(row({ expires_at: null })), true, "lifetime");
  assert.equal(iap.active(row({ expires_at: 500 })), false);
  assert.equal(iap.active(row({ expires_at: 500, auto_renew: 1 })), false, "auto_renew does not grant access");
  assert.equal(iap.active(row({ expires_at: 500, grace_until: 1_500 })), true, "grace keeps the entitlement after expiry");
  assert.equal(iap.active(row({ expires_at: 500, grace_until: 800 })), false);
  assert.equal(iap.active(row({ expires_at: 2_000, grace_until: 3_000, revoked_at: 900 })), false, "revoke wins over future expiry and grace");
  assert.equal(iap.active(row({ expires_at: null, revoked_at: 900 })), false);

  iap.upsert({ original_tx: "a", last_tx: "a1", user: "alice", app_token: null, product_id: "p", environment: "Production", expires_at: 2_000, revoked_at: null });
  iap.upsert({ original_tx: "b", last_tx: "b1", user: "alice", app_token: null, product_id: "life", environment: "Production", expires_at: null, revoked_at: null });
  assert.deepEqual(iap.pro("alice"), { pro: true, expires_at: null, environment: "Production" });
  iap.patch("b", { revoked_at: 900 });
  assert.deepEqual(iap.pro("alice"), { pro: true, expires_at: 2_000, environment: "Production" });
  iap.patch("a", { expires_at: 500 });
  assert.deepEqual(iap.pro("alice"), { pro: false, expires_at: null, environment: null });
});

function pki(dir: string) {
  const o = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "ca.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
  writeFileSync(join(dir, "leaf.ext"), "basicConstraints=critical,CA:FALSE\n1.2.840.113635.100.6.11.1=ASN1:NULL\n");
  for (const k of ["root", "int", "leaf"]) o("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${k}.key`);
  o("req", "-x509", "-new", "-key", "root.key", "-subj", "/CN=Test Root", "-days", "30", "-out", "root.pem", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  o("req", "-new", "-key", "int.key", "-subj", "/CN=Test WWDR", "-out", "int.csr"); o("x509", "-req", "-in", "int.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-days", "30", "-extfile", "ca.ext", "-out", "int.pem");
  o("req", "-new", "-key", "leaf.key", "-subj", "/CN=Test StoreKit", "-out", "leaf.csr"); o("x509", "-req", "-in", "leaf.csr", "-CA", "int.pem", "-CAkey", "int.key", "-CAcreateserial", "-days", "30", "-extfile", "leaf.ext", "-out", "leaf.pem");
  const der = (f: string) => new X509Certificate(readFileSync(join(dir, f))).raw.toString("base64");
  return { root: new X509Certificate(readFileSync(join(dir, "root.pem"))), x5c: [der("leaf.pem"), der("int.pem"), der("root.pem")], key: createPrivateKey(readFileSync(join(dir, "leaf.key"))) };
}
const jws = (p: ReturnType<typeof pki>, payload: object) => { const h = Buffer.from(JSON.stringify({ alg: "ES256", x5c: p.x5c })).toString("base64url"); const b = Buffer.from(JSON.stringify(payload)).toString("base64url"); return `${h}.${b}.${sign("sha256", Buffer.from(`${h}.${b}`), { key: p.key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`; };

test("IAP notifications: grace keeps pro, expiry/revoke clear it, offer redeem restores", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iap-ent-")); const p = pki(dir);
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", IAP_ALLOW_SANDBOX: "0" });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false, iapRoots: [p.root] });
  b.app.addHook("preClose", (done) => { b.app.server.closeAllConnections?.(); done(); });
  await b.app.listen({ port: 0, host: "127.0.0.1" }); const base = `http://127.0.0.1:${(b.app.server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown, h: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
  const B = "com.grepawk.moviefone"; const tok = "6f1c2a3b-1111-4222-8333-944455556666"; const future = Date.now() + 30 * 86_400_000; const past = Date.now() - 60_000; const grace = Date.now() + 7 * 86_400_000;
  const tx = (o: object = {}) => ({ transactionId: "1001", originalTransactionId: "1000", bundleId: B, productId: `${B}.pro_monthly`, expiresDate: future, environment: "Production", appAccountToken: tok, ...o });
  const note = (uuid: string, type: string, t: object, extra: { subtype?: string; ren?: object } = {}) => ({
    signedPayload: jws(p, { notificationType: type, subtype: extra.subtype, notificationUUID: uuid, data: { bundleId: B, environment: "Production", signedTransactionInfo: jws(p, tx(t)), ...(extra.ren ? { signedRenewalInfo: jws(p, extra.ren) } : {}) } }),
  });
  const pro = async (h: Record<string, string>) => (await (await fetch(`${base}/api/me`, { headers: h })).json()).pro as boolean;
  try {
    const g = await (await post("/api/auth/anonymous", { deviceId: "iap-ent-000000001", username: "SunnyHeron" })).json();
    const A = { authorization: `Bearer ${g.token}` };
    await post("/api/iap/apple", { signed_transaction: jws(p, tx()), app_account_token: tok }, A);
    assert.equal(await pro(A), true);

    assert.equal((await post("/api/iap/apple/notifications", note("g1", "DID_FAIL_TO_RENEW", { transactionId: "1002", expiresDate: past }, { subtype: "GRACE_PERIOD", ren: { autoRenewStatus: 1, gracePeriodExpiresDate: grace } }))).status, 200);
    assert.equal(await pro(A), true, "GRACE_PERIOD keeps the entitlement after the period lapses");

    assert.equal((await post("/api/iap/apple/notifications", note("g2", "GRACE_PERIOD_EXPIRED", { transactionId: "1003", expiresDate: past }))).status, 200);
    assert.equal(await pro(A), false);

    assert.equal((await post("/api/iap/apple/notifications", note("g3", "OFFER_REDEEMED", { transactionId: "1004", expiresDate: future }))).status, 200);
    assert.equal(await pro(A), true);

    assert.equal((await post("/api/iap/apple/notifications", note("g4", "EXPIRED", { transactionId: "1005", expiresDate: past }))).status, 200);
    assert.equal(await pro(A), false);

    assert.equal((await post("/api/iap/apple/notifications", note("g5", "SUBSCRIBED", { transactionId: "1006", expiresDate: future }))).status, 200);
    assert.equal(await pro(A), true);

    assert.equal((await post("/api/iap/apple/notifications", note("g6", "REVOKE", { transactionId: "1007", revocationDate: Date.now() }))).status, 200);
    assert.equal(await pro(A), false);
  } finally { await b.app.close(); }
});
