#!/usr/bin/env python3
"""Attach the review recording (docs/asc/review-video.mp4) to the App Review
details of GBK Music Composer v1.0, via POST /v1/appStoreReviewAttachments.

Apple's Guideline 2.1 rejection asked for a physical-device screen recording;
the user recorded it on device (feed playback + report flag, AI compose from a
typed prompt, the piano-roll editor) and this puts it on the review detail
where the resubmission's notes point to it.

Idempotent: if an attachment with the same file name and MD5 checksum already
exists on the review detail, it is reported and nothing is uploaded.
Never creates or modifies a review submission.

Env: ASC_ISSUER_ID (or APP_STORE_CONNECT_ISSUER_ID), ASC_KEY_ID (default
95M27GJTV7), ASC_KEY_PATH or ASC_API_PRIVATE_KEY (push_listing.py conventions).
"""
import hashlib, os, time
from pathlib import Path
import jwt, requests

APP_ID = "6826906431"; VERSION = "1.0"
BASE = "https://api.appstoreconnect.apple.com"
VIDEO = Path(__file__).resolve().parent.parent / "review-video.mp4"
_tok = {"v": None, "t": 0}


def token():
    now = int(time.time())
    if _tok["v"] and now - _tok["t"] < 600:
        return _tok["v"]
    iss = (os.environ.get("ASC_ISSUER_ID") or os.environ["APP_STORE_CONNECT_ISSUER_ID"]).strip()
    kp = os.environ.get("ASC_KEY_PATH", "")
    if kp and Path(kp).exists():
        key = Path(kp).read_text()
    else:
        key = os.environ["ASC_API_PRIVATE_KEY"].replace("\\n", "\n")
    _tok["v"] = jwt.encode({"iss": iss, "iat": now, "exp": now + 1100, "aud": "appstoreconnect-v1"}, key,
                           algorithm="ES256", headers={"kid": os.environ.get("ASC_KEY_ID", "95M27GJTV7"), "typ": "JWT"})
    _tok["t"] = now
    return _tok["v"]


def api(method, path, body=None):
    r = requests.request(method, path if path.startswith("http") else BASE + path, json=body,
                         headers={"Authorization": "Bearer " + token()}, timeout=180)
    if r.status_code >= 300:
        raise SystemExit(f"{method} {path} -> {r.status_code}: {r.text[:1500]}")
    return r.json() if r.text else {}


def main():
    data = VIDEO.read_bytes()
    md5 = hashlib.md5(data).hexdigest()
    vers = api("GET", f"/v1/apps/{APP_ID}/appStoreVersions?filter[platform]=IOS")["data"]
    ver = next((v for v in vers if v["attributes"]["versionString"] == VERSION), None)
    if ver is None:
        raise SystemExit(f"ABORT: version {VERSION} not found")
    print("version", ver["id"], VERSION, ver["attributes"].get("appStoreState"))
    rd_id = api("GET", f"/v1/appStoreVersions/{ver['id']}/appStoreReviewDetail")["data"]["id"]

    cur = api("GET", f"/v1/appStoreReviewDetails/{rd_id}/appStoreReviewAttachments")
    for a in cur.get("data", []):
        at = a["attributes"]
        print("existing attachment:", a["id"], at.get("fileName"), (at.get("assetDeliveryState") or {}).get("state"))
        if at.get("fileName") == VIDEO.name and at.get("sourceFileChecksum") == md5:
            print("ATTACH_OK already present:", a["id"])
            return

    att = api("POST", "/v1/appStoreReviewAttachments", {"data": {"type": "appStoreReviewAttachments",
              "attributes": {"fileName": VIDEO.name, "fileSize": len(data)},
              "relationships": {"appStoreReviewDetail": {"data": {"type": "appStoreReviewDetails", "id": rd_id}}}}})["data"]
    for op in att["attributes"]["uploadOperations"]:
        chunk = data[op["offset"]: op["offset"] + op["length"]]
        h = {x["name"]: x["value"] for x in op.get("requestHeaders", [])}
        requests.request(op["method"], op["url"], data=chunk, headers=h, timeout=300).raise_for_status()
    api("PATCH", f"/v1/appStoreReviewAttachments/{att['id']}", {"data": {"type": "appStoreReviewAttachments",
        "id": att["id"], "attributes": {"uploaded": True, "sourceFileChecksum": md5}}})
    state = None
    for _ in range(60):
        st = api("GET", f"/v1/appStoreReviewAttachments/{att['id']}")["data"]["attributes"]
        state = (st.get("assetDeliveryState") or {}).get("state")
        if state in ("COMPLETE", "FAILED"):
            break
        time.sleep(5)
    print("ATTACHMENT", att["id"], VIDEO.name, len(data), "bytes md5", md5, "->", state)
    if state != "COMPLETE":
        raise SystemExit(f"attachment delivery state {state}")
    print("ATTACH_OK", att["id"])


if __name__ == "__main__":
    main()
