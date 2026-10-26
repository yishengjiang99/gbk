// #131: site-wide first-touch attribution. The shared snippet (public/attribution.js) is executed in a
// fake browser (node:vm) to prove the acceptance flow: land on /s/x?utm_source=reddit, then a checkout
// started later from /pricing still carries utm_source=reddit. Plus: first-touch never overwrites,
// GPC/DNT skip storage, every page shell includes the snippet, and the waitlist signup records the
// attribution cookie's utm_source.
import test from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { readFileSync, mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { ScriptModel, reply, testConfig } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { pricingRoutes, WaitlistStore } from "../src/routes/pricing.ts";
import { SessionStore } from "../src/security/authentication.ts";
import { AccountStore } from "../src/persistence/accounts.ts";

const SNIPPET = readFileSync(new URL("../../public/attribution.js", import.meta.url), "utf8");
const TAG = `<script src="/attribution.js"></script>`;

class Jar {
  values = new Map<string, string>(); attrs = new Map<string, string>();
  get header() { return [...this.values].map(([k, v]) => `${k}=${v}`).join("; "); }
  set(raw: string) {
    const [pair, ...rest] = raw.split("; ");
    const i = pair.indexOf("=");
    this.values.set(pair.slice(0, i), pair.slice(i + 1));
    this.attrs.set(pair.slice(0, i), rest.join("; "));
  }
}
const memStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); } };
};
type Storage = ReturnType<typeof memStorage>;

function checkoutForm(plan: string, ads = "1") {
  const fields = new Map<string, { value: string }>();
  const listeners: (() => void)[] = [];
  const form = {
    dataset: { ads },
    fields,
    addEventListener: (ev: string, fn: () => void) => { if (ev === "submit") listeners.push(fn); },
    querySelector: (sel: string) => {
      const name = /input\[name="(.+)"\]/.exec(sel)?.[1];
      if (!name) return null;
      return name === "plan" ? { value: plan } : fields.get(name) ?? null;
    },
    appendChild: (el: { name: string; value: string }) => { fields.set(el.name, el); return el; },
    submit: () => listeners.forEach((f) => f()),
  };
  return form;
}
type Form = ReturnType<typeof checkoutForm>;

/** Run the snippet once, as one page view in a fresh tab (own session/local storage unless shared in). */
function pageView(o: { url: string; jar?: Jar; session?: Storage; local?: Storage; nav?: object; forms?: Form[] }) {
  const jar = o.jar ?? new Jar();
  const session = o.session ?? memStorage(); const local = o.local ?? memStorage();
  const document = {
    readyState: "complete",
    get cookie() { return jar.header; },
    set cookie(v: string) { jar.set(v); },
    querySelectorAll: (sel: string) => (sel === "form[data-checkout]" ? o.forms ?? [] : []),
    createElement: () => ({ type: "", name: "", value: "" }),
    addEventListener: () => { /* readyState is complete, so DOMContentLoaded is never awaited */ },
  };
  const sandbox = { navigator: o.nav ?? {}, window: {}, location: new URL(o.url), document, sessionStorage: session, localStorage: local, URLSearchParams };
  runInContext(SNIPPET, createContext(sandbox));
  return { jar, session, local };
}

test("acceptance: land on /s/x?utm_source=reddit, then checkout carries utm_source=reddit", () => {
  const { jar } = pageView({ url: "https://compose.grepawk.com/s/x?utm_source=reddit&utm_medium=paid-social&twclid=tw123&rdt_cid=rd456" });
  assert.equal(jar.values.get("gbk_utm_source"), "reddit");
  assert.equal(jar.values.get("gbk_utm_medium"), "paid-social");
  assert.equal(jar.values.get("gbk_twclid"), "tw123");
  assert.equal(jar.values.get("gbk_rdt_cid"), "rd456");
  assert.match(decodeURIComponent(jar.values.get("gbk_landing")!), /\/s\/x\?utm_source=reddit/); // cookie wire value is percent-encoded
  assert.match(jar.attrs.get("gbk_utm_source")!, /Path=\//);
  assert.match(jar.attrs.get("gbk_utm_source")!, /Max-Age=2592000/); // 30 days

  // Days later, a new tab (empty sessionStorage) opens /pricing directly and buys.
  const local = memStorage();
  const form = checkoutForm("pro_yearly");
  pageView({ url: "https://compose.grepawk.com/pricing", jar, local, forms: [form] });
  form.submit();
  assert.equal(form.fields.get("utm_source")?.value, "reddit");
  assert.equal(form.fields.get("utm_medium")?.value, "paid-social");
  assert.equal(form.fields.get("twclid")?.value, "tw123");
  assert.equal(form.fields.get("rdt_cid")?.value, "rd456");
  assert.match(form.fields.get("landing")?.value ?? "", /\/s\/x/);
  const eventId = form.fields.get("event_id")?.value ?? "";
  assert.match(eventId, /^gc-/);
  assert.equal(form.fields.get("ads_opt_out"), undefined);
  // The /pricing/thanks pixels read this record: same event id, chosen plan.
  const saved = JSON.parse(local.getItem("gbk_checkout")!) as { id: string; plan: string };
  assert.equal(saved.id, eventId); assert.equal(saved.plan, "pro_yearly");
});

test("first touch wins per key: a later landing never overwrites a stored id", () => {
  const { jar } = pageView({ url: "https://compose.grepawk.com/s/x?utm_source=reddit" });
  pageView({ url: "https://compose.grepawk.com/chatgpt?utm_source=google&utm_campaign=launch", jar });
  assert.equal(jar.values.get("gbk_utm_source"), "reddit"); // untouched
  assert.equal(jar.values.get("gbk_utm_campaign"), "launch"); // not seen before: first touch is now
  assert.match(decodeURIComponent(jar.values.get("gbk_landing")!), /\/s\/x/); // landing stays the first one
});

test("nothing is stored under Global Privacy Control or Do Not Track", () => {
  for (const nav of [{ globalPrivacyControl: true }, { doNotTrack: "1" }]) {
    const { jar, session } = pageView({ url: "https://compose.grepawk.com/feed?utm_source=reddit&twclid=tw1", nav });
    assert.equal(jar.values.size, 0);
    assert.equal(session.getItem("gbk_utm_source"), null);
  }
  // Under GPC the Buy form still submits, but forwards no stored ids: only event_id + ads_opt_out.
  const jar = new Jar(); jar.set("gbk_utm_source=reddit; Path=/; Max-Age=2592000");
  const form = checkoutForm("pro_monthly");
  pageView({ url: "https://compose.grepawk.com/pricing", jar, nav: { globalPrivacyControl: true }, forms: [form] });
  form.submit();
  assert.equal(form.fields.get("utm_source"), undefined);
  assert.equal(form.fields.get("ads_opt_out")?.value, "1");
  assert.match(form.fields.get("event_id")?.value ?? "", /^gc-/);
  // The ads off switch (data-ads="0") also marks the checkout as opted out.
  const off = checkoutForm("lifetime", "0");
  pageView({ url: "https://compose.grepawk.com/pricing", jar: new Jar(), forms: [off] });
  off.submit();
  assert.equal(off.fields.get("ads_opt_out")?.value, "1");
});

test("every page shell includes the shared snippet; /pricing no longer inlines it", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    // /chatgpt/gallery is deliberately script-free (its own test asserts it), so it is not in this list.
    for (const path of ["/chatgpt", "/privacy", "/terms", "/support", "/pricing", "/pricing/thanks", "/plans", "/privacy/payments-and-ads"]) {
      const html = await (await fetch(`${s.base}${path}`)).text();
      assert.ok(html.includes(TAG), `${path} loads /attribution.js`);
    }
    const pricing = await (await fetch(`${s.base}/pricing`)).text();
    assert.ok(!pricing.includes("gbk_landing"), "the old inline /pricing-only snippet is gone");
  } finally { await s.app.close(); }
  // The SPA shell (also what /s/<slug> and /u/<handle> are rendered into) loads it too.
  assert.ok(readFileSync(new URL("../../index.html", import.meta.url), "utf8").includes(TAG));
});

test("waitlist signup records the attribution cookie's utm_source (body field still wins)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbk-wl-"));
  const file = join(dir, "waitlist.sqlite");
  const cfg = testConfig();
  const sessions = new SessionStore(cfg); const accounts = new AccountStore(":memory:");
  const waitlist = new WaitlistStore(file);
  const app = Fastify(); pricingRoutes(app, cfg, sessions, accounts, waitlist);
  await app.ready();
  const post = (email: string, extra: Record<string, string>, cookie?: string) =>
    app.inject({ method: "POST", url: "/api/pricing/waitlist", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, payload: new URLSearchParams({ email, ...extra }).toString() });
  assert.equal((await post("a@example.com", {}, "gbk_utm_source=reddit")).statusCode, 303);
  assert.equal((await post("b@example.com", { utm_source: "google" }, "gbk_utm_source=reddit")).statusCode, 303);
  assert.equal((await post("c@example.com", {})).statusCode, 303);
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = (db.prepare("SELECT email, utm_source FROM pro_waitlist ORDER BY email").all() as { email: string; utm_source: string | null }[])
    .map((r) => ({ email: r.email, utm_source: r.utm_source }));
  assert.deepEqual(rows, [
    { email: "a@example.com", utm_source: "reddit" },
    { email: "b@example.com", utm_source: "google" },
    { email: "c@example.com", utm_source: null },
  ]);
  db.close(); await app.close(); waitlist.close(); sessions.close(); accounts.close();
});
