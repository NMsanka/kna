# Specification: retrieval scope and access

**Status:** Active
**Version:** 1.0.0
**Implements:** `packages/retrieval/src/acl.ts`, `packages/retrieval/src/types.ts`

> **Authorship.** Written by an LLM (Claude Opus 5), not by a human. The ACL rules and the
> isolation properties are under test; the scope-selection defaults are design judgement. See
> [Authorship and evidence](../../../docs/AUTHORSHIP.md).

---

## Why this spec exists

§13 lists retrieval scope semantics among the contracts worth writing down first, on the grounds
that they are *"subtle, security-adjacent, and easy to get quietly wrong."*

Quietly is the operative word. A scope bug does not throw. It returns results — the wrong ones,
or too many, or too few — and looks like a retrieval-quality problem for months.

---

## The addressing tuple

Every chunk is addressed by `(orgId, projectIds, repoId, moduleId, versionId)`.

`versionId` is the axis §4.3 insists on carrying from day one:

> Keep `(scopeKeys, version)` as the full addressing tuple on every chunk. Retrofitting the
> version axis later means reindexing everything, so put the column in from day one even if
> Phase 1 only ever writes `main`.

---

## Scope kinds

| Kind | Resolves to | When |
|---|---|---|
| `project` | All modules across all the project's repos | **Default.** Matches how developers reason |
| `expanded` | Plus projects linked by API contract or package dependency | The query names an external system, or project scope scored weakly |
| `repo` | One repository | "Where in *this* repo is X" |
| `module` | One module | Narrowest; mostly used by tooling |
| `org` | Everything the caller may read | Only when explicitly requested |

### S1. Project is the default, not repo and not org

§4.3. A repo-scoped default cannot answer the questions with the highest value, which are
precisely the ones crossing a repo boundary. An org-scoped default retrieves worse *and* widens
the blast radius.

### S2. MCP infers scope from the working directory

§4.3 — *"when someone has `billing-api` open in Cursor, default to the Billing project."*
Exposed as an optional tool parameter so an agent can widen it deliberately. Org scope is the
last resort, never the default.

### S3. Module, not repo, is the unit of project membership

Repo↔project is many-to-many. `module_projects` resolves it. Scoping by repo breaks on both
common realities: a project spanning several repos, and a monorepo spanning several projects.

---

## Access rules

### A1. The ACL filter is SQL, applied before scoring

§10 Layer 4 — *"never as a post-filter: filtering after ranking still leaks result counts and
relative scores for repos the user cannot read."*

`buildAclPredicate()` returns a `SQL` fragment. There is no code path in this package that
retrieves first and filters second.

### A2. It throws rather than returning an empty filter

A caller with no permitted repositories is an error, not an unscoped query. An empty predicate
that accidentally means "everything" is the failure this design exists to prevent.

### A3. Authorisation is computed upstream and is not re-derivable from context

§10 Layer 5 — *"never let retrieved content influence tool selection, scope widening, or ACL
decisions."* `AccessContext` is built from the caller's identity before retrieval runs. Nothing
a chunk contains can alter it.

### A4. Revocation takes precedence over any grant

§15.4. `permission_revocations` is a short-TTL deny list consulted on **every** resolution,
including cache hits. A wildcard row (`repo_id IS NULL`) denies everything, which is what
offboarding writes — it must not depend on enumerating what the person could see.

### A5. `confidential` and above bypass the permission cache

§15.4 — *"re-evaluate on every token refresh and on every `confidential`/`restricted` access."*

### A6. `restricted` is unreachable through retrieval

It never enters the embedding pipeline (§10 Layer 3). Reachable only by direct, audited symbol
lookup.

### A7. The external corpus is physically distinct

§10 Layer 4 — *"a jailbreak or injection against that assistant cannot surface internal content,
because internal content was never in the candidate set to begin with."*

The external predicate restricts to `corpus IN ('docs','spec')`, `sensitivity = 'public'`, and
modules with a recorded external-publication approval. It contains zero code chunks. It requires
no repo grants, because there is nothing repo-scoped in it.

### A8. Empty results are indistinguishable from denied results

§15.7 — differential responses turn the assistant into an oracle for *"does this repository
exist"*. `uniformEmptyMessage()` is the single response for both, and the error handler maps
`AccessDeniedError` to the same shape.

### A9. Result caches key on the permission set, not the query

§15.6 — *"key it on the caller's permission-set hash, never on query text alone, or you will
serve one user's authorised results to another."* `permissionSetHash()` is order-independent so
two representations of the same permissions share a cache entry, and two different permission
sets never do.

---

## Version selection

| Surface | Default version |
|---|---|
| Developer Assistant, MCP | The repo's default branch, continuously indexed |
| Documentation Assistant | The partner key's `pinnedVersionId` |

§4.3 — an integration partner on API v1 must not receive v2 documentation. §15.7 adds that
partner keys are scoped to their contracted version, which is why the pin lives on the key
rather than on the request.

---

## Defence in depth

Row-level security is **not** the primary control; A1 is. RLS exists so that a bug in A1 is
contained rather than catastrophic (§15.4).

Two conditions make it real, and both are asserted at startup:

1. **`FORCE ROW LEVEL SECURITY`**, or the table owner bypasses its own policies.
2. **A non-superuser connection.** A superuser ignores RLS *silently* — policies exist,
   `relrowsecurity` is true, the invariant check passes, and every tenant reads every other
   tenant. `assertRlsEffective()` refuses to serve otherwise.

Two paths deliberately run outside user context and use `withSystemContext()` instead: the
indexing workers and the cross-repo resolution pass. The distinct wrapper makes that choice
visible at the call site rather than implicit in a missing one.

---

## Testing

- `packages/retrieval/src/retrieval.test.ts` — predicate construction, refusals, cache keying.
- `packages/db/src/integration.test.ts` — isolation against a live database, including the
  superuser case, because that is the one that cannot be caught any other way.
