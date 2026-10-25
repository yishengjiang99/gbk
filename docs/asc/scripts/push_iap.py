#!/usr/bin/env python3
"""Create/refresh GBK Pro in-app purchases in App Store Connect (app 6826906431). Idempotent. Never submits for review.

Source of truth: ios/StoreKit/GBKComposer.storekit (products, prices, intro offer) + docs/asc/iap.md.
Creates: subscription group "GBK Pro" (+en-US localization), pro_monthly / pro_yearly auto-renewables
(localizations, USA base price, all territories, 7-day free-trial intro offer, review screenshot),
lifetime non-consumable (localization, price schedule, availability, review screenshot); then reads back.

Env: ASC_ISSUER_ID (required unless --dry-run), ASC_KEY_ID (default 95M27GJTV7),
     ASC_KEY_PATH (default /workspace/asc/AuthKey_95M27GJTV7.p8).
Flags: --dry-run (offline: print the plan, no network), --verify (read back only), --no-screenshot
"""
import hashlib, json, os, sys, time
from pathlib import Path

APP_ID = "6826906431"; LOCALE = "en-US"
ROOT = Path(__file__).resolve().parents[3]
STOREKIT = ROOT / "ios/StoreKit/GBKComposer.storekit"
SHOT = ROOT / "docs/asc/screenshots/iap/paywall.png"
BASE = "https://api.appstoreconnect.apple.com"
DRY = "--dry-run" in sys.argv; VERIFY = "--verify" in sys.argv; NOSHOT = "--no-screenshot" in sys.argv
PERIOD = {"P1M": "ONE_MONTH", "P1Y": "ONE_YEAR"}
REVIEW_NOTE = ("Open the Profile tab and tap 'Get Pro' (or the crown on the Create tab). No sign-in needed; "
               "guests can buy. All products unlock the same Pro limits (10x Studio agent budget, 120 renders/hour).")

def catalog():
    sk = json.loads(STOREKIT.read_text())
    (grp,) = sk["subscriptionGroups"]
    subs = [dict(productId=s["productID"], name=s["referenceName"], price=s["displayPrice"],
                 period=PERIOD[s["recurringSubscriptionPeriod"]], level=s["groupNumber"],
                 trial=s.get("introductoryOffer"), loc=s["localizations"][0]) for s in grp["subscriptions"]]
    iaps = [dict(productId=p["productID"], name=p["referenceName"], price=p["displayPrice"],
                 type={"NonConsumable": "NON_CONSUMABLE", "Consumable": "CONSUMABLE"}[p["type"]],
                 loc=p["localizations"][0]) for p in sk["products"]]
    for x in subs + iaps:
        assert x["productId"].startswith("com.grepawk.moviefone."), x
        assert len(x["loc"]["displayName"]) <= 35 and len(x["loc"]["description"]) <= 55, x["loc"]
    return grp["name"], subs, iaps

_tok = [None, 0]
def token():
    if _tok[0] and time.time() < _tok[1] - 60: return _tok[0]
    import jwt
    iss = os.environ.get("ASC_ISSUER_ID", "").strip()
    if not iss: raise SystemExit("ASC_ISSUER_ID is not set; run with --dry-run or set it (App Store Connect > Users and Access > Integrations).")
    key = Path(os.environ.get("ASC_KEY_PATH", "/workspace/asc/AuthKey_95M27GJTV7.p8")).read_text()
    n = int(time.time())
    _tok[0] = jwt.encode({"iss": iss, "iat": n, "exp": n + 1100, "aud": "appstoreconnect-v1"}, key, algorithm="ES256",
                         headers={"kid": os.environ.get("ASC_KEY_ID", "95M27GJTV7"), "typ": "JWT"})
    _tok[1] = n + 1100
    return _tok[0]

def api(method, path, body=None, ok=(200, 201, 204)):
    if DRY: print("DRY", method, path, json.dumps(body)[:300] if body else ""); return {"data": [] if method == "GET" else {"id": "dry"}}
    import requests
    r = requests.request(method, path if path.startswith("http") else BASE + path, json=body,
                         headers={"Authorization": "Bearer " + token()}, timeout=120)
    if r.status_code not in ok: raise SystemExit(f"{method} {path} -> {r.status_code}: {r.text[:1500]}")
    return r.json() if r.text else {}

def get_all(path):
    out, url = [], path
    while url:
        j = api("GET", url); out += j.get("data", []); url = (j.get("links") or {}).get("next")
    return out

def rel(t, i): return {"data": {"type": t, "id": i}}
def create(t, attrs, rels): return api("POST", f"/v1/{t}" if t != "inAppPurchases" else "/v2/inAppPurchases",
                                     {"data": {"type": t, "attributes": attrs, "relationships": rels}})["data"]

def price_point(path, price):
    pts = get_all(f"{path}?filter[territory]=USA&limit=200")
    if DRY: return "dry-pp"
    m = [p for p in pts if p["attributes"]["customerPrice"] in (price, price.rstrip("0").rstrip("."))]
    if not m: raise SystemExit(f"no USA price point {price} at {path}")
    return m[0]["id"]

def territories(): return [{"type": "territories", "id": t["id"]} for t in get_all("/v1/territories?limit=200")]

def screenshot(kind, rel_name, parent_type, pid):
    if NOSHOT: return
    if not SHOT.exists(): print("WARN no", SHOT); return
    data = SHOT.read_bytes()
    s = create(kind, {"fileName": SHOT.name, "fileSize": len(data)}, {rel_name: rel(parent_type, pid)})
    if not DRY:
        import requests
        for op in s["attributes"]["uploadOperations"]:
            requests.request(op["method"], op["url"], data=data[op["offset"]:op["offset"] + op["length"]],
                             headers={h["name"]: h["value"] for h in op["requestHeaders"]}, timeout=120).raise_for_status()
    api("PATCH", f"/v1/{kind}/{s['id']}", {"data": {"type": kind, "id": s["id"],
        "attributes": {"uploaded": True, "sourceFileChecksum": hashlib.md5(data).hexdigest()}}})

def ensure_group(name):
    g = [x for x in get_all(f"/v1/apps/{APP_ID}/subscriptionGroups?limit=200") if x["attributes"]["referenceName"] == name]
    if g: gid = g[0]["id"]
    else: gid = create("subscriptionGroups", {"referenceName": name}, {"app": rel("apps", APP_ID)})["id"]
    if not [l for l in get_all(f"/v1/subscriptionGroups/{gid}/subscriptionGroupLocalizations") if l["attributes"]["locale"] == LOCALE]:
        create("subscriptionGroupLocalizations", {"name": name, "locale": LOCALE}, {"subscriptionGroup": rel("subscriptionGroups", gid)})
    return gid

def ensure_sub(gid, s):
    ex = [x for x in get_all(f"/v1/subscriptionGroups/{gid}/subscriptions?limit=200") if x["attributes"]["productId"] == s["productId"]]
    fresh = not ex
    sid = ex[0]["id"] if ex else create("subscriptions", {"name": s["name"], "productId": s["productId"], "subscriptionPeriod": s["period"],
        "groupLevel": s["level"], "familySharable": False, "reviewNote": REVIEW_NOTE}, {"group": rel("subscriptionGroups", gid)})["id"]
    if not [l for l in get_all(f"/v1/subscriptions/{sid}/subscriptionLocalizations") if l["attributes"]["locale"] == LOCALE]:
        create("subscriptionLocalizations", {"locale": LOCALE, "name": s["loc"]["displayName"], "description": s["loc"]["description"]},
               {"subscription": rel("subscriptions", sid)})
    if fresh or not get_all(f"/v1/subscriptions/{sid}/prices?filter[territory]=USA"):
        pp = price_point(f"/v1/subscriptions/{sid}/pricePoints", s["price"])
        create("subscriptionPrices", {"preserveCurrentPrice": False}, {"subscription": rel("subscriptions", sid),
               "subscriptionPricePoint": rel("subscriptionPricePoints", pp), "territory": rel("territories", "USA")})
        # Other storefronts: ASC auto-equalizes from the USA base price when no manual price is set.
    if fresh:
        create("subscriptionAvailabilities", {"availableInNewTerritories": True},
               {"subscription": rel("subscriptions", sid), "availableTerritories": {"data": territories()}})
    if s["trial"] and not get_all(f"/v1/subscriptions/{sid}/introductoryOffers"):
        create("subscriptionIntroductoryOffers", {"duration": "ONE_WEEK", "offerMode": "FREE_TRIAL", "numberOfPeriods": 1},
               {"subscription": rel("subscriptions", sid)})
    if fresh: screenshot("subscriptionAppStoreReviewScreenshots", "subscription", "subscriptions", sid)
    return sid

def ensure_iap(p):
    ex = [x for x in get_all(f"/v1/apps/{APP_ID}/inAppPurchasesV2?filter[productId]={p['productId']}") if x["attributes"]["productId"] == p["productId"]]
    fresh = not ex
    iid = ex[0]["id"] if ex else create("inAppPurchases", {"name": p["name"], "productId": p["productId"],
        "inAppPurchaseType": p["type"], "familySharable": False, "reviewNote": REVIEW_NOTE}, {"app": rel("apps", APP_ID)})["id"]
    if not [l for l in get_all(f"/v2/inAppPurchases/{iid}/inAppPurchaseLocalizations") if l["attributes"]["locale"] == LOCALE]:
        create("inAppPurchaseLocalizations", {"locale": LOCALE, "name": p["loc"]["displayName"], "description": p["loc"]["description"]},
               {"inAppPurchaseV2": rel("inAppPurchases", iid)})
    if fresh:
        pp = price_point(f"/v2/inAppPurchases/{iid}/pricePoints", p["price"])
        api("POST", "/v1/inAppPurchasePriceSchedules", {"data": {"type": "inAppPurchasePriceSchedules", "relationships": {
                "inAppPurchase": rel("inAppPurchases", iid), "baseTerritory": rel("territories", "USA"),
                "manualPrices": {"data": [{"type": "inAppPurchasePrices", "id": "${p0}"}]}}},
            "included": [{"type": "inAppPurchasePrices", "id": "${p0}", "attributes": {"startDate": None},
                          "relationships": {"inAppPurchasePricePoint": rel("inAppPurchasePricePoints", pp)}}]})
        create("inAppPurchaseAvailabilities", {"availableInNewTerritories": True},
               {"inAppPurchase": rel("inAppPurchases", iid), "availableTerritories": {"data": territories()}})
        screenshot("inAppPurchaseAppStoreReviewScreenshots", "inAppPurchaseV2", "inAppPurchases", iid)
    return iid

def verify(name, subs, iaps):
    g = [x for x in get_all(f"/v1/apps/{APP_ID}/subscriptionGroups?limit=200") if x["attributes"]["referenceName"] == name]
    have = {x["attributes"]["productId"]: x["attributes"].get("state") for gg in g
            for x in get_all(f"/v1/subscriptionGroups/{gg['id']}/subscriptions?limit=200")}
    have.update({x["attributes"]["productId"]: x["attributes"].get("state") for x in get_all(f"/v1/apps/{APP_ID}/inAppPurchasesV2?limit=200")})
    bad = 0
    for x in subs + iaps:
        st = have.get(x["productId"]); print(f"{x['productId']}: {st or 'MISSING'}"); bad += st is None
    if bad and not DRY: raise SystemExit(f"{bad} product(s) missing")

def main():
    name, subs, iaps = catalog()
    print(f"group={name} subs={[s['productId'] for s in subs]} iaps={[p['productId'] for p in iaps]}")
    if not VERIFY:
        gid = ensure_group(name)
        for s in subs: ensure_sub(gid, s)
        for p in iaps: ensure_iap(p)
    verify(name, subs, iaps)
    print("done (nothing submitted for review)")

if __name__ == "__main__":
    main()
