# ADR 0001 — Build versus buy

**Status:** Accepted (build), with the scope reductions in §4
**Date:** 20 August 2026
**Deciders:** *(to be named — see §6)*

> **Authorship.** Written by an LLM (Claude Opus 5), not by a human, and **this is the most
> assertion-heavy document in the repository**. The effort estimate, the cost figures and the
> claims about what each vendor does not cover are reasoning, not measurement — nothing here
> was tested against a real procurement or a real team. Treat it as a structured argument to
> disagree with, which is also why §6 lists its deciders as unnamed. See [Authorship and
> evidence](../AUTHORSHIP.md).

---

## Context

§15.8 rates the absence of this analysis a **BLOCKER**, to be answered *before* Phase 1:

> Phases 1–5 are roughly 24–32 weeks with 3–4 engineers — about 3 FTE-years to v1 plus 2–3 FTE
> steady state, on the order of $1M to build and $500k+/year to run before LLM and infrastructure
> spend. That deserves an explicit one-page comparison.

This ADR is that comparison. It is written to be disagreed with: if the capability gaps in §3
do not hold for your organisation, the honest answer is to buy.

---

## The alternatives, and what each actually covers

| Option | Covers well | Does not cover |
|---|---|---|
| **Sourcegraph / Cody** | Code search at org scale, cross-repo navigation, IDE integration, an existing permissions model | Generated documentation as a reviewed artefact; a normalised IR other tools can consume; sensitivity tiering below repo granularity |
| **Glean** | Enterprise-wide search across many sources, strong connectors, mature permissions | Code-specific structure — no call graph, no signature-level drift detection; documentation generation is not the product |
| **Unblocked** | Codebase Q&A with good context assembly, low setup cost | Deterministic documentation output; self-hosting for the confidential tier; an IR to build on |
| **DeepWiki** | Fast automatic repo documentation, genuinely good first impression | Enterprise permissions, cross-repo API-contract edges, drift detection tied to signatures |
| **Mintlify / ReadMe / Redocly** | Published documentation sites, API reference rendering, partner-facing polish | Everything upstream of the Markdown: extraction, drift detection, retrieval |
| **Swimm** | Documentation coupled to code with staleness detection | Retrieval, assistants, MCP, polyglot IR |
| **Context7-style MCP endpoints** | Library documentation to coding agents, trivial adoption | Your own code; permissions; anything private |

**None of these is a poor product.** Several would deliver value in a fortnight, which is a
strong argument on its own — §15.8 is right that this deserves stating plainly rather than
being assumed away.

---

## What justifies building

Three capabilities, and only three. Everything else in the architecture is table stakes that
several vendors already do at least as well.

### 1. The polyglot IR as a first-class artefact

§4.2 is the load-bearing claim: a normalised IR makes drift detection **a structural diff rather
than an LLM judgement**, makes chunk boundaries semantic, and makes adding a fourth language a
one-week job. No vendor exposes an equivalent artefact. Buying means every downstream capability
— documentation, drift, release notes, architecture diagrams — is whatever that vendor chose to
build, permanently.

This is also what makes the cost model work. §7's change classification means a typical merge
costs a handful of embedding upserts and zero LLM calls. A vendor priced per seat or per query
does not pass that structure through to you.

### 2. Cross-repo API-contract edges

§4.3 calls this "the single most useful edge in the system": linking a `fetch` call in
TypeScript to a controller action in C# via a shared `operationId`. It is what makes *"how does
the web app authenticate against the billing API"* answerable.

Every vendor above indexes repositories. None resolves an OpenAPI `operationId` in one
repository against a generated client method in another, across a language boundary. If your
architecture is a monolith, **this reason does not apply to you and you should buy.**

### 3. Self-hosted sensitivity tiering

§10 Layer 3 requires four tiers with `restricted` excluded from the embedding pipeline
altogether, and §10 provider posture requires pinning which tiers may reach which providers.
Vendor products offer repository-level permissions; none offers path-level classification with
per-tier provider routing.

§15.7 sharpens this: stored embeddings are "source-code-equivalent" because embedding inversion
reconstructs substantial input text, and this design maximises invertibility. Sending them to a
vendor is materially the same decision as uploading source.

---

## What we are not building

The scope reductions are the substantive output of this ADR. Building everything in §§1–14 is
what produces the $1M estimate; building the three capabilities above does not.

| Deferred or bought | Decision |
|---|---|
| **Documentation site** | Buy. Docusaurus or Nextra renders the Markdown we generate. Building a docs site is a solved problem and not a capability gap. |
| **API reference rendering** | Buy. Scalar or Redoc, against the OpenAPI documents we already extract. |
| **Technical design documents** | Deferred indefinitely. §6 is explicit that these are "the weakest fit for automation" and that overpromising is "the fastest route to disappointment". |
| **External Documentation Assistant** | Deferred past v1. §15.8 makes it a customer-facing product with an SLA, an escalation path, staffed hours, and legally reviewed terms. That is a product launch, not a feature. |
| **Onboarding guides, release notes** | Deferred to Phase 5. Nice, not load-bearing. |
| **Qdrant migration** | Deferred until measured. §8 is clear it is premature until pgvector's limits are actually hit. |

That takes the build from "everything in the document" to the IR, the analysers, the sync loop,
the internal assistant, and MCP. Roughly **14–18 weeks with 3 engineers**, not 24–32.

---

## Hybrid alternative, considered and rejected

**Buy Sourcegraph for search, build only the IR and documentation generation.** Genuinely
attractive: it removes the retrieval-quality engineering in §15.5, which is the largest source
of hidden work in the whole plan.

Rejected because the IR *is* the retrieval quality lever. §8's chunking at symbol boundaries and
graph expansion over the call graph both consume the IR directly; running documentation
generation on our IR while search runs on a vendor's index means two indexes disagreeing about
the same codebase, and the disagreement surfaces to users as the tool being wrong.

**Worth revisiting** if retrieval quality plateaus below expectations by end of Phase 3. That is
a real exit ramp, and it should be treated as one rather than as a failure.

---

## Consequences

**Accepted:**

- 14–18 weeks to a v1 that serves internal engineers only.
- 2–3 FTE steady state, which §15.8 correctly notes must be a named, funded line — not
  goodwill. Internal platforms without a named product owner "reliably decay within twelve
  months".
- We own retrieval quality permanently. §15.5's eval work is not optional and not one-off.

**Mitigated:**

- Generated Markdown lives in the customer's own repositories (§15.8 exit plan), so a decision
  to abandon this in 2027 leaves the documentation where it is.
- Retrieval is behind an interface (§8), so a Qdrant or vendor swap is contained.

**Kill criterion.** If by the end of Phase 3 the internal assistant has fewer than 20 weekly
active askers across the pilot teams, or doc-PR abandonment exceeds 40%, stop and buy. §15.8
asks for a written kill criterion per phase; this is the one that matters most, because both
numbers measure whether anyone actually wants the thing.

---

## Open questions this ADR does not answer

§15.8 lists four more blockers that are **not** resolved here and remain open before Phase 1:

1. **Named owner, funding line, steady-state headcount.** Unassigned.
2. **Existing-documentation coexistence rule.** Confluence, READMEs and wikis already exist;
   without a written canonical-source rule "the predictable outcome is engineers maintaining two
   sets of docs and trusting neither".
3. **Cost model with per-repo unit cost.** `estimateIndexCost()` in `@kna/llm` computes it
   mechanically, but nobody has run it against a real repository and published the number.
4. **Rollout sequencing and kill criteria per phase.** Only the Phase 3 criterion above exists.

These are cheap to answer now and structurally expensive later.
