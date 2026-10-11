#!/bin/bash
# Deploy a commit as the running LaunchAgent.
#   deploy/deploy.sh <git-ref>
# Builds the commit in ~/.aye-links/releases/<sha> and tests it there. Only if that succeeds does
# it stop the service, wait for every process using aye.env to exit, back up the database, point
# ~/.aye-links/current at the new release and start the service again. A failed build leaves the
# running install untouched. A failed start prints recovery commands that go back to
# ~/.aye-links/known-good, the last release that served.
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

# Stopped means no process is using aye.env (the server or the key CLI): bootout returns before
# the process has exited.
stop_and_wait() {
  launchctl bootout "$domain/$label" 2>/dev/null || true
  for _ in $(seq 50); do
    pgrep -f -- "--env-file=$env_file" > /dev/null || return 0
    sleep 0.5
  done
  return 1
}

switch_to() { ln -sfn "$1" "$home/current.new" && mv -fh "$home/current.new" "$home/current"; }

# Keeps what current and known-good point to, the 10 newest backups, and every failed-* file.
prune() {
  local keep_current keep_good r backups
  keep_current="$(readlink "$home/current" || true)"
  keep_good="$(readlink "$home/known-good" || true)"
  for r in "$home"/releases/*; do
    [ -e "$r" ] || continue
    [ "$r" = "$keep_current" ] || [ "$r" = "$keep_good" ] || rm -rf "$r"
  done
  backups=("$home"/data/backups/links-*.db)
  if [ -e "${backups[0]}" ] && [ "${#backups[@]}" -gt 10 ]; then
    rm -f -- "${backups[@]:0:${#backups[@]}-10}"
  fi
}

# Stops the service, then prints how to get back to known-good. The schema is compared only once
# nothing can still write to the database.
recover() {
  local known_good switch_cmd="" restore_cmd failed_db
  touch "$release/.failed"
  known_good="$(readlink "$home/known-good" || true)"
  if [ -n "$known_good" ]; then
    switch_cmd="ln -sfn \"$known_good\" \"$home/current.new\" && mv -fh \"$home/current.new\" \"$home/current\" && launchctl bootstrap $domain \"$plist\""
  else
    echo "There is no known-good release to go back to." >&2
  fi
  if ! stop_and_wait; then
    echo "A process using $env_file is still running after 25 s; nothing was restarted. Once 'pgrep -f -- --env-file=$env_file' prints nothing, run the commands below." >&2
  fi
  if [ -n "$backup" ] && [ -f "$db" ] &&
    [ "$(sqlite3 "$db" 'pragma user_version')" != "$(sqlite3 "$backup" 'pragma user_version')" ]; then
    failed_db="$home/data/backups/failed-$(date +%Y%m%d-%H%M%S).db"
    restore_cmd="sqlite3 \"$db\" '.backup \"$failed_db\"' && sqlite3 \"$db\" '.restore \"$backup\"'"
    echo "The failed release changed the database schema and older releases refuse it. Save the failed database, restore the backup, switch back and start:" >&2
    echo "  $restore_cmd${switch_cmd:+ && $switch_cmd}" >&2
    echo "This undoes every change since $backup, including key revocations and new links; run the revocations again afterwards." >&2
  elif [ -n "$switch_cmd" ]; then
    echo "Switch back and start the service:" >&2
    echo "  $switch_cmd" >&2
  fi
}

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

backup=""
switched=0

if ! stop_and_wait; then
  echo "A process using $env_file is still running after 25 s. Nothing was changed or started." >&2
  echo "Once 'pgrep -f -- --env-file=$env_file' prints nothing, start the service with: launchctl bootstrap $domain \"$plist\"" >&2
  exit 1
fi
trap '
  if [ "$switched" = 0 ] && [ -f "$plist" ] && stop_and_wait && launchctl bootstrap "$domain" "$plist"; then
    echo "The deploy failed before anything was switched. The previous release (${previous:-none}) is running again." >&2
  else
    echo "The deploy failed and the service is stopped." >&2
    recover
  fi
' ERR

if [ -f "$db" ]; then
  backup="$home/data/backups/links-$(date +%Y%m%d-%H%M%S).db"
  sqlite3 "$db" ".backup \"$backup\""
fi

switched=1
mv -f "$plist.new" "$plist"
switch_to "$release"
# The release being replaced served until now, so recovery can go back to it. One that failed to
# start is never promoted, and a retry of the same release leaves known-good alone.
if [ -n "$previous" ] && [ "$previous" != "$release" ] && [ -d "$previous" ] && [ ! -e "$previous/.failed" ]; then
  ln -sfn "$previous" "$home/known-good.new"
  mv -fh "$home/known-good.new" "$home/known-good"
fi
launchctl bootstrap "$domain" "$plist"
trap - ERR

for _ in $(seq 30); do
  pid="$(service_pid)"
  if [ -n "$pid" ] && [ -n "$(lsof -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN -t 2> /dev/null || true)" ]; then
    rm -f "$release/.failed"
    prune
    echo "Deployed $sha."
    exit 0
  fi
  sleep 0.5
done

echo "Deployed $sha but the service is not listening on 127.0.0.1:$port after 15 s. Stopping it." >&2
recover
exit 1
