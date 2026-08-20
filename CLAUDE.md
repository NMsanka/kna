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
database has not tested tenant isolation. Current baseline: **142 tests, 8 files.**

| Connection | URL | Used by |
|---|---|---|
| Owner / superuser | `postgres://kna:kna@localhost:5432/kna` | Migrations, test fixtures |
| Interactive | `postgres://kna_interactive:devpass@localhost:5432/kna` | API, MCP |
| Batch | `postgres://kna_batch:devpass@localhost:5432/kna` | Worker, integration tests |

The distinction is not cosmetic — see the first gotcha below.

---

## Gotchas

These cost time during the build. Each one fails in a way that does not look like its cause.

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
| Indexing worker, partition swap, cross-repo resolution | Complete |
| MCP server, seven read-only tools | Complete |
| Git provider HTTP calls | **Not written.** Interfaces and write-gating refusals work |
| Web UI, docs site | Not started — bought, not built (ADR 0001) |

---

## Next

Roughly in order of value. Each is scoped to be a session's work.

**1. The eval runner.** The highest-value gap. `packages/retrieval/src/eval` has the metrics,
the paired bootstrap and the CI gate, all unit-tested — what is missing is the thing that loads
`eval_items`, runs the pipeline against a seeded corpus, and calls `evaluateGate()`. CI currently
**fails deliberately** when a retrieval config change is detected, rather than passing silently;
that is the honest state but not a good permanent one. Needs a seeded corpus first.

**2. A seed path.** Nothing populates a database for local development. The pieces exist —
`kna describe` produces a bundle, and the worker can index one — but there is no command that
joins them without the full API. This unblocks the eval runner and makes the retrieval code
runnable rather than only testable.

**3. The Griffe analyser.** `packages/analyzer-core/src/registry.ts` defines the contract and
`subprocess.ts` the transport. Write it as a Python subprocess speaking `kna-analyzer/1`, add a
fixture repo mirroring `packages/analyzer-typescript/test/fixtures/billing`, and run
`pnpm conformance`. §5 estimates a week; the suite is what makes that estimate hold.

**4. Git provider calls.** `apps/api/src/services/git.ts` and `apps/worker/src/services/git.ts`.
The refusal logic and write-gating are done and correct — what is missing is the HTTP. Start with
`commitExists()` (needed by ingest verification) and `headSha()` (needed by the reconciliation
sweep); PR creation is larger and can wait.

**5. Roslyn analyser.** Same shape as 3, as a `dotnet tool`.

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
- **Edit an applied migration.** Fix forward.
