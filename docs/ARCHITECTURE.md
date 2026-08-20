# Architecture

> **Authorship.** Written by an LLM (Claude Opus 5), not by a human. It describes code
> written in the same session, so it agrees with that code by construction. The "where the
> design was extended" table is the exception — each row there was found by something
> failing. See [Authorship and evidence](AUTHORSHIP.md).

How the pieces fit, and which finding shaped each. This is the map; the design document
(`architecture-recommendation.md`) is the reasoning, and the code carries the citations.

---

## The shape

```
DEVELOPER MACHINE / CI
  docs-cli
    discovery ─→ Tier 0 (always) ─→ Tier 1 (if toolchain) ─→ Tier 2 (build artifacts)
                                          │
                                    guardrail scan  ← fails closed, before anything leaves
                                          │
                                    IR assembly  ← identity minted exactly once
                                          │
                                    sign + publish
                                          │
────────────────────────────────────────┼─────────────────────────────────────────────────
                                          ▼  HTTPS, signed, repo-scoped credential
PLATFORM
  ingest ─→ verify ─→ store bundle ─→ diff ─→ circuit breaker ─→ fan out per module
                          │                                            │
              object storage (system of record)              BullMQ + advisory locks
                                                                       │
                                          chunk → blurb → embed → partition swap → sweep
                                                                       │
  ┌────────────────────────── Postgres + pgvector ─────────────────────┘
  │
  ├─→ retrieval: dense + lexical + symbol → RRF → diversity → rerank → expand → abstain
  │        │
  │        ├─→ API  (/v1/search, /v1/chat)
  │        └─→ MCP  (seven read-only tools)
  │
  └─→ docgen: deterministic render + bounded prose → reviewed pull request
```

---

## Package dependency order

Nothing above depends on anything below it, which is what keeps the IR usable independently of
the platform.

```
ir                              no dependencies beyond zod — deliberately
  ├── config, contracts, scanner
  ├── analyzer-core ── analyzer-typescript, analyzer-openapi
  ├── db, llm
  │     └── chunking ── retrieval ── docgen
  └── observability
```

`@kna/ir` is importable on its own. §4.2's claim — that the IR is the whole system — only holds
if consuming it does not drag in a database driver.

---

## The five decisions everything else follows from

### 1. The IR is the contract, not an implementation detail

§4.2. Language-specific analysers produce it; everything downstream is language-agnostic.

The consequence people underestimate: **drift detection becomes a structural diff.** `diffIr()`
compares `signatureHash` and classifies. A typical merge changes bodies rather than signatures,
so it triggers a handful of embedding upserts and zero LLM calls. That is the difference between
cents per merge and a system nobody can afford to leave switched on.

`normalizeSignature()` is what makes it hold. A Prettier upgrade must not flip every hash, and
the test suite asserts invariance under reformatting, trailing commas and comment changes —
while asserting that a parameter type change *does* flip it.

### 2. Deterministic-first, LLM-second

§6. `packages/docgen/src/render.ts` calls no model. `prose.ts` calls one, sees only IR facts, and
its output is checked against those facts by a separate judge before publication. Ungrounded
prose is **dropped**, not published with a caveat.

A page with accurate tables and no narrative is a good document. A page with one invented
sentence is a liability, and §16 gives it a price: two bad answers loses a team permanently.

### 3. Module is the unit of everything

§4.3 makes module the unit of project membership; §15.1 fix 3 extends it to atomicity and
concurrency.

So: chunks are partitioned by module, the reindex is a partition swap inside one transaction,
and serialisation is a Postgres advisory lock keyed on `moduleId`. That last point is a decision
§15.6 forces — stock BullMQ cannot enforce per-key concurrency, and a stalled-job re-dispatch
would otherwise interleave with the original run. BullMQ schedules; Postgres serialises.

### 4. Hybrid retrieval, with the reviews' additions in the same flow

§8's pipeline, plus what §15.5 adds — placed inline rather than bolted alongside:

```
query → rewrite (multi-turn) → dense ‖ lexical ‖ symbol → RRF
      → diversity (MMR + per-module cap)   ← before reranking, not after
      → cross-encoder rerank
      → budget primary → expand within what remains
      → abstention gate                    ← before anything reaches a model
      → trace
```

Two placements are load-bearing. **Diversity before reranking**, because otherwise the reranker
faithfully ranks eight copies of the same answer. **Abstention before generation**, because weak
retrieval flowing into a model identically to strong retrieval is precisely how the
confident-and-wrong answer gets produced.

### 5. Guardrails are a precondition, not a phase

§10. Six layers, built in Phase 1, because an embedded secret cannot be retracted — it has
already reached the vector index, the caches, and possibly a provider's logs.

See [SECURITY.md](SECURITY.md) for what each layer actually enforces.

---

## Where the design was extended

Not departures — the reviews in §15 anticipated most of these. Recording them because the
implementation makes choices the prose left open.

| Extension | Why |
|---|---|
| **`filesAnalyzed` in the analyser contract** | Superseding Tier 0 by symbol identity does not work: the two tiers never agree on an overload discriminator, so every symbol emitted twice. Discovered by the pipeline test, which showed a module claiming `shallow` despite semantic analysis succeeding |
| **`assertRlsEffective()` at startup** | A superuser bypasses RLS *silently*. Found by the integration test: policies existed, the invariant check passed, and every tenant read every other tenant. RLS that is enabled and inert is worse than none, because it is believed |
| **`halfvec` rather than `vector`** | §11's dimension trap, resolved structurally. Indexes to 4,000 dimensions, so both escape hatches stay open without a schema change |
| **Migration 0004** | The invariant check found `lexical_stats` unprotected — created after the policy loop in the same migration. Fixed forward, because applied migrations are immutable |
| **Post-generation DDL fixup** | Drizzle emits `"halfvec(1536)"` quoted, which Postgres reads as a type of that literal name. Automated rather than hand-edited, because hand-editing works until the once it is forgotten |
| **Symbol id algorithm v2** | §15.1 flags `sha256(repo + module + qualifiedName)` as not rename-stable. v2 keys on package identity where one exists, so a directory move is a no-op for identity |

---

## What is not built

Recorded so the gaps are explicit rather than discovered.

| Not built | Why |
|---|---|
| Python (Griffe) and .NET (Roslyn) analysers | Contract, transport, conformance suite and registry are complete. §5 estimates a week each against the suite |
| Git provider calls | Interfaces, refusal logic and write-gating are complete; the provider HTTP calls are not. `WriteDisabledError` fires correctly, which is the part that matters |
| Sigstore bundle verification | Claim-matching against asserted scope is implemented — the part §15.2 is actually about. The cryptographic bundle verification delegates to `@sigstore/verify` |
| Web UI, docs site | Bought, not built. ADR 0001 |
| External Documentation Assistant | Deferred. §15.8 makes it a product launch with an SLA and staffed hours, not a feature |

---

## Reading order

For someone new to the codebase, in the order that makes each next file make sense:

1. `packages/ir/src/schema/symbol.ts` — the contract everything reads
2. `packages/ir/src/diff/diff.ts` — why synchronisation is cheap
3. `packages/analyzer-typescript/src/analyzer.ts` — what an analyser actually does
4. `packages/retrieval/src/pipeline.ts` — the whole retrieval flow in one file
5. `packages/retrieval/src/acl.ts` — the security boundary, in SQL
6. `apps/worker/src/jobs/index-module.ts` — the partition swap and the stale-chunk sweep
7. `apps/api/src/routes/ingest.ts` — the trust boundary

§18's advice applies to reading as much as to building: *"If the IR is right, everything else is
conventional engineering."*
