#!/bin/bash
# Run an outside pull request's tests on a Mac without letting its code see anything else.
#
#   scripts/pr-guard/sandbox-test.sh <PR number> <package dir, e.g. sdk or integrations/mcp>
#
# 1. Fetches the PR into a throwaway clone under /tmp (never into this working tree: no private/, no keys).
# 2. Runs the static guard on it.
# 3. Installs dependencies with --ignore-scripts (no install-time code runs) from the lockfile.
# 4. Runs the tests under macOS sandbox-exec: no network except localhost, no reads of your home directory, no
#    writes outside the throwaway clone and temp dirs.
# Prefer CI for routine PRs; use this only when you need to look closer.
set -euo pipefail
PR="${1:?PR number}"; PKG="${2:?package dir}"
[[ "$PR" =~ ^[0-9]+$ ]] || { echo "PR must be a number"; exit 2; }
[[ "$PKG" =~ ^[a-z0-9/_-]+$ && "$PKG" != *..* ]] || { echo "bad package dir"; exit 2; }
REPO="https://github.com/DeepFirstHQ/deepfirstsearch.git"
WORK="$(cd "$(mktemp -d /tmp/pr-sandbox-XXXXXX)" && pwd -P)"
HERE="$(cd "$(dirname "$0")" && pwd)"
echo "throwaway clone: $WORK"

git clone --quiet --no-tags "$REPO" "$WORK/repo"
cd "$WORK/repo"
git fetch --quiet --no-tags origin "+refs/pull/${PR}/head:refs/remotes/pr/head"
BASE_SHA="$(git rev-parse origin/main)"; HEAD_SHA="$(git rev-parse pr/head)"

echo "== static guard (main's version, not the PR's)"
BASE_SHA="$BASE_SHA" HEAD_SHA="$HEAD_SHA" node "$HERE/guard.mjs" || { echo "guard blocked: read the findings before going further"; exit 1; }

git -c advice.detachedHead=false checkout --quiet "$HEAD_SHA"
cd "$PKG"
echo "== install from lockfile, no lifecycle scripts"
npm ci --ignore-scripts --no-audit --no-fund

PROFILE="$WORK/sandbox.sb"
cat > "$PROFILE" <<SB
(version 1)
(allow default)
(deny network*)
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(deny file-read* (subpath "$HOME"))
(deny file-write* (subpath "/"))
(allow file-write* (subpath "$WORK") (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))
SB
echo "== tests inside the sandbox (no network, no home directory)"
HOME="$WORK/home" npm_config_cache="$WORK/npm-cache" sandbox-exec -f "$PROFILE" npm test
echo "== done. Remove the clone with: rm -rf $WORK"
