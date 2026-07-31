#!/usr/bin/env bash
#
# Install or update the application intake API. Run ON THE SERVER as root:
#
#   sudo bash install.sh
#
# Safe to re-run: it updates the code, keeps the database and uploaded files,
# and preserves the existing admin password.

set -euo pipefail

APP_DIR=/opt/najafschool
DATA_DIR=/var/lib/najafschool
ENV_FILE=/etc/najafschool.env
WEBROOT=/var/www/najaf.school
DOMAIN=najaf.school
SRC="$(cd "$(dirname "$0")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash install.sh" >&2
  exit 1
fi

apt-get update -qq
apt-get install -y -qq python3-venv python3-pip

# ── Code ────────────────────────────────────────────────────────────────
mkdir -p "$APP_DIR"
install -m 644 "$SRC/app.py" "$APP_DIR/app.py"
install -m 644 "$SRC/requirements.txt" "$APP_DIR/requirements.txt"

if [[ ! -d "$APP_DIR/.venv" ]]; then
  python3 -m venv "$APP_DIR/.venv"
fi
"$APP_DIR/.venv/bin/pip" install -q --upgrade pip
"$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"

# ── Data ────────────────────────────────────────────────────────────────
# Applications and uploaded documents live outside the web root, so nothing
# here is ever reachable over HTTP without going through the admin login.
mkdir -p "$DATA_DIR/uploads"
chown -R www-data:www-data "$DATA_DIR"
chmod 750 "$DATA_DIR"

# ── Configuration ───────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  ADMIN_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"
  cat > "$ENV_FILE" <<EOF
FIELDS_PATH=$WEBROOT/assets/fields.json
DATA_DIR=$DATA_DIR
ADMIN_USER=admin
ADMIN_PASSWORD=$ADMIN_PASSWORD
ALLOWED_ORIGIN=https://www.$DOMAIN
EOF
  echo
  echo "──────────────────────────────────────────────────────"
  echo "  Admin login created — store this somewhere safe:"
  echo "    https://www.$DOMAIN/admin"
  echo "    username: admin"
  echo "    password: $ADMIN_PASSWORD"
  echo "──────────────────────────────────────────────────────"
  echo
else
  echo "Keeping the existing configuration in $ENV_FILE"
fi
chown root:www-data "$ENV_FILE"
chmod 640 "$ENV_FILE"

# ── Service ─────────────────────────────────────────────────────────────
install -m 644 "$SRC/najafschool-api.service" /etc/systemd/system/najafschool-api.service
systemctl daemon-reload
systemctl enable najafschool-api
systemctl restart najafschool-api
sleep 2
systemctl is-active --quiet najafschool-api \
  || { echo "Service failed to start:"; journalctl -u najafschool-api -n 30 --no-pager; exit 1; }

# ── nginx ───────────────────────────────────────────────────────────────
# Insert the proxy rules into the existing TLS server block, just once.
NGINX_CONF=/etc/nginx/sites-available/$DOMAIN
if ! grep -q "location /api/" "$NGINX_CONF"; then
  python3 - "$NGINX_CONF" <<'PY'
import re, sys
path = sys.argv[1]
conf = open(path).read()
block = """
    # Application intake API and staff review area
    client_max_body_size 60m;

    location /api/ {
        proxy_pass http://127.0.0.1:8001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    location /admin {
        proxy_pass http://127.0.0.1:8001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
"""
# Add to the HTTPS server block (the one certbot created), else the only block.
marker = "listen 443"
idx = conf.find(marker)
if idx == -1:
    idx = conf.find("server {")
    insert_at = conf.index("{", idx) + 1
else:
    insert_at = conf.index("\n", idx) + 1
open(path, "w").write(conf[:insert_at] + block + conf[insert_at:])
print("nginx: proxy rules added")
PY
else
  echo "nginx: proxy rules already present"
fi

nginx -t
systemctl reload nginx

echo
echo "API installed. Checking it responds…"
curl -fsS http://127.0.0.1:8001/api/health && echo || echo "health check failed"
