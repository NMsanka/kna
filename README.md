# KNA — AI-powered documentation and knowledge platform

> **Authorship.** Written by an LLM (Claude Opus 5), not by a human. The implementation-state
> table reflects what was actually run; the surrounding framing restates the design
> document's reasoning. See [Authorship and evidence](docs/AUTHORSHIP.md).

A polyglot code knowledge platform built on a normalised Intermediate Representation. Three
products over one substrate: a CLI that analyses repositories and generates documentation, a
knowledge base that stays synchronised with code changes, and an MCP server that exposes the
same knowledge to coding agents.

Existing Markdown and MDX documentation is ingested into a documentation corpus that stays
separate from code embeddings but remains linked by repository, project, module, version, and
provenance. The source-neutral connector boundary supports later integrations such as Confluence
without a rewrite of indexing or retrieval. See
[existing documentation ingestion](docs/existing-documentation.md).

Built from [`docs/architecture-recommendation.md`](docs/architecture-recommendation.md). Where
this implementation departs from that document, the code says why at the point of departure.

---

## The two decisions everything else follows from

**All three products consume a normalised IR, not raw source.** Language-specific analysers
produce it; everything downstream is language-agnostic. This is what makes polyglot support
tractable, makes drift detection a structural diff rather than an LLM judgement, and makes
adding a fourth language one analyser rather than a re-architecture.

**Documentation generation is deterministic-first, LLM-second.** Structure, signatures, routes
and dependency graphs are extracted mechanically and are always correct. The model writes prose
*around* verified facts, and prose that is not entailed by those facts is dropped rather than
published. Systems that ask a model to read the repo and write the docs produce confident,
plausible, wrong documentation and lose developer trust permanently after about two bad answers.

---

## Quick start

```bash
pnpm install
pnpm build
```

Analyse any repository, with no platform, no token and no configuration:

```bash
node apps/cli/dist/bin.js describe --format summary
```

That runs the whole extraction pipeline locally and prints what the platform would know about
your code. It is also the fastest way to see the guardrails work — the scan fails closed, and
this repository's own scanner tests trip it until the allowlist in `kna.config.yaml` explains
each finding.

Bring up the local stack and apply the schema:

```bash
docker compose -f deploy/docker-compose.yml up -d postgres redis minio
```

```bash
DATABASE_URL=postgres://kna:kna@localhost:5432/kna pnpm --filter @kna/db migrate
```

---

## Layout

```
packages/
  ir                    The Intermediate Representation. Schema, identity, diff, circuit breaker.
  config                Repo configuration and platform environment, both validated.
  scanner               Guardrail Layer 2: secrets, PII, injection patterns. Fails closed.
  analyzer-core         Discovery, Tier 0 parsing, the analyser contract, conformance suite.
  analyzer-typescript   Tier 1 TypeScript/JavaScript analyser (ts-morph).
  analyzer-openapi      Tier 2: OpenAPI, IaC, service manifests.
  db                    Postgres schema, migrations, RLS, pgvector access.
  llm                   LiteLLM routing, model policy, budgets.
  chunking              AST-boundary chunking, contextual headers, near-duplicate clustering.
  retrieval             Hybrid retrieval, fusion, rerank, expansion, abstention, eval.
  docgen                Deterministic renderer, bounded prose layer, staleness assessment.
  contracts             API contracts, bundle signing and verification, bundle store.
  observability         Logging, metrics, tracing, health and degraded modes.

apps/
  cli                   docs-cli: init, describe, scan, generate, publish, ask, doctor.
  api                   Ingestion, retrieval, admin, webhooks.
  worker                Indexing, cross-repo resolution, nightly maintenance.
  mcp                   MCP server: seven read-only tools.
```

---

## What is actually implemented

| Area | State |
|---|---|
| IR schema, identity, diff, breaking-change detection | Complete, tested |
| Magnitude circuit breaker | Complete, tested |
| Tier 0 lexical parsing (TS/JS/Python/C#) | Complete |
| Tier 1 TypeScript analyser | Complete, passes the conformance suite |
| Tier 1 Python (Griffe) and .NET (Roslyn) | Contract defined; subprocess transport ready; analysers not written |
| Tier 2 OpenAPI, IaC, compose, Helm | Complete |
| Guardrail scanning and classification | Complete, tested |
| Bundle signing and envelope verification | Complete; Sigstore claim-matching implemented, Sigstore bundle verification delegated |
| Postgres schema, RLS, pgvector | Complete, verified against a real database |
| Hybrid retrieval, fusion, diversity, expansion, abstention | Complete, tested |
| Eval harness with paired bootstrap and CI gate | Complete, tested |
| Indexing worker and module partition swap | Complete |
| Cross-repo resolution | Complete |
| MCP server and seven tools | Complete |
| Git provider integration (PRs, HEAD, permissions) | Interfaces and refusal logic complete; provider calls not implemented |
| Web UI and docs site | Not started — bought, not built (see ADR 0001) |

---

## Documentation

- [ADR 0001 — Build versus buy](docs/adr/0001-build-vs-buy.md) — the analysis §15.8 requires
  before Phase 1, and the scope reductions that follow from it.
- [Architecture](docs/ARCHITECTURE.md) — how the pieces fit, and which findings shaped each.
- [Security](docs/SECURITY.md) — the six guardrail layers, and what each one actually enforces.
- [Operations](docs/runbooks/) — deployment, embedding migration, incident response, retrieval
  tuning.
- [Specifications](openspec/) — the contracts several independently-authored components must
  agree on.
- [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md) — orientation for coding agents: verified
  commands, the gotchas that fail in ways that do not look like their cause, and what is not
  built yet.
- [Authorship and evidence](docs/AUTHORSHIP.md) — who wrote each document here, and which of
  its claims were executed, which are internally consistent by construction, and which are
  reasoning that nobody has tested.

---

## Development

```bash
pnpm test
```

```bash
pnpm exec tsc -b
```

Integration tests skip unless `DATABASE_URL` is set. They connect as a **non-superuser** role,
because a superuser bypasses row-level security silently — testing tenant isolation over an
owner connection proves nothing. See `packages/db/migrations/0005_login_roles.sql`.

The platform indexes its own repositories from week one. CI runs `describe` and `scan` against
this repo, so a change that breaks analysis fails here rather than in someone else's build.
