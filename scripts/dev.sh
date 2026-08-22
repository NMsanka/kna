#!/usr/bin/env bash
#
# One entry point for running the platform locally.
#
# Runtime configuration is NOT here. The services read `.env` themselves through
# `loadPlatformEnv()`, so duplicating DATABASE_URL and friends into a shell script only creates
# two places to be wrong. What lives here is the handful of values that are *not* runtime config:
# the owner database URL used for migrations and seeding, the tenant slugs, and where credentials
# are kept once the seed has printed them.
#
# Run it from Git Bash as ./scripts/dev.sh, or from PowerShell and cmd as `pnpm dev` — on
# Windows the `bash` on PATH is usually WSL's, which is a different thing entirely.
#
# Usage:
#   ./scripts/dev.sh bootstrap        everything from cold, in order
#   ./scripts/dev.sh status           what is up and what is not
#   ./scripts/dev.sh repo <remote>    register a repository and mint its publish credential
#   ./scripts/dev.sh publish <path>   analyse and publish a repository
#   ./scripts/dev.sh ask "question"
#
# `./scripts/dev.sh help` lists the rest.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

# ── The only settings you are likely to change ─────────────────────────────────────────────

# The owner connection. Migrations and the seed need it because the application roles
# deliberately have no rights on `orgs` and cannot create schema.
OWNER_URL="${KNA_OWNER_URL:-postgres://kna:kna@localhost:5432/kna}"

# The application roles' password. Set once per database, and note that Postgres roles are
# cluster-wide — this changes it for every database on the server, not just this one.
APP_PASSWORD="${KNA_APP_PASSWORD:-devpass}"

# Must match the `org:` value in each repository's kna.config.yaml, and the project slug must
# exist before a repository claiming it can be usefully indexed.
ORG="${KNA_ORG:-kna}"
PROJECT="${KNA_PROJECT:-platform}"

API_URL="${KNA_API_URL:-http://localhost:8080}"

# Written by `seed`, read by everything else. `.kna/` is gitignored, so credentials stay local.
STATE_DIR="$ROOT/.kna"
TOKENS_FILE="$STATE_DIR/tokens.env"
LOG_DIR="$STATE_DIR/logs"

COMPOSE=(docker compose --env-file .env -f deploy/docker-compose.yml)

# ── Output ─────────────────────────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  DIM=$'\033[2m'; BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
else
  DIM=''; BOLD=''; GREEN=''; RED=''; YELLOW=''; OFF=''
fi

step() { printf '\n%s==>%s %s%s%s\n' "$GREEN" "$OFF" "$BOLD" "$1" "$OFF"; }
info() { printf '    %s\n' "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$OFF"; }
warn() { printf '    %s%s%s\n' "$YELLOW" "$1" "$OFF"; }
die()  { printf '\n%serror%s %s\n\n' "$RED" "$OFF" "$1" >&2; exit 1; }

# ── Services ───────────────────────────────────────────────────────────────────────────────

SERVICES=(api worker mcp)

service_entry() {
  case "$1" in
    api)    echo "apps/api/dist/server.js" ;;
    worker) echo "apps/worker/dist/main.js" ;;
    mcp)    echo "apps/mcp/dist/server.js" ;;
    *)      die "unknown service '$1' (expected: ${SERVICES[*]})" ;;
  esac
}

# Killing a node process by name differs enough between platforms to be worth handling rather
# than hoping. On Windows `pkill -f` reports success and kills nothing, so a stale service keeps
# consuming jobs with the old code — which looks exactly like a fix that did not take.
kill_matching() {
  local pattern="$1"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      powershell.exe -NoProfile -Command \
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*$pattern*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" \
        >/dev/null 2>&1 || true
      ;;
    *)
      pkill -f "$pattern" >/dev/null 2>&1 || true
      ;;
  esac
}

is_running() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      powershell.exe -NoProfile -Command \
        "if (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*$1*' }) { exit 0 } else { exit 1 }" \
        >/dev/null 2>&1
      ;;
    *)
      pgrep -f "$1" >/dev/null 2>&1
      ;;
  esac
}

# ── Commands ───────────────────────────────────────────────────────────────────────────────

cmd_up() {
  step "Starting containers"
  "${COMPOSE[@]}" up -d postgres redis minio minio-init litellm
  info "waiting for postgres"
  until "${COMPOSE[@]}" ps --format '{{.Service}} {{.Status}}' 2>/dev/null | grep -q 'postgres Up.*healthy'; do
    sleep 2
  done
  info "ready"
}

cmd_down() {
  step "Stopping containers"
  # Deliberately without -v. That flag destroys the volumes, and one of them holds the IR
  # bundles, which are the system of record and the one thing here that cannot be rebuilt.
  "${COMPOSE[@]}" down
  note "volumes kept — 'docker compose ... down -v' would destroy the stored bundles"
}

cmd_db() {
  step "Migrating"
  DATABASE_URL="$OWNER_URL" pnpm --filter @kna/db exec tsx bin/migrate.ts

  step "Setting application role passwords"
  # Not a migration, on purpose: a migration containing a password would put it in git and in a
  # checksum the runner refuses to let you change.
  docker exec "$(container postgres)" psql -U kna -d kna -c \
    "ALTER ROLE kna_interactive WITH PASSWORD '$APP_PASSWORD'; ALTER ROLE kna_batch WITH PASSWORD '$APP_PASSWORD';" >/dev/null
  info "kna_interactive and kna_batch set"
  note "roles are cluster-wide: this applies to every database on this server"
}

container() {
  "${COMPOSE[@]}" ps -q "$1" 2>/dev/null | head -1 ||
    die "container '$1' is not running — try: ./scripts/dev.sh up"
}

cmd_seed() {
  mkdir -p "$STATE_DIR"
  step "Seeding tenant '$ORG'"

  local remote
  remote="$(git remote get-url origin 2>/dev/null || echo '')"
  [ -n "$remote" ] && info "registering this repository: $remote"

  local output
  output="$(DATABASE_URL="$OWNER_URL" SEED_ORG_ID="$ORG" SEED_ORG="$ORG" \
    SEED_PROJECT="$PROJECT" SEED_REPOS="$remote" \
    pnpm --filter @kna/db exec tsx bin/seed.ts)"

  # The seed prints credentials once and stores them hashed, so they are captured here or lost.
  printf '# Written by scripts/dev.sh seed on %s\n' "$(date)" > "$TOKENS_FILE"
  echo "$output" | grep -E '^\s*export KNA_' | sed 's/^[[:space:]]*//' >> "$TOKENS_FILE"

  # The seed prints one ingest credential per registered repository, all named KNA_INGEST_TOKEN.
  # Store the seeded repo's under its per-repo key too, so `publish` finds it the same way it
  # finds one minted later by `repo` — otherwise publishing a second repository would silently
  # fall back to the first repository's credential and fail with a confusing scope error.
  if [ -n "$remote" ] && [ -d "$ROOT/packages/ir/dist" ]; then
    local seeded_id seeded_token
    seeded_id="$(repo_id_for "$remote" 2>/dev/null || echo '')"
    seeded_token="$(grep -E '^export KNA_INGEST_TOKEN=' "$TOKENS_FILE" | head -1 | cut -d= -f2-)"
    if [ -n "$seeded_id" ] && [ -n "$seeded_token" ]; then
      printf 'export %s=%s\n' "$(token_key_for "$seeded_id")" "$seeded_token" >> "$TOKENS_FILE"
    fi
  fi

  echo "$output" | grep -E '^\s{2}(org|project|principal|repos|\s{13})' || true
  info ""
  info "credentials written to .kna/tokens.env"
  note "regenerated on every seed; the previous ones stop working"
}

load_tokens() {
  [ -f "$TOKENS_FILE" ] || die "no credentials yet — run: ./scripts/dev.sh seed"
  set -a; . "$TOKENS_FILE"; set +a
}

# The CLI signs bundles with KNA_INGEST_HMAC_SECRET; the server verifies them with
# INGEST_HMAC_SECRET. Two names for one shared value, and only the server's is in .env — so
# every publish silently produced an unsigned bundle until the CLI's name was set by hand.
# Bridged here rather than left as a trap.
load_signing_secret() {
  local secret
  secret="$(grep -E '^INGEST_HMAC_SECRET=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
  if [ -n "$secret" ]; then
    export KNA_INGEST_HMAC_SECRET="${KNA_INGEST_HMAC_SECRET:-$secret}"
  else
    warn "no INGEST_HMAC_SECRET in .env — the bundle will be unsigned"
  fi
}

# The key a repository's publish credential is stored under. Derived from the repoId so several
# repositories can be registered without their credentials being confused for one another.
token_key_for() {
  printf 'KNA_INGEST_TOKEN_%s' "$(echo "$1" | tr -dc 'a-zA-Z0-9' | tail -c 8)"
}

repo_id_for() {
  # Relative path, run from the repo root. Git Bash rewrites paths that appear as command
  # arguments but not ones inside a quoted script body, so an absolute path would reach Node
  # as `/c/...` and fail to resolve.
  ( cd "$ROOT" && KNA_ORG="$ORG" KNA_REMOTE="$1" node -e "
      const { computeRepoId } = require('./packages/ir/dist/index.js');
      process.stdout.write(computeRepoId(process.env.KNA_ORG, process.env.KNA_REMOTE));
    " )
}

cmd_start() {
  [ -d "$ROOT/apps/api/dist" ] || die "not built — run: pnpm build"
  mkdir -p "$LOG_DIR"
  step "Starting services"
  for svc in "${SERVICES[@]}"; do
    local entry; entry="$(service_entry "$svc")"
    if is_running "$entry"; then
      info "$svc already running"
      continue
    fi
    ( cd "$ROOT" && nohup node "$entry" > "$LOG_DIR/$svc.log" 2>&1 & )
    info "$svc started"
  done
  note "logs in .kna/logs/ — follow one with: ./scripts/dev.sh logs worker"
}

cmd_stop() {
  step "Stopping services"
  for svc in "${SERVICES[@]}"; do
    kill_matching "$(service_entry "$svc")"
    info "$svc stopped"
  done
}

cmd_restart() { cmd_stop; sleep 2; cmd_start; }

cmd_logs() {
  local svc="${1:-worker}"
  service_entry "$svc" >/dev/null
  tail -f "$LOG_DIR/$svc.log"
}

cmd_status() {
  step "Containers"
  "${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}' 2>/dev/null || warn "docker not responding"

  step "Services"
  for svc in "${SERVICES[@]}"; do
    if is_running "$(service_entry "$svc")"; then
      printf '    %-8s %srunning%s\n' "$svc" "$GREEN" "$OFF"
    else
      printf '    %-8s %sstopped%s\n' "$svc" "$RED" "$OFF"
    fi
  done

  step "API"
  curl -sf -m 5 "$API_URL/health/ready" 2>/dev/null | head -c 400 || warn "not answering"
  echo

  step "Corpus"
  docker exec "$(container postgres)" psql -U kna -d kna -tAc \
    "SELECT r.name || ': ' || (SELECT count(*) FROM modules m WHERE m.repo_id=r.id) || ' modules, ' || (SELECT count(*) FROM symbols s WHERE s.repo_id=r.id) || ' symbols, ' || (SELECT count(*) FROM chunks c WHERE c.repo_id=r.id) || ' chunks' FROM repos r ORDER BY 1;" \
    2>/dev/null | sed 's/^/    /' || warn "cannot read the database"
}

cmd_repo() {
  local remote="${1:-}"
  [ -n "$remote" ] || die "usage: ./scripts/dev.sh repo <git-remote-url>"
  load_tokens

  step "Registering $remote"
  local response repo_id
  response="$(curl -sf -X POST "$API_URL/v1/admin/repos" \
    -H "authorization: Bearer $KNA_TOKEN" -H 'content-type: application/json' \
    -d "{\"remote\":\"$remote\",\"projectSlugs\":[\"$PROJECT\"],\"openPullRequest\":false}")" \
    || die "registration failed — is the API running?"

  repo_id="$(echo "$response" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).repoId')"
  info "repoId: $repo_id"

  local unknown
  unknown="$(echo "$response" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).unknownProjectSlugs.join(", ")')"
  # An unknown slug is not an error, and that is exactly why it is worth shouting about: the repo
  # still indexes, and then answers nothing to every project-scoped question.
  [ -n "$unknown" ] && warn "project slug does not exist: $unknown"

  step "Minting a publish credential"
  local token
  token="$(curl -sf -X POST "$API_URL/v1/admin/repos/$repo_id/ingest-credential" \
    -H "authorization: Bearer $KNA_TOKEN" -H 'content-type: application/json' \
    -d '{"reason":"local development","ttlHours":24}' \
    | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')"

  # One credential per repository, so they cannot be confused with each other or with KNA_TOKEN.
  local key; key="$(token_key_for "$repo_id")"
  printf 'export %s=%s\n' "$key" "$token" >> "$TOKENS_FILE"
  info "saved as $key"

  echo
  info "next: add kna.config.yaml to that repository with 'org: $ORG', then"
  info "  ./scripts/dev.sh publish /path/to/repo"
}

cmd_publish() {
  local path="${1:-$ROOT}"
  load_tokens
  [ -d "$path" ] || die "no such directory: $path"

  # Match the repository to the credential minted for it, rather than making the caller
  # remember which of several tokens belongs to which repo.
  local remote repo_id key token
  remote="$(cd "$path" && git remote get-url origin 2>/dev/null || echo '')"
  [ -n "$remote" ] || die "$path has no git remote, so it cannot be matched to a credential"

  repo_id="$(repo_id_for "$remote")" || die "could not compute repoId — run: pnpm build"
  key="$(token_key_for "$repo_id")"
  token="${!key:-}"

  # Deliberately no fallback to whatever credential happens to be loaded. An ingest credential is
  # scoped to one repository, so using another repo's would fail at the server with an error
  # about org and repo scope — true, and no help at all in working out what to do next.
  [ -n "$token" ] || die "no credential for $remote
    run: ./scripts/dev.sh repo $remote"

  load_signing_secret
  step "Publishing $path"
  KNA_INGEST_TOKEN="$token" node "$ROOT/apps/cli/dist/bin.js" --cwd "$path" publish
}

cmd_ask() {
  load_tokens
  [ $# -gt 0 ] || die 'usage: ./scripts/dev.sh ask "your question"'
  node "$ROOT/apps/cli/dist/bin.js" ask "$@"
}

cmd_reindex() {
  local repo_id="${1:-}"
  [ -n "$repo_id" ] || die "usage: ./scripts/dev.sh reindex <repoId>  (see: dev.sh status)"
  load_tokens
  step "Reindexing $repo_id"
  curl -sf -X POST "$API_URL/v1/admin/reindex" \
    -H "authorization: Bearer $KNA_TOKEN" -H 'content-type: application/json' \
    -d "{\"repoIds\":[\"$repo_id\"],\"reason\":\"local development\"}" \
    | node -pe 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); `queued ${j.jobIds.length} job(s) for ${j.moduleCount} module(s)`'
}

cmd_bootstrap() {
  cmd_up
  cmd_db
  step "Building"
  pnpm build
  cmd_seed
  cmd_start
  echo
  step "Ready"
  info "./scripts/dev.sh publish          index this repository"
  info "./scripts/dev.sh ask \"a question\"  once indexing finishes"
  info "./scripts/dev.sh status           check on everything"
}

cmd_reset() {
  warn "This drops every derived table. The IR bundles in object storage are untouched,"
  warn "so everything can be rebuilt with 'dev.sh reindex <repoId>'."
  printf '    type "reset" to continue: '
  read -r confirm
  [ "$confirm" = "reset" ] || die "cancelled"

  cmd_stop
  step "Dropping and recreating the database"
  docker exec "$(container postgres)" psql -U kna -d postgres -c "DROP DATABASE IF EXISTS kna;" >/dev/null
  docker exec "$(container postgres)" psql -U kna -d postgres -c "CREATE DATABASE kna OWNER kna;" >/dev/null
  rm -f "$TOKENS_FILE"
  cmd_db
  cmd_seed
  cmd_start
}

cmd_help() {
  cat <<'USAGE'

  ./scripts/dev.sh <command>

  Getting going
    bootstrap            containers, database, build, seed, services — from cold
    status               what is running, and what is indexed

  Pieces of that
    up / down            containers only
    db                   migrate and set the application role passwords
    seed                 create the tenant and save credentials to .kna/tokens.env
    start / stop / restart   the three services
    logs [api|worker|mcp]    follow one service's log

  Using it
    repo <remote>        register a repository and mint its publish credential
    publish [path]       analyse and publish a repository (defaults to this one)
    ask "question"       query the knowledge base
    reindex <repoId>     rebuild from the stored bundle, without republishing

  Starting over
    reset                drop the database and re-seed; bundles are kept

  Settings live at the top of this file. Runtime configuration is in .env, which the
  services read themselves — it is deliberately not duplicated here.

USAGE
}

case "${1:-help}" in
  bootstrap) shift; cmd_bootstrap "$@" ;;
  up)        shift; cmd_up "$@" ;;
  down)      shift; cmd_down "$@" ;;
  db)        shift; cmd_db "$@" ;;
  seed)      shift; cmd_seed "$@" ;;
  start)     shift; cmd_start "$@" ;;
  stop)      shift; cmd_stop "$@" ;;
  restart)   shift; cmd_restart "$@" ;;
  logs)      shift; cmd_logs "$@" ;;
  status)    shift; cmd_status "$@" ;;
  repo)      shift; cmd_repo "$@" ;;
  publish)   shift; cmd_publish "$@" ;;
  ask)       shift; cmd_ask "$@" ;;
  reindex)   shift; cmd_reindex "$@" ;;
  reset)     shift; cmd_reset "$@" ;;
  help|-h|--help) cmd_help ;;
  *) die "unknown command '$1' — try: ./scripts/dev.sh help" ;;
esac
