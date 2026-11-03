#!/usr/bin/env bash
# Tarball install test: pack codeloom the way it will be published, install the tarball with plain npm in
# an empty folder (no workspace, no pnpm), and drive the installed CLI end to end on demo-shop.
#
# Usage:
#   scripts/release/pack-test.sh                  release build + pnpm pack + everything below
#   scripts/release/pack-test.sh --tarball FILE   test an existing tarball (CI packs on Node 22 first,
#                                                 then runs this on the matrix Node, whose npm installs it)
#
# Steps: tarball contents + sizes → npm install → no native install steps → --version → init → index →
# check → check --json → doctor → dashboard (token URL, cookie, /api/overview) → serve (MCP client).
# Needs: node, npm, git, curl, tar (and pnpm unless --tarball). The npm install needs the npm registry.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARBALL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tarball) TARBALL="$2"; shift 2 ;;
    *) echo "usage: $0 [--tarball FILE]" >&2; exit 2 ;;
  esac
done

# Budgets (bytes). The 14 grammar .wasm files are ~25 MB unpacked, ~85% of the package.
MAX_PACKED=$((5 * 1000 * 1000))
MAX_UNPACKED=$((35 * 1000 * 1000))

WORK="$(mktemp -d "${TMPDIR:-/tmp}/codeloom-pack-test.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
DASH_PID=""
PASSED=0
WARNINGS=()

cleanup() {
  local code=$?
  if [ -n "$DASH_PID" ]; then kill "$DASH_PID" 2>/dev/null || true; fi
  if [ "$code" -eq 0 ]; then rm -rf "$WORK"; else echo "pack-test: FAILED (exit $code); files kept in $WORK" >&2; fi
}
trap cleanup EXIT

ok() { PASSED=$((PASSED + 1)); echo "  ✓ $*"; }
die() { echo "  ✗ $*" >&2; exit 1; }
step() { echo; echo "▸ $*"; }

echo "pack-test: node $(node --version), npm $(npm --version), work dir $WORK"

# ---- 1. build + pack ------------------------------------------------------------------------------------
if [ -z "$TARBALL" ]; then
  step "release build"
  (cd "$REPO_ROOT" && pnpm release:build >"$WORK/build.log" 2>&1) || { tail -40 "$WORK/build.log" >&2; die "pnpm release:build failed"; }
  ok "pnpm release:build"

  step "pnpm pack (runs the prepack guard; rewrites workspace: specifiers)"
  mkdir -p "$WORK/pack"
  (cd "$REPO_ROOT/packages/cli" && pnpm pack --pack-destination "$WORK/pack" >"$WORK/pack.log" 2>&1) || { cat "$WORK/pack.log" >&2; die "pnpm pack failed"; }
  TARBALL="$(ls "$WORK"/pack/*.tgz)"
  ok "packed $(basename "$TARBALL")"
fi
[ -f "$TARBALL" ] || die "tarball not found: $TARBALL"
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd -P)/$(basename "$TARBALL")"

# ---- 2. tarball contents --------------------------------------------------------------------------------
step "tarball contents"
tar -tzf "$TARBALL" | sed 's#^package/##' | sort >"$WORK/files.txt"
mkdir -p "$WORK/unpacked"
tar -xzf "$TARBALL" -C "$WORK/unpacked"
PKG="$WORK/unpacked/package"

for f in package.json LICENSE NOTICE dist/bin.js dist/bin.js.map dist/dashboard/index.html; do
  grep -qx "$f" "$WORK/files.txt" || die "missing from the tarball: $f"
done
WASM_COUNT=$(grep -c '^dist/grammars/[^/]*\.wasm$' "$WORK/files.txt" || true)
LICENCE_COUNT=$(grep -c '^dist/grammars/LICENSES/[^/]*\.txt$' "$WORK/files.txt" || true)
[ "$WASM_COUNT" -gt 0 ] || die "no grammar .wasm in the tarball"
[ "$LICENCE_COUNT" -gt 0 ] || die "no dist/grammars/LICENSES/*.txt in the tarball"
ok "LICENSE, NOTICE, bin.js(+map), dashboard, $WASM_COUNT grammars, $LICENCE_COUNT grammar licences"

BAD=$(grep -E '(^|/)(src|test)/|\.map$' "$WORK/files.txt" | grep -vx 'dist/bin.js.map' || true)
[ -z "$BAD" ] || die "files that must not ship:"$'\n'"$BAD"
ok "no src/, test/ or source maps besides dist/bin.js.map"

sed -n 2p "$PKG/dist/bin.js" | grep -q '^// codeloom-release-bundle ' || die "dist/bin.js is not the release bundle (no marker)"
ok "dist/bin.js is the release bundle ($(sed -n 2p "$PKG/dist/bin.js" | sed 's#^// ##'))"

if grep -q '"workspace:' "$PKG/package.json"; then die "packed package.json still has a workspace: specifier"; fi
ok "packed package.json has no workspace: specifier"

# README.md (packages/cli/README.md, generated from the root README) and CHANGELOG.md (root, copied by the
# release build) must ship. Until the v0.1 docs (release Task 4) merge, a doc whose source is not in the
# repo yet is only a warning; once the source exists, its absence from the tarball fails the test.
for doc in "README.md:packages/cli/README.md" "CHANGELOG.md:CHANGELOG.md"; do
  f="${doc%%:*}"; src="${doc#*:}"
  if grep -qx "$f" "$WORK/files.txt"; then ok "$f is in the tarball"
  elif [ -f "$REPO_ROOT/$src" ]; then die "$f is missing from the tarball although $src exists (rerun pnpm release:build)"
  else WARNINGS+=("$f is not in the tarball: $src does not exist yet (release Task 4 docs)"); fi
done

VERSION=$(node -p "require('$PKG/package.json').version")
PACKED=$(node -p "require('fs').statSync('$TARBALL').size")
UNPACKED=$(node -e '
  const fs = require("fs"), path = require("path");
  const size = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).reduce((n, e) => n + size(path.join(p, e)), 0) : fs.statSync(p).size;
  console.log(size(process.argv[1]));' "$PKG")
FILE_COUNT=$(wc -l <"$WORK/files.txt" | tr -d ' ')
mb() { node -p "($1 / 1e6).toFixed(1) + ' MB'"; }
[ "$PACKED" -lt "$MAX_PACKED" ] || die "packed size $(mb "$PACKED") is over the $(mb $MAX_PACKED) budget"
[ "$UNPACKED" -lt "$MAX_UNPACKED" ] || die "unpacked size $(mb "$UNPACKED") is over the $(mb $MAX_UNPACKED) budget"
ok "size: $FILE_COUNT files, packed $(mb "$PACKED") (< $(mb $MAX_PACKED)), unpacked $(mb "$UNPACKED") (< $(mb $MAX_UNPACKED))"

# ---- 3. install with plain npm --------------------------------------------------------------------------
step "npm install <tarball> in an empty folder"
INSTALL="$WORK/install"
mkdir -p "$INSTALL"
(cd "$INSTALL" && npm init -y >/dev/null && npm install --no-audit --no-fund "$TARBALL" >"$WORK/npm-install.log" 2>&1) \
  || { cat "$WORK/npm-install.log" >&2; die "npm install failed"; }
CODELOOM="$INSTALL/node_modules/.bin/codeloom"
[ -x "$CODELOOM" ] || die "node_modules/.bin/codeloom is missing"
ADDED=$(grep -oE 'added [0-9]+ packages?' "$WORK/npm-install.log" | head -1 || true)
ok "npm install: ${ADDED:-done}"
if ls -d "$INSTALL"/node_modules/tree-sitter-* >/dev/null 2>&1; then die "a tree-sitter-* grammar package was installed"; fi
ok "no tree-sitter-* grammar package installed (grammars come from dist/grammars)"

step "no native install steps"
node "$REPO_ROOT/scripts/release/no-native-deps.mjs" "$INSTALL/node_modules" || die "a dependency needs an install step"
ok "no-native-deps"

# ---- 4. the installed CLI on demo-shop ------------------------------------------------------------------
step "codeloom --version (npx)"
GOT=$(cd "$INSTALL" && npx --no-install codeloom --version)
[ "$GOT" = "$VERSION" ] || die "npx codeloom --version printed '$GOT', expected '$VERSION'"
ok "npx codeloom --version = $GOT"

WS="$WORK/demo-shop"
cp -R "$REPO_ROOT/fixtures/demo-shop" "$WS"
# Each child folder becomes a git repo, as packages/cli/test/helpers.ts materializeFixture does.
for d in "$WS"/*/; do
  git -C "$d" init -q -b main
  git -C "$d" -c user.name=pack-test -c user.email=pack-test@example.com add -A
  git -C "$d" -c user.name=pack-test -c user.email=pack-test@example.com commit -q --allow-empty -m fixture
done

step "codeloom init"
"$CODELOOM" init "$WS" >"$WORK/init.log" 2>&1 || { cat "$WORK/init.log" >&2; die "init failed"; }
[ -f "$WS/codeloom.workspace.json" ] || die "init wrote no codeloom.workspace.json"
ok "init: $(head -1 "$WORK/init.log" | sed "s# in $WS##")"

step "codeloom index"
(cd "$WS" && "$CODELOOM" index) >"$WORK/index.log" 2>&1 || { cat "$WORK/index.log" >&2; die "index failed"; }
[ -f "$WS/.codeloom/chains.json" ] || die "index wrote no .codeloom/chains.json"
ok "index: $(grep -E 'repos indexed|chains \(' "$WORK/index.log" | sed "s# in $WS##" | paste -sd ';' - | sed 's/;/; /')"

step "codeloom check"
set +e; (cd "$WS" && "$CODELOOM" check) >"$WORK/check.log" 2>&1; CODE=$?; set -e
[ "$CODE" -eq 0 ] || { cat "$WORK/check.log" >&2; die "check exited $CODE"; }
SUMMARY=$(grep -E '^[0-9]+ journeys?: ' "$WORK/check.log" | head -1 || true)
[ -n "$SUMMARY" ] || { cat "$WORK/check.log" >&2; die "check printed no summary line"; }
ok "check: $SUMMARY"

step "codeloom check --json"
(cd "$WS" && "$CODELOOM" check --json) >"$WORK/check.json" || die "check --json failed"
CHECK_JSON=$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (typeof r.version !== "number") throw new Error("no version field");
  const s = r.summary;
  if (!s || !(s.chains > 0) || typeof s.complete !== "number") throw new Error("bad summary: " + JSON.stringify(s));
  if (!Array.isArray(r.items)) throw new Error("no items array");
  console.log(`version ${r.version}, ${s.chains} chains, ${s.complete} complete, ${r.items.length} items`);' "$WORK/check.json") \
  || die "check --json is not a valid report"
ok "check --json: $CHECK_JSON"

step "codeloom doctor"
set +e; (cd "$WS" && "$CODELOOM" doctor --json) >"$WORK/doctor.json" 2>"$WORK/doctor.err"; CODE=$?; set -e
[ "$CODE" -le 1 ] || { cat "$WORK/doctor.err" >&2; die "doctor exited $CODE"; }
DOCTOR=$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const errors = r.items.filter((i) => i.status === "error");
  if (errors.length > 0) { console.error(errors.map((i) => `${i.check}${i.repo ? " " + i.repo : ""}: ${i.message}`).join("\n")); process.exit(1); }
  const warns = r.items.filter((i) => i.status === "warn").map((i) => `${i.check}${i.repo ? "/" + i.repo : ""}`);
  console.log(`${r.summary.ok} ok, ${r.summary.warn} warn${warns.length ? " (" + warns.join(", ") + ")" : ""}, 0 errors`);' "$WORK/doctor.json") \
  || die "doctor reported errors"
ok "doctor (exit $CODE): $DOCTOR"

step "codeloom dashboard"
(cd "$WS" && exec "$CODELOOM" dashboard --no-open --port 0) >"$WORK/dashboard.log" 2>&1 &
DASH_PID=$!
URL=""
for _ in $(seq 1 100); do
  URL=$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[0-9a-f]+' "$WORK/dashboard.log" | head -1 || true)
  [ -n "$URL" ] && break
  kill -0 "$DASH_PID" 2>/dev/null || { cat "$WORK/dashboard.log" >&2; die "dashboard exited early"; }
  sleep 0.2
done
[ -n "$URL" ] || { cat "$WORK/dashboard.log" >&2; die "dashboard printed no URL within 20 s"; }
BASE="${URL%%/\?*}"
JAR="$WORK/cookies.txt"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/overview")
[ "$CODE" = "401" ] || die "/api/overview without the session cookie returned $CODE, expected 401"
CODE=$(curl -sS -L -c "$JAR" -b "$JAR" -o "$WORK/index.html" -w '%{http_code}' "$URL")
[ "$CODE" = "200" ] || die "GET the token URL returned $CODE"
grep -qi '<html' "$WORK/index.html" || die "the token URL did not serve the dashboard's index.html"
CODE=$(curl -sS -b "$JAR" -o "$WORK/overview.json" -w '%{http_code}' "$BASE/api/overview")
[ "$CODE" = "200" ] || die "/api/overview with the cookie returned $CODE"
REPOS=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).repos.length' "$WORK/overview.json")
[ "$REPOS" = "3" ] || die "/api/overview listed $REPOS repos, expected 3"
kill "$DASH_PID"; wait "$DASH_PID" 2>/dev/null || true; DASH_PID=""
ok "dashboard: 401 without cookie, token URL 200 (index.html), /api/overview 200 with $REPOS repos"

step "codeloom serve (MCP over stdio)"
cp "$REPO_ROOT/scripts/release/pack-test-mcp.mjs" "$INSTALL/pack-test-mcp.mjs"
MCP=$(cd "$INSTALL" && node pack-test-mcp.mjs "$CODELOOM" "$WS" 2>"$WORK/mcp.err") || { cat "$WORK/mcp.err" >&2; die "MCP smoke failed"; }
ok "$MCP"

echo
for w in ${WARNINGS[@]+"${WARNINGS[@]}"}; do echo "  ! warning: $w"; done
echo "pack-test: PASSED ($PASSED checks) — codeloom $VERSION, packed $(mb "$PACKED"), unpacked $(mb "$UNPACKED"), $FILE_COUNT files, npm ${ADDED:-install ok}"
