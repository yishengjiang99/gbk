#!/usr/bin/env python3
"""Read-only pre-submit checks for GBK Music Composer v1.0 (app 6826906431).

Prints the state a submission depends on, changing nothing:
  - version 1.0 state, attached build, en-US description (EULA check)
  - App Store Review details (contact fields present, demoAccountRequired)
  - en-US screenshot sets (counts + asset delivery states)
  - territory availability (how many territories the app is available in)
  - in-app purchases (v2) and subscription groups/subscriptions with states
  - agreements list, if the API exposes it
  - existing review submissions with states
Env: same ASC_* conventions as push_listing.py / attach_build.py.
"""
import json, os, sys, time
from pathlib import Path
import jwt, requests

APP_ID = "6826906431"; VERSION = "1.0"; LOCALE = "en-US"
BASE = "https://api.appstoreconnect.apple.com"

def token():
    iss = (os.environ.get("ASC_ISSUER_ID") or os.environ["APP_STORE_CONNECT_ISSUER_ID"]).strip()
    kp = os.environ.get("ASC_KEY_PATH", "")
    if kp and Path(kp).exists():
        key = Path(kp).read_text()
    else:
        key = os.environ["ASC_API_PRIVATE_KEY"].replace("\\n", "\n")
    n = int(time.time())
    return jwt.encode({"iss": iss, "iat": n, "exp": n + 1100, "aud": "appstoreconnect-v1"}, key,
                      algorithm="ES256", headers={"kid": os.environ.get("ASC_KEY_ID", "95M27GJTV7"), "typ": "JWT"})

def api_soft(method, path, body=None):
    r = requests.request(method, path if path.startswith("http") else BASE + path, json=body,
                         headers={"Authorization": "Bearer " + token()}, timeout=120)
    try:
        j = r.json()
    except Exception:
        j = {}
    return r.status_code, j

def api(method, path, body=None):
    s, j = api_soft(method, path, body)
    if s >= 300:
        raise SystemExit(f"{method} {path} -> {s}: {json.dumps(j)[:1500]}")
    return j

def err_text(j):
    errs = j.get("errors") or []
    if errs:
        e = errs[0]
        return f"{e.get('code')}: {e.get('detail') or e.get('title')}"
    return json.dumps(j)[:300]

def count_availability(av_data):
    """Walk an availability resource's territoryAvailabilities relationship."""
    rel = ((av_data.get("relationships") or {}).get("territoryAvailabilities") or {})
    link = ((rel.get("links") or {}).get("related")) or ""
    if not link:
        return 0, 0
    avail = 0; total = 0
    url = link + ("&" if "?" in link else "?") + "limit=200"
    while url:
        page = api("GET", url)
        for ta in page.get("data", []):
            total += 1
            if (ta.get("attributes") or {}).get("available"):
                avail += 1
        url = ((page.get("links") or {}).get("next")) or ""
    return avail, total

def main():
    vers = api("GET", f"/v1/apps/{APP_ID}/appStoreVersions?filter[platform]=IOS")["data"]
    ver = next((v for v in vers if v["attributes"]["versionString"] == VERSION), None)
    if ver is None:
        raise SystemExit(f"ABORT: version {VERSION} not found")
    vid = ver["id"]
    print(f"VERSION {VERSION} id {vid} state {ver['attributes']['appStoreState']}")

    rb = api("GET", f"/v1/appStoreVersions/{vid}?include=build")
    inc = [i for i in rb.get("included", []) if i["type"] == "builds"]
    print(f"VERSION attached build {(inc[0]['attributes']['version'] if inc else None)}")

    locs = api("GET", f"/v1/appStoreVersions/{vid}/appStoreVersionLocalizations")["data"]
    loc = next((l for l in locs if l["attributes"]["locale"] == LOCALE), None)
    desc = (loc["attributes"].get("description") or "") if loc else ""
    print(f"DESCRIPTION {LOCALE} length {len(desc)} eula {'stdeula' in desc}")

    s, rd = api_soft("GET", f"/v1/appStoreVersions/{vid}/appStoreReviewDetail")
    if s < 300:
        a = rd["data"]["attributes"]
        present = {k: bool(a.get(k)) for k in
                   ("contactFirstName", "contactLastName", "contactPhone", "contactEmail", "notes")}
        print(f"REVIEW_DETAIL {present} demoAccountRequired {a.get('demoAccountRequired')}")
    else:
        print(f"REVIEW_DETAIL unavailable -> {s}: {err_text(rd)}")

    if loc:
        sets = api("GET", f"/v1/appStoreVersionLocalizations/{loc['id']}/appScreenshotSets?include=appScreenshots")
        shots = {}
        for i in sets.get("included", []):
            if i["type"] == "appScreenshots":
                shots[i["id"]] = (i["attributes"].get("assetDeliveryState") or {}).get("state")
        for st in sets.get("data", []):
            ids = ((st.get("relationships") or {}).get("appScreenshots") or {}).get("data") or []
            states = [shots.get(x["id"]) for x in ids]
            print(f"SCREENSHOTS {st['attributes'].get('screenshotDisplayType')} count {len(ids)} states {states}")

    # Availability: v2 first, legacy v1 as fallback.
    s, av = api_soft("GET", f"/v1/apps/{APP_ID}/appAvailabilityV2")
    if s < 300 and av.get("data"):
        a = av["data"].get("attributes") or {}
        avail, total = count_availability(av["data"])
        print(f"AVAILABILITY v2 territories_available {avail} of {total} availableInNewTerritories {a.get('availableInNewTerritories')}")
    else:
        print(f"AVAILABILITY v2 -> {s}: {err_text(av)}")
        s1, av1 = api_soft("GET", f"/v1/apps/{APP_ID}/appAvailabilities")
        rows = av1.get("data") or []
        if s1 < 300 and rows:
            avail, total = count_availability(rows[0])
            print(f"AVAILABILITY v1 territories_available {avail} of {total}")
        else:
            print(f"AVAILABILITY v1 -> {s1}: {err_text(av1)}")
            print("AVAILABILITY territories_available 0 (no availability resource found)")

    # NOTE: the app's IAP list lives under /v1/apps/{id}/inAppPurchasesV2 even
    # though single-IAP operations are /v2/inAppPurchases/{id}; /v2/apps/... 404s.
    si, iap_resp = api_soft("GET", f"/v1/apps/{APP_ID}/inAppPurchasesV2?limit=200")
    if si >= 300:
        print(f"IAPS unreadable -> {si}: {err_text(iap_resp)}")
        iaps = []
    else:
        iaps = iap_resp.get("data", [])
    print(f"IAPS count {len(iaps)}")
    for p in iaps:
        a = p["attributes"]
        print(f"  IAP id {p['id']} productId {a.get('productId')} type {a.get('inAppPurchaseType')} state {a.get('state')}")

    groups = api("GET", f"/v1/apps/{APP_ID}/subscriptionGroups?include=subscriptions&limit=200")
    subs = [i for i in groups.get("included", []) if i["type"] == "subscriptions"]
    print(f"SUBSCRIPTION_GROUPS count {len(groups.get('data', []))} subscriptions {len(subs)}")
    for g in groups.get("data", []):
        print(f"  GROUP id {g['id']} referenceName {g['attributes'].get('referenceName')}")
    for sub in subs:
        a = sub["attributes"]
        print(f"  SUB id {sub['id']} productId {a.get('productId')} name {a.get('name')} state {a.get('state')} period {a.get('subscriptionPeriod')}")

    s, ag = api_soft("GET", "/v1/agreements?limit=20")
    if s < 300:
        for a in ag.get("data", []):
            at = a.get("attributes") or {}
            print(f"AGREEMENT id {a['id']} type {at.get('agreementType') or at.get('type')} status {at.get('status')}")
        if not ag.get("data"):
            print("AGREEMENTS list empty")
    else:
        print(f"AGREEMENTS not readable -> {s}: {err_text(ag)}")

    prod_label = {}
    for p in iaps:
        prod_label[p["id"]] = f"IAP {p['attributes'].get('productId')}"
    for sub in subs:
        prod_label[sub["id"]] = f"SUB {sub['attributes'].get('productId')}"

    subs_r = api("GET", f"/v1/apps/{APP_ID}/reviewSubmissions?limit=50").get("data", [])
    print(f"REVIEW_SUBMISSIONS count {len(subs_r)}")
    for r in subs_r:
        a = r["attributes"]
        print(f"  SUBMISSION id {r['id']} platform {a.get('platform')} state {a.get('state')} submittedDate {a.get('submittedDate')}")
        s_it, items_r = api_soft("GET", f"/v1/reviewSubmissions/{r['id']}/items?limit=200")
        if s_it >= 300:
            print(f"    ITEMS unreadable -> {s_it}: {err_text(items_r)}")
            continue
        items = items_r.get("data", [])
        print(f"    ITEMS count {len(items)}")
        for it in items:
            parts = []
            for key, rel in (it.get("relationships") or {}).items():
                data = (rel or {}).get("data")
                if not data:
                    continue
                entries = data if isinstance(data, list) else [data]
                for e in entries:
                    label = prod_label.get(e.get("id"), "")
                    if e.get("type") == "appStoreVersions":
                        label = "VERSION (appStoreVersion)"
                    parts.append(f"{key} type {e.get('type')} id {e.get('id')} {label}".rstrip())
            print(f"    ITEM id {it['id']} state {it.get('attributes', {}).get('state')}: " + ("; ".join(parts) if parts else "no relationships"))

    print("PRECHECK DONE (read-only; nothing changed)")

if __name__ == "__main__":
    main()
