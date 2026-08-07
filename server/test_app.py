"""End-to-end checks for the application intake service.

Run:  ./.venv/bin/python test_app.py
Uses a throwaway data directory, so it never touches real submissions.
"""

import io
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="najaf-test-"))
os.environ["DATA_DIR"] = str(TMP)
os.environ["FIELDS_PATH"] = str(Path(__file__).parent.parent / "assets" / "fields.json")
os.environ["ADMIN_USER"] = "tester"
os.environ["ADMIN_PASSWORD"] = "secret"

import app as service  # noqa: E402  (configuration must precede import)

service.RATE_LIMIT_MAX = 10_000  # the rate limiter is exercised separately

PASSED, FAILED = 0, 0


def check(label, condition, detail=""):
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  ok   {label}")
    else:
        FAILED += 1
        print(f"  FAIL {label} {detail}")


def a_valid_submission():
    """Every required field, filled with acceptable values."""
    schema = service.load_schema()
    form = {}
    essay_500 = " ".join(["word"] * 720)

    for field in service.iter_fields(schema):
        name, ftype = field["name"], field["type"]
        if ftype == "file":
            continue
        if ftype == "email":
            form[name] = "applicant@example.com"
        elif ftype == "tel":
            form[name] = "+9647719482220"
        elif ftype == "date":
            form[name] = "1999-05-14"
        elif ftype == "country":
            form[name] = "IQ"
        elif ftype == "fluency":
            form[name] = "intermediate"
        elif ftype == "level":
            form[name] = "beginner"
        elif ftype == "yesno":
            form[name] = "yes"
        elif ftype in ("radio", "select"):
            form[name] = field["options"][0]["value"]
        elif ftype == "checkbox":
            form[name] = field["options"][0]["value"]
        elif ftype == "declaration":
            form[name] = "yes"
        elif ftype == "essay":
            form[name] = essay_500
        else:
            form[name] = "Test value"

    form["full_name"] = "Ali Hassan Al-Najafi"
    form["logic_answer"] = " ".join(["word"] * 60)      # capped at 100 words
    form["motivation_essay"] = " ".join(["word"] * 420)  # 350–500
    form["_lang"] = "en"
    return form


def with_files(form, **overrides):
    data = dict(form)
    pdf = b"%PDF-1.4 test document"
    data["passport_copy"] = (io.BytesIO(pdf), "passport.pdf")
    data["transcript"] = (io.BytesIO(pdf), "transcript.pdf")
    data["recommendation_letter"] = (io.BytesIO(pdf), "letter.pdf")
    data.update(overrides)
    return data


def main():
    client = service.app.test_client()
    base = a_valid_submission()

    print("\nvalid submission")
    res = client.post("/api/apply", data=with_files(base), content_type="multipart/form-data")
    check("accepted (201)", res.status_code == 201, res.get_json())
    app_id = (res.get_json() or {}).get("id", "")
    check("returns a reference", bool(app_id))
    check("files stored on disk",
          len(list((TMP / "uploads" / app_id).iterdir())) == 3 if app_id else False)

    print("\nvalidation")
    res = client.post("/api/apply",
                      data=with_files({**base, "email": "not-an-email"}),
                      content_type="multipart/form-data")
    check("rejects a malformed email", res.status_code == 422
          and res.get_json()["errors"].get("email") == "email")

    res = client.post("/api/apply",
                      data=with_files({**base, "full_name": ""}),
                      content_type="multipart/form-data")
    check("rejects a missing required field", res.status_code == 422
          and res.get_json()["errors"].get("full_name") == "required")

    res = client.post("/api/apply",
                      data=with_files({**base, "motivation_essay": "too short"}),
                      content_type="multipart/form-data")
    check("enforces the essay minimum",
          res.status_code == 422
          and res.get_json()["errors"].get("motivation_essay", "").startswith("minWords"))

    res = client.post("/api/apply",
                      data=with_files({**base, "logic_answer": " ".join(["w"] * 300)}),
                      content_type="multipart/form-data")
    check("enforces the 100-word logic cap",
          res.status_code == 422
          and res.get_json()["errors"].get("logic_answer", "").startswith("maxWords"))

    res = client.post("/api/apply",
                      data=with_files({**base, "date_of_birth": "2020-01-01"}),
                      content_type="multipart/form-data")
    check("rejects an implausible age",
          res.status_code == 422 and res.get_json()["errors"].get("date_of_birth") == "age")

    res = client.post("/api/apply",
                      data=with_files({**base, "marital_status": "smuggled"}),
                      content_type="multipart/form-data")
    check("rejects an option not in the schema",
          res.status_code == 422 and res.get_json()["errors"].get("marital_status") == "invalid")

    print("\ncountry allowlist")
    offered = service.load_schema().get("countries", [])
    check("the schema defines the offered countries", len(offered) > 100, len(offered))

    # Anything absent from the list must be refused, whatever it is. Every
    # country dropdown enforces the same list.
    absent = [c for c in ("ZZ", "QQ", "XX") if c not in offered]
    for field in ("country", "nationality", "passport_issuer"):
        for code in absent:
            res = client.post("/api/apply",
                              data=with_files({**base, field: code}),
                              content_type="multipart/form-data")
            check(f"{field} rejects unlisted code {code}",
                  res.status_code == 422
                  and res.get_json()["errors"].get(field) == "invalid")

    res = client.post("/api/apply",
                      data=with_files({**base, "passport_issuer": offered[0]}),
                      content_type="multipart/form-data")
    check("an offered country is accepted", res.status_code == 201, res.get_json())

    print("\nconditional fields")
    # education_other is only required when education_level is "other"
    res = client.post("/api/apply",
                      data=with_files({**base, "education_level": "bachelor", "education_other": ""}),
                      content_type="multipart/form-data")
    check("hidden conditional field is not required", res.status_code == 201, res.get_json())

    res = client.post("/api/apply",
                      data=with_files({**base, "education_level": "other", "education_other": ""}),
                      content_type="multipart/form-data")
    check("shown conditional field is required",
          res.status_code == 422 and res.get_json()["errors"].get("education_other") == "required")

    print("\nfile handling")
    res = client.post("/api/apply",
                      data=with_files(base, passport_copy=(io.BytesIO(b"MZ"), "malware.exe")),
                      content_type="multipart/form-data")
    check("rejects a disallowed extension",
          res.status_code == 422 and res.get_json()["errors"].get("passport_copy") == "fileType")

    big = io.BytesIO(b"x" * (service.MAX_FILE_BYTES + 1024))
    res = client.post("/api/apply",
                      data=with_files(base, passport_copy=(big, "huge.pdf")),
                      content_type="multipart/form-data")
    check("rejects an oversized file",
          res.status_code == 422 and res.get_json()["errors"].get("passport_copy") == "fileSize")

    data = dict(base)
    data["transcript"] = (io.BytesIO(b"%PDF"), "t.pdf")
    data["recommendation_letter"] = (io.BytesIO(b"%PDF"), "l.pdf")
    res = client.post("/api/apply", data=data, content_type="multipart/form-data")
    check("rejects a missing required upload",
          res.status_code == 422 and res.get_json()["errors"].get("passport_copy") == "required")

    # Every upload directory must belong to an accepted application: rejected
    # submissions have to leave nothing behind.
    accepted = {
        row[0] for row in service.sqlite3.connect(TMP / "applications.db")
        .execute("SELECT id FROM applications")
    }
    orphans = [d.name for d in (TMP / "uploads").iterdir() if d.name not in accepted]
    check("no files kept from rejected submissions", not orphans, orphans)

    print("\nsecurity")
    res = client.post("/api/apply",
                      data=with_files({**base, "website": "http://spam.example"}),
                      content_type="multipart/form-data")
    check("silently absorbs the honeypot", res.status_code == 200)

    res = client.post("/api/apply",
                      data=with_files({**base, "injected_column": "x"}),
                      content_type="multipart/form-data")
    stored = json.loads(
        service.sqlite3.connect(TMP / "applications.db")
        .execute("SELECT answers FROM applications ORDER BY created_at DESC LIMIT 1")
        .fetchone()[0]
    )
    check("ignores unknown fields", "injected_column" not in stored)

    check("admin needs a password", client.get("/admin").status_code == 401)
    check("wrong password refused",
          client.get("/admin", headers={"Authorization": "Basic dGVzdGVyOndyb25n"}).status_code == 401)

    auth = {"Authorization": "Basic dGVzdGVyOnNlY3JldA=="}  # tester:secret
    check("admin list loads", client.get("/admin", headers=auth).status_code == 200)
    check("admin detail loads", client.get(f"/admin/{app_id}", headers=auth).status_code == 200)

    res = client.get(f"/admin/{app_id}/file/passport_copy", headers=auth)
    check("uploaded file downloads", res.status_code == 200 and b"%PDF" in res.data)

    res = client.get("/admin/../../etc/passwd", headers=auth)
    check("path traversal blocked", res.status_code in (404, 308))

    res = client.get("/admin/export.csv", headers=auth)
    body = res.data.decode("utf-8")
    check("CSV exports", res.status_code == 200 and "Ali Hassan Al-Najafi" in body)
    check("CSV has a UTF-8 BOM for Excel", body.startswith("﻿"))

    print("\nrate limiting")
    service.RATE_LIMIT_MAX = 2
    service._rate_log.clear()
    codes = [
        client.post("/api/apply", data=with_files(base),
                    content_type="multipart/form-data").status_code
        for _ in range(4)
    ]
    check("throttles repeated submissions", 429 in codes, codes)

    print(f"\n{PASSED} passed, {FAILED} failed")
    shutil.rmtree(TMP, ignore_errors=True)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
