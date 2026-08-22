# CLAUDE.md

> **Authorship.** Written by an LLM (Claude Opus 5) in the session that built this codebase,
> not by a human. The commands and endpoint behaviours below were run and their output read;
> the "Next" section is judgement about ordering, not a plan anyone has validated. See
> [Authorship and evidence](docs/AUTHORSHIP.md).

Working notes for Claude Code sessions in this repository.

Conventions and ground rules live in [AGENTS.md](AGENTS.md) — read that too, it is short. This
file is the operational half: how to run things, what will surprise you, and where the work
stopped.

---

## What this is

A polyglot code knowledge platform built from [`docs/architecture-recommendation.md`](docs/architecture-recommendation.md).
That document is the source of truth for *why*; the code cites it as §N throughout, and those
citations are load-bearing. If you are about to "simplify" something that carries one, read the
section first — most of them exist because a specific failure was anticipated.

Read [`docs/adr/0001-build-vs-buy.md`](docs/adr/0001-build-vs-buy.md) before proposing new
scope. It records what was deliberately **not** built.

**Orientation, in the order that makes each next file make sense:**

1. `packages/ir/src/schema/symbol.ts` — the contract everything reads
2. `packages/ir/src/diff/diff.ts` — why synchronisation is cheap
3. `packages/analyzer-typescript/src/analyzer.ts` — what an analyser actually does
4. `packages/retrieval/src/pipeline.ts` — the whole retrieval flow in one file
5. `packages/retrieval/src/acl.ts` — the security boundary, in SQL
6. `apps/worker/src/jobs/index-module.ts` — the partition swap and stale-chunk sweep
7. `apps/api/src/routes/ingest.ts` — the trust boundary

---

## Commands

Every command here was run and verified. If one fails, that is a bug worth fixing rather than
working around.

```bash
pnpm install
```

```bash
pnpm build
```

`build` and `typecheck` are both `tsc -b`. Use it rather than `pnpm -r build` — the packages are
wired with TypeScript project references, and `-r` does not honour their dependency order.

```bash
pnpm test
```

```bash
pnpm lint
pnpm format
```

Analyse this repository with its own CLI (no platform, no token, no config needed):

```bash
node apps/cli/dist/bin.js describe --format summary
```

Other CLI commands: `init`, `describe`, `scan`, `generate`, `publish`, `ask`, `doctor`. All of
them work offline except `publish` and `ask`, which need a platform.

### Running the services

Configuration comes from `.env` at the repo root — gitignored, and pre-filled with values
verified against the local stack. `loadPlatformEnv()` loads it automatically, so no shell export
is needed:

```bash
node apps/api/dist/server.js
```

Two properties of that loader are deliberate and worth not undoing:

- **The real environment always wins.** A value already in `process.env` is never overwritten,
  so a stale local file cannot shadow what CI or an orchestrator set.
- **Production refuses to read it.** §15.7 requires KMS-backed secrets with no key material in
  environment variables or images; a `.env` on disk in production is precisely what that
  prohibits.

Postgres and Redis must be up and migrated (see below). Then:

```bash
node apps/api/dist/server.js
```

```bash
node apps/mcp/dist/server.js
```

```bash
node apps/worker/dist/main.js
```

All three start and pass their startup assertions with **no LLM provider configured** —
`LITELLM_BASE_URL` can point at nothing, and `OPENAI_API_KEY` can be empty. What breaks without a provider is the query path
(`/v1/search` needs an embedding) and indexing (needs embeddings and blurbs). Everything
structural — health, auth, routing, the ACL filter, symbol lookup — works without one.

Verified endpoints:

| Request | Expect |
|---|---|
| `GET :8080/health/live` | `{"status":"ok"}` — never touches a dependency |
| `GET :8080/health/ready` | Per-dependency states. Advisory failures keep the service `ok` |
| `POST :8080/v1/search` unauthenticated | `401` |
| `GET :8080/nope` | Uniform error envelope with a `traceId` |
| `GET :8081/.well-known/oauth-protected-resource` | RFC 9728 metadata |
| `GET :8081/mcp` unauthenticated | `401` plus a `WWW-Authenticate` naming the resource |

With MinIO stopped, readiness reports `bundle-store: degraded` while overall status stays `ok`.
That is §15.6 working, not a fault: readiness must not depend on an external provider, or one
vendor blip pulls every pod from the load balancer.

---

## Local environment

Postgres and Redis are enough for everything except the LLM paths.

```bash
docker compose -f deploy/docker-compose.yml up -d postgres redis
```

```bash
DATABASE_URL=postgres://kna:kna@localhost:5432/kna pnpm db:migrate
```

Set the application role passwords once — the integration tests need them, and services refuse
to start without them:

```bash
docker exec kna-postgres-1 psql -U kna -d kna -c "ALTER ROLE kna_interactive WITH PASSWORD 'devpass'; ALTER ROLE kna_batch WITH PASSWORD 'devpass';"
```

Then the full suite, including the integration tests:

```bash
DATABASE_URL=postgres://kna:kna@localhost:5432/kna pnpm test
```

Integration tests **skip silently** when `DATABASE_URL` is unset. A green `pnpm test` with no
database has not tested tenant isolation. Current baseline: **194 unit tests plus 25 integration tests, 12 files.**

| Connection | URL | Used by |
|---|---|---|
| Owner / superuser | `postgres://kna:kna@localhost:5432/kna` | Migrations, test fixtures |
| Interactive | `postgres://kna_interactive:devpass@localhost:5432/kna` | API, MCP |
| Batch | `postgres://kna_batch:devpass@localhost:5432/kna` | Worker, integration tests |

The distinction is not cosmetic — see the first gotcha below.

---

## End-to-end against a real repository

The full loop — analyse, publish, index, generate documentation, ask — verified against this
repository. Every step below has been run; the failures each one exposed are in Gotchas.

Bring up the stack. `--env-file .env` is not optional: compose resolves `.env` relative to the
compose file, so without it every `${VAR}` comes from `deploy/.env` and the OpenAI key silently
becomes the placeholder.

```bash
docker compose --env-file .env -f deploy/docker-compose.yml up -d postgres redis minio litellm
```

Migrate, then seed a tenant. The seed must run as the **owner** role — the application roles have
no rights on `orgs` — and `SEED_ORG_ID` must match the `org:` value in `kna.config.yaml`, because
the CLI asserts it in the bundle envelope and ingest refuses a mismatch (§15.2).

```bash
DATABASE_URL=postgres://kna:kna@localhost:5432/kna pnpm db:migrate
```

```bash
DATABASE_URL=postgres://kna:kna@localhost:5432/kna SEED_ORG_ID=kna SEED_ORG=kna SEED_PROJECT=platform SEED_REPOS=$(git remote get-url origin) INGEST_HMAC_SECRET=development-ingest-secret pnpm db:seed
```

The seed prints three credentials, once, because they are stored hashed. They are **three
different kinds of token** and are not interchangeable:

| Variable | Used by | What it is |
|---|---|---|
| `KNA_TOKEN` | `kna ask`, `kna doctor`, `/v1/*` | A principal identity, resolved against `api_tokens` |
| `KNA_INGEST_TOKEN` | `kna publish` | An HMAC-signed claim scoped to one repository (§15.2) |
| `KNA_MCP_TOKEN` | The MCP server | Audience-bound to the resource indicator (§15.4) |

Start the services, publish, and ask:

```bash
node apps/api/dist/server.js & node apps/worker/dist/main.js & node apps/mcp/dist/server.js &
```

```bash
node apps/cli/dist/bin.js publish
```

```bash
node apps/cli/dist/bin.js ask "how does the ACL filter enforce tenant isolation?"
```

What a healthy run looks like on this repo: 19–20 modules indexed, ~2,000 symbols, ~1,200 code
chunks, 22 documents, ~317 documentation chunks. `kna ask` warns that ordering is fusion-only
because no reranker runs locally — that warning is the abstention machinery working, not a fault.

To force a rebuild after changing something about *retrieval* rather than the code — a new
embedding model, different chunk sizes, a fixed indexer bug — ingest will not do it for you,
because it correctly skips modules whose IR is unchanged:

```bash
curl -X POST localhost:8080/v1/admin/reindex -H "authorization: Bearer $KNA_TOKEN" -H 'content-type: application/json' -d '{"repoIds":["<repoId>"],"reason":"why"}'
```

---

## Automatic indexing

Two triggers, and only one of them can actually produce new knowledge.

**CI is the indexer.** Analysis runs the repository's own build logic — resolving a TypeScript
project or restoring packages executes code from the repo — so it happens where the toolchains
are, which is CI. `kna init` writes the workflow, and `--cli-source` decides how the runner gets
the CLI:

| Mode | What the workflow does | Status |
|---|---|---|
| `source` (default) | Checks out the platform repo and builds it in each job | Works today |
| `registry` | One `npx @kna/cli` line | Needs the CLI published — [ADR 0002](docs/adr/0002-cli-distribution.md) |

`source` costs an install and build per job and gives every indexed repo read access to the
platform repo. It is interim on purpose; migrating is a one-flag change.

Its shape is load-bearing:

```
analyse job    no credentials, runs repo build logic  ->  kna-ir.json artifact
publish job    holds the credential, runs no repo code -> kna publish --bundle
```

Collapsing those two jobs puts a publish credential on a runner executing repository-controlled
code, which is remote code execution by design. `--bundle` is what makes the split possible; the
publish step re-signs the envelope, because the analyse job deliberately has no signing secret.

`--oidc` exchanges the runner's workload identity at `/v1/auth/ci-exchange` for a credential
scoped to one repo and valid for minutes. The job needs `permissions: id-token: write` or the
exchange fails loudly rather than falling back to something weaker.

**Webhooks trigger regeneration, not indexing.** A push or a merged pull request tells the
platform the code moved; it does not carry IR, so there is nothing to index until CI publishes.
What the webhook does is regenerate documentation from the newest stored bundle, debounced 60
seconds per `(repo, ref)` so a merge train of twenty pushes produces one job.

Merged pull requests are handled as well as pushes. A PR closed *without* merging is ignored, as
is one merged into a non-default branch — reindexing either would spend money to reproduce the
state we already have.

Both paths need `GIT_WEBHOOK_SECRET`; unsigned webhooks are refused, and the signature is checked
against the raw body before it is parsed.

### Onboarding a repository

Registration is an administrator action, deliberately — it grants read access, and a developer
self-serving that would make the ACL model advisory.

```bash
curl -X POST localhost:8080/v1/admin/repos -H "authorization: Bearer $KNA_TOKEN" -H 'content-type: application/json' -d '{"remote":"github.com/you/svc","projectSlugs":["platform"]}'
```

That registers the repo, grants the calling administrator read access, and reports any project
slug that does not exist. All three matter: a repo with no permission row is indexable and
invisible, and an unknown project slug leaves it invisible to project-scoped questions while
looking indexed.

For a first manual publish before CI exists, mint a credential explicitly. It refuses in
production, caps the lifetime, demands a reason, and names you in the audit log:

```bash
curl -X POST localhost:8080/v1/admin/repos/<repoId>/ingest-credential -H "authorization: Bearer $KNA_TOKEN" -H 'content-type: application/json' -d '{"reason":"first manual publish","ttlHours":2}'
```

---

## Using it from an editor

The MCP server is the developer-facing surface. `.mcp.json` in this repo points at it; each
developer supplies their own `KNA_MCP_TOKEN`, because results are filtered by *their*
permissions.

Scope is inferred from the working directory's git remote, so opening a repo in the editor scopes
tool calls to it with no project picker.

Every tool is read-only, permanently — see the first entry under **Do not**.

---

## Gotchas

These cost time during the build. Each one fails in a way that does not look like its cause.

### ALTER DEFAULT PRIVILEGES does not cover tables that already exist

0005 gave the login roles their posture with `ALTER DEFAULT PRIVILEGES`, which applies only to
objects created *after* it runs. Every table is created in 0001b, four migrations earlier, so
none were covered: the roles could log in, could see the schema, and had privileges on nothing.

It stayed invisible because no database in use had been built from the migrations alone — the
ones we had picked up the grants some other way and carried on working. It appeared the first
time CI ran against a database created from nothing, which is also exactly what a first
deployment is. The failure there is total and immediate: every service starts cleanly, passes its
startup assertions, and then returns permission denied for the first query of any kind.

Fixed forward in 0010 and pinned by an integration test asserting every table is reachable by
both roles. If you add a table, that test is what tells you it needs grants.

Related, and worth stating precisely because 0007's comment overstates it: `kna_interactive` is
not SELECT-only. 0002 grants it INSERT on `audit_events`, `query_traces` and `feedback` — three
append-only tables holding no tenant content. The rule is that the internet-facing role may
append to its own trail and may not modify anything else.

### The sweep must compare ids, not commit shas

Indexing deletes whatever it did not just write, scoped to `(module, version)`. It used to delete
by `indexed_commit_sha <> commitSha`, which is right for a new commit and silently wrong for the
two cases that reindex the *same* one:

- **A deliberate reindex.** `/v1/admin/reindex` replays a stored bundle at its own commit — that
  is the point. And the reasons for asking are exactly the ones that change the output: a new
  embedding model, different chunk sizes, a fixed analyser bug. Stale rows carried the matching
  sha and survived, so the corpus held both versions at once.
- **A crashed run, retried.** Same reason. The old comment claimed robustness here and did not
  have it.

Symbols were not swept at all, so a deleted function stayed answerable through `get_symbol` and
`find_usages` indefinitely — §15.5's "serving deleted code as current" applied to the symbol
surface rather than the chunk one.

### Tier 0 read calls as declarations

`clearInterval(this.autoplay);` has the same shape as an interface method signature, and the
lexical pattern accepted both because `foo(a: string): void;` is a real declaration. Every call
inside a class body therefore became a method of that class.

In a Shopify theme this produced two `SlideshowComponent.clearInterval` symbols from two calls on
consecutive lines: identical qualified names, so identical symbol ids, so identical chunk ids, and
a primary-key violation that failed the whole module's index job. Fixing it removed 70 phantom
symbols from a 458-symbol repository — about 15% of that index was noise.

Assembly now also drops duplicate ids and records the loss in `analysisNotes`, because §5's
registry accepts third-party analysers and cannot assume they are correct. One bad line in one
file should not cost a module its index.

### Luhn alone does not identify a card number

It passes roughly one digit run in ten, and long numeric identifiers are everywhere. A Shopify
section id — `template--22224696705326` — is fourteen digits, passes Luhn, and blocked a publish
with a CRITICAL payment-card finding.

Card numbers are not free-form: each scheme fixes a length *and* a prefix, and at fourteen digits
only Diners Club is assigned. Checking the pair rejects identifiers while still catching every
real card. This matters more than a tidy scan report — a fail-closed gate that cries wolf teaches
people to reach for the allowlist, and an allowlist entry added in irritation is how a real
credential gets waved through later.

### Reads that happen before a tenant is known need a probe

Four of them now, and each failed silently and totally:

| Read | Migration | Symptom while broken |
|---|---|---|
| Bearer token → principal | 0006 | "unknown or expired token" for valid tokens |
| Provider login → principals | 0008 | permission revocations never applied |
| Git remote → repo | 0009 | every push webhook "repo not registered"; auto-indexing never fired |
| Role check, org known | — | every admin route 403'd real administrators |

The first three genuinely cannot know the org — working it out *is* the query. Each declares what
it is resolving and the policy opens exactly that row. Only the token probe is self-authorising
(naming a hash proves possession); the other two narrow an already-authenticated caller and must
never be used from a path that has not verified a signature first.

The fourth was not a probe problem at all — the org was known and simply not set. If you are
reading a tenant table after authentication, use `withOrgContext`.

The tell is always the same: a correct-looking query returning zero rows, and a caller treating
"none" as a legitimate answer.

### Drizzle spreads array parameters instead of binding them

``sql`c.id = ANY(${ids})` `` does not compile to `ANY($1)` with an array bound to it. Drizzle
*spreads* the array into one placeholder per element, so it becomes `ANY($1)` for one id — a text
value where an array was expected — and `ANY($1, $2)` for two. Postgres rejects both:

```
malformed array literal: "chk_1a2b..."
op ANY/ALL (array) requires array on right side
```

Twenty-five call sites across five packages were written the natural way and every one was wrong.
Use `anyOf()` from `@kna/db`, never a bare array in a template. The same applies to `unnest()` and
the jsonb `?|` operator, which need `sql.param()`.

Nothing catches this without a live database: the template reads exactly like the SQL it was meant
to be, and a mocked driver never notices. Pinned now in `packages/db/src/integration.test.ts`.

### RLS hides the rows authentication needs

Resolving a bearer token happens before there is a principal, so there is no org to set — and
`api_tokens` is org-isolated like every other tenant table. The read returned zero rows and the
API answered "unknown or expired token" for tokens created seconds earlier.

Migrations 0006 and 0008 add two narrow probes. `withAuthProbe` opens exactly the row whose token
hash the caller declares — naming the hash proves possession of the token. `withIdentityProbe`
opens principals matching a declared provider subject, for the identity webhook, which is
genuinely cross-tenant and is authorised by its HMAC signature instead.

Anything reading before a principal exists has this problem. Anything reading *after* one exists
must use `withOrgContext` — `requireAdmin` and the MCP permission resolver both used a bare
connection, so every admin route 403'd a real administrator and every MCP tool call reported "no
permitted repositories".

### The interactive role cannot write, deliberately

0005 grants `kna_interactive` SELECT and nothing else. That rules out conveniences that look
harmless: stamping `last_used_at` during authentication would mean granting the internet-facing
role UPDATE on the credential table. Writes the platform owes regardless of the caller — audit,
breadth accounting — go through a batch handle. See migration 0007.

Related: there is no such thing as a best-effort statement inside a transaction. A failing INSERT
wrapped in `.catch()` still aborts the transaction, and the COMMIT fails.

### BullMQ job ids make deliberate re-runs no-ops

Job identity is `(moduleId, commitSha)` for indexing and `(repoId, commitSha)` for docs, which
gives replayed-webhook idempotency for free. It also means an operator asking for the same work
again gets a 204 and nothing happens. Deliberate triggers pass a discriminator — `reindexToken`
or `regenerationToken` — which joins the job id. Ingest does not.

Also: BullMQ rejects `:` in a job id, and its default 30-second lock assumes short jobs.
Documentation regeneration makes one model call per module in sequence and needs `lockDurationMs`
sized for that, or it is declared stalled while it is still working.

### Model names in application code defeat the proxy

`WORKLOAD_POLICIES[*].defaultModel` and the `MODEL_*` env vars name **routes on the LiteLLM
proxy** — `chat`, `query`, `blurb`, `docgen` — not provider model ids. §11 keeps LiteLLM so that a
vendor swap is a config change; naming `gpt-5` in application code moves that decision back into a
deploy, and a model the deployment's key cannot reach becomes a runtime 400 the proxy existed to
prevent.

The symptom was 21 of 21 documentation prose sections "rejected", which reads as a content-quality
problem and was a model-access problem. The counters are now separate: `proseRejected` is the
grounding check refusing a claim, `proseFailed` is the call never completing.

### LiteLLM shares a Postgres server, not a database

Its Prisma migrations drop tables they do not recognise. Point the LiteLLM container's
`DATABASE_URL` at `kna_litellm`, created by `deploy/postgres/initdb/01-databases.sql`. Also:
`model_info.tier` is LiteLLM's own field, validated as `free|paid` — using it for the
interactive/batch split starts the proxy with **zero models loaded**.

### The repo speaks slugs; the platform speaks ids

`kna.config.yaml` says `projects: [platform]`. The platform stores `prj_local`. A repository
cannot know platform ids, so resolution happens at index time — `resolveProjectIds` in
`apps/worker/src/jobs/project-scope.ts`, shared by both jobs that write chunks.

It is shared because it was not. Indexing resolved and documentation regeneration did not, so the
code and docs corpora ended up in different namespaces, and every project-scoped query — which is
every MCP tool call, since scope is inferred from the working directory — silently returned zero
documentation chunks. Anything writing `chunks.project_ids` or `module_projects` must resolve
first.

### Postgres roles are cluster-wide, so a scratch database clobbers the real one

`ALTER ROLE kna_interactive WITH PASSWORD ...` does not belong to the database you are connected
to. Setting a CI-style password while reproducing a CI failure against a throwaway database
changed it for every database in the cluster, and the running services died at startup with
`password authentication failed` — which looks exactly like the dependency upgrade under test
having broken something.

Reproduce CI against a scratch database by all means, but put the passwords back afterwards, or
use a separate cluster.

### The OpenTelemetry SDK was never wired up

`packages/observability` imports only `@opentelemetry/api`, which returns a **no-op tracer** when
no SDK is registered. Nothing registers one, so `withSpan` has always been decoration: correct
code, producing no spans.

That was disguised by `sdk-node`, `auto-instrumentations-node`, `exporter-trace-otlp-http`,
`resources` and `semantic-conventions` all sitting in `package.json` — declared, never imported.
They were removed when five of them turned up in a security audit, which is a poor reason to
discover that your tracing does nothing.

Depending on the OTel API alone is the right shape for a shared library; registering the SDK is
the application's job, usually through a `--require` bootstrap. That bootstrap does not exist
yet. §15.6's requirement to correlate a Langfuse trace id with an OTel span id is unmet until it
does.

### Windows: `pkill` does not reach node processes

`pkill -f "apps/worker/dist/main.js"` reports success and kills nothing, so a stale worker keeps
consuming jobs with the old code — which looks exactly like a fix that did not take. Use:

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*apps/worker/dist/main.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
```

### A superuser connection makes RLS silently inert

Not "throws an error". **Silently.** Policies exist, `relrowsecurity` is true, the invariant
check passes, and every tenant reads every other tenant's source code. Nothing anywhere reports
a problem.

`assertRlsEffective()` runs at startup in every service and refuses to serve otherwise. If you
add a service, call it. If a test asserts isolation, it must connect as `kna_batch`, not `kna` —
otherwise it proves nothing and will pass regardless.

### Migrations are immutable once applied

The runner compares checksums and refuses a changed file. Fix forward. `0004_lexical_stats_rls.sql`
exists because the invariant check found a gap in `0002` — that is the intended workflow, not a
mistake to tidy up.

Ordering is filename-lexical, which is why the generated tables are `0001b_tables.sql`: they
must run after `0001_extensions.sql` (which installs pgvector) and before `0002_rls.sql`.

### drizzle-kit reads `dist/`, not `src/`

`drizzle.config.ts` points at the compiled schema, because drizzle-kit loads it through a
CommonJS require that cannot resolve NodeNext `.js` specifiers. **Build before generating:**

```bash
pnpm build && pnpm db:generate
```

`db:generate` also runs `scripts/fix-vector-ddl.mjs`, which unquotes `"halfvec(1536)"` →
`halfvec(1536)`. Drizzle emits parameterised custom types as quoted identifiers, which Postgres
reads as a type literally named `halfvec(1536)` and rejects. The fixup is idempotent; do not
remove it.

### pnpm blocks install scripts

`onlyBuiltDependencies` in `pnpm-workspace.yaml` is the allowlist, and
`scripts/check-install-scripts.mjs` fails CI if an entry has no stated reason. If a dependency
needs a postinstall, justify it there rather than widening the list quietly.

### `pnpm test` with no `DATABASE_URL` is a partial run

Worth repeating. Eight files pass either way; the isolation and advisory-lock tests only
actually execute with a database.

### Compiling is not running

Three bugs survived a clean `tsc -b`, a clean lint and 142 passing tests, and only appeared the
first time a server was actually started:

- `pino-pretty` was named in a transport but never a dependency, so **every service died at
  startup in development** with a stack trace that did not mention logging. It is now an
  optional dependency behind a resolve check, falling back to JSON.
- Fastify 5 takes a configuration object under `logger` and a constructed instance under
  `loggerInstance`. Passing a pino instance to the former throws.
- The inferred `buildServer` return type named pino through a nested `node_modules` path, which
  is not portable. There is now an explicit `KnaServer` type in `apps/api/src/context.ts`.

If you add a service or change its wiring, start it once. The type checker will not tell you.

---

## State

| Area | State |
|---|---|
| IR schema, identity, diff, breaking-change detection, circuit breaker | Complete, tested |
| Tier 0 lexical parsing (TS/JS/Python/C#) | Complete |
| Tier 1 TypeScript analyser (ts-morph) | Complete, passes conformance |
| Tier 1 Python (Griffe), .NET (Roslyn) | **Not written.** Contract, subprocess transport and conformance suite are ready |
| Tier 2 OpenAPI, IaC, compose, Helm | Complete |
| Guardrail scanning and classification | Complete, tested |
| Bundle signing and envelope verification | Complete; Sigstore *claim matching* done, crypto delegates to `@sigstore/verify` |
| Postgres schema, RLS, pgvector | Complete, verified against a live database |
| Retrieval: hybrid, fusion, diversity, expansion, abstention | Complete, tested |
| Eval harness (metrics, bootstrap, gate) | Complete, tested. **The runner is not built** |
| Indexing worker, partition swap, cross-repo resolution | Complete, run end to end against this repo |
| Documentation regeneration worker | Complete. Three of §6's six document types; `docs.types` is not yet in the bundle, so the platform copy always has all three |
| MCP server, seven read-only tools | Complete, exercised over streamable HTTP |
| Local seed path and end-to-end walkthrough | Complete |
| Multi-repo | Two repositories indexed and queried in one tenant. Cross-repo *symbol resolution* is written but still unexercised — both repos are independent |
| CLI distribution to CI | Interim: built from source in the workflow. See [ADR 0002](docs/adr/0002-cli-distribution.md) |
| Git provider HTTP calls | **Not written.** Interfaces and write-gating refusals work |
| Documentation site | Not started — bought, not built (ADR 0001) |
| Web chat UI | Not started, and **not** ruled out by ADR 0001. That ADR defers the *documentation site* and the *external* assistant; the internal assistant is on its build list. The IDE surface (MCP) covers developers today |

---

## Next

Roughly in order of value. Each is scoped to be a session's work.

**1. The eval runner.** The highest-value gap. `packages/retrieval/src/eval` has the metrics, the
paired bootstrap and the CI gate, all unit-tested — what is missing is the thing that loads
`eval_items`, runs the pipeline against a seeded corpus, and calls `evaluateGate()`. CI currently
**fails deliberately** when a retrieval config change is detected, rather than passing silently;
that is the honest state but not a good permanent one. The corpus it needed now exists: `pnpm
db:seed` plus `kna publish` produces a real indexed repository in minutes.

**2. The Griffe analyser.** `packages/analyzer-core/src/registry.ts` defines the contract and
`subprocess.ts` the transport. Write it as a Python subprocess speaking `kna-analyzer/1`, add a
fixture repo mirroring `packages/analyzer-typescript/test/fixtures/billing`, and run
`pnpm conformance`. §5 estimates a week; the suite is what makes that estimate hold.

**3. Git provider calls.** `apps/api/src/services/git.ts` and `apps/worker/src/services/git.ts`.
The refusal logic and write-gating are done and correct — what is missing is the HTTP. Start with
`commitExists()` (needed by ingest verification) and `headSha()` (needed by the reconciliation
sweep); PR creation is larger and can wait.

**4. Roslyn analyser.** Same shape as 2, as a `dotnet tool`.

**5. Per-module documentation jobs.** Regeneration currently does a whole repo in one job, one
model call per module in sequence, held together by a 15-minute queue lock. That is fine for a
repo of this size and is the wrong shape at organisation scale; fanning out to one job per module
bounds it properly and removes the long lock.

**6. `docs.types` in the bundle envelope.** The platform cannot see a repo's document-type
selection, so `kna generate` honours it and the platform's queryable copy does not. Carrying it in
the envelope is an IR schema change and belongs with the next version bump.

Four **decisions**, not code, are still open and block Phase 1 per §15.8. They are listed in
[ADR 0001 §6](docs/adr/0001-build-vs-buy.md): named owner and funding line, the coexistence rule
for existing Confluence/wiki docs, a per-repo unit cost run against a real repository, and
rollout waves with kill criteria.

---

## Do not

- **Add a write tool to the MCP surface.** §10 Layer 5. The corpus is full of
  attacker-controllable text; a side-effecting tool reachable from it is an injection payload
  waiting for a target. This is not a temporary limitation.
- **Merge the analyse and publish CI jobs.** §15.2. That separation is the trust boundary.
- **Present shallow analysis with the confidence of semantic analysis.** §5. The badge travels
  from the analyser through chunking and retrieval into the response for a reason.
- **Change retrieval config without the eval gate.** Anything touching chunking, embedding,
  fusion, reranking, expansion or prompts moves `retrieval_config_version`. §15.5's point is
  about statistical power: at n=100 the set resolves 5–8 point deltas and most real changes move
  1–3, so a point estimate that improved is not evidence.

  Until the runner exists there is an interim control, not a substitute: a watched file change
  must carry an entry in [`docs/retrieval-changes.md`](docs/retrieval-changes.md) arguing why it
  cannot regress quality. `scripts/check-retrieval-config.mjs` enforces it. An entry saying
  "small change, looks fine" is exactly what that section says is not evidence.
- **Edit an applied migration.** Fix forward.
