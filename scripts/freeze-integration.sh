#!/usr/bin/env bash
# Integration test: the account-level freeze on Drive's real HTTP surface and on the
# OfficeStorage RPC entrypoint, against built Workers and a faithful local Identity fixture
# (test-fixtures/identity-fixture.mjs). The central status is checked fresh per request.
#
#   bash scripts/freeze-integration.sh          # KEEP=1 keeps the temp dir
#
# Matrix per surface (web page, WebDAV, OfficeStorage RPC): active -> works | frozen ->
# refused 423 (RPC: freeze error) | secret rejected / Identity down -> refused 503 / unavailable
# | active again -> works (nothing cached).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8805}"
RPC_PORT="${RPC_PORT:-8807}"
FIXTURE_PORT="${FIXTURE_PORT:-8806}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/southbag-drive-freeze.XXXXXX")"
STATE="$TMP/state"
RPC_STATE="$TMP/rpc-state"
DEV_PID=""; RPC_PID=""; FIXTURE_PID=""

cleanup() {
  [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null || true
  for pid in "$DEV_PID" "$RPC_PID"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  [ -n "$DEV_PID" ] && wait "$DEV_PID" 2>/dev/null || true
  [ "${KEEP:-}" = 1 ] && echo "kept $TMP" || rm -rf "$TMP"
}
trap cleanup EXIT

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*"; exit 1; }
ok() { printf '\033[32mok\033[0m %s\n' "$*"; }

WR=(npx --prefix "$ROOT" wrangler)
start_fixture() { FIXTURE_SECRET=itsec node "$ROOT/test-fixtures/identity-fixture.mjs" "$FIXTURE_PORT" "$1" >"$TMP/fixture.log" 2>&1 & FIXTURE_PID=$!; sleep 1; }
stop_fixture() { [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null || true; wait "$FIXTURE_PID" 2>/dev/null || true; FIXTURE_PID=""; }

step "build (fresh, so the tested worker is the current source)"
(cd "$ROOT" && npx vite build >/dev/null 2>&1) || fail "vite build failed"
(cd "$ROOT" && node scripts/export-office-entrypoint.ts >/dev/null) || fail "office entrypoint export failed"

step "migrate + seed (drive)"
(cd "$ROOT" && "${WR[@]}" d1 migrations apply drive --local --persist-to "$STATE" >/dev/null)
now=$(date +%s)000
whash=$(node -e "console.log(require('crypto').createHash('sha256').update('wtoken').digest('hex'))")
(cd "$ROOT" && "${WR[@]}" d1 execute drive --local --persist-to "$STATE" --command "
INSERT INTO users (id, email, name, created_at) VALUES ('dev-alice', 'alice@example.com', 'Alice', $now);
INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('sess-alice', 'dev-alice', $now, 9999999999999);
INSERT INTO webdav_tokens (user_id, token_hash, created_at) VALUES ('dev-alice', '$whash', $now);
" >/dev/null)
ok "database ready"

step "drive worker on :$PORT + identity fixture (active)"
start_fixture active
(cd "$ROOT" && exec "${WR[@]}" dev --persist-to "$STATE" --port "$PORT" \
  --var IDENTITY_ISSUER:http://127.0.0.1:$FIXTURE_PORT --var IDENTITY_INTERNAL_SECRET:itsec >"$TMP/dev.log" 2>&1) &
DEV_PID=$!
for i in $(seq 1 90); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/auth/login" && break
  sleep 1
  [ "$i" = 90 ] && fail "drive worker did not start: $(tail -5 "$TMP/dev.log")"
done
ok "started"

step "OfficeStorage RPC probe worker on :$RPC_PORT"
cat > "$TMP/wrangler.rpc.jsonc" <<EOF
{
  "name": "southbag-drive-rpc-it",
  "main": "rpc-entry.ts",
  "compatibility_date": "2026-06-25",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    { "binding": "DB", "database_name": "drive", "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "$ROOT/migrations" }
  ]
}
EOF
cat > "$TMP/rpc-entry.ts" <<EOF
import { WorkerEntrypoint } from 'cloudflare:workers';
import { OfficeStorage } from '$ROOT/src/lib/server/office-entrypoint';
const user = { sub: 'dev-alice', email: 'alice@example.com', name: 'Alice' };
export default class Probe extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const store = new OfficeStorage(this.ctx, this.env);
    const what = new URL(request.url).pathname;
    try {
      if (what === '/snapshot') { await store.snapshot(user as never); return new Response('snapshot ok'); }
      if (what === '/commit') {
        await store.commit(user as never, { base: null, files: { 'notes.txt': 'hi' }, message: 'test' } as never);
        return new Response('commit ok');
      }
      return new Response('unknown probe', { status: 404 });
    } catch (error) {
      return new Response('blocked: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
}
EOF
(cd "$ROOT" && "${WR[@]}" d1 migrations apply drive --local --persist-to "$RPC_STATE" -c "$TMP/wrangler.rpc.jsonc" >/dev/null)
(cd "$ROOT" && exec "${WR[@]}" dev -c "$TMP/wrangler.rpc.jsonc" --persist-to "$RPC_STATE" --port "$RPC_PORT" \
  --var IDENTITY_ISSUER:http://127.0.0.1:$FIXTURE_PORT --var IDENTITY_INTERNAL_SECRET:itsec >"$TMP/rpc.log" 2>&1) &
RPC_PID=$!
for i in $(seq 1 90); do
  curl -s -o /dev/null "http://127.0.0.1:$RPC_PORT/none" && break
  sleep 1
  [ "$i" = 90 ] && fail "rpc worker did not start: $(tail -5 "$TMP/rpc.log")"
done
ok "started"

COOKIE="Cookie: __Host-sb_drive_session=sess-alice"
BASIC="Authorization: Basic $(printf 'alice@example.com:wtoken' | base64)"

check() { # $1 label $2 expected web status $3 webdav status $4 rpc body fragment
  local web dav snap com
  web=$(curl -sL -o /dev/null -w '%{http_code}' -H "$COOKIE" "http://127.0.0.1:$PORT/")
  dav=$(curl -s -o /dev/null -w '%{http_code}' -X PROPFIND -H "$BASIC" -H 'Depth: 0' "http://127.0.0.1:$PORT/webdav/")
  snap=$(curl -s "http://127.0.0.1:$RPC_PORT/snapshot")
  com=$(curl -s "http://127.0.0.1:$RPC_PORT/commit")
  [ "$web" = "$2" ] || fail "$1: web page status $web, want $2"
  [ "$dav" = "$3" ] || fail "$1: webdav status $dav, want $3"
  grep -q "$4" <<<"$snap" || fail "$1: rpc snapshot: $snap"
  grep -q "$4" <<<"$com" || fail "$1: rpc commit: $com"
  ok "$1: web=$2 webdav=$3 rpc '$4'"
}

check "active" 200 207 "ok"
stop_fixture; start_fixture frozen
check "frozen" 423 423 "frozen pending review"
stop_fixture; start_fixture reject
check "secret rejected" 503 503 "Identity is unavailable"
stop_fixture
check "identity down" 503 503 "Identity is unavailable"
start_fixture active
check "active again (no stale cache)" 200 207 "ok"

printf '\n\033[32mAll drive freeze integration checks passed.\033[0m\n'
