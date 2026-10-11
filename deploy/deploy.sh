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

read_env() { env -i "$node_path" --env-file="$env_file" -e "console.log(process.env.$1 ?? \"$2\")"; }
service_pid() { { launchctl print "$domain/$label" 2>/dev/null || true; } | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' | head -n 1; }

db="$(read_env AYE_DB "")"
port="$(read_env AYE_PORT 3002)"
[ -n "$db" ] || { echo "AYE_DB is not set in $env_file." >&2; exit 1; }

own_pid="$(service_pid)"
for pid in $(lsof -iTCP:"$port" -sTCP:LISTEN -t || true); do
  if [ "$pid" != "$own_pid" ]; then
    echo "Process $pid is already listening on port $port and it is not the $label service. Nothing was changed." >&2
    exit 1
  fi
done

previous="$(readlink "$home/current" || true)"
sed -e "s#@NODE@#$node_path#g" -e "s#@HOME@#$HOME#g" "$release/deploy/$label.plist" > "$plist.new"

switched=0

launchctl bootout "$domain/$label" 2>/dev/null || true
trap '
  if [ "$switched" = 0 ] && [ -f "$plist" ] && launchctl bootstrap "$domain" "$plist"; then
    echo "The deploy failed before anything was switched. The previous release (${previous:-none}) is running again." >&2
  else
    echo "The service is stopped. Restart it with: launchctl bootstrap $domain \"$plist\" (previous release: ${previous:-none})" >&2
  fi
' ERR

if [ -f "$db" ]; then
  sqlite3 "$db" ".backup \"$home/data/backups/links-$(date +%Y%m%d-%H%M%S).db\""
fi

switched=1
mv -f "$plist.new" "$plist"
ln -sfn "$release" "$home/current.new"
mv -fh "$home/current.new" "$home/current"
launchctl bootstrap "$domain" "$plist"
trap - ERR

for _ in $(seq 30); do
  pid="$(service_pid)"
  if [ -n "$pid" ] && [ -n "$(lsof -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)" ]; then
    echo "Deployed $sha."
    exit 0
  fi
  sleep 0.5
done

echo "Deployed $sha but the service is not listening on 127.0.0.1:$port after 15 s. Previous release: ${previous:-none}." >&2
echo "Roll back: ln -sfn \"${previous:-<previous release>}\" \"$home/current.new\" && mv -fh \"$home/current.new\" \"$home/current\"; launchctl bootout $domain/$label; launchctl bootstrap $domain \"$plist\"" >&2
exit 1
