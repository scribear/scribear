#!/bin/sh
#
# Writes the build-info.json that the static images in the stack report.
#
# The Node services answer GET /build-info from a route `createBaseServer`
# registers for them, and transcription-service builds the same payload in
# Python. The webapps and the reverse proxy have no process to ask - they are
# nginx serving files - so the identical document is generated here at image
# build time and served as a static file.
#
# One script rather than a copy of this logic per Dockerfile: five hand-written
# JSON serializers in shell is five places for the stack's containers to start
# disagreeing about their own shape, which is precisely the failure the
# Deployment Check exists to catch.
#
# Usage: write-build-info.sh <service-name> <output-path>
#
# Reads BUILD_COMMIT, BUILD_REF, BUILD_TIME, BUILD_VERSION, BUILD_TAGS,
# BUILD_PR and BUILD_ORIGIN from the environment, all optional. See any
# service Dockerfile for where they come from.

set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <service-name> <output-path>" >&2
  exit 2
fi

service="$1"
output="$2"

# Minimal JSON string escaping. Every input is a git ref, a SHA, an ISO
# timestamp, a semver string or an image tag, so backslash and double quote are
# the only characters that can realistically appear and break the document.
escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Missing fields become the same "unknown" literal the Node and Python readers
# use, so an unstamped image reads identically whichever container answered.
default() {
  if [ -z "${1:-}" ]; then printf 'unknown'; else printf '%s' "$1"; fi
}

# The `-dirty` suffix rides on the commit (the `git describe --dirty`
# convention) so that `docker inspect`'s revision label carries it too. It is
# split back out here into a boolean the console can render without
# string-matching.
commit="$(default "${BUILD_COMMIT:-}")"
dirty=false
case "$commit" in
  *-dirty)
    dirty=true
    commit="${commit%-dirty}"
    ;;
esac

# A JSON number or null, never a string: the console shows "PR #123" only when
# this is genuinely a number, and every non-PR build passes the arg empty.
pull_request=null
case "${BUILD_PR:-}" in
  '' | 0 | *[!0-9]*) ;;
  *) pull_request="${BUILD_PR}" ;;
esac

origin="${BUILD_ORIGIN:-}"
case "$origin" in
  ci | local) ;;
  *) origin=unknown ;;
esac

# BUILD_TAGS arrives comma-joined, because a --build-arg cannot be an array.
# Empty is the normal case on a PR build, which publishes nothing. Globbing is
# disabled around the split so a tag containing `*` or `?` is not expanded
# against the image's filesystem.
tags=''
set -f
old_ifs="$IFS"
IFS=','
for tag in ${BUILD_TAGS:-}; do
  [ -n "$tag" ] || continue
  if [ -z "$tags" ]; then
    tags="\"$(escape "$tag")\""
  else
    tags="$tags,\"$(escape "$tag")\""
  fi
done
IFS="$old_ifs"
set +f

mkdir -p "$(dirname "$output")"

printf '{"service":"%s","version":"%s","commit":"%s","ref":"%s","builtAt":"%s","imageTags":[%s],"pullRequest":%s,"origin":"%s","dirty":%s}\n' \
  "$(escape "$service")" \
  "$(escape "$(default "${BUILD_VERSION:-}")")" \
  "$(escape "$commit")" \
  "$(escape "$(default "${BUILD_REF:-}")")" \
  "$(escape "$(default "${BUILD_TIME:-}")")" \
  "$tags" \
  "$pull_request" \
  "$(escape "$origin")" \
  "$dirty" \
  >"$output"
