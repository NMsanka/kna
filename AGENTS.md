# AGENTS.md

> **Authorship.** Written by an LLM (Claude Opus 5), not by a human. These conventions were
> derived from the design document while writing the code, so they are internally consistent
> with it rather than independently validated. See [Authorship and
> evidence](docs/AUTHORSHIP.md).

Conventions for coding agents working in this repository. §13 recommends this file exists so every agent picks up the project's conventions rather than inferring them.

## What this is

A polyglot code knowledge platform built from `docs/architecture-recommendation.md`. That document is the source of truth for *why*; this repository is the *how*. Sections are cited as §N throughout the code — those citations are load-bearing, not decoration.

Read `docs/adr/0001-build-vs-buy.md` before proposing new scope. It records what was deliberately **not** built, and why.

## Ground rules

**Cite the finding.** When code exists because of a specific finding, say so where it matters. `// §15.5 — RRF scores are not calibrated across queries` prevents someone "simplifying" the abstention rule six months from now.

**Fail closed.** Guardrail scanning, ACL filters, bundle verification, budget admission, provider routing. If the safe direction is unclear, refuse and explain.

**Never widen the MCP tool surface with a write tool.** §10 Layer 5. The corpus is full of attacker-controllable text; a side-effecting tool reachable from it is an injection payload waiting for a target. This is not a current limitation.

**Never present shallow analysis with the confidence of semantic analysis.** §5. The badge follows the content from the analyser through chunking, retrieval, and the response.

**Do not merge the analyse and publish CI jobs.** §15.2. That separation is the trust boundary, not an inefficiency.

**Migrations are immutable once applied.** The runner refuses a changed checksum. Fix forward — see `migrations/0004_lexical_stats_rls.sql`, which exists because the invariant check caught a gap in `0002`.

## Before you change retrieval

Anything touching chunking, embedding, fusion, reranking, expansion, or prompts changes `retrieval_config_version` and must go through the eval gate. `scripts/check-retrieval-config.mjs` decides whether CI runs it.

§15.5's point is about statistical power: at n=100 the eval set resolves 5–8 point deltas, and most real changes move 1–3. A point estimate that improved is not evidence. The report prints the minimum detectable effect for exactly this reason.

## Testing

```bash
pnpm test
```

Integration tests skip without `DATABASE_URL`. They connect as a **non-superuser** role deliberately: a superuser bypasses RLS silently, so testing tenant isolation over an owner connection proves nothing at all.

```bash
DATABASE_URL=postgres://kna:kna@localhost:5432/kna pnpm test
```

## Dogfooding

The platform analyses its own repositories (§16). CI runs `describe` and `scan` against this repo, so breaking the analyser fails here rather than in someone else's build. If `kna.config.yaml`'s allowlist needs a new entry, write the reason — an unexplained suppression is how a real credential gets waved through later.
