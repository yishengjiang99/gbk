#!/usr/bin/env python3
"""Attach TestFlight build 27 to GBK Music Composer version 1.0 in App Store Connect.

Attach ONLY: never creates a reviewSubmission and never submits for review.
Env: ASC_ISSUER_ID (or APP_STORE_CONNECT_ISSUER_ID), ASC_KEY_ID (default 95M27GJTV7),
     ASC_KEY_PATH or ASC_API_PRIVATE_KEY (same conventions as push_listing.py).
Behavior: lists the app's builds; if build 27 is missing or not processingState VALID,
prints the available builds and exits 1 WITHOUT attaching anything. On success it
PATCHes the appStoreVersion's build relationship, then reads the version back with
?include=build and prints the attached build number, the version state, and the
en-US description length (to confirm listing edits are intact).
"""
import json, os, sys, time
from pathlib import Path
import jwt, requests

APP_ID = "6826906431"; VERSION = "1.0"; TARGET_BUILD = "27"; LOCALE = "en-US"
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

def api(method, path, body=None):
    r = requests.request(method, path if path.startswith("http") else BASE + path, json=body,
                         headers={"Authorization": "Bearer " + token()}, timeout=120)
    if r.status_code >= 300:
        raise SystemExit(f"{method} {path} -> {r.status_code}: {r.text[:1500]}")
    return r.json() if r.text else {}

def main():
    builds = api("GET", f"/v1/builds?filter[app]={APP_ID}&sort=-uploadedDate&limit=50")["data"]
    print(f"BUILDS ({len(builds)} most recent):")
    for b in builds:
        a = b["attributes"]
        print(f"  build {a['version']} state {a['processingState']} uploaded {a.get('uploadedDate')} expired {a.get('expired')}")
    target = next((b for b in builds if b["attributes"]["version"] == TARGET_BUILD), None)
    if target is None:
        raise SystemExit(f"ABORT: build {TARGET_BUILD} not found; nothing attached")
    state = target["attributes"]["processingState"]
    if state != "VALID":
        raise SystemExit(f"ABORT: build {TARGET_BUILD} processingState is {state}, not VALID; nothing attached")
    print(f"TARGET build {TARGET_BUILD} id {target['id']} VALID")

    vers = api("GET", f"/v1/apps/{APP_ID}/appStoreVersions?filter[platform]=IOS")["data"]
    ver = next((v for v in vers if v["attributes"]["versionString"] == VERSION), None)
    if ver is None:
        raise SystemExit(f"ABORT: version {VERSION} not found; nothing attached")
    print(f"VERSION {VERSION} id {ver['id']} state {ver['attributes']['appStoreState']}")

    api("PATCH", f"/v1/appStoreVersions/{ver['id']}",
        {"data": {"type": "appStoreVersions", "id": ver["id"],
                  "relationships": {"build": {"data": {"type": "builds", "id": target["id"]}}}}})
    print(f"ATTACHED build {TARGET_BUILD} to version {VERSION}")

    rb = api("GET", f"/v1/appStoreVersions/{ver['id']}?include=build")
    inc = [i for i in rb.get("included", []) if i["type"] == "builds"]
    attached = inc[0]["attributes"]["version"] if inc else None
    vstate = rb["data"]["attributes"]["appStoreState"]
    print(f"READBACK version {VERSION} state {vstate} build {attached}")
    if attached != TARGET_BUILD:
        raise SystemExit(f"ABORT: read-back build is {attached}, expected {TARGET_BUILD}")

    locs = api("GET", f"/v1/appStoreVersions/{ver['id']}/appStoreVersionLocalizations")["data"]
    loc = next((l for l in locs if l["attributes"]["locale"] == LOCALE), None)
    desc = (loc["attributes"].get("description") or "") if loc else ""
    print(f"READBACK {LOCALE} description length {len(desc)} eula {'stdeula' in desc}")
    print("DONE: build attached only; NOT submitted for review")

if __name__ == "__main__":
    main()
