# Runbook: incidents

> **Authorship.** Written by an LLM (Claude Opus 5), not by a human. **No incident described
> here has occurred.** The SQL runs against tables that exist; the alert thresholds are
> plausible starting values calibrated against nothing. See [Authorship and
> evidence](../AUTHORSHIP.md).

Named degraded modes, the alerts that matter, and the two incidents that need a rehearsed
response rather than an improvised one.

---

## Degraded modes

§15.6 — *"Define per-dependency circuit breakers and named degraded modes: reranker down ⇒ serve
RRF order with a banner, not a 500."* Each of these is a mode the system enters deliberately and
tells the user about, not an outage.

| Mode | Trigger | Behaviour | User sees |
|---|---|---|---|
| `reranker-unavailable` | Cross-encoder timeout or 5 consecutive failures | Serve fusion order. **Abstention switches to a structural rule** — RRF scores are not calibrated across queries, so the numeric threshold cannot be reused | "Results are ordered by fusion score only" |
| `embeddings-unavailable` | Embedding provider down | Lexical and symbol arms still serve. Indexing holds; the existing index keeps answering | "Semantic search is unavailable" |
| `generation-unavailable` | Chat model down | Search and symbol lookup unaffected. §15.6: retrieval needs no LLM and is the most valuable surface anyway | Sources returned directly |
| `git-provider-unavailable` | Provider API down | Permissions serve from last-known-good inside the hard expiry, then **fail closed** | "Access limited to last confirmed permissions" |
| `bundle-store-unavailable` | Object storage down | **Ingestion pauses.** A bundle must be durably stored before anything derived happens (§15.1) | CI publish returns 503 |

**Readiness never depends on a provider.** §15.6: *"one vendor blip pulls every pod from the load
balancer and Kubernetes restarts your fleet."* Only Postgres and Redis are `critical`; every
provider is `advisory`.

---

## Alerts worth waking someone for

§15.6 — *"product metrics are not operational SLIs."*

| Alert | Threshold | What it means |
|---|---|---|
| `kna.queue.oldest_job_age_seconds` | > 900 | **The best staleness alarm.** Depth alone looks fine while nothing progresses |
| `kna.queue.dlq_depth` | > 0 and rising | Jobs are exhausting retries. Drain and inspect |
| `kna.index.lag_seconds` p95 | > 3600 | Repos are falling behind HEAD |
| `kna.provider.rate_limited{keyClass="interactive"}` | any | Batch work is bleeding into the interactive quota — the isolation has failed |
| `kna.cost.usd` rate | > 2× 7-day baseline | Runaway spend. Check for a tripped-but-approved circuit breaker |
| `kna.guardrail.secrets_blocked` | **= 0 for 7 days** | §17: "should be non-zero — zero means the scanner isn't working" |
| `kna.guardrail.breadth_anomalies` | any | Possible insider exfiltration. See below |
| `kna.retrieval.abstentions` rate | > 2× baseline | Retrieval quality dropped, or an index is incomplete |

Correlate the Langfuse trace id with the OTel span id at the API edge, or you will have two
disjoint views of the same request mid-incident.

---

## Incident: a secret reached the index

**Assume it is unrecoverable and act accordingly.** §16: *"treat this as unrecoverable if it
happens — plan for prevention, not remediation."* The secret has reached the vector index, the
embedding cache, the query logs, and possibly a provider's retention window.

1. **Rotate the credential first.** Before any cleanup. Everything below is containment; this is
   the only step that actually stops the exposure.
2. Identify the blast radius from the audit trail:
   ```sql
   SELECT actor_id, actor_subject, occurred_at, chunk_ids
   FROM audit_events
   WHERE org_id = $1 AND action = 'retrieval.search'
     AND chunk_ids @> to_jsonb(ARRAY[$2]::text[])
   ORDER BY occurred_at;
   ```
   This is what §10 Layer 6 exists for. Without it, "what was exposed?" is unanswerable.
3. Delete the chunks and embeddings, then **vacuum**. A soft delete is not a deletion: deleted
   tuples remain traversable in the HNSW graph until vacuum runs.
4. Purge the blurb cache entry keyed on that `signatureHash`, and the content-hash embedding
   cache entry.
5. Check the LiteLLM request logs and the provider's retention policy.
6. **Then** work out why the scanner missed it, and add a rule with a test. A rule added without
   a test is a rule that regresses.

---

## Incident: the magnitude circuit breaker tripped

Not an outage. A formatter upgrade, a namespace rename, or an SDK bump shifted `signatureHash`
on a large fraction of a repository, and the breaker halted documentation regeneration before it
opened hundreds of PRs (§15.3).

```sql
SELECT id, name, pending_bulk_review_reason FROM repos WHERE pending_bulk_review;
```

The search index is **still being updated** — it reflects reality rather than asserting anything,
so index-only is always safe.

Decide whether the change is semantic or cosmetic:

```bash
node apps/cli/dist/bin.js describe --format symbols | head -50
```

- **Cosmetic** (formatting, inferred-type churn): approve. The regeneration is a no-op in
  substance and the PRs will be trivial.
- **Semantic** (a real API change): approve, but tell the affected teams first. Hundreds of
  unexpected doc PRs is precisely the PR fatigue §16 names as fatal to the whole loop.

```bash
curl -X POST "$KNA_URL/v1/admin/bulk-review" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -d '{"repoId":"repo_x","decision":"approve","reason":"Prettier 4 upgrade; no semantic change"}'
```

The reason is recorded in the audit trail. "Approved" with no reason teaches operators to click
through it, which removes the breaker without removing the code.

---

## Incident: breadth anomaly

An identity touched an anomalous number of repositories in an hour. §15.4: `search_codebase` +
`find_usages` + `get_symbol` in a loop is a better exfiltration tool than `git clone`, and it
looks like ordinary IDE traffic.

```sql
SELECT principal_id, window_start, distinct_repos, distinct_modules, tool_calls, surface
FROM access_breadth
WHERE org_id = $1 AND window_start > now() - interval '24 hours'
ORDER BY distinct_repos DESC LIMIT 20;
```

**Most of these are legitimate** — an architect surveying the estate, someone tracing a
cross-cutting dependency. Breadth is a signal, not a verdict. Look at what they retrieved and
whether it coheres as a task.

If it does not: revoke the MCP token (immediate, via the deny path) and escalate. §15.4 notes
that notice periods deserve specific attention.

---

## Incident: index is stale and webhooks look fine

The nightly reconciliation sweep (§7) is what catches this, because webhook loss produces no
error anywhere.

```sql
SELECT name, last_indexed_sha, last_indexed_at, stale_since_sha, stale_reason
FROM repos WHERE org_id = $1 AND stale_since_sha IS NOT NULL;
```

`stale_since_sha` set means the last run **failed and the previous index was retained** — §7's
"fail safe, not empty". The index is old, not wrong, which is the correct trade.

Ask the developer to run `kna doctor`, which answers the question from their side: toolchain
present, config valid, index freshness, whether the repo is awaiting bulk review.

---

## Disaster recovery

§15.3 — *"No defined RPO/RTO, and the index may not be rebuildable at all."*

Two numbers, because they are very different:

| Recovery | Target | Bounded by |
|---|---|---|
| Structured IR (symbols, modules, documents) | **minutes** | Bundle replay from object storage |
| Vector index | **hours** | Embedding provider throughput, then HNSW build |

The vector recovery is bounded by *embedding throughput*, not by the data copy — and
`pg_dump`/restore rebuilds HNSW indexes on restore, so the index build sets the RTO. **DR must be
physical/PITR and must be rehearsed with a timed drill, not assumed.**

Rebuild from the system of record:

```bash
node apps/worker/dist/replay.js --org org_x --from-object-storage --concurrency 8
```

This works because §15.1 fix 1 made bundles immutable and Postgres an explicitly derived cache.
Without it, recovery means re-triggering CI across every repository and hoping each still builds
at that commit.

**Rehearse quarterly.** Record the actual elapsed time and update this table with real numbers.
