#!/bin/bash
# Deploy a commit as the running LaunchAgent.
#   deploy/deploy.sh <git-ref>
# Builds the commit in ~/.aye-links/releases/<sha> and tests it there. Only if that succeeds does
# it stop the service, back up the database, point ~/.aye-links/current at the new release and
# start the service again. A failed build leaves the running install untouched.
# Run it from the source checkout, or set AYE_SOURCE to one. Run deploys and key commands one at a time.
set -euo pipefail

ref="${1:?Usage: deploy/deploy.sh <git-ref>}"
source_repo="${AYE_SOURCE:-$(cd "$(dirname "$0")/.." && pwd)}"
home="$HOME/.aye-links"
env_file="$home/aye.env"
label="com.aye-links"
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"

[ -f "$env_file" ] || { echo "Missing $env_file. Create it first (see README, \"Run it on your Mac\")." >&2; exit 1; }
node_path="$(command -v node)" || { echo "node is not on PATH." >&2; exit 1; }

sha="$(git -C "$source_repo" rev-parse --verify "$ref^{commit}")"
release="$home/releases/$sha"

mkdir -p "$home/releases" "$home/data/backups" "$home/logs" "$HOME/Library/LaunchAgents"

# A release is complete only once .ready exists; a leftover without it is a failed build.
if [ ! -e "$release/.ready" ]; then
  rm -rf "$release"
  mkdir "$release"
  # Chained with && because errexit does not apply inside a tested subshell.
  if ! (
    git -C "$source_repo" archive "$sha" | tar -x -C "$release" &&
      cd "$release" &&
      npm ci &&
      npm run build &&
      npm test &&
      touch .ready
  ); then
    rm -rf "$release"
    echo "Build or tests failed for $sha. The running install was not changed." >&2
    exit 1
  fi
fi

launchctl bootout "$domain/$label" 2>/dev/null || true

db="$(sed -n 's/^AYE_DB=//p' "$env_file" | tail -1 | sed -e 's/^"//' -e 's/"$//')"
if [ -n "$db" ] && [ -f "$db" ]; then
  sqlite3 "$db" ".backup $home/data/backups/links-$(date +%Y%m%d-%H%M%S).db"
fi

previous="$(readlink "$home/current" || true)"
ln -sfn "$release" "$home/current.new"
mv -fh "$home/current.new" "$home/current"

sed -e "s#@NODE@#$node_path#g" -e "s#@HOME@#$HOME#g" "$source_repo/deploy/$label.plist" > "$plist.new"
mv -f "$plist.new" "$plist"

if ! launchctl bootstrap "$domain" "$plist"; then
  echo "Deployed $sha but the service did not start. Previous release: ${previous:-none}." >&2
  exit 1
fi
echo "Deployed $sha."
