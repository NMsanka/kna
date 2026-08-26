# Hosting KNA

> **Authorship.** Written by an LLM (Claude Opus 5). **This deployment has never been performed.**
> Every command was derived from code that was read and, where possible, exercised locally — but
> nothing here has been run against a cloud provider. Treat it as a considered plan, not a
> tested procedure, and expect to correct it the first time through. See
> [Authorship and evidence](AUTHORSHIP.md).

[`runbooks/deployment.md`](runbooks/deployment.md) is the policy: environment separation, deploy
ordering, sizing, and the pre-production checklist. This is the mechanics — what to provision and
in what order to turn it on.

---

## What you are standing up

Three stateless services and four stateful dependencies.

| Service | Port | Scales on | Notes |
|---|---|---|---|
| API | 8080 | Request rate | Ingest, search, admin. The only public surface |
| MCP | 8081 | Concurrent editors | Long-lived streaming sessions; needs graceful drain |
| Worker | — | Queue depth **and oldest-job age** | No HTTP surface at all |

| Dependency | What it holds | Losing it means |
|---|---|---|
| Postgres + pgvector | Symbols, chunks, embeddings, tenancy, audit | Rebuildable from object storage |
| Object storage | **The IR bundles — the system of record** | Unrecoverable |
| Redis | Job queues | Re-publish to recover |
| LiteLLM | Model routing, cost attribution, rate limits | Query and indexing stop; structure still serves |

The asymmetry in that second table is the important part. Postgres is a *derived cache*: it can
be dropped and rebuilt by replaying bundles. Object storage cannot. Back up accordingly — and
notice that this means your restore drill is "replay the bundles", which is a thing you can
actually rehearse.

---

## 1. Provision

**Postgres 16+ with the `vector` extension.** Managed is fine — RDS, Cloud SQL, Azure Database,
Neon and Supabase all ship pgvector. Two things to get right:

- **RAM must fit the HNSW index twice over.** During an embedding migration both the old and new
  index exist at once. This is the number that dictates instance size, not CPU.
- `maintenance_work_mem` at 1–2GB. The default makes index builds crawl.

You need a second database on the same server for LiteLLM — **not** the same database. Its Prisma
migrations drop tables they do not recognise, and they will take your schema with them. See
`deploy/postgres/initdb/01-databases.sql`.

**Redis 7+** with `maxmemory-policy=noeviction` and AOF on. The API asserts this at startup and
refuses to serve otherwise, because an evicting Redis silently drops queued indexing jobs.

**S3-compatible object storage**, two buckets:

| Bucket | Setting | Why |
|---|---|---|
| `kna-ir-bundles` | Versioning **and** object lock | It is the system of record; a rewritable record is not one |
| `kna-audit` | WORM retention | §15.7 — audit that lives in the database it polices is not audit |

Object lock is set **at bucket creation** and cannot be added later. Getting this wrong means
recreating the bucket.

**A container host.** Anything that runs OCI images: ECS, Cloud Run, AKS, Fly, Railway, a VM with
compose. Nothing here needs Kubernetes.

---

## 2. Build and push the images

One Dockerfile, four targets. The runtime stages are separate on purpose — the services must not
share a process, a database role, or a provider quota.

```bash
docker build -f deploy/Dockerfile --target api     -t YOUR_REGISTRY/kna-api:$(git rev-parse --short HEAD) .
docker build -f deploy/Dockerfile --target worker  -t YOUR_REGISTRY/kna-worker:$(git rev-parse --short HEAD) .
docker build -f deploy/Dockerfile --target mcp     -t YOUR_REGISTRY/kna-mcp:$(git rev-parse --short HEAD) .
docker build -f deploy/Dockerfile --target migrate -t YOUR_REGISTRY/kna-migrate:$(git rev-parse --short HEAD) .
```

Tag by commit, not `latest`. A rolling deploy needs to name the version it is rolling to.

The `api` image also carries the web application. It is bundled during the image build and
served from `apps/web/dist`, so there is no second container, no static host and nothing to put
in front of it — one image, one process, one port.

Two things about that build are worth knowing before it surprises you:

- **`.dockerignore` is load-bearing.** Without it `COPY apps apps` copies the host's
  `node_modules` over the ones the image just installed, and the web build fails with
  `Cannot find module` because a pnpm bin symlink points into a store path that does not exist
  in the image.
- **Every workspace package needs its manifest copied** in the dependency stage of the
  Dockerfile. A missing one is invisible for as long as anyone builds on a machine that has
  already run `pnpm install`, and fails only on a clean builder — which is what CI is.

The `migrate` image exists separately because migrations run as the **owner** role while the
services run as non-superuser roles. One image cannot hold both credentials without defeating the
point.

---

## 3. Secrets

**Production refuses to read `.env`.** `loadPlatformEnv()` enforces it: §15.7 requires KMS-backed
secrets with no key material in environment variables or images, and a file on disk is exactly
what that prohibits. Use your platform's secret manager and inject at runtime.

Required, with no default:

```
KNA_ENV=production
DATABASE_URL                 postgres://kna_interactive:...@host/kna
DATABASE_URL_BATCH           postgres://kna_batch:...@host/kna
REDIS_URL
BUNDLE_STORE_ENDPOINT
BUNDLE_STORE_ACCESS_KEY
BUNDLE_STORE_SECRET_KEY
LITELLM_BASE_URL
LITELLM_KEY_INTERACTIVE      distinct virtual keys — see below
LITELLM_KEY_BATCH
LITELLM_AUTH_HEADER          optional; defaults to authorization
LITELLM_AUTH_SCHEME          bearer (default) or raw
SESSION_SECRET               32 bytes minimum
```

Production-specific:

```
INGEST_SIGNATURE_MODE=sigstore    the loader refuses permissive-dev outside development
WRITE_ENABLED=true                refused anywhere but production
OIDC_ISSUER                       required for CI to exchange its identity
GIT_PROVIDER=github               and GIT_APP_ID, GIT_APP_PRIVATE_KEY_REF
GIT_WEBHOOK_SECRET                without it webhooks are refused with 501
```

`GIT_APP_PRIVATE_KEY_REF` is a **reference** to a KMS key, never key material. That key grants
read access across every repository in the company.

`LITELLM_BASE_URL` may point at the bundled LiteLLM instance or directly at any endpoint that
implements the OpenAI-compatible `/v1/chat/completions` and `/v1/embeddings` schema. The base URL
must not include `/v1`; KNA appends the endpoint path. For gateways that authenticate with a raw
API-key header rather than `Authorization: Bearer`, set for example:

```dotenv
LITELLM_BASE_URL=https://models.example.com
LITELLM_KEY_INTERACTIVE=<interactive-or-shared-key>
LITELLM_KEY_BATCH=<batch-or-shared-key>
LITELLM_AUTH_HEADER=x-api-key
LITELLM_AUTH_SCHEME=raw
```

The `MODEL_*` and `EMBEDDING_MODEL` values must name models or route aliases exposed by that
gateway. A gateway with one shared key can use the same value for both key variables; separate
keys remain preferable when the gateway supports independent interactive and batch quotas.

**The two LiteLLM keys must share no model entry.** That is what stops a backfill saturating the
embedding quota and 429-ing interactive chat at the same moment. An annotation would not; a key
that physically cannot reach a model does.

The `MODEL_*` variables name **routes on the proxy** (`chat`, `query`, `blurb`, `docgen`), not
provider model ids. The defaults are correct; override them only to point a workload at a
different route you have defined.

---

## 4. Bootstrap, in order

**Migrate**, as the owner role:

```bash
docker run --rm -e DATABASE_URL="postgres://owner:...@host/kna" YOUR_REGISTRY/kna-migrate:TAG
```

**Set the application role passwords.** Deliberately not a migration — a migration containing a
password puts it in git, in every environment's history, and in a checksum the runner will not let
you change.

```bash
KNA_INTERACTIVE_PASSWORD=... KNA_BATCH_PASSWORD=... PGHOST=... ./deploy/postgres/bootstrap-roles.sh
```

Note that Postgres roles are **cluster-wide**. If the same server hosts another environment, this
changes the password there too.

**Verify RLS is effective before serving anything:**

```bash
psql "postgres://kna_interactive:...@host/kna" -c "SELECT kna_rls_is_effective();"
```

It must return `t`. A superuser connection makes row-level security *silently* inert — policies
exist, `relrowsecurity` is true, the invariant check passes, and every tenant reads every other
tenant's source code. The services assert this at startup and refuse to run, which is the single
most important safety property in the deployment.

**Deploy the services**, in the order the runbook gives: workers, then API, then MCP.

**Create the first organisation.** `pnpm db:seed` is development-only — it refuses to run against
`KNA_ENV=production`, prints credentials to stdout, and grants broad permissions. For production,
insert the org, project and first admin principal deliberately, then mint that principal an API
token. There is no bootstrap-admin endpoint, on purpose.

---

## 5. Networking

| Surface | Exposure |
|---|---|
| API :8080 | Public — CI publishes to it, and webhooks arrive on it |
| MCP :8081 | Public or VPN, depending on whether developers work remotely |
| Postgres, Redis, object storage | **Private.** Never public |
| LiteLLM :4000 | Private. It holds your provider keys |

TLS terminates at your load balancer. Both HTTP services are plain HTTP behind it.

MCP holds long-lived streaming sessions, so set the idle timeout generously — a 60-second default
will cut editor connections mid-session.

---

## 6. Turning on automatic indexing

Per repository: `kna.config.yaml`, the CI workflow from `kna init`, and registration through
`POST /v1/admin/repos`. See [Automatic indexing](../CLAUDE.md#automatic-indexing).

The workflow needs the CLI. Today it builds it from a checkout of this repository, which costs an
install and build per job and gives every indexed repo read access to the platform repo. See
[ADR 0002](adr/0002-cli-distribution.md) — publishing the CLI makes it one `npx` line, and
migrating is a one-flag change.

---

## What is not ready

Four things a first deployment will meet. None is a blocker; all are better known in advance.

**Tracing produces nothing.** `packages/observability` depends on the OpenTelemetry API alone,
which returns a no-op tracer when no SDK is registered — and nothing registers one. `withSpan` is
correct code emitting no spans. Wiring an SDK bootstrap is the application's job and does not
exist yet, so `OTEL_EXPORTER_OTLP_ENDPOINT` currently has no effect.

**No reranker unless you deploy one.** Retrieval degrades to fusion-only ordering and says so in
every response. That is a documented, acceptable Phase 1 posture — but it is a quality difference,
not a cosmetic one.

**The eval gate is a written justification, not a measurement.** The runner does not exist and
`eval_items` is empty. A retrieval change is reviewed by a human writing down why it is safe. Do
not read a green build as evidence that quality held.

**Only TypeScript gets semantic analysis.** Python and C# are parsed lexically — signatures as
written, no type resolution. Every result carries an `analysisDepth` badge saying so. If your
estate is mostly .NET, that badge is the honest answer and the Roslyn analyser is the fix.

---

## Cost

Two meters, and only one is under your control at deploy time.

**Infrastructure** is a Postgres instance sized for its index, a small Redis, object storage, and
three small services. Ordinary.

**Model spend** is dominated by the first full index of each repository — the per-merge cost after
that is cents, because unchanged modules are skipped entirely. `estimateIndexCost()` computes it,
`ORG_DAILY_SPEND_CEILING_USD` caps it, and admission pauses the queue rather than failing
mid-write.

Nobody has yet run that estimate against a real repository and published the number. §15.8 rates
its absence a blocker for Phase 1, and it is an afternoon's work now that the machinery exists.
Do it before you commit a budget, not after.
