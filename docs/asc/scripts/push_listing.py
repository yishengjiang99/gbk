#!/usr/bin/env python3
"""Push the GBK Music Composer App Store listing (docs/asc) to App Store Connect. Never submits for review.

Env: ASC_ISSUER_ID (or APP_STORE_CONNECT_ISSUER_ID), ASC_KEY_ID (default 95M27GJTV7),
     ASC_KEY_PATH (default /workspace/asc/AuthKey_95M27GJTV7.p8) or ASC_API_PRIVATE_KEY.
Optional: REVIEW_CONTACT_FIRST/LAST/PHONE/EMAIL, REVIEW_DEMO_PASSWORD.
Flags: --dry-run, --no-screenshots, --verify (read back only)
"""
import hashlib, json, os, re, sys, time
from pathlib import Path
import jwt, requests

APP_ID = "6826906431"; VERSION = "1.0"; LOCALE = "en-US"
ASC = Path(__file__).resolve().parent.parent
MD = ASC / "metadata" / LOCALE
SHOTS = ASC / "screenshots" / LOCALE
SHOT_TYPES = {"iphone-69": "APP_IPHONE_67", "iphone-65": "APP_IPHONE_65"}
DRY = "--dry-run" in sys.argv
BASE = "https://api.appstoreconnect.apple.com"

def token():
    iss = (os.environ.get("ASC_ISSUER_ID") or os.environ["APP_STORE_CONNECT_ISSUER_ID"]).strip()
    kp = os.environ.get("ASC_KEY_PATH", "/workspace/asc/AuthKey_95M27GJTV7.p8")
    key = Path(kp).read_text() if Path(kp).exists() else os.environ["ASC_API_PRIVATE_KEY"].replace("\\n", "\n")
    n = int(time.time())
    return jwt.encode({"iss": iss, "iat": n, "exp": n + 1100, "aud": "appstoreconnect-v1"}, key,
                      algorithm="ES256", headers={"kid": os.environ.get("ASC_KEY_ID", "95M27GJTV7"), "typ": "JWT"})

def api(method, path, body=None, ok_fail=False):
    if DRY and method != "GET":
        print("DRY", method, path); return {"data": {"id": "dry", "attributes": {}}}
    r = requests.request(method, path if path.startswith("http") else BASE + path, json=body,
                         headers={"Authorization": "Bearer " + token()}, timeout=120)
    if r.status_code >= 300:
        msg = f"{method} {path} -> {r.status_code}: {r.text[:1500]}"
        if ok_fail: print("WARN", msg); return None
        raise SystemExit(msg)
    return r.json() if r.text else {}

def rd(n): return (MD / n).read_text().strip()

def review_notes():
    m = re.search(r"## Review notes.*?```\n(.*?)```", (ASC / "app-review.md").read_text(), re.S)
    return m.group(1).strip()

def L():
    d = dict(name=rd("name.txt"), subtitle=rd("subtitle.txt"), description=rd("description.txt"),
             keywords=rd("keywords.txt"), promo=rd("promotional_text.txt"), support=rd("support_url.txt"),
             marketing=rd("marketing_url.txt"), privacy=rd("privacy_url.txt"), whatsnew=rd("whatsnew.txt"),
             copyright=(MD / "copyright.txt").read_text().strip() if (MD / "copyright.txt").exists() else "2026 Yisheng Jiang")
    for k, lim in [("name", 30), ("subtitle", 30), ("promo", 170), ("keywords", 100), ("description", 4000)]:
        assert len(d[k]) <= lim, f"{k} {len(d[k])}>{lim}"
    return d

def patch(t, i, attrs=None, rels=None):
    data = {"type": t, "id": i}
    if attrs: data["attributes"] = attrs
    if rels: data["relationships"] = rels
    return api("PATCH", f"/v1/{t}/{i}", {"data": data})

def main():
    d = L()
    app = api("GET", f"/v1/apps/{APP_ID}")["data"]["attributes"]
    print("APP", app["name"], app["bundleId"], app["sku"])
    if "--verify" in sys.argv: return verify()
    patch("apps", APP_ID, {"contentRightsDeclaration": "USES_THIRD_PARTY_CONTENT"})
    infos = api("GET", f"/v1/apps/{APP_ID}/appInfos")["data"]
    info = next(i for i in infos if i["attributes"].get("appStoreState") not in ("READY_FOR_SALE", "REPLACED_WITH_NEW_INFO"))
    locs = api("GET", f"/v1/appInfos/{info['id']}/appInfoLocalizations")["data"]
    loc = next(l for l in locs if l["attributes"]["locale"] == LOCALE)
    patch("appInfoLocalizations", loc["id"], {"name": d["name"], "subtitle": d["subtitle"], "privacyPolicyUrl": d["privacy"]})
    patch("appInfos", info["id"], rels={"primaryCategory": {"data": {"type": "appCategories", "id": "MUSIC"}}})
    print("appInfo: name/subtitle/privacy/category MUSIC/content rights")

    # Age rating: everything NONE/false except UGC; no unrestricted web; no messaging.
    ar = api("GET", f"/v1/appInfos/{info['id']}/ageRatingDeclaration")["data"]
    attrs = {}
    for k, v in ar["attributes"].items():
        if k in ("kidsAgeBand", "ageRatingOverride", "ageRatingOverrideV2", "koreaAgeRatingOverride", "developerAgeRatingInfoUrl"): continue
        if isinstance(v, bool) or v is None and k in ("gambling", "unrestrictedWebAccess", "lootBox", "messagingAndChat",
                "userGeneratedContent", "advertising", "ageAssurance", "parentalControls", "healthOrWellnessTopics", "seventeenPlus"):
            attrs[k] = (k == "userGeneratedContent")
        else:
            attrs[k] = "NONE"
    r = api("PATCH", f"/v1/ageRatingDeclarations/{ar['id']}", {"data": {"type": "ageRatingDeclarations", "id": ar["id"], "attributes": attrs}}, ok_fail=True)
    print("age rating", "ok" if r else "FAILED (see WARN)")

    vers = api("GET", f"/v1/apps/{APP_ID}/appStoreVersions?filter[platform]=IOS")["data"]
    ver = next((v for v in vers if v["attributes"]["versionString"] == VERSION), None) or \
          next((v for v in vers if v["attributes"]["appStoreState"] in ("PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED")), None)
    if ver is None:
        ver = api("POST", "/v1/appStoreVersions", {"data": {"type": "appStoreVersions", "attributes": {"platform": "IOS", "versionString": VERSION},
              "relationships": {"app": {"data": {"type": "apps", "id": APP_ID}}}}})["data"]
        print("created version", VERSION)
    patch("appStoreVersions", ver["id"], {"copyright": d["copyright"]})
    vattrs = {"description": d["description"], "keywords": d["keywords"], "promotionalText": d["promo"],
              "supportUrl": d["support"], "marketingUrl": d["marketing"]}
    vlocs = api("GET", f"/v1/appStoreVersions/{ver['id']}/appStoreVersionLocalizations")["data"]
    vloc = next((l for l in vlocs if l["attributes"]["locale"] == LOCALE), None)
    if vloc: patch("appStoreVersionLocalizations", vloc["id"], vattrs)
    else:
        vloc = api("POST", "/v1/appStoreVersionLocalizations", {"data": {"type": "appStoreVersionLocalizations", "attributes": {"locale": LOCALE, **vattrs},
                   "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": ver["id"]}}}}})["data"]
    # What's New is not allowed on the first version; try and ignore failure.
    if not any(v["attributes"]["appStoreState"] == "READY_FOR_SALE" for v in vers):
        print("whatsNew skipped (first release)")
    else:
        api("PATCH", f"/v1/appStoreVersionLocalizations/{vloc['id']}", {"data": {"type": "appStoreVersionLocalizations", "id": vloc["id"], "attributes": {"whatsNew": d["whatsnew"]}}}, ok_fail=True)
    print("version localization updated")

    # App Review details
    rv = api("GET", f"/v1/appStoreVersions/{ver['id']}/appStoreReviewDetail", ok_fail=True)
    rattrs = {"notes": review_notes(), "demoAccountName": "openai-reviewer", "demoAccountRequired": True}
    for env, k in [("REVIEW_CONTACT_FIRST", "contactFirstName"), ("REVIEW_CONTACT_LAST", "contactLastName"),
                   ("REVIEW_CONTACT_PHONE", "contactPhone"), ("REVIEW_CONTACT_EMAIL", "contactEmail"), ("REVIEW_DEMO_PASSWORD", "demoAccountPassword")]:
        if os.environ.get(env): rattrs[k] = os.environ[env]
    if rv and rv.get("data"):
        patch("appStoreReviewDetails", rv["data"]["id"], rattrs)
    else:
        api("POST", "/v1/appStoreReviewDetails", {"data": {"type": "appStoreReviewDetails", "attributes": rattrs,
            "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": ver["id"]}}}}})
    print("review detail set", sorted(k for k in rattrs if k != "demoAccountPassword"))

    if "--no-screenshots" not in sys.argv:
        sets = api("GET", f"/v1/appStoreVersionLocalizations/{vloc['id']}/appScreenshotSets")["data"]
        for prefix, dtype in SHOT_TYPES.items():
            files = sorted(SHOTS.glob(f"{prefix}-*.png"))
            sset = next((s for s in sets if s["attributes"]["screenshotDisplayType"] == dtype), None)
            if sset is None:
                sset = api("POST", "/v1/appScreenshotSets", {"data": {"type": "appScreenshotSets", "attributes": {"screenshotDisplayType": dtype},
                           "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": vloc["id"]}}}}})["data"]
            else:
                for old in api("GET", f"/v1/appScreenshotSets/{sset['id']}/appScreenshots")["data"]:
                    api("DELETE", f"/v1/appScreenshots/{old['id']}")
            for f in files:
                data = f.read_bytes()
                shot = api("POST", "/v1/appScreenshots", {"data": {"type": "appScreenshots", "attributes": {"fileName": f.name, "fileSize": len(data)},
                           "relationships": {"appScreenshotSet": {"data": {"type": "appScreenshotSets", "id": sset["id"]}}}}})["data"]
                if DRY: continue
                for op in shot["attributes"]["uploadOperations"]:
                    h = {x["name"]: x["value"] for x in op.get("requestHeaders", [])}
                    requests.request(op["method"], op["url"], data=data[op["offset"]:op["offset"] + op["length"]], headers=h, timeout=180).raise_for_status()
                patch("appScreenshots", shot["id"], {"uploaded": True, "sourceFileChecksum": hashlib.md5(data).hexdigest()})
                print("uploaded", dtype, f.name)
        time.sleep(10)
    verify()

def verify():
    infos = api("GET", f"/v1/apps/{APP_ID}/appInfos?include=primaryCategory")["data"]
    for i in infos:
        print("APPINFO", i["attributes"].get("appStoreState"), i["relationships"]["primaryCategory"].get("data"))
        for l in api("GET", f"/v1/appInfos/{i['id']}/appInfoLocalizations")["data"]:
            a = l["attributes"]; print("  ", a["locale"], a.get("name"), "|", a.get("subtitle"), "|", a.get("privacyPolicyUrl"))
        ar = api("GET", f"/v1/appInfos/{i['id']}/ageRatingDeclaration", ok_fail=True)
        if ar: print("  AGE", {k: v for k, v in ar["data"]["attributes"].items() if v not in ("NONE", False, None)})
    print("CONTENT RIGHTS", api("GET", f"/v1/apps/{APP_ID}")["data"]["attributes"].get("contentRightsDeclaration"))
    for v in api("GET", f"/v1/apps/{APP_ID}/appStoreVersions?filter[platform]=IOS")["data"]:
        a = v["attributes"]; print("VERSION", a["versionString"], a["appStoreState"], a.get("copyright"))
        b = api("GET", f"/v1/appStoreVersions/{v['id']}/build", ok_fail=True)
        print("  BUILD", (b or {}).get("data") and b["data"]["attributes"].get("version"))
        rv = api("GET", f"/v1/appStoreVersions/{v['id']}/appStoreReviewDetail", ok_fail=True)
        if rv and rv.get("data"):
            a = rv["data"]["attributes"]; print("  REVIEW", {k: (("set" if a[k] else None) if k == "demoAccountPassword" else (a[k][:60] if isinstance(a[k], str) else a[k])) for k in a})
        for l in api("GET", f"/v1/appStoreVersions/{v['id']}/appStoreVersionLocalizations")["data"]:
            a = l["attributes"]
            print("  LOC", a["locale"], "desc", len(a.get("description") or ""), "kw", a.get("keywords"), "promo", a.get("promotionalText"), a.get("supportUrl"), a.get("marketingUrl"), "whatsNew", a.get("whatsNew"))
            for s in api("GET", f"/v1/appStoreVersionLocalizations/{l['id']}/appScreenshotSets")["data"]:
                for sc in api("GET", f"/v1/appScreenshotSets/{s['id']}/appScreenshots")["data"]:
                    sa = sc["attributes"]; print("   SHOT", s["attributes"]["screenshotDisplayType"], sa.get("fileName"), (sa.get("assetDeliveryState") or {}).get("state"))
    for b in api("GET", f"/v1/builds?filter[app]={APP_ID}&sort=-uploadedDate&limit=3")["data"]:
        a = b["attributes"]; print("BUILD", a["version"], a["processingState"], "icon", bool(a.get("iconAssetToken")))

if __name__ == "__main__":
    main()
