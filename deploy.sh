#!/usr/bin/env bash
#
# Deploy the site to the web server over SSH.
#
#   ./deploy.sh            # upload
#   ./deploy.sh --dry-run  # show exactly what would change, upload nothing
#
# Settings come from deploy.env (copy deploy.env.example and edit it).
# deploy.env is git-ignored so server details stay out of the repository.

set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f deploy.env ]]; then
  echo "deploy.env not found. Copy deploy.env.example to deploy.env and fill it in." >&2
  exit 1
fi
# shellcheck disable=SC1091
source deploy.env

: "${SSH_HOST:?set SSH_HOST in deploy.env}"
: "${SSH_USER:?set SSH_USER in deploy.env}"
: "${REMOTE_PATH:?set REMOTE_PATH in deploy.env}"
SSH_PORT="${SSH_PORT:-22}"

# Identity file is optional — without it, ssh falls back to the agent and
# to the default keys in ~/.ssh.
SSH_OPTS="-p ${SSH_PORT}"
if [[ -n "${SSH_KEY:-}" ]]; then
  [[ -f "${SSH_KEY}" ]] || { echo "SSH_KEY not found: ${SSH_KEY}" >&2; exit 1; }
  SSH_OPTS="${SSH_OPTS} -i ${SSH_KEY} -o IdentitiesOnly=yes"
fi

DRY_RUN=()
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=(--dry-run)
  echo "── DRY RUN — nothing will be uploaded ──"
fi

echo "Deploying to ${SSH_USER}@${SSH_HOST}:${REMOTE_PATH}"

# --delete removes files on the server that no longer exist locally, so the
# remote directory always mirrors the repository exactly. Everything listed in
# --exclude is repository tooling that must never be served publicly.
rsync -avz --checksum ${DRY_RUN[@]+"${DRY_RUN[@]}"} \
  --delete \
  --exclude '.git/' \
  --exclude '.gitignore' \
  --exclude '.claude/' \
  --exclude 'deploy.sh' \
  --exclude 'deploy.env' \
  --exclude 'deploy.env.example' \
  --exclude '.DS_Store' \
  --exclude 'server-setup.sh' \
  --exclude 'server/' \
  --exclude 'README.md' \
  -e "ssh ${SSH_OPTS}" \
  ./ "${SSH_USER}@${SSH_HOST}:${REMOTE_PATH}"

echo
echo "Done. ${SITE_URL:-Check the site in a browser.}"
