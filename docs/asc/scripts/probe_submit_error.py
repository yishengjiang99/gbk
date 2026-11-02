#!/usr/bin/env python3
"""Read-only diagnostics for a version that ASC says "cannot be reviewed".

Prints the declaration surfaces that commonly block adding a version to a
review submission, changing nothing:
  - every appInfo's ageRatingDeclaration (null fields = unanswered questions)
  - appInfo localizations (privacy policy URL etc.) and version localization
    marketing/support URLs
  - the target build's usesNonExemptEncryption + processingState
  - app-level attributes (content rights, primary locale)
Env: same ASC_* conventions as push_listing.py. Target build: env
ASC_BUILD_NUMBER, else "29".
"""
import json, os, time
from pathlib import Path
import jwt, requests

APP_ID = "6826906431"; VERSION = "1.0"
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

def show(label, status, j):
    print(f"--- {label} -> {status}")
    print(json.dumps(j)[:3500])

def main():
    s, app = api_soft("GET", f"/v1/apps/{APP_ID}")
    a = (app.get("data") or {}).get("attributes") or {}
    print(f"APP attributes: contentRightsDeclaration {a.get('contentRightsDeclaration')} primaryLocale {a.get('primaryLocale')}")

    s, infos = api_soft("GET", f"/v1/apps/{APP_ID}/appInfos")
    for info in infos.get("data", []):
        iid = info["id"]
        print(f"APPINFO id {iid} state {info['attributes'].get('appStoreState')}")
        s2, decl = api_soft("GET", f"/v1/appInfos/{iid}/ageRatingDeclaration")
        if s2 < 300:
            attrs = (decl.get("data") or {}).get("attributes") or {}
            nulls = [k for k, v in attrs.items() if v is None]
            print(f"AGERATING null fields {nulls}")
            print(f"AGERATING values {json.dumps(attrs)}")
        else:
            show("AGERATING", s2, decl)
        s3, locs = api_soft("GET", f"/v1/appInfos/{iid}/appInfoLocalizations")
        for l in locs.get("data", []):
            la = l["attributes"]
            print(f"APPINFO_LOC {la.get('locale')} privacyPolicyUrl {la.get('privacyPolicyUrl')} privacyChoicesUrl {la.get('privacyChoicesUrl')}")

    s, vers = api_soft("GET", f"/v1/apps/{APP_ID}/appStoreVersions?filter[platform]=IOS")
    ver = next((v for v in vers.get("data", []) if v["attributes"]["versionString"] == VERSION), None)
    vid = ver["id"]
    s, vlocs = api_soft("GET", f"/v1/appStoreVersions/{vid}/appStoreVersionLocalizations")
    for l in vlocs.get("data", []):
        la = l["attributes"]
        print(f"VERSION_LOC {la.get('locale')} supportUrl {la.get('supportUrl')} marketingUrl {la.get('marketingUrl')}")

    s, builds = api_soft("GET", f"/v1/builds?filter[app]={APP_ID}&sort=-uploadedDate&limit=10")
    for b in builds.get("data", []):
        ba = b["attributes"]
        if ba["version"] == TARGET_BUILD:
            print(f"BUILD {TARGET_BUILD} processingState {ba.get('processingState')} usesNonExemptEncryption {ba.get('usesNonExemptEncryption')} expired {ba.get('expired')}")
    print("PROBE DONE (read-only; nothing changed)")

if __name__ == "__main__":
    main()
