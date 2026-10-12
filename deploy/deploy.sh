#!/bin/bash
# Deploy a commit as the running LaunchAgent.
#   deploy/deploy.sh <git-ref>
# Builds the commit in ~/.aye-links/releases/<sha> and tests it there, then downloads and checks
# the meaning-search model in ~/.aye-links/models. Only if both succeed does it stop the service,
# wait for every process using aye.env to exit, back up the database, point ~/.aye-links/current
# at the new release and start the service again. A failed build or model check leaves the
# running install untouched.
# Run it from the source checkout, or set AYE_SOURCE to one. Run deploys and key commands one at a time.
set -eEuo pipefail

ref="${1:?Usage: deploy/deploy.sh <git-ref>}"
source_repo="${AYE_SOURCE:-$(cd "$(dirname "$0")/.." && pwd)}"
home="$HOME/.aye-links"
env_file="$home/aye.env"
pending="$home/recovery-pending"
label="com.aye-links"
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"

if [ -e "$pending" ]; then
  echo "An earlier deploy could not roll back. Fix the install by hand, then delete $pending. It says:" >&2
  cat "$pending" >&2
  exit 1
fi
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

# Runs on every deploy, since the model lives outside the release. No --env-file: stop_and_wait
# looks for that argument, and the check needs no settings.
if [ -e "$release/dist/cli/prefetch-model-main.js" ] && ! "$node_path" "$release/dist/cli/prefetch-model-main.js"; then
  echo "Model prefetch failed for $sha. The running install was not changed." >&2
  exit 1
fi

read_env() { env -i "$node_path" --env-file="$env_file" -e "console.log(process.env.$1 ?? \"$2\")"; }
service_pid() { { launchctl print "$domain/$label" 2>/dev/null || true; } | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' | head -n 1; }

# Stopped means no process is using aye.env (the server or the key CLI): bootout returns before
# the process has exited.
stop_and_wait() {
  local rc
  launchctl bootout "$domain/$label" 2>/dev/null || true
  for _ in $(seq 50); do
    rc=0
    pgrep -f -- "--env-file=$env_file" > /dev/null || rc=$?
    [ "$rc" != 1 ] || return 0
    [ "$rc" = 0 ] || return 1
    sleep 0.5
  done
  echo "A process using $env_file is still running after 25 s." >&2
  return 1
}

listening() {
  local pid
  for _ in $(seq 30); do
    pid="$(service_pid)"
    if [ -n "$pid" ] && [ -n "$(lsof -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN -t 2> /dev/null || true)" ]; then return 0; fi
    sleep 0.5
  done
  return 1
}

point_to() { ln -sfn "$2" "$1.new" && mv -fh "$1.new" "$1"; }

prune() {
  local r f backups rc=0
  for r in "$home"/releases/*; do
    [ -e "$r" ] || continue
    [ "$r" = "$release" ] || [ "$r" = "$previous" ] || { rm -f "$r/.ready" && rm -rf "$r"; } || rc=1
  done
  backups=("$home"/data/backups/links-*.db)
  if [ -e "${backups[0]}" ] && [ "${#backups[@]}" -gt 10 ]; then
    for f in "${backups[@]:0:${#backups[@]}-10}"; do
      rm -f -- "$f" "$f-wal" "$f-shm" || rc=1
    done
  fi
  return "$rc"
}

set_aside() {
  local f target
  target="$home/data/backups/failed-$(date +%Y%m%d-%H%M%S)-$$.db"
  for f in "" -wal -shm; do
    if [ -e "$target$f" ]; then return 1; fi
  done
  for f in "" -wal -shm; do
    if [ -e "$db$f" ]; then mv "$db$f" "$target$f" || return 1; failed_db="$target"; fi
  done
}

give_up() {
  local stop_note="The service is stopped." note moved=none
  if [ "$1" = stop ] || ! stop_and_wait; then stop_note="Stopping the service is unconfirmed."; fi
  if [ -e "$plist" ]; then moved="$home/$label.plist.disabled"; mv -f "$plist" "$moved" || moved="nowhere; it is still $plist"; fi
  note="deploy of $sha failed and its rollback did not finish ($(date))
failed step: $1
previous release: ${previous:-none}
current: $(readlink "$home/current" || echo none)
backup: ${backup:-none}
failed database: ${failed_db:-none}
plist moved to: $moved"
  printf '%s\n' "$note" > "$pending" || echo "Could not write $pending." >&2
  echo "The deploy failed and the rollback failed at: $1. $stop_note" >&2
  echo "Fix the install by hand, then delete $pending; deploys refuse to run until then." >&2
  printf '%s\n' "$note" >&2
  exit 1
}

rollback() {
  local failed_db="" live_uv="-" kept=""
  [ "$BASH_SUBSHELL" = 0 ] || exit 1
  [ "$rolling_back" = 0 ] || return 0
  rolling_back=1
  trap - ERR
  trap '' INT TERM HUP
  set +e
  stop_and_wait || give_up stop
  if [ "$switched" = 0 ]; then
    if [ ! -f "$plist" ]; then
      echo "The deploy failed before anything was switched, and there was no service to restart. The service is stopped." >&2
      exit 1
    fi
    launchctl bootstrap "$domain" "$plist" || give_up bootstrap
    listening || give_up "listen check"
    echo "The deploy failed before anything was switched. The previous release (${previous:-none}) is running again." >&2
    exit 1
  fi
  if [ -n "$backup" ]; then
    [ -f "$backup" ] || give_up "read the backup"
    if [ -f "$db" ]; then live_uv="$(sqlite3 "$db" 'pragma user_version')" || give_up "read the database"; fi
    if [ "$live_uv" != "$backup_uv" ]; then
      set_aside || give_up "rename the database"
      if ! sqlite3 "$db" ".restore \"$backup\"" || [ "$(sqlite3 "$db" 'pragma user_version')" != "$backup_uv" ]; then
        give_up "restore the backup"
      fi
    fi
  elif [ -f "$db" ]; then
    set_aside || give_up "rename the database"
  fi
  [ -z "$failed_db" ] || kept=" Writes accepted by the failed release are kept in $failed_db and were not merged back."
  if [ -z "$previous" ]; then
    rm -f "$home/current" "$plist" || give_up "remove current and the plist"
    echo "The deploy failed and there is no previous release, so $home/current and the plist were removed. The service is stopped.$kept" >&2
    exit 1
  fi
  { sed -e "s#@NODE@#$node_path#g" -e "s#@HOME@#$HOME#g" "$previous/deploy/$label.plist" > "$plist.new" && mv -f "$plist.new" "$plist"; } || give_up "render the plist"
  point_to "$home/current" "$previous" || give_up "point current at the previous release"
  launchctl bootstrap "$domain" "$plist" || give_up bootstrap
  listening || give_up "listen check"
  echo "Rolled back to $previous, which is running.$kept" >&2
  exit 1
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
backup_uv=""
switched=0
rolling_back=0
trap rollback ERR INT TERM HUP

if ! stop_and_wait; then
  trap - ERR INT TERM HUP
  echo "The service was told to stop, but that is unconfirmed. Nothing was changed or started." >&2
  exit 1
fi

if [ -f "$db" ]; then
  backup="$home/data/backups/links-$(date +%Y%m%d-%H%M%S).db"
  sqlite3 "$db" ".backup \"$backup\""
  backup_uv="$(sqlite3 "$backup" 'pragma user_version')"
fi

switched=1
mv -f "$plist.new" "$plist"
point_to "$home/current" "$release"
launchctl bootstrap "$domain" "$plist"
if ! listening; then
  echo "Deployed $sha but the service is not listening on 127.0.0.1:$port after 15 s. Rolling back." >&2
  rollback
fi
trap - ERR INT TERM HUP

echo "Deployed $sha."
prune || echo "Warning: removing old releases or backups failed. The deploy itself succeeded." >&2
