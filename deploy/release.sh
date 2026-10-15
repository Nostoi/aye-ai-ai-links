#!/bin/bash
# Names a deploy and publishes it as a GitHub release. Run it from this checkout where `gh` is
# signed in; the server needs no GitHub login.
#   deploy/release.sh next <sha>               prints the version to deploy <sha> as
#   deploy/release.sh publish <version> <sha>  tags <sha> and makes its release with generated notes
# Run publish only after `deploy/deploy.sh <sha> <version>` has exited 0, so a deploy that failed
# or rolled back is never tagged. Both are safe to run again.
set -euo pipefail

pattern='^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]+)?$'
api="repos/{owner}/{repo}"

commit() { git rev-parse --verify "$1^{commit}"; }

# tag_commit <version>: the commit a tag points at, through an annotated tag object if it is one.
tag_commit() {
  local type sha
  read -r type sha < <(gh api "$api/git/ref/tags/$1" --jq '.object.type + " " + .object.sha') || return 1
  [ -n "$sha" ] || return 1
  if [ "$type" = tag ]; then
    gh api "$api/git/tags/$sha" --jq .object.sha
  else
    printf '%s\n' "$sha"
  fi
}

next() {
  local sha tags today
  sha="$(commit "$1")"
  tags="$(gh api --paginate "$api/tags" --jq '.[] | .name + " " + .commit.sha')"
  # A commit already tagged keeps its name, so deploying it again makes no second release.
  awk -v sha="$sha" '
    $2 == sha && $1 ~ /^v[0-9][0-9][0-9][0-9]\.[0-9][0-9]\.[0-9][0-9](\.[0-9]+)?$/ { print $1; found = 1; exit }
    END { exit !found }' <<< "$tags" && return 0
  today="v$(date +%Y.%m.%d)"
  awk -v day="$today" '
    $1 == day { n = (n > 1 ? n : 1) }
    index($1, day ".") == 1 { s = substr($1, length(day) + 2); if (s ~ /^[0-9]+$/ && s + 0 > n) n = s + 0 }
    END { print (n ? day "." (n + 1) : day) }' <<< "$tags"
}

publish() {
  local version="$1" sha target err url
  [[ "$version" =~ $pattern ]] || { echo "The version must look like v2026.10.14 or v2026.10.14.2, not $version." >&2; exit 1; }
  sha="$(commit "$2")"
  # Creating the tag fails if it exists, so another commit can never take over a name.
  if ! err="$(gh api -X POST "$api/git/refs" -f ref="refs/tags/$version" -f sha="$sha" --jq .ref 2>&1)"; then
    if ! target="$(tag_commit "$version")"; then
      echo "Could not create tag $version, and it does not exist: $err" >&2
      exit 1
    fi
    if [ "$target" != "$sha" ]; then
      echo "Tag $version already points at $target, not $sha. Nothing was published." >&2
      exit 1
    fi
  fi
  if url="$(gh api "$api/releases/tags/$version" --jq .html_url 2> /dev/null)"; then
    echo "The release for $version already exists: $url" >&2
    return 0
  fi
  gh api -X POST "$api/releases" -f tag_name="$version" -f name="$version" -F generate_release_notes=true --jq .html_url
}

case "${1:-}" in
  next) next "${2:?Usage: deploy/release.sh next <sha>}" ;;
  publish) publish "${2:?Usage: deploy/release.sh publish <version> <sha>}" "${3:?Usage: deploy/release.sh publish <version> <sha>}" ;;
  *)
    echo "Usage: deploy/release.sh next <sha> | publish <version> <sha>" >&2
    exit 1
    ;;
esac
