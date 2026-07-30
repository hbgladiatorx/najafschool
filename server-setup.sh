#!/usr/bin/env bash
#
# One-time web server setup. Run this ON THE SERVER, as a user with sudo:
#
#   sudo bash server-setup.sh
#
# Installs and configures nginx to serve the site over HTTPS, with a
# Let's Encrypt certificate that renews itself. Safe to re-run.
#
# Afterwards, deploy site files from your laptop with ./deploy.sh — this
# script only prepares the server, it does not upload the site.

set -euo pipefail

DOMAIN="najaf.school"
WWW_DOMAIN="www.najaf.school"
WEBROOT="/var/www/${DOMAIN}"
# Let's Encrypt sends expiry warnings here. Override when running:
#   CERT_EMAIL=you@example.com sudo -E bash server-setup.sh
CERT_EMAIL="${CERT_EMAIL:-}"
# The account that runs deploy.sh; it owns the web root so uploads need no sudo.
DEPLOY_USER="${DEPLOY_USER:-${SUDO_USER:-ubuntu}}"

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash server-setup.sh" >&2
  exit 1
fi

# ── Packages ────────────────────────────────────────────────────────────
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq nginx certbot python3-certbot-nginx rsync
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q nginx certbot python3-certbot-nginx rsync
elif command -v yum >/dev/null 2>&1; then
  yum install -y -q nginx certbot python3-certbot-nginx rsync
else
  echo "No supported package manager found (apt/dnf/yum)." >&2
  exit 1
fi

# ── Web root ────────────────────────────────────────────────────────────
mkdir -p "${WEBROOT}"
if [[ ! -f "${WEBROOT}/index.html" ]]; then
  echo "<!doctype html><title>${DOMAIN}</title><p>Server ready. Awaiting deployment." \
    > "${WEBROOT}/index.html"
fi
# Owned by the deploying user so ./deploy.sh works without sudo, group-readable
# by the web server. setgid keeps the group on files rsync creates later.
WEB_GROUP=$(getent group www-data >/dev/null && echo www-data || echo nginx)
chown -R "${DEPLOY_USER}:${WEB_GROUP}" "${WEBROOT}"
chmod -R 2755 "${WEBROOT}"

# ── nginx site ──────────────────────────────────────────────────────────
# Plain HTTP only at this stage; certbot rewrites this file to add the TLS
# server block and the HTTP-to-HTTPS redirect once the certificate exists.
if [[ -d /etc/nginx/sites-available ]]; then
  CONF="/etc/nginx/sites-available/${DOMAIN}"
  LINK="/etc/nginx/sites-enabled/${DOMAIN}"
else
  CONF="/etc/nginx/conf.d/${DOMAIN}.conf"
  LINK=""
fi

cat > "${CONF}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} ${WWW_DOMAIN};

    root ${WEBROOT};
    index index.html;

    charset utf-8;

    location / {
        try_files \$uri \$uri/ =404;
    }

    # Long cache for fingerprinted assets; index.html must stay fresh so
    # content edits appear immediately.
    location ~* \.(css|js|svg|png|jpg|jpeg|webp|woff2?)$ {
        expires 30d;
        add_header Cache-Control "public";
    }
    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    gzip on;
    gzip_types text/css application/javascript image/svg+xml;
    gzip_min_length 512;
}
EOF

[[ -n "${LINK}" ]] && ln -sf "${CONF}" "${LINK}"
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable --now nginx
systemctl reload nginx

# ── Firewall (host level; the EC2 security group is separate) ────────────
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 'Nginx Full' || true
fi
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http --add-service=https || true
  firewall-cmd --reload || true
fi

# ── TLS certificate ─────────────────────────────────────────────────────
# Requires both names to already resolve to this server, and ports 80/443
# to be reachable from the internet, or the challenge will fail.
echo
echo "Requesting a Let's Encrypt certificate for ${DOMAIN} and ${WWW_DOMAIN}…"
CERTBOT_ARGS=(--nginx -d "${DOMAIN}" -d "${WWW_DOMAIN}"
              --redirect --non-interactive --agree-tos)
if [[ -n "${CERT_EMAIL}" ]]; then
  CERTBOT_ARGS+=(-m "${CERT_EMAIL}")
else
  CERTBOT_ARGS+=(--register-unsafely-without-email)
fi

if certbot "${CERTBOT_ARGS[@]}"; then
  systemctl reload nginx
  echo
  echo "HTTPS is live: https://${WWW_DOMAIN}"
else
  echo
  echo "Certificate request failed — the site is still served over plain HTTP." >&2
  echo "Usual causes: DNS not pointing here yet, or ports 80/443 blocked by the" >&2
  echo "EC2 security group. Fix that, then re-run this script." >&2
fi

# certbot installs its own renewal timer; confirm it is active.
systemctl list-timers 2>/dev/null | grep -q certbot \
  && echo "Automatic renewal is scheduled." \
  || echo "Note: check that certbot's renewal timer/cron is enabled."

echo
echo "Server ready. Web root: ${WEBROOT}"
echo "Now deploy the site from your laptop:  ./deploy.sh"
