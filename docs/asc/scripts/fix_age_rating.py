#!/usr/bin/env python3
"""Complete GBK's age rating declaration in App Store Connect.

Why: the declaration was never answered (every content field null), which
makes ASC refuse the version for review ("This resource cannot be reviewed").
push_listing.py's age-rating PATCH never landed because it derived value
types from the current (null) values and sent the string "NONE" for boolean
fields (socialMedia, socialMediaAgeRestricted), failing validation.

Answers (the repo's recorded policy, docs/asc): everything NONE / false
except userGeneratedContent = true; no unrestricted web access; no messaging.
Field types follow the current ageRatingDeclaration schema: frequency fields
take NONE/INFREQUENT/FREQUENT, the rest are booleans. kidsAgeBand,
gracRatingClassificationNumber and developerAgeRatingInfoUrl are left alone
(not a Kids-category app; no GRAC certificate).
Prints the full API response on failure and the read-back null fields.
Env: same ASC_* conventions as push_listing.py.
"""
import json, os, time
from pathlib import Path
import jwt, requests

APP_ID = "6826906431"
BASE = "https://api.appstoreconnect.apple.com"

ENUM_NONE = [
    "alcoholTobaccoOrDrugUseOrReferences", "contests", "gamblingSimulated",
    "gunsOrOtherWeapons", "horrorOrFearThemes", "matureOrSuggestiveThemes",
    "medicalOrTreatmentInformation", "profanityOrCrudeHumor",
    "sexualContentGraphicAndNudity", "sexualContentOrNudity",
    "violenceCartoonOrFantasy", "violenceRealistic",
    "violenceRealisticProlongedGraphicOrSadistic",
]
BOOL_FIELDS = [
    "advertising", "ageAssurance", "gambling", "healthOrWellnessTopics",
    "lootBox", "messagingAndChat", "parentalControls", "socialMedia",
    "socialMediaAgeRestricted", "unrestrictedWebAccess", "userGeneratedContent",
]
TRUE_FIELDS = {"userGeneratedContent"}
LEAVE_ALONE = {"kidsAgeBand", "gracRatingClassificationNumber", "developerAgeRatingInfoUrl",
               "ageRatingOverride", "ageRatingOverrideV2", "koreaAgeRatingOverride"}

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

def main():
    infos = api("GET", f"/v1/apps/{APP_ID}/appInfos")["data"]
    info = next(i for i in infos if i["attributes"].get("appStoreState") not in ("READY_FOR_SALE", "REPLACED_WITH_NEW_INFO"))
    ar = api("GET", f"/v1/appInfos/{info['id']}/ageRatingDeclaration")["data"]
    current = ar["attributes"]
    attrs = {}
    for k in ENUM_NONE:
        if k in current:
            attrs[k] = "NONE"
    for k in BOOL_FIELDS:
        if k in current:
            attrs[k] = k in TRUE_FIELDS
    missing = [k for k in current if k not in LEAVE_ALONE and k not in attrs and current[k] is None]
    if missing:
        print(f"NOTE unmapped null fields not sent: {missing}")
    s, resp = api_soft("PATCH", f"/v1/ageRatingDeclarations/{ar['id']}",
                       {"data": {"type": "ageRatingDeclarations", "id": ar["id"], "attributes": attrs}})
    if s >= 300:
        print(f"PATCH_FAILED full response: {json.dumps(resp)[:4000]}")
        raise SystemExit(f"ABORT: age rating PATCH -> {s}; declaration unchanged")
    print("AGE_RATING patched")
    rb = api("GET", f"/v1/appInfos/{info['id']}/ageRatingDeclaration")["data"]["attributes"]
    nulls = [k for k, v in rb.items() if v is None and k not in LEAVE_ALONE]
    print(f"READBACK null content fields {nulls}")
    print(f"READBACK userGeneratedContent {rb.get('userGeneratedContent')} messagingAndChat {rb.get('messagingAndChat')} socialMedia {rb.get('socialMedia')}")
    print("AGE_RATING_SET" if not nulls else "AGE_RATING_INCOMPLETE")

if __name__ == "__main__":
    main()
