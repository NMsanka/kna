# KNA — project conventions

Spec-driven development per §13. Not every change needs a spec; the contract-heavy surfaces do.

## What gets a spec

| Spec | Why |
|---|---|
| `analyser-contract` | Three implementations must produce byte-identical IR semantics. §13 calls it the highest-value spec in the project |
| `ir-schema` | The keystone. Every downstream component reads it |
| `mcp-tools` | A public API to external agents; churn silently breaks people's IDE integrations |
| `retrieval-scope` | Subtle, security-adjacent, and easy to get quietly wrong |
| `guardrail-policy` | Sensitivity tiers and enforcement points should be specified and reviewed, not emergent |

Everything else — a UI change, a new CLI flag, a bug fix — is a pull request.

§13's caveat is taken seriously: *"do not let spec ceremony throttle Phase 1 exploration. Formalise a contract once you believe it, not before."*

## The recursion

§13 notes that archived specs are excellent input to the knowledge base itself:

> Section 6 flags technical design documents as the weakest fit for automation, because code records *what* was built and almost never *why*. Spec archives are precisely the missing "why".

`openspec/` is indexed as a first-class source, so "why is this built this way?" has somewhere to retrieve from. The platform ends up documenting itself using the artefacts of its own construction.

## Conventions

- **Cite the finding.** A decision traceable to §4.3 or §15.6 says so, at the point in the code where it matters. A comment explaining *what* the code does is usually noise; one explaining why this shape rather than the obvious one is not.
- **Fail closed.** Guardrails, ACL filters, signature verification, budget admission. When the safe direction is ambiguous, refuse.
- **Degrade visibly.** A missing toolchain, a downed reranker, a stale repo: report it and carry on. Never let a degraded answer look identical to a confident one.
- **Errors end in an action.** "Bundle rejected" is a support ticket. "Bundle rejected because the signing workload identity does not match the repository, and here is how to mint the right credential" is not.
