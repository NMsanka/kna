# Runbook: deployment

> **Authorship.** Written by an LLM (Claude Opus 5), not by a human. **This deployment has
> never been performed.** The checklist derives from named findings and is worth keeping; the
> sizing rules are reasoning, and the DR figures say "rehearse this" precisely because nobody
> has. See [Authorship and evidence](../AUTHORSHIP.md).

[`../HOSTING.md`](../HOSTING.md) is the mechanics — what to provision, how to build the images,
and the bootstrap order. This file is the policy: environment separation, deploy ordering, sizing,
and what must be true before production.

---

## Environments

§15.3 BLOCKER — *"Environment promotion is undefined for a system that writes to real repos. One
GitHub App with webhook fan-out means a staging deploy opens documentation PRs on production
repos and assigns them to real engineers, burning exactly the trust §7 identifies as the whole
game."*

| | Development | Staging | Production |
|---|---|---|---|
| Git provider App | none | **a distinct App** | the production App |
| `WRITE_ENABLED` | false | false | true |
| Corpus | fixtures | **replayed IR bundles** | live |
| Ingest signature | hmac | sigstore | sigstore |

Three properties make the separation real rather than documented:

1. **A distinct Git App per environment.** Sharing one App means sharing its webhook fan-out.
2. **`WRITE_ENABLED` is asserted at the PR-creation client**, not read from config at the call
   site. `WriteDisabledError` fires regardless of what any caller asks for.
3. **`loadPlatformEnv()` refuses `WRITE_ENABLED=true` outside production.** The service does not
   start, rather than starting and behaving badly.

Staging's corpus comes from replayed production bundles (§15.1), which is what makes it
representative without giving it write access to anything.

---

## First deploy

```bash
DATABASE_URL=postgres://owner@host/kna pnpm --filter @kna/db migrate
```

Then set the application role passwords from KMS. Deliberately **not** a migration: a migration
containing a password puts it in git, in every environment's history, and in a checksum the
runner will not let you change.

```bash
KNA_INTERACTIVE_PASSWORD=... KNA_BATCH_PASSWORD=... ./deploy/postgres/bootstrap-roles.sh
```

Then deploy the services, which connect as those non-superuser roles and **refuse to start
otherwise**.

That refusal is the point. §15.4 asks for forced RLS as defence in depth; a superuser connection
makes it silently inert — policies exist, `relrowsecurity` is true, the invariant check passes,
and every tenant reads every other tenant. `assertRlsEffective()` is what turns that from a
latent breach into a failed startup.

---

## Rolling deploy

Order matters, because the failure modes differ:

1. **Migrations first**, expand-only. §15.6's expand/contract discipline: a naive `ALTER TABLE`
   on `chunks` takes an ACCESS EXCLUSIVE lock and stalls every assistant query in the org.
2. **Workers next.** They drain on SIGTERM, finishing in-flight indexing rather than orphaning a
   half-written module partition.
3. **API next.** Sessions are short; graceful drain is 25 seconds.
4. **MCP last, with drain.** §15.6 — *"Streamable HTTP sessions in IDEs break on every rolling
   deploy without graceful drain."* An engineer whose editor loses its knowledge connection on
   every deploy stops relying on it.

Contract migrations (dropping a column, tightening a constraint) run **after** the deploy that
stopped using them, never in the same one.

---

## Sizing

§15.6 gives the scaling order explicitly: *"embedding provider throughput during backfill, then
[the cross-repo] pass, then pgvector index-maintenance memory."*

| Component | Sizing rule |
|---|---|
| Postgres RAM | The HNSW index must fit, **twice over** during an embedding migration. This is the number that dictates instance size |
| `maintenance_work_mem` | 1–2GB. Index builds are memory-bound; the default makes them crawl |
| Workers | Scale on queue depth **and oldest-job age** — depth alone looks fine while nothing progresses |
| Embedding TPM | The backfill bound. A separate virtual key from interactive, always |

pgvector scales vertically only, so §8's Qdrant trigger is better expressed as a memory and
maintenance-window threshold than as a chunk count.

---

## Pre-production checklist

Each item is a §15 finding, not a preference.

- [ ] Services connect as `kna_interactive` / `kna_batch`, never the owner (§15.4)
- [ ] `INGEST_SIGNATURE_MODE=sigstore`; the env loader refuses `permissive-dev` (§15.2)
- [ ] A distinct Git App, and `WRITE_ENABLED=false` everywhere but production (§15.3)
- [ ] Redis `maxmemory-policy=noeviction` with AOF on — the API asserts this at startup (§15.6)
- [ ] Object storage has versioning and object-lock; the audit bucket has WORM retention (§15.7)
- [ ] Git App private key is KMS-backed, not an env var or an image layer (§15.7)
- [ ] Separate LiteLLM virtual keys for interactive and batch, sharing no model entry (§15.6)
- [ ] `EMBEDDING_DIMENSIONS <= 2000`, or the column is `halfvec` (§11)
- [ ] DR drill rehearsed and **timed**, with both numbers written down (§15.3)
- [ ] Eval set exists, stratified, with an unanswerable stratum (§15.5)
- [ ] Abstention threshold calibrated against that stratum, for this embedding model (§15.5)
- [ ] Alerting on oldest-job age, DLQ depth, provider 429s, and spend rate (§15.6)
- [ ] A named owner and a funding line — §15.8 rates its absence a blocker, and internal
      platforms without one "reliably decay within twelve months"
