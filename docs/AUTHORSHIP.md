# Authorship and evidence

Every prose document in this repository — this one included — was written by an LLM (Claude
Opus 5) during the session that built the codebase. No human authored them.

That is worth stating plainly rather than leaving to inference, for a reason specific to this
project: the platform's own design draws a hard line between mechanically derived facts and
model-written prose, and refuses to publish prose a grounding check cannot entail from those
facts (§6). The documents describing the platform did not go through that check. Applying a
weaker standard to our own writing than we apply to the product's output would be the kind of
quiet inconsistency this codebase is otherwise careful about.

---

## Three categories, not two

| | What it is | Reproducible | How far to trust it |
|---|---|---|---|
| **Rendered** | `docs/generated/**` — produced by `render.ts` from the IR. No model runs at any point | Yes: same commit, same bytes | The facts *are* the IR. If a signature is wrong here, the analyser is wrong |
| **Written** | Everything else in `docs/`, `openspec/`, `README.md`, `CLAUDE.md`, `AGENTS.md` | No | Depends on the claim — see below |
| **Given** | `docs/architecture-recommendation.md` | n/a | Yours. The input this was built from |

The middle row is the one that needs unpacking, because its contents are not uniform.

---

## Three kinds of claim inside the written documents

**Verified by execution.** Someone ran it and read the output. The commands in `CLAUDE.md`, the
endpoint behaviours, the test counts, the migration ordering, the row-level-security finding,
the three startup bugs. These are observations, and they were wrong often enough during the
build to be worth trusting *because* they were checked — several were written down only after
the first attempt failed.

**Verified by construction.** The §-citations throughout the code and docs. The code and its
citation were written in the same act, so they agree with each other by definition rather than
by anyone checking. If a section of the design document was misread, the comment faithfully
records the misreading. These are internally consistent, not independently confirmed.

**Assertion.** Reasoning, presented as reasoning but easy to read as fact. Effort estimates,
cost figures, vendor capability comparisons, threshold recommendations, sizing rules. Nothing
here was measured. ADR 0001's "14–18 weeks with 3 engineers" is an argument, not a projection
from data.

---

## Where each document sits

| Document | Predominantly |
|---|---|
| `CLAUDE.md` | Executed — commands and behaviours were run. The "Next" section is judgement |
| `README.md` | Executed for the state table; assertion for the framing |
| `AGENTS.md` | Construction — conventions derived from the design document |
| `docs/ARCHITECTURE.md` | Construction, with the "where the design was extended" table executed |
| `docs/SECURITY.md` | Construction, with the RLS isolation claim executed against a live database |
| `docs/adr/0001-build-vs-buy.md` | **Assertion.** The most estimate-heavy document here |
| `docs/runbooks/deployment.md` | Assertion — the checklist derives from findings; sizing is reasoning; the DR figures are unrehearsed |
| `docs/runbooks/incidents.md` | Mixed — the SQL runs against real tables; the alert thresholds are guesses |
| `docs/runbooks/embedding-migration.md` | **Assertion.** This procedure has never been executed |
| `docs/runbooks/retrieval-tuning.md` | **Assertion.** Never run against a real corpus, because none exists yet |
| `openspec/specs/analyser-contract/spec.md` | Executed — enforced by a conformance suite that passes |
| `openspec/specs/retrieval-scope/spec.md` | Construction, with the ACL and isolation rules under test |
| `openspec/project.md` | Construction |
| `eval/golden/README.md` | **Assertion.** Describes a set that does not exist yet |

---

## What to do with this

Treat the assertion-heavy documents the way §6 says to treat a generated design document: **a
scaffold, not a finished artefact.** They are structured arguments from someone who had just
read the design document closely and written the code — which is a real vantage point, and not
the same as experience with your organisation, your repositories, or your costs.

The specific things worth arguing with before anyone relies on them:

- ADR 0001's effort estimate and its claim about what vendors do not do. The build-vs-buy
  conclusion turns on both.
- Every threshold: the abstention default, the circuit-breaker ratios, the alert levels, the
  spend ceiling. All plausible starting values; none calibrated against anything real.
- The DR numbers in `incidents.md`. They say "rehearse this" precisely because nobody has.

The executed claims are a different matter. If `CLAUDE.md` says a command works and it does not,
that is a bug, not a difference of opinion.
