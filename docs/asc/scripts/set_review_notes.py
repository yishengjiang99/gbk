#!/usr/bin/env python3
"""Set ONLY the App Review Information Notes for GBK Music Composer v1.0.

Reads docs/asc/review-notes.txt and PATCHes the version's appStoreReviewDetail
notes attribute — contact fields, demo account, and everything else in the
review detail are left untouched. Verifies by reading the detail back and
comparing length + sha256. Never creates or modifies a review submission.

Env: ASC_ISSUER_ID (or APP_STORE_CONNECT_ISSUER_ID), ASC_KEY_ID (default
95M27GJTV7), ASC_KEY_PATH or ASC_API_PRIVATE_KEY (push_listing.py conventions).
"""
import hashlib, os, sys, time
from pathlib import Path
import jwt, requests

APP_ID = "6826906431"; VERSION = "1.0"
BASE = "https://api.appstoreconnect.apple.com"
NOTES = Path(__file__).resolve().parent.parent / "review-notes.txt"


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
    text = NOTES.read_text().strip()
    want_sha = hashlib.sha256(text.encode()).hexdigest()
    vers = api("GET", f"/v1/apps/{APP_ID}/appStoreVersions?filter[platform]=IOS")["data"]
    ver = next((v for v in vers if v["attributes"]["versionString"] == VERSION), None)
    if ver is None:
        raise SystemExit(f"ABORT: version {VERSION} not found")
    print("VERSION", ver["id"], VERSION, ver["attributes"].get("appStoreState"))
    rd = api("GET", f"/v1/appStoreVersions/{ver['id']}/appStoreReviewDetail")["data"]
    cur = rd["attributes"].get("notes") or ""
    print("current notes:", len(cur), "chars; new notes:", len(text), "chars sha256", want_sha[:16])
    api("PATCH", f"/v1/appStoreReviewDetails/{rd['id']}",
        {"data": {"type": "appStoreReviewDetails", "id": rd["id"], "attributes": {"notes": text}}})
    back = api("GET", f"/v1/appStoreVersions/{ver['id']}/appStoreReviewDetail")["data"]["attributes"].get("notes") or ""
    got_sha = hashlib.sha256(back.strip().encode()).hexdigest()
    print("read-back notes:", len(back), "chars sha256", got_sha[:16])
    if back.strip() != text:
        raise SystemExit("ABORT: read-back notes do not match review-notes.txt")
    print("SET_NOTES_OK", rd["id"], len(text))


if __name__ == "__main__":
    main()
