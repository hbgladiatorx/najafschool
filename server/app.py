"""
Application intake service for Sayyid al-Awsiya Religious School.

Accepts the ḥawza application form, stores each submission in SQLite and saves
uploaded documents to disk, and provides a password-protected area for staff to
review applications and export them as CSV.

Configuration comes from environment variables (see najafschool-api.service):

    FIELDS_PATH     path to assets/fields.json — the shared form schema
    DATA_DIR        directory for the database and uploaded files
    ADMIN_USER      username for the review area
    ADMIN_PASSWORD  password for the review area
    ALLOWED_ORIGIN  site origin permitted to submit the form
"""

from __future__ import annotations

import csv
import hmac
import io
import json
import os
import re
import sqlite3
import time
import unicodedata
import uuid
from collections import defaultdict, deque
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

from flask import (
    Flask, Response, abort, g, jsonify, render_template_string, request, send_file,
)
from werkzeug.exceptions import RequestEntityTooLarge

# ── Configuration ───────────────────────────────────────────────────────────
FIELDS_PATH = Path(os.environ.get("FIELDS_PATH", "../assets/fields.json"))
DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "https://www.najaf.school")

UPLOAD_DIR = DATA_DIR / "uploads"
DB_PATH = DATA_DIR / "applications.db"

MAX_FILE_BYTES = 15 * 1024 * 1024          # per file
MAX_REQUEST_BYTES = 60 * 1024 * 1024       # whole submission
ALLOWED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png", ".webp", ".heic", ".doc", ".docx"}
MAX_TEXT_CHARS = 20000                     # per text answer

# Submissions allowed per IP address within the window, to blunt spam floods.
RATE_LIMIT_MAX = 5
RATE_LIMIT_WINDOW_SECONDS = 3600

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_REQUEST_BYTES


# ── Form schema ─────────────────────────────────────────────────────────────
def load_schema() -> dict:
    """Read the shared field definitions. Re-read per call so that deploying an
    updated fields.json takes effect without restarting the service."""
    with open(FIELDS_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def iter_fields(schema: dict):
    for section in schema["sections"]:
        for field in section["fields"]:
            if field["type"] != "heading":
                yield field


# ── Database ────────────────────────────────────────────────────────────────
def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    # Answers are stored as a JSON document rather than one column per question,
    # so that editing fields.json never requires a schema migration.
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS applications (
            id          TEXT PRIMARY KEY,
            created_at  TEXT NOT NULL,
            full_name   TEXT,
            email       TEXT,
            country     TEXT,
            lang        TEXT,
            remote_ip   TEXT,
            answers     TEXT NOT NULL,
            files       TEXT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'new'
        )
        """
    )
    con.execute("CREATE INDEX IF NOT EXISTS idx_created ON applications(created_at DESC)")
    con.commit()
    con.close()


# ── Helpers ─────────────────────────────────────────────────────────────────
def client_ip() -> str:
    forwarded = request.headers.get("X-Forwarded-For", "")
    return forwarded.split(",")[0].strip() if forwarded else (request.remote_addr or "?")


_rate_log: dict[str, deque] = defaultdict(deque)


def rate_limited(ip: str) -> bool:
    now = time.time()
    hits = _rate_log[ip]
    while hits and now - hits[0] > RATE_LIMIT_WINDOW_SECONDS:
        hits.popleft()
    if len(hits) >= RATE_LIMIT_MAX:
        return True
    hits.append(now)
    return False


def count_words(text: str) -> int:
    return len([w for w in re.split(r"\s+", text.strip()) if w])


def safe_filename(name: str) -> str:
    """Keep the original name recognisable while stripping anything that could
    escape the upload directory or confuse the filesystem."""
    name = unicodedata.normalize("NFKD", name)
    name = os.path.basename(name).replace("\x00", "")
    name = re.sub(r"[^A-Za-z0-9._؀-ۿ-]", "_", name)
    name = name.strip("._") or "file"
    return name[:120]


def field_is_visible(field: dict, answers: dict) -> bool:
    """Conditional fields are only required when their condition is met — this
    mirrors the showIf logic the browser uses to hide them."""
    cond = field.get("showIf")
    if not cond:
        return True
    other = answers.get(cond["field"])
    if other is None:
        return False
    if "equals" in cond:
        return other == cond["equals"]
    if "notEquals" in cond:
        return other != cond["notEquals"]
    if "contains" in cond:
        values = other if isinstance(other, list) else [other]
        return cond["contains"] in values
    return True


# ── Submission ──────────────────────────────────────────────────────────────
def collect_answers(schema: dict) -> tuple[dict, list[str]]:
    """Pull every known field out of the request. Unknown keys are ignored, so a
    crafted request cannot inject extra columns."""
    answers: dict = {}
    errors: list[str] = []

    for field in iter_fields(schema):
        name, ftype = field["name"], field["type"]
        if ftype == "file":
            continue
        if ftype == "checkbox":
            answers[name] = request.form.getlist(name)
        elif ftype == "declaration":
            answers[name] = "yes" if request.form.get(name) in ("yes", "on", "true") else ""
        else:
            value = (request.form.get(name) or "").strip()
            if len(value) > MAX_TEXT_CHARS:
                errors.append(name)
                value = value[:MAX_TEXT_CHARS]
            answers[name] = value

    return answers, errors


def validate(schema: dict, answers: dict) -> dict[str, str]:
    """Returns {field_name: reason}. Reasons are codes the browser translates."""
    errors: dict[str, str] = {}
    valid_options = {}
    for field in iter_fields(schema):
        if field.get("options"):
            valid_options[field["name"]] = {o["value"] for o in field["options"]}

    fluency_values = {lvl["value"] for lvl in schema["fluencyLevels"]}
    level_values = {"beginner", "intermediate", "advanced"}

    for field in iter_fields(schema):
        name, ftype = field["name"], field["type"]
        value = answers.get(name)

        if not field_is_visible(field, answers):
            continue

        empty = value in (None, "", []) or (isinstance(value, list) and not value)
        if field.get("required") and ftype != "file" and empty:
            errors[name] = "required"
            continue
        if empty:
            continue

        if ftype == "email" and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[A-Za-z]{2,}", value):
            errors[name] = "email"
        elif ftype in ("date", "signed_date") and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            errors[name] = "date"
        elif ftype == "country" and value not in schema.get("countries", []):
            # An allowlist: any code not offered in the form is refused, so a
            # crafted request cannot submit a country the school does not accept.
            errors[name] = "invalid"
        elif ftype == "fluency" and value not in fluency_values:
            errors[name] = "invalid"
        elif ftype == "level" and value not in level_values:
            errors[name] = "invalid"
        elif ftype == "yesno" and value not in ("yes", "no"):
            errors[name] = "invalid"
        elif ftype in ("radio", "select") and value not in valid_options.get(name, {value}):
            errors[name] = "invalid"
        elif ftype == "checkbox":
            allowed = valid_options.get(name, set())
            if any(v not in allowed for v in value):
                errors[name] = "invalid"
        elif ftype == "essay":
            words = count_words(value)
            if field.get("minWords") and words < field["minWords"]:
                errors[name] = f"minWords:{field['minWords']}"
            elif field.get("maxWords") and words > field["maxWords"]:
                errors[name] = f"maxWords:{field['maxWords']}"

    # Date of birth must be a real past date, and the applicant an adult.
    dob = answers.get("date_of_birth")
    if dob and "date_of_birth" not in errors:
        try:
            born = datetime.strptime(dob, "%Y-%m-%d").date()
            today = datetime.now(timezone.utc).date()
            age = today.year - born.year - ((today.month, today.day) < (born.month, born.day))
            if born >= today:
                errors["date_of_birth"] = "invalid"
            elif age < 16 or age > 80:
                errors["date_of_birth"] = "age"
        except ValueError:
            errors["date_of_birth"] = "date"

    return errors


def save_uploads(schema: dict, app_id: str) -> tuple[dict, dict[str, str]]:
    saved: dict = {}
    errors: dict[str, str] = {}
    target_dir = UPLOAD_DIR / app_id

    for field in iter_fields(schema):
        if field["type"] != "file":
            continue
        name = field["name"]
        upload = request.files.get(name)

        if upload is None or not upload.filename:
            if field.get("required"):
                errors[name] = "required"
            continue

        ext = os.path.splitext(upload.filename)[1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            errors[name] = "fileType"
            continue

        upload.stream.seek(0, io.SEEK_END)
        size = upload.stream.tell()
        upload.stream.seek(0)
        if size > MAX_FILE_BYTES:
            errors[name] = "fileSize"
            continue
        if size == 0:
            errors[name] = "required" if field.get("required") else "fileEmpty"
            continue

        target_dir.mkdir(parents=True, exist_ok=True)
        stored = f"{name}__{safe_filename(upload.filename)}"
        upload.save(target_dir / stored)
        saved[name] = {"stored": stored, "original": upload.filename, "size": size}

    return saved, errors


@app.post("/api/apply")
def apply_route():
    ip = client_ip()
    if rate_limited(ip):
        return jsonify(ok=False, error="rateLimit"), 429

    # Bots fill in every field they find; a real applicant never sees this one.
    if (request.form.get("website") or "").strip():
        return jsonify(ok=True, id="ok"), 200

    schema = load_schema()
    answers, oversize = collect_answers(schema)
    errors = validate(schema, answers)
    for name in oversize:
        errors[name] = "tooLong"

    app_id = uuid.uuid4().hex[:12]
    files, file_errors = save_uploads(schema, app_id)
    errors.update(file_errors)

    if errors:
        # Discard any files already written for a submission we are rejecting.
        target_dir = UPLOAD_DIR / app_id
        if target_dir.exists():
            for path in target_dir.iterdir():
                path.unlink()
            target_dir.rmdir()
        return jsonify(ok=False, errors=errors), 422

    db = get_db()
    db.execute(
        """INSERT INTO applications
           (id, created_at, full_name, email, country, lang, remote_ip, answers, files)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            app_id,
            datetime.now(timezone.utc).isoformat(timespec="seconds"),
            answers.get("full_name", ""),
            answers.get("email", ""),
            answers.get("country", ""),
            (request.form.get("_lang") or "ar")[:5],
            ip,
            json.dumps(answers, ensure_ascii=False),
            json.dumps(files, ensure_ascii=False),
        ),
    )
    db.commit()
    app.logger.info("application %s received from %s", app_id, answers.get("email", "?"))
    return jsonify(ok=True, id=app_id), 201


@app.errorhandler(RequestEntityTooLarge)
def too_large(_e):
    return jsonify(ok=False, error="tooLarge"), 413


@app.get("/api/health")
def health():
    db = get_db()
    count = db.execute("SELECT COUNT(*) AS n FROM applications").fetchone()["n"]
    return jsonify(ok=True, applications=count)


@app.after_request
def security_headers(response: Response) -> Response:
    if request.path.startswith("/api/"):
        response.headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN
        response.headers["Vary"] = "Origin"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


# ── Review area ─────────────────────────────────────────────────────────────
def require_admin(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        auth = request.authorization
        ok = (
            ADMIN_PASSWORD
            and auth
            and hmac.compare_digest(auth.username or "", ADMIN_USER)
            and hmac.compare_digest(auth.password or "", ADMIN_PASSWORD)
        )
        if not ok:
            return Response(
                "Authentication required.", 401,
                {"WWW-Authenticate": 'Basic realm="Applications"'},
            )
        return view(*args, **kwargs)

    return wrapper


LIST_TEMPLATE = """<!doctype html><meta charset="utf-8">
<title>Applications — Sayyid al-Awsiya</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font:15px/1.6 system-ui,sans-serif;margin:0;background:#FBF8F3;color:#1A2422}
 header{background:#0E4D45;color:#fff;padding:18px 24px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
 header h1{margin:0;font-size:1.1rem;font-weight:600}
 header a{color:#E4C877;margin-inline-start:auto}
 .wrap{max-width:1100px;margin:24px auto;padding:0 20px}
 table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #E2D9CB;border-radius:10px;overflow:hidden}
 th,td{padding:11px 14px;text-align:start;border-bottom:1px solid #F0EAE0;font-size:.93rem}
 th{background:#F4EEE4;font-weight:600}
 tr:last-child td{border-bottom:0}
 a{color:#146055}
 .empty{padding:50px;text-align:center;color:#4B5A56;background:#fff;border:1px solid #E2D9CB;border-radius:10px}
 .pill{background:#EEF4F2;border-radius:99px;padding:2px 10px;font-size:.8rem}
</style>
<header>
  <h1>Applications</h1>
  <span class="pill">{{ rows|length }} total</span>
  <a href="/admin/export.csv">Download CSV</a>
</header>
<div class="wrap">
{% if rows %}
<table>
  <tr><th>Received</th><th>Name</th><th>Email</th><th>Country</th><th>Files</th><th></th></tr>
  {% for r in rows %}
  <tr>
    <td>{{ r["created_at"].replace("T", " ")[:16] }}</td>
    <td>{{ r["full_name"] }}</td>
    <td>{{ r["email"] }}</td>
    <td>{{ r["country"] }}</td>
    <td>{{ r["files"]|from_json|length }}</td>
    <td><a href="/admin/{{ r['id'] }}">View</a></td>
  </tr>
  {% endfor %}
</table>
{% else %}
<p class="empty">No applications yet.</p>
{% endif %}
</div>
"""

DETAIL_TEMPLATE = """<!doctype html><meta charset="utf-8">
<title>{{ row["full_name"] }} — Application</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font:15px/1.7 system-ui,sans-serif;margin:0;background:#FBF8F3;color:#1A2422}
 header{background:#0E4D45;color:#fff;padding:18px 24px}
 header h1{margin:0;font-size:1.1rem}
 header a{color:#E4C877}
 .wrap{max-width:860px;margin:24px auto;padding:0 20px}
 section{background:#fff;border:1px solid #E2D9CB;border-radius:10px;padding:8px 22px 18px;margin-bottom:18px}
 h2{font-size:1rem;color:#0E4D45;border-bottom:1px solid #F0EAE0;padding-bottom:8px}
 dt{font-weight:600;font-size:.85rem;color:#4B5A56;margin-top:14px}
 dd{margin:2px 0 0;white-space:pre-wrap}
 dd:lang(ar){direction:rtl;text-align:right}
 .files a{display:inline-block;margin:4px 8px 0 0;background:#EEF4F2;padding:6px 12px;border-radius:8px;text-decoration:none;color:#146055}
 .meta{color:#4B5A56;font-size:.85rem}
</style>
<header><h1><a href="/admin">← All applications</a> &nbsp; {{ row["full_name"] }}</h1></header>
<div class="wrap">
 <p class="meta">Received {{ row["created_at"].replace("T"," ") }} · reference {{ row["id"] }}</p>
 {% for section in schema["sections"] %}
 <section>
  <h2>{{ section["title"]["en"] }}</h2>
  <dl>
  {% for f in section["fields"] if f["type"] != "heading" %}
    {% set v = answers.get(f["name"]) %}
    {% if v %}
    <dt>{{ f["label"]["en"] }}</dt>
    <dd>{{ v|join(", ") if v is not string else v }}</dd>
    {% endif %}
  {% endfor %}
  </dl>
 </section>
 {% endfor %}
 {% if files %}
 <section>
  <h2>Uploaded documents</h2>
  <p class="files">
  {% for name, info in files.items() %}
    <a href="/admin/{{ row['id'] }}/file/{{ name }}">{{ name }} — {{ info["original"] }}</a>
  {% endfor %}
  </p>
 </section>
 {% endif %}
</div>
"""


@app.template_filter("from_json")
def from_json_filter(value):
    return json.loads(value)


@app.get("/admin")
@require_admin
def admin_list():
    rows = get_db().execute(
        "SELECT * FROM applications ORDER BY created_at DESC"
    ).fetchall()
    return render_template_string(LIST_TEMPLATE, rows=rows)


@app.get("/admin/<app_id>")
@require_admin
def admin_detail(app_id: str):
    row = get_db().execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone()
    if row is None:
        abort(404)
    return render_template_string(
        DETAIL_TEMPLATE,
        row=row,
        answers=json.loads(row["answers"]),
        files=json.loads(row["files"]),
        schema=load_schema(),
    )


@app.get("/admin/<app_id>/file/<field>")
@require_admin
def admin_file(app_id: str, field: str):
    row = get_db().execute("SELECT files FROM applications WHERE id = ?", (app_id,)).fetchone()
    if row is None:
        abort(404)
    info = json.loads(row["files"]).get(field)
    if not info:
        abort(404)
    # Resolve and confirm the path stays inside the upload directory.
    path = (UPLOAD_DIR / app_id / info["stored"]).resolve()
    if not str(path).startswith(str(UPLOAD_DIR.resolve())) or not path.exists():
        abort(404)
    return send_file(path, as_attachment=True, download_name=info["original"])


@app.get("/admin/export.csv")
@require_admin
def admin_export():
    schema = load_schema()
    columns = ["id", "created_at", "lang"] + [f["name"] for f in iter_fields(schema)]
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(columns)

    for row in get_db().execute("SELECT * FROM applications ORDER BY created_at DESC"):
        answers = json.loads(row["answers"])
        files = json.loads(row["files"])
        record = {"id": row["id"], "created_at": row["created_at"], "lang": row["lang"]}
        for field in iter_fields(schema):
            name = field["name"]
            if field["type"] == "file":
                record[name] = files.get(name, {}).get("original", "")
            else:
                value = answers.get(name, "")
                record[name] = ", ".join(value) if isinstance(value, list) else value
        writer.writerow([record.get(c, "") for c in columns])

    # BOM so Excel opens the Arabic answers as UTF-8.
    data = "﻿" + buffer.getvalue()
    return Response(
        data,
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="applications.csv"'},
    )


init_db()

if __name__ == "__main__":
    app.run(debug=True, port=5000)
