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

# How to spell the next command back to the caller. `pnpm dev` sets this, so a PowerShell user is
# not told to run `./scripts/dev.sh`, which their shell cannot execute.
invocation() { printf '%s' "${KNA_DEV_INVOCATION:-./scripts/dev.sh}"; }

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

# Start a service without holding on to this terminal.
#
# `nohup ... &` is enough on Unix and is not enough here. Under Git Bash the backgrounded process
# keeps the parent's console handles even with every stream redirected, so the shell that
# launched it does not return — `start` appears to hang while all three services are in fact
# running perfectly. `Start-Process` genuinely detaches.
#
# The cost is two files per service, because Start-Process cannot point both streams at one. In
# practice everything normal goes to .log, since the services log to stdout, and .err.log stays
# empty unless something crashed — which makes a non-empty one a useful signal in itself.
spawn_service() {
  local svc="$1" entry="$2"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      powershell.exe -NoProfile -Command         "Start-Process -FilePath 'node' -ArgumentList '$entry'            -WorkingDirectory '$(cygpath -w "$ROOT")'            -RedirectStandardOutput '$(cygpath -w "$LOG_DIR/$svc.log")'            -RedirectStandardError '$(cygpath -w "$LOG_DIR/$svc.err.log")'            -WindowStyle Hidden" >/dev/null 2>&1
      ;;
    *)
      ( cd "$ROOT" && nohup node "$entry" < /dev/null > "$LOG_DIR/$svc.log" 2>&1 & )
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
    die "container '$1' is not running — try: $(invocation) up"
}

cmd_seed() {
  mkdir -p "$STATE_DIR"
  step "Seeding tenant '$ORG'"

  local remote
  remote="$(git remote get-url origin 2>/dev/null || echo '')"
  [ -n "$remote" ] && info "registering this repository: $remote"

  # The seed HMAC-signs each ingest credential and falls back to the documented default when
  # this is unset, so a rotated secret would mint credentials the API cannot verify. The only
  # symptom is every publish failing on signature, long after the rotation.
  local ingest_secret
  ingest_secret="$(env_value INGEST_HMAC_SECRET)"
  [ -n "$ingest_secret" ] || warn "no INGEST_HMAC_SECRET in .env — seeding with the default"

  local output
  output="$(
    export DATABASE_URL="$OWNER_URL" SEED_ORG_ID="$ORG" SEED_ORG="$ORG" \
      SEED_PROJECT="$PROJECT" SEED_REPOS="$remote"
    [ -n "$ingest_secret" ] && export INGEST_HMAC_SECRET="$ingest_secret"
    pnpm --filter @kna/db exec tsx bin/seed.ts
  )"

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
  sync_env_tokens
  mcp_token_hint
}

# Point .env at the credentials that were just minted.
#
# The seed regenerates every credential and stores them hashed, so the previous ones stop
# working the moment it runs. .kna/tokens.env is rewritten here, but the CLI reads .env — and
# nothing kept the two in step, so after a wipe-and-rebuild `kna ask` failed with
# `invalid_token`, which reads like a bug rather than "you re-seeded".
#
# Only the two keys the CLI actually uses, only if .env exists, and a commented placeholder is
# activated rather than duplicated. Everything else in the file is left exactly as it was.
sync_env_tokens() {
  [ -f "$ROOT/.env" ] || { note "no .env — skipping token sync"; return 0; }

  local synced=""
  for key in KNA_TOKEN KNA_INGEST_TOKEN; do
    local value
    value="$(grep -E "^export $key=" "$TOKENS_FILE" | head -1 | cut -d= -f2-)"
    [ -n "$value" ] || continue

    local tmp="$ROOT/.env.tmp.$$"
    # Through ENVIRON rather than -v: awk expands backslash escapes in a -v value, and a
    # credential is not something to run through an escape parser.
    KNA_SYNC_KEY="$key" KNA_SYNC_VAL="$value" awk '
      BEGIN { key = ENVIRON["KNA_SYNC_KEY"]; val = ENVIRON["KNA_SYNC_VAL"]; done = 0 }
      $0 ~ "^" key "=" || $0 ~ "^#[ \t]*" key "=" {
        if (!done) { print key "=" val; done = 1 }
        next
      }
      { print }
      END { if (!done) print key "=" val }
    ' "$ROOT/.env" > "$tmp" && mv "$tmp" "$ROOT/.env"

    synced="$synced $key"
  done

  [ -n "$synced" ] && info ".env updated:$synced"
  return 0
}

# The MCP token is read by the editor from the OS environment, not from .env, so it is the one
# credential this script cannot put in place itself.
mcp_token_hint() {
  local value
  value="$(grep -E '^export KNA_MCP_TOKEN=' "$TOKENS_FILE" | head -1 | cut -d= -f2-)"
  [ -n "$value" ] || return 0

  info ""
  info "for the editor, set KNA_MCP_TOKEN and restart it:"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      # PowerShell, because that is where this is run from on Windows even though the script
      # itself is bash. Handing over a `grep | cut` pipeline here just produces an error.
      info "  setx KNA_MCP_TOKEN \"$value\""
      ;;
    *)
      info "  export KNA_MCP_TOKEN=$value"
      ;;
  esac
}

load_tokens() {
  [ -f "$TOKENS_FILE" ] || die "no credentials yet — run: $(invocation) seed"
  set -a; . "$TOKENS_FILE"; set +a
}

# Read one value out of `.env` the way the services' own loader reads it.
#
# `cut -d= -f2-` is the obvious thing and is wrong in two ways that surface much later: it
# keeps a trailing ` # comment`, which the Node loader strips, and it keeps surrounding
# quotes. Two readers of one file disagreeing about what a value is produces a signature
# mismatch, which reports as a rejected bundle and looks nothing like a parsing difference.
env_value() {
  [ -f "$ROOT/.env" ] || return 0
  sed -n "s/^$1=//p" "$ROOT/.env" | head -1 |
    sed -e 's/ #.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# The CLI signs bundles with KNA_INGEST_HMAC_SECRET; the server verifies them with
# INGEST_HMAC_SECRET. Two names for one shared value, and only the server's is in .env — so
# every publish silently produced an unsigned bundle until the CLI's name was set by hand.
# Bridged here rather than left as a trap.
load_signing_secret() {
  local secret
  secret="$(env_value INGEST_HMAC_SECRET)"
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
    spawn_service "$svc" "$entry"
    info "$svc started"
  done
  note "logs in .kna/logs/ — follow one with: $(invocation) logs worker"
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
  local entry; entry="$(service_entry "$svc")"

  # A missing log file usually means the service is running but was not started by this script —
  # started by hand, it logs wherever that command sent it. `tail: no such file` is a true and
  # unhelpful way to say so.
  if [ ! -f "$LOG_DIR/$svc.log" ]; then
    if is_running "$entry"; then
      die "$svc is running but was not started by this script, so it is logging elsewhere.
    $(invocation) restart   will restart all three and log to .kna/logs/"
    fi
    die "$svc is not running.
    $(invocation) start"
  fi

  if [ -s "$LOG_DIR/$svc.err.log" ]; then
    warn "$svc has written to $svc.err.log — something was logged outside the normal stream"
  fi

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
  [ -n "$remote" ] || die "usage: $(invocation) repo <git-remote-url>"
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
  info "next: clone the repository if you have not already, add kna.config.yaml to"
  info "it with 'org: $ORG', then:"
  info ""
  info "  $(invocation) publish /path/to/repo"
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
    run: $(invocation) repo $remote"

  load_signing_secret
  step "Publishing $path"
  # --org, because this script registered the repository under $ORG and looked its
  # credential up by the repo id derived from it. Without it the CLI falls back to the
  # config file, and a repository that has none asserts org "default" — a different repo
  # id, and a credential that does not authorise it. The config schema says a repository
  # with no config file is fully onboardable; this is what makes that true here.
  KNA_INGEST_TOKEN="$token" node "$ROOT/apps/cli/dist/bin.js" --cwd "$path" --org "$ORG" publish
}

cmd_ask() {
  load_tokens

  # Scope is inferred from the working directory, exactly as it is in an editor. Run from this
  # repository and you ask about this repository — which is rarely what you want once a second
  # one is indexed, and gives no clue that it is what happened.
  local target="$ROOT" scope=()
  if [ "${1:-}" = "--in" ]; then
    [ -n "${2:-}" ] || die 'usage: ask --in <path-to-repo> "your question"'
    target="$2"; shift 2
    scope=(--scope repo)
    [ -d "$target" ] || die "no such directory: $target"
  fi

  [ $# -gt 0 ] || die "usage: $(invocation) ask [--in <path>] \"your question\""
  node "$ROOT/apps/cli/dist/bin.js" --cwd "$target" ask "${scope[@]}" "$@"
}

cmd_reindex() {
  local repo_id="${1:-}"
  [ -n "$repo_id" ] || die "usage: $(invocation) reindex <repoId>  (see: dev.sh status)"

  # Some Markdown renderers visually consume the escape in `repo\_…` but leave the literal
  # backslash in copied text. PowerShell does not treat that backslash as an escape, so the API
  # receives a different repository id and used to answer with the deeply misleading
  # "0 job(s) for 0 module(s)". Accept that one unambiguous presentation-layer escape here,
  # then validate the identifier before sending it across the API boundary.
  local supplied_repo_id="$repo_id"
  repo_id="${repo_id//\\_/_}"
  if [ "$repo_id" != "$supplied_repo_id" ]; then
    warn "normalised copied repository id to $repo_id"
  fi
  [[ "$repo_id" =~ ^repo_[0-9a-f]{32}$ ]] || die "invalid repoId '$repo_id'
    expected repo_ followed by 32 lowercase hexadecimal characters"

  load_tokens
  step "Reindexing $repo_id"
  local response
  response="$(curl -sf -X POST "$API_URL/v1/admin/reindex" \
    -H "authorization: Bearer $KNA_TOKEN" -H 'content-type: application/json' \
    -d "{\"repoIds\":[\"$repo_id\"],\"reason\":\"local development\"}")" \
    || die "reindex request failed — is the API running?"

  echo "$response" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (j.moduleCount === 0) {
      const reason = j.skipped?.map((x) => x.reason).join(", ") || "repository has no modules";
      console.error(`reindex queued nothing: ${reason}`);
      process.exit(1);
    }
    console.log(`queued ${j.jobIds.length} job(s) for ${j.moduleCount} module(s)`);
  '
}

cmd_bootstrap() {
  cmd_up
  cmd_db
  step "Building"
  pnpm build
  cmd_seed
  # A build does not change code already loaded by the host Node processes. Keeping an old API
  # alive after an IR schema change makes it parse a new bundle with an old schema, which can
  # discard additive fields and surface as a misleading payload-hash mismatch. Bootstrap means
  # "run the stack I just built", so replace any existing local services deliberately.
  cmd_restart
  echo
  step "Ready"
  info "$(invocation) publish          index this repository"
  info "$(invocation) ask \"a question\"  once indexing finishes"
  info "$(invocation) status           check on everything"
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

  $(invocation) <command>

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
    ask "question"       query the knowledge base (this repository)
    ask --in <path> "…"  query one specific repository
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
  *) die "unknown command '$1' — try: $(invocation) help" ;;
esac
