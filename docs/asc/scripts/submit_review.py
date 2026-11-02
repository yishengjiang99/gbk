#!/usr/bin/env python3
"""Submit GBK Music Composer v1.0 (app 6826906431) for App Store review.

Authorized by the user in chat 2026-11-01 ("Build 29 is good. Submit v1.0 and
attach build 29"). Target build: env ASC_BUILD_NUMBER, else "29".

Gates (any failure aborts BEFORE anything is submitted):
  - version 1.0 exists and the target build is attached to it
  - territory availability: at least one territory available (an app with no
    salable countries is bounced by App Review)
  - no in-app product stuck in MISSING_METADATA
First-release products (state READY_TO_SUBMIT: the non-consumable IAP and the
auto-renewable subscriptions) must ride the same review submission as the
version, so the script tries to add each as a reviewSubmission item. If the
public API refuses a product item, the script does NOT submit the version
alone: it leaves the draft submission holding the version item, prints the
API errors verbatim, and exits 3 (SUBMIT_HELD) so the products can be added
in the App Store Connect web UI and the same draft submitted from there.
On success prints SUBMIT_OK with the submission id and the read-back states.
Env: same ASC_* conventions as push_listing.py / attach_build.py.
"""
import json, os, sys, time
from pathlib import Path
import jwt, requests

APP_ID = "6826906431"; VERSION = "1.0"; LOCALE = "en-US"
TARGET_BUILD = os.environ.get("ASC_BUILD_NUMBER", "29")
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

def errors_text(j):
    out = []
    for e in j.get("errors") or []:
        out.append(f"{e.get('status')} {e.get('code')}: {e.get('detail') or e.get('title')}")
    return " | ".join(out) if out else json.dumps(j)[:600]

def count_availability(av_data):
    rel = ((av_data.get("relationships") or {}).get("territoryAvailabilities") or {})
    link = ((rel.get("links") or {}).get("related")) or ""
    if not link:
        return 0
    avail = 0
    url = link + ("&" if "?" in link else "?") + "limit=200"
    while url:
        page = api("GET", url)
        for ta in page.get("data", []):
            if (ta.get("attributes") or {}).get("available"):
                avail += 1
        url = ((page.get("links") or {}).get("next")) or ""
    return avail

def availability_count():
    s, av = api_soft("GET", f"/v1/apps/{APP_ID}/appAvailabilityV2")
    if s < 300 and av.get("data"):
        return count_availability(av["data"])
    s1, av1 = api_soft("GET", f"/v1/apps/{APP_ID}/appAvailabilities")
    rows = av1.get("data") or []
    if s1 < 300 and rows:
        return count_availability(rows[0])
    return 0

def main():
    vers = api("GET", f"/v1/apps/{APP_ID}/appStoreVersions?filter[platform]=IOS")["data"]
    ver = next((v for v in vers if v["attributes"]["versionString"] == VERSION), None)
    if ver is None:
        raise SystemExit(f"ABORT: version {VERSION} not found; nothing submitted")
    vid = ver["id"]; vstate = ver["attributes"]["appStoreState"]
    print(f"VERSION {VERSION} id {vid} state {vstate}")
    if vstate in ("WAITING_FOR_REVIEW", "IN_REVIEW"):
        print(f"ALREADY_SUBMITTED version state {vstate}; nothing to do")
        return
    if vstate != "PREPARE_FOR_SUBMISSION":
        raise SystemExit(f"ABORT: version state is {vstate}, not PREPARE_FOR_SUBMISSION; nothing submitted")

    rb = api("GET", f"/v1/appStoreVersions/{vid}?include=build")
    inc = [i for i in rb.get("included", []) if i["type"] == "builds"]
    attached = inc[0]["attributes"]["version"] if inc else None
    print(f"VERSION attached build {attached}")
    if attached != TARGET_BUILD:
        raise SystemExit(f"ABORT: attached build is {attached}, expected {TARGET_BUILD}; nothing submitted")

    nterr = availability_count()
    print(f"AVAILABILITY territories_available {nterr}")
    if nterr == 0:
        raise SystemExit("ABORT: no salable territories set for this app; submitting now would repeat the no-countries rejection; nothing submitted")

    # Products: first-release items must ride this submission.
    first_timers = []   # (kind, id, productId, rel_key, rel_type)
    blockers = []
    for p in api("GET", f"/v2/apps/{APP_ID}/inAppPurchasesV2?limit=200").get("data", []):
        a = p["attributes"]; st = a.get("state")
        print(f"IAP productId {a.get('productId')} type {a.get('inAppPurchaseType')} state {st}")
        if st == "READY_TO_SUBMIT":
            first_timers.append(("iap", p["id"], a.get("productId"), "inAppPurchaseV2", "inAppPurchases"))
        elif st == "MISSING_METADATA":
            blockers.append(f"IAP {a.get('productId')} is MISSING_METADATA")
    groups = api("GET", f"/v1/apps/{APP_ID}/subscriptionGroups?include=subscriptions&limit=200")
    for sub in [i for i in groups.get("included", []) if i["type"] == "subscriptions"]:
        a = sub["attributes"]; st = a.get("state")
        print(f"SUB productId {a.get('productId')} state {st}")
        if st == "READY_TO_SUBMIT":
            first_timers.append(("subscription", sub["id"], a.get("productId"), "subscription", "subscriptions"))
        elif st == "MISSING_METADATA":
            blockers.append(f"Subscription {a.get('productId')} is MISSING_METADATA")
    if blockers:
        raise SystemExit("ABORT: " + "; ".join(blockers) + "; nothing submitted")

    # Find or create the draft submission for iOS.
    existing = api("GET", f"/v1/apps/{APP_ID}/reviewSubmissions?limit=50").get("data", [])
    draft = None
    for r in existing:
        a = r["attributes"]
        if a.get("platform") != "IOS":
            continue
        print(f"EXISTING submission {r['id']} state {a.get('state')}")
        if a.get("state") in ("WAITING_FOR_REVIEW", "IN_REVIEW"):
            print(f"ALREADY_SUBMITTED submission {r['id']} state {a.get('state')}; nothing to do")
            return
        if a.get("state") == "READY_FOR_REVIEW" and draft is None:
            draft = r
    if draft is None:
        s, created = api_soft("POST", "/v1/reviewSubmissions",
                              {"data": {"type": "reviewSubmissions",
                                        "attributes": {"platform": "IOS"},
                                        "relationships": {"app": {"data": {"type": "apps", "id": APP_ID}}}}})
        if s >= 300:
            raise SystemExit(f"ABORT: create reviewSubmission -> {errors_text(created)}; nothing submitted")
        draft = created["data"]
        print(f"CREATED submission {draft['id']}")
    sub_id = draft["id"]

    # Version item (skip if already in the draft).
    items = api("GET", f"/v1/reviewSubmissions/{sub_id}/reviewSubmissionItems?include=appStoreVersion&limit=200")
    have_version = False
    for it in items.get("data", []):
        rel = ((it.get("relationships") or {}).get("appStoreVersion") or {}).get("data") or {}
        if rel.get("id") == vid:
            have_version = True
    if have_version:
        print("ITEM version already in submission")
    else:
        s, resp = api_soft("POST", "/v1/reviewSubmissionItems",
                           {"data": {"type": "reviewSubmissionItems",
                                     "relationships": {
                                         "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": sub_id}},
                                         "appStoreVersion": {"data": {"type": "appStoreVersions", "id": vid}}}}})
        if s >= 300:
            raise SystemExit(f"ABORT: add version item -> {errors_text(resp)}; nothing submitted")
        print("ITEM version added")

    # First-release product items.
    held = []
    for kind, pid_, product_id, rel_key, rel_type in first_timers:
        s, resp = api_soft("POST", "/v1/reviewSubmissionItems",
                           {"data": {"type": "reviewSubmissionItems",
                                     "relationships": {
                                         "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": sub_id}},
                                         rel_key: {"data": {"type": rel_type, "id": pid_}}}}})
        if s >= 300:
            held.append(f"{kind} {product_id}: {errors_text(resp)}")
            print(f"ITEM {kind} {product_id} FAILED -> {errors_text(resp)}")
        else:
            print(f"ITEM {kind} {product_id} added")
    if held:
        print(f"SUBMIT_HELD submission {sub_id} holds the version item only; {len(held)} first-release product(s) could not be attached via the public API:")
        for h in held:
            print(f"  HELD {h}")
        print("NEXT: in App Store Connect (web UI) open Monetization > each product > Add for Review and add it to this existing submission, then submit the same submission.")
        sys.exit(3)

    # Submit.
    s, resp = api_soft("PATCH", f"/v1/reviewSubmissions/{sub_id}",
                       {"data": {"type": "reviewSubmissions", "id": sub_id,
                                 "attributes": {"submitted": True}}})
    if s >= 300:
        print(f"SUBMIT_FAILED submission {sub_id} -> {errors_text(resp)}")
        sys.exit(4)
    print(f"SUBMIT accepted submission {sub_id}")

    s, sub_rb = api_soft("GET", f"/v1/reviewSubmissions/{sub_id}")
    sub_state = ((sub_rb.get("data") or {}).get("attributes") or {}).get("state")
    v_rb = api("GET", f"/v1/appStoreVersions/{vid}?include=build")
    inc = [i for i in v_rb.get("included", []) if i["type"] == "builds"]
    attached2 = inc[0]["attributes"]["version"] if inc else None
    v_state2 = v_rb["data"]["attributes"]["appStoreState"]
    print(f"SUBMIT_OK submission {sub_id} state {sub_state} version_state {v_state2} build {attached2}")

if __name__ == "__main__":
    main()
