#!/usr/bin/env bash
# Starts the example app and checks negotiated responses end to end.
#
# Environment:
#   MODE=start|dev          `next start` (default; run `npm run build` first)
#                           or `next dev`
#   BUNDLER=turbopack|webpack
#                           bundler for `next dev` (default: turbopack)
#   BASE_PATH, TRAILING_SLASH=1, PATCH_VARY=0
#                           the same options that next.config.ts reads; use
#                           the values that the app was built with
#   PORT                    default: 3000
#
# Run `npm run build` in the repository root first.

# The check functions below are called through `check`.
# shellcheck disable=SC2329

set -euo pipefail

cd "$(dirname "$0")"
port="${PORT:-3000}"
base_path="${BASE_PATH:-}"
slash=""
[ "${TRAILING_SLASH:-}" = 1 ] && slash="/"

# URL of an app path, with the base path and trailing slash applied.
url() { echo "http://localhost:$port$base_path$1$slash"; }

case "${MODE:-start}" in
start) server=(node_modules/.bin/next start -p "$port") ;;
dev)
  server=(node_modules/.bin/next dev -p "$port")
  [ "${BUNDLER:-turbopack}" = webpack ] && server+=(--webpack)
  ;;
*)
  echo "Unknown MODE: $MODE" >&2
  exit 2
  ;;
esac

"${server[@]}" &
pid=$!
trap 'kill "$pid" 2>/dev/null' EXIT

# `next dev` compiles on the first request, so allow for a slow start.
for _ in $(seq 1 120); do
  curl -sf -o /dev/null "$(url /docs/intro)" && break
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "FAIL: server exited before it was ready" >&2
    exit 1
  fi
  sleep 1
done

failed=0
check() {
  local name=$1
  shift
  if "$@"; then
    echo "ok: $name"
  else
    echo "FAIL: $name" >&2
    failed=1
  fi
}

# Prints the response headers of a request. Arguments are passed to curl.
headers() { curl -s -o /dev/null -D - "$@"; }

# Succeeds if the headers match the extended regular expression. Otherwise
# prints them, to show why the check failed.
expect_header() {
  local pattern=$1 response=$2
  grep -iqE "$pattern" <<<"$response" || {
    echo "$response" >&2
    return 1
  }
}

# The Vary loader keeps the proxy's Vary next to Next.js's own values. With
# `PATCH_VARY=0`, Next.js replaces it
# (https://github.com/vercel/next.js/issues/85999). If that check fails,
# Next.js has fixed the bug and the patch may no longer be needed.
page_vary() {
  local response
  response=$(headers "$(url "$1")")
  if [ "${PATCH_VARY:-}" = 0 ]; then
    ! grep -iqE '^vary:.*accept-language' <<<"$response" &&
      expect_header '^vary:.*next-router-state-tree' "$response"
  else
    expect_header '^vary:.*accept-language.*next-router-state-tree' "$response"
  fi
}
static_page_vary() { page_vary /docs/intro; }
dynamic_page_vary() { page_vary /docs/guide/setup; }

serves_french() {
  local body
  body=$(curl -sf -H 'Accept-Language: fr' "$(url /docs/intro)")
  grep -q 'lang="fr"' <<<"$body"
}

content_language() {
  local response
  response=$(headers -H 'Accept-Language: fr' "$(url /docs/intro)")
  expect_header '^content-language: fr\s*$' "$response"
}

serves_markdown() {
  local response
  response=$(headers -H 'Accept: text/markdown' "$(url /docs/intro)")
  expect_header '^content-type: text/markdown' "$response" &&
    expect_header "^content-location: $base_path/md/docs/intro$slash\\s*$" "$response"
}

# Next.js keeps the proxy's Link header on page responses.
alternates_link() {
  local response
  response=$(headers "$(url /docs/intro)")
  expect_header "^link:.*<$base_path/fr/docs/intro$slash>; rel=\"alternate\"; type=\"text/html\"; hreflang=\"fr\"" "$response" &&
    expect_header "^link:.*<$base_path/md/docs/intro$slash>; rel=\"alternate\"; type=\"text/markdown\"" "$response"
}

# A variant's own URL links back to the negotiated URL, without the type or
# language that negotiation can change.
negotiated_link() {
  local response
  response=$(headers "$(url /md/docs/intro)")
  expect_header "^link: <$base_path/docs/intro$slash>; rel=\"alternate\"\\s*$" "$response"
}

not_acceptable() {
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: image/png' "$(url /data/1)")
  [ "$status" = 406 ]
}

# A browser whose language is not offered, fetching `*/*`, gets the
# language-neutral Markdown variant. App Router navigations send the same
# headers plus `RSC: 1`, and must get the page's RSC payload instead.
wildcard_gets_markdown() {
  local response
  response=$(headers -H 'Accept: */*' -H 'Accept-Language: de' "$(url /docs/intro)")
  expect_header '^content-type: text/markdown' "$response"
}
navigation_gets_page() {
  local response
  # Follow the redirect that adds the `_rsc` cache-busting parameter, which
  # the client router would have sent.
  response=$(headers -L -H 'RSC: 1' -H 'Accept: */*' -H 'Accept-Language: de' "$(url /docs/intro)")
  expect_header '^content-type: text/x-component' "$response"
}

# Server Actions send `Accept: text/x-component` but must reach the page the
# browser shows. The action ID is unknown, so Next.js answers 404 after the
# proxy has rewritten the request.
server_action_negotiated() {
  local response
  response=$(headers -X POST \
    -H 'Next-Action: 0000000000000000000000000000000000000000' \
    -H 'Accept: text/x-component' -H 'Accept-Language: fr' \
    -H 'Content-Type: text/plain' --data '[]' "$(url /docs/intro)")
  expect_header "^content-location: $base_path/fr/docs/intro$slash\\s*$" "$response"
}

check "static page Vary" static_page_vary
check "dynamic page Vary" dynamic_page_vary
check "Accept-Language: fr serves the French page" serves_french
check "the French page sends Content-Language: fr" content_language
check "Accept: text/markdown serves Markdown" serves_markdown
check "negotiated pages link to their alternates" alternates_link
check "variant URLs link to the negotiated URL" negotiated_link
check "unacceptable Accept on a 406 rule responds 406" not_acceptable
check "Accept: */* with an unoffered language serves Markdown" wildcard_gets_markdown
check "App Router navigations get the page" navigation_gets_page
check "Server Actions negotiate like page requests" server_action_negotiated

exit "$failed"
