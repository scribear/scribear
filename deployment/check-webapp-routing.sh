#!/usr/bin/env bash
#
# Diagnoses the "kiosk/client/standalone content is swapped" symptom reported
# against a running scribear stage/prod deployment.
#
# Checks, independently, at each layer where a swap could be introduced:
#   1. Which image (repo:tag + underlying image ID) each webapp container is
#      actually running, and whether more than one container shares an image ID.
#   2. What each webapp container serves when queried directly (bypassing
#      nginx), compared against the app name we expect from its container name.
#   3. What the running nginx container's baked-in nginx.conf actually maps
#      each /client/, /kiosk/, /standalone/ location to.
#   4. What comes back through nginx itself (the end-to-end path IT tested),
#      compared against the same expectation.
#
# Run this ON the docker host (needs `docker` CLI access to the compose
# project's containers). Read-only: only runs `docker inspect`, `docker exec`
# of read-only commands (wget/cat), and `docker images`.
#
# If ONSITE_ALLOWLIST_PATH (see UPGRADING.md) is set to a real allowlist,
# section 4's "curl https://localhost/..." may get redirected to /extlanding
# instead of the app's real content - handled below, not a routing bug, and
# expected. Whether it actually happens depends on Docker's own compose
# network bridge gateway address (what nginx sees curl-from-the-host as),
# which is assigned per-project and outside your control - it may coincide
# with a private range your allowlist admits, in which case this section
# passes/fails exactly as it did before this feature existed. Neither outcome
# says anything about whether the onsite gate itself is working; that's
# infra/scribear-nginx/tests/unit/onsite-gate.test.ts's job, not this
# script's.
#
# Usage:
#   ./check-webapp-routing.sh [compose-project-name-or-container-prefix]
#
# If no argument is given, containers are located by name substring match
# against client-webapp / kiosk-webapp / standalone-webapp / nginx, which
# works for any `docker compose` project name.

set -uo pipefail

PREFIX="${1:-}"
FAILURES=()
WARNINGS=()

hr() { printf '%s\n' "--------------------------------------------------------------------"; }
section() { echo; hr; echo "## $1"; hr; }
ok()   { printf '  [OK]   %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1"; FAILURES+=("$1"); }
warn() { printf '  [WARN] %s\n' "$1"; WARNINGS+=("$1"); }
info() { printf '  [INFO] %s\n' "$1"; }

if ! command -v docker >/dev/null 2>&1; then
  echo "docker CLI not found on PATH; this script must run on the docker host." >&2
  exit 1
fi

find_container() {
  # $1 = substring to match in container name (e.g. "client-webapp")
  local match="$1"
  local candidates
  if [ -n "$PREFIX" ]; then
    candidates=$(docker ps --format '{{.Names}}' | grep -- "$PREFIX" | grep -- "$match" || true)
  else
    candidates=$(docker ps --format '{{.Names}}' | grep -- "$match" || true)
  fi
  # If multiple match (e.g. "client-webapp" also matches a hypothetical
  # "client-webapp-canary"), prefer the shortest / most exact name.
  echo "$candidates" | awk '{ print length, $0 }' | sort -n | head -1 | cut -d' ' -f2-
}

CLIENT_C=$(find_container "client-webapp")
KIOSK_C=$(find_container "kiosk-webapp")
STANDALONE_C=$(find_container "standalone-webapp")
NGINX_C=$(find_container "nginx")

section "0. Containers located"
info "client-webapp     -> ${CLIENT_C:-<not found>}"
info "kiosk-webapp       -> ${KIOSK_C:-<not found>}"
info "standalone-webapp   -> ${STANDALONE_C:-<not found>}"
info "nginx              -> ${NGINX_C:-<not found>}"

for pair in "client-webapp:$CLIENT_C" "kiosk-webapp:$KIOSK_C" "standalone-webapp:$STANDALONE_C" "nginx:$NGINX_C"; do
  name="${pair%%:*}"; val="${pair#*:}"
  if [ -z "$val" ]; then
    bad "Could not find a running container for '$name' (docker ps had no match). Remaining checks for it will be skipped."
  fi
done

# ---------------------------------------------------------------------------
section "1. Image identity per container (repo:tag vs actual image ID)"
# ---------------------------------------------------------------------------
declare -A IMAGE_ID_OF
for pair in "client-webapp:$CLIENT_C" "kiosk-webapp:$KIOSK_C" "standalone-webapp:$STANDALONE_C"; do
  name="${pair%%:*}"; c="${pair#*:}"
  [ -z "$c" ] && continue
  configured_image=$(docker inspect --format '{{.Config.Image}}' "$c" 2>/dev/null)
  image_id=$(docker inspect --format '{{.Image}}' "$c" 2>/dev/null)
  created=$(docker inspect --format '{{.Created}}' "$c" 2>/dev/null)
  IMAGE_ID_OF["$name"]="$image_id"
  info "$name ($c)"
  info "    configured image : $configured_image"
  info "    running image ID : $image_id"
  info "    container created: $created"
done

# Flag if two of the three webapps are literally running the same image ID.
# This is the clearest possible signature of a mistagged/reused build.
names=(client-webapp kiosk-webapp standalone-webapp)
for i in "${!names[@]}"; do
  for j in "${!names[@]}"; do
    [ "$i" -ge "$j" ] && continue
    a="${names[$i]}"; b="${names[$j]}"
    ida="${IMAGE_ID_OF[$a]:-}"; idb="${IMAGE_ID_OF[$b]:-}"
    if [ -n "$ida" ] && [ -n "$idb" ] && [ "$ida" = "$idb" ]; then
      bad "$a and $b containers are running the IDENTICAL image ID ($ida) - they were built/tagged from the same content."
    fi
  done
done

# ---------------------------------------------------------------------------
section "2. Content served directly by each container (bypassing nginx)"
# ---------------------------------------------------------------------------
# Each app's index.html <title> is distinct:
#   client-webapp     -> "ScribeAR Client"
#   kiosk-webapp      -> "ScribeAR Kiosk"
#   standalone-webapp -> "ScribeAR - Live Captions"
declare -A EXPECT_TITLE=(
  [client-webapp]="ScribeAR Client"
  [kiosk-webapp]="ScribeAR Kiosk"
  [standalone-webapp]="ScribeAR - Live Captions"
)

fetch_title_direct() {
  # $1 = container name
  local c="$1"
  local body
  body=$(docker exec "$c" wget -qO- http://127.0.0.1/ 2>/dev/null) || \
  body=$(docker exec "$c" curl -sf http://127.0.0.1/ 2>/dev/null) || true
  printf '%s' "$body" | grep -o '<title>[^<]*</title>' | head -1 | sed -e 's/<title>//' -e 's/<\/title>//'
}

for pair in "client-webapp:$CLIENT_C" "kiosk-webapp:$KIOSK_C" "standalone-webapp:$STANDALONE_C"; do
  name="${pair%%:*}"; c="${pair#*:}"
  [ -z "$c" ] && continue
  title=$(fetch_title_direct "$c")
  expected="${EXPECT_TITLE[$name]}"
  if [ -z "$title" ]; then
    warn "$name ($c): could not fetch/parse title directly (wget/curl missing in container, or empty response)."
  elif [ "$title" = "$expected" ]; then
    ok "$name ($c) serves its own content directly. <title>$title</title>"
  else
    bad "$name ($c) is serving the WRONG app's content directly (not an nginx routing issue). Expected <title>$expected</title>, got <title>$title</title>."
  fi
done

# ---------------------------------------------------------------------------
section "3. nginx's baked-in routing config (location -> upstream)"
# ---------------------------------------------------------------------------
declare -A EXPECT_UPSTREAM=(
  [/client/]="client-webapp"
  [/kiosk/]="kiosk-webapp"
  [/standalone/]="standalone-webapp"
)

if [ -n "$NGINX_C" ]; then
  conf=$(docker exec "$NGINX_C" cat /etc/nginx/nginx.conf 2>/dev/null)
  if [ -z "$conf" ]; then
    warn "Could not read /etc/nginx/nginx.conf from $NGINX_C."
  else
    # Map upstream name -> backing server (e.g. "client-webapp" -> "client-webapp:80")
    declare -A UPSTREAM_SERVER
    while read -r uname userver; do
      [ -z "$uname" ] && continue
      UPSTREAM_SERVER["$uname"]="$userver"
    done < <(printf '%s\n' "$conf" | awk '/^\s*upstream/ { name=$2 } /server /{ if (name) { gsub(/[;{}]/,"",$2); print name, $2; name="" } }')

    for path in /client/ /kiosk/ /standalone/; do
      # Find "location <path> { ... proxy_pass http://<upstream>...; ... }"
      block=$(printf '%s\n' "$conf" | awk -v p="location $path" 'index($0,p){f=1} f{print; if(/}/ && f){exit}}')
      upstream=$(printf '%s' "$block" | grep -oP 'proxy_pass\s+http://\K[^/; ]+')
      expected="${EXPECT_UPSTREAM[$path]}"
      backing="${UPSTREAM_SERVER[$upstream]:-$upstream}"
      if [ -z "$upstream" ]; then
        warn "Could not find a proxy_pass for location $path in nginx.conf."
      elif [ "$upstream" = "$expected" ]; then
        ok "nginx location $path -> upstream '$upstream' (-> $backing) - correct."
      else
        bad "nginx location $path is pointed at upstream '$upstream' (-> $backing), expected '$expected'."
      fi
    done
  fi
else
  warn "Skipping nginx.conf check: no nginx container found."
fi

# ---------------------------------------------------------------------------
section "4. Content served through nginx end-to-end (what IT actually saw)"
# ---------------------------------------------------------------------------
fetch_via_nginx() {
  # $1 = path, e.g. /client/. Prints "STATUS\nLOCATION\nBODY" (LOCATION empty
  # if the response wasn't a redirect) - not following redirects, since a
  # redirect to /extlanding is itself a meaningful, distinguishable result
  # (see the onsite-gate check below), not something to chase through.
  local path="$1"
  local out
  out=$(curl -sk -D - -o - "https://localhost${path}" 2>/dev/null) || \
  out=$(curl -s -D - -o - "http://localhost${path}" 2>/dev/null) || true
  local status location body
  status=$(printf '%s' "$out" | head -1 | tr -d '\r')
  location=$(printf '%s' "$out" | grep -i '^location:' | head -1 | sed -e 's/^[Ll]ocation: *//' -e 's/\r$//')
  body=$(printf '%s' "$out" | awk 'f; /^\r?$/{f=1}')
  printf '%s\n%s\n%s' "$status" "$location" "$body"
}

declare -A EXPECT_TITLE_BY_PATH=(
  [/client/]="ScribeAR Client"
  [/kiosk/]="ScribeAR Kiosk"
  [/standalone/]="ScribeAR - Live Captions"
)

for path in /client/ /kiosk/ /standalone/; do
  result=$(fetch_via_nginx "$path")
  status=$(printf '%s\n' "$result" | sed -n '1p')
  location=$(printf '%s\n' "$result" | sed -n '2p')
  body=$(printf '%s\n' "$result" | sed -n '3,$p')
  expected="${EXPECT_TITLE_BY_PATH[$path]}"

  if [ -n "$location" ] && printf '%s' "$location" | grep -q '/extlanding'; then
    # The onsite-only access gate (nginx.conf's $onsite check) redirected
    # this request - expected and CORRECT if the deployment has a real
    # allowlist configured (ONSITE_ALLOWLIST_PATH), since this script runs
    # on the docker host itself and curl's "https://localhost" is loopback,
    # which is never on-campus/VPN under any real allowlist. Not a routing
    # bug, and not something this check can see past from localhost - if you
    # need to verify the actual app content, curl the same path from a
    # machine your allowlist actually admits.
    warn "https://localhost$path : redirected to /extlanding (onsite gate active). Inconclusive from localhost - this is expected if ONSITE_ALLOWLIST_PATH is set to a real allowlist; re-run this check from an allowlisted network to verify $path's actual content."
    continue
  fi

  title=$(printf '%s' "$body" | grep -o '<title>[^<]*</title>' | head -1 | sed -e 's/<title>//' -e 's/<\/title>//')
  if [ -z "$title" ]; then
    warn "https://localhost$path : no response / could not parse title (is nginx reachable on localhost from this host?)."
  elif [ "$title" = "$expected" ]; then
    ok "https://localhost$path -> <title>$title</title> - correct."
  else
    bad "https://localhost$path -> <title>$title</title>, expected <title>$expected</title>."
  fi
done

# ---------------------------------------------------------------------------
section "5. Locally cached images for these three repos (spot manual/stale tags)"
# ---------------------------------------------------------------------------
for repo_substr in client-webapp kiosk-webapp standalone-webapp; do
  info "Images matching '*$repo_substr*':"
  docker images --format '    {{.Repository}}:{{.Tag}}  {{.ID}}  created {{.CreatedSince}}' \
    | grep -- "$repo_substr" || info "    (none found)"
done

# ---------------------------------------------------------------------------
section "SUMMARY"
# ---------------------------------------------------------------------------
if [ "${#FAILURES[@]}" -eq 0 ] && [ "${#WARNINGS[@]}" -eq 0 ]; then
  echo "No mismatches found at any layer checked. If IT is still seeing swapped"
  echo "content, re-check from a client outside any CDN/browser cache."
else
  if [ "${#FAILURES[@]}" -gt 0 ]; then
    echo "FAILURES (${#FAILURES[@]}) - these pinpoint the swap:"
    for f in "${FAILURES[@]}"; do echo "  - $f"; done
  fi
  if [ "${#WARNINGS[@]}" -gt 0 ]; then
    echo
    echo "WARNINGS (${#WARNINGS[@]}) - inconclusive, needs a manual look:"
    for w in "${WARNINGS[@]}"; do echo "  - $w"; done
  fi
  echo
  echo "How to read this:"
  echo "  - Section 1/5 flags   -> images were built/tagged wrong (fix: rebuild"
  echo "    and re-push the correct image under the correct name, or fix a"
  echo "    manual 'docker tag' mistake on this host)."
  echo "  - Section 2 flags only -> the image itself is wrong; nginx is fine."
  echo "  - Section 3 flags only -> nginx's baked-in config is stale/wrong even"
  echo "    though the app images are correct (rebuild+redeploy scribear-nginx)."
  echo "  - Section 4 matches section 2/3's flags -> confirms which layer is at fault."
fi
