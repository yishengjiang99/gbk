import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate, createPrivateKey, sign, generateKeyPairSync } from "node:crypto";
import { buildApp } from "../src/app.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";
import { APPLE_ROOT_CA_G3_B64 } from "../src/iap/apple-root.ts";
import { verifyAppleJws, appleRoot } from "../src/iap/apple-jws.ts";

// Test PKI shaped like Apple's: root CA -> intermediate CA -> leaf carrying OID 1.2.840.113635.100.6.11.1.
function pki(dir: string, leafOid = true) {
  const o = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "ca.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
  writeFileSync(join(dir, "leaf.ext"), `basicConstraints=critical,CA:FALSE\n${leafOid ? "1.2.840.113635.100.6.11.1=ASN1:NULL\n" : ""}`);
  for (const k of ["root", "int", "leaf"]) o("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${k}.key`);
  o("req", "-x509", "-new", "-key", "root.key", "-subj", "/CN=Test Root", "-days", "30", "-out", "root.pem", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  o("req", "-new", "-key", "int.key", "-subj", "/CN=Test WWDR", "-out", "int.csr"); o("x509", "-req", "-in", "int.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-days", "30", "-extfile", "ca.ext", "-out", "int.pem");
  o("req", "-new", "-key", "leaf.key", "-subj", "/CN=Test StoreKit", "-out", "leaf.csr"); o("x509", "-req", "-in", "leaf.csr", "-CA", "int.pem", "-CAkey", "int.key", "-CAcreateserial", "-days", "30", "-extfile", "leaf.ext", "-out", "leaf.pem");
  const der = (f: string) => new X509Certificate(readFileSync(join(dir, f))).raw.toString("base64");
  return { root: new X509Certificate(readFileSync(join(dir, "root.pem"))), x5c: [der("leaf.pem"), der("int.pem"), der("root.pem")], key: createPrivateKey(readFileSync(join(dir, "leaf.key"))) };
}
const jws = (p: ReturnType<typeof pki>, payload: object, x5c = p.x5c) => { const h = Buffer.from(JSON.stringify({ alg: "ES256", x5c })).toString("base64url"); const b = Buffer.from(JSON.stringify(payload)).toString("base64url"); return `${h}.${b}.${sign("sha256", Buffer.from(`${h}.${b}`), { key: p.key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`; };

test("apple root pin: embedded constant == server/certs/AppleRootCA-G3.cer, fingerprint matches Apple's", () => {
  assert.equal(readFileSync(new URL("../certs/AppleRootCA-G3.cer", import.meta.url)).toString("base64"), APPLE_ROOT_CA_G3_B64);
  assert.equal(appleRoot().fingerprint256, "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79");
});

test("IAP: verify chain/OID/signature, bundle/product/env checks, ownership 409, idempotent, pending claim, notifications, pro in /api/me + 10x budget, guest merge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iap-")); const p = pki(dir); const bad = pki(mkdtempSync(join(tmpdir(), "iap2-")), false);
  // verifier unit checks
  assert.throws(() => verifyAppleJws(jws(p, { a: 1 }), { roots: [appleRoot()] }), /pinned Apple root/);
  assert.throws(() => verifyAppleJws(jws(bad, { a: 1 }), { roots: [bad.root] }), /OID/);
  const forged = jws(p, { a: 1 }).split("."); forged[1] = Buffer.from(JSON.stringify({ a: 2 })).toString("base64url");
  assert.throws(() => verifyAppleJws(forged.join("."), { roots: [p.root] }), /signature/);
  { const k = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey; const h = Buffer.from(JSON.stringify({ alg: "ES256", x5c: p.x5c })).toString("base64url"); const b = Buffer.from("{}").toString("base64url");
    assert.throws(() => verifyAppleJws(`${h}.${b}.${sign("sha256", Buffer.from(`${h}.${b}`), { key: k, dsaEncoding: "ieee-p1363" }).toString("base64url")}`, { roots: [p.root] }), /signature/); }
  assert.throws(() => verifyAppleJws(jws(p, {}), { roots: [p.root], now: Date.now() + 60 * 86_400_000 }), /validity/);

  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", IAP_ALLOW_SANDBOX: "0" });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false, iapRoots: [p.root] });
  b.app.addHook("preClose", (done) => { b.app.server.closeAllConnections?.(); done(); });
  await b.app.listen({ port: 0, host: "127.0.0.1" }); const base = `http://127.0.0.1:${(b.app.server.address() as { port: number }).port}`;
  const J = { "content-type": "application/json" };
  const post = (path: string, body: unknown, h: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { ...J, ...h }, body: JSON.stringify(body) });
  const guest = async (dev: string, name: string) => { const g = await (await post("/api/auth/anonymous", { deviceId: dev, username: name })).json(); return { id: g.user.id as string, A: { authorization: `Bearer ${g.token}` } }; };
  const B = "com.grepawk.moviefone"; const tok = "6f1c2a3b-1111-4222-8333-944455556666"; const exp = Date.now() + 30 * 86_400_000;
  const tx = (o: object = {}) => ({ transactionId: "1001", originalTransactionId: "1000", bundleId: B, productId: `${B}.pro_monthly`, expiresDate: exp, environment: "Production", appAccountToken: tok, ...o });
  try {
    const u1 = await guest("iap-device-000000001", "SunnyHeron");
    const me0 = await (await fetch(`${base}/api/me`, { headers: u1.A })).json(); assert.equal(me0.pro, false);
    for (const [o, code] of [[{ bundleId: "x.y" }, "WRONG_BUNDLE"], [{ productId: `${B}.coins` }, "UNKNOWN_PRODUCT"], [{ environment: "Sandbox" }, "SANDBOX_NOT_ALLOWED"]] as const) {
      const r = await post("/api/iap/apple", { signed_transaction: jws(p, tx(o)), app_account_token: tok }, u1.A); assert.equal(r.status, 400); assert.equal((await r.json()).code, code); }
    assert.equal((await (await post("/api/iap/apple", { signed_transaction: jws(p, tx()), app_account_token: "6f1c2a3b-0000-4222-8333-944455556666" }, u1.A)).json()).code, "TOKEN_MISMATCH");
    assert.equal((await (await post("/api/iap/apple", { signed_transaction: "a.b.c" }, u1.A)).json()).code, "INVALID_JWS");
    const ok = await (await post("/api/iap/apple", { signed_transaction: jws(p, tx()), app_account_token: tok }, u1.A)).json();
    assert.deepEqual(ok, { entitlements: ["pro"], expires_at: exp, product_id: `${B}.pro_monthly`, environment: "Production" });
    assert.deepEqual(await (await post("/api/iap/apple", { signed_transaction: jws(p, tx()), app_account_token: tok }, u1.A)).json(), ok); // idempotent
    const me1 = await (await fetch(`${base}/api/me`, { headers: u1.A })).json(); assert.equal(me1.pro, true); assert.equal(me1.pro_source, "apple"); assert.equal(me1.pro_environment, "Production");
    assert.equal(b.limits.for(u1.id).dailyTokens, cfg.agent.dailyTokenBudget * 10);
    // another account cannot take it
    const u2 = await guest("iap-device-000000002", "QuietLark");
    const c = await post("/api/iap/apple", { signed_transaction: jws(p, tx()), app_account_token: tok }, u2.A); assert.equal(c.status, 409); assert.equal((await c.json()).code, "IAP_OWNED_BY_OTHER");
    // no auth + known token -> same owner
    assert.equal((await post("/api/iap/apple", { signed_transaction: jws(p, tx({ transactionId: "1002" })), app_account_token: tok })).status, 200);
    // pending (no auth, new token) then claimed by u2 with bearer
    const tok2 = "7f1c2a3b-1111-4222-8333-944455556666"; const life = (o: object = {}) => tx({ transactionId: "2001", originalTransactionId: "2000", productId: `${B}.lifetime`, expiresDate: undefined, appAccountToken: tok2, ...o });
    assert.deepEqual((await (await post("/api/iap/apple", { signed_transaction: jws(p, life()), app_account_token: tok2 })).json()).entitlements, ["pro"]);
    assert.equal((await (await fetch(`${base}/api/me`, { headers: u2.A })).json()).pro, false);
    await post("/api/iap/apple", { signed_transaction: jws(p, life()), app_account_token: tok2 }, u2.A);
    const me2 = await (await fetch(`${base}/api/me`, { headers: u2.A })).json(); assert.equal(me2.pro, true); assert.equal(me2.pro_expires_at, null);
    // notifications: refund revokes, idempotent on uuid, renew restores
    const note = (uuid: string, type: string, t: object, subtype?: string) => ({ signedPayload: jws(p, { notificationType: type, subtype, notificationUUID: uuid, data: { bundleId: B, environment: "Production", signedTransactionInfo: jws(p, tx(t)) } }) });
    assert.equal((await post("/api/iap/apple/notifications", note("n1", "REFUND", { revocationDate: Date.now() }))).status, 200);
    assert.equal((await (await fetch(`${base}/api/me`, { headers: u1.A })).json()).pro, false);
    await post("/api/iap/apple/notifications", note("n2", "DID_RENEW", { transactionId: "1003", expiresDate: exp + 1 }));
    assert.equal((await (await fetch(`${base}/api/me`, { headers: u1.A })).json()).pro, true);
    await post("/api/iap/apple/notifications", note("n3", "EXPIRED", { transactionId: "1003", expiresDate: exp + 1 }));
    assert.equal((await (await fetch(`${base}/api/me`, { headers: u1.A })).json()).pro, false);
    await post("/api/iap/apple/notifications", note("n2", "DID_RENEW", { transactionId: "1003", expiresDate: exp + 1 })); // replay ignored
    assert.equal((await (await fetch(`${base}/api/me`, { headers: u1.A })).json()).pro, false);
    assert.equal((await post("/api/iap/apple/notifications", { signedPayload: "x" })).status, 400);
  } finally { await b.app.close(); }
});
