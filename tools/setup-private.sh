#!/bin/sh
# One-time: puts the private part (engine/plugins: job sites, company-site checks) in its own PRIVATE repository
# and lets the public repository's GitHub runs read it with a read-only deploy key.
#   sh tools/setup-private.sh
set -e
cd "$(dirname "$0")/.."
OWNER=Neca1990
PRIVATE=$OWNER/jobhuntmate-sources
PUBLIC=$OWNER/jobhuntmate

echo "Pravim privatni repozitorijum…"
gh repo view "$PRIVATE" >/dev/null 2>&1 || gh repo create "$PRIVATE" --private --description "Private part of the job search" >/dev/null
[ "$(gh repo view "$PRIVATE" --json visibility -q .visibility)" = "PRIVATE" ] || { echo "Repozitorijum nije privatan – prekidam."; exit 1; }

echo "Šaljem privatni deo…"
cd engine/plugins
git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$PRIVATE.git"
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -q -u origin main
cd ../..

echo "Pravim ključ samo za čitanje…"
umask 077
KEY=$(mktemp -d)/deploy_key
ssh-keygen -q -t ed25519 -N "" -C "jobhuntmate runs" -f "$KEY"
gh repo deploy-key add "$KEY.pub" -R "$PRIVATE" -t "public repo runs (read-only)" >/dev/null
gh secret set SOURCES_DEPLOY_KEY -R "$PUBLIC" < "$KEY"
rm -f "$KEY" "$KEY.pub"
echo "Gotovo: privatni deo je u $PRIVATE, a javna pokretanja ga čitaju ključem samo za čitanje."
