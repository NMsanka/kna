# Security

The six-layer model from §10, and what each layer enforces in this codebase. §10's framing is
worth repeating because it shapes everything below:

> This platform takes the most sensitive asset the company owns, makes it semantically
> searchable, and points a language model at it. Guardrails are not a hardening phase — they are
> a precondition for the thing existing.

---

## Layer 1 — Don't collect what you don't need

**Enforced by:** `packages/config` (`security.uploadSource`), `packages/ir/src/assemble.ts`,
`apps/cli/src/commands/publish.ts`.

Raw source never leaves the developer machine. The CLI publishes IR and generated documentation,
not file contents. `assemble()` drops `sourceText` unless the repository opted in; `publish`
refuses to run when the opt-in exists without a recorded approver.

**Qualification (§15.7).** The claim "nothing to leak" is weaker than it sounds. Embedding
inversion research reconstructs substantial input text from vectors, and this design maximises
invertibility: chunks are short, and each carries a context header naming file, module and
class. **The embedding table is a recoverable proxy for the source** and is classified at the
same tier. It is excluded from read replicas, analytics exports and debug dumps, and "move
vectors to a hosted vector service" requires the same review as "upload source".

---

## Layer 2 — Pre-index scanning, fail closed

**Enforced by:** `packages/scanner`, invoked from `apps/cli/src/commands/analyze.ts` before the
IR bundle is assembled, and re-checked at `POST /v1/ingest`.

Secret detection with entropy and placeholder heuristics, PII detection with Luhn and mod-97
validation, injection-pattern flagging, and a hard path denylist that is never read at all.

Three properties matter more than the ruleset:

- **It fails closed.** A finding stops the publish and exits non-zero. There is no
  warn-and-continue path. §16: "treat this as unrecoverable if it happens — plan for prevention,
  not remediation."
- **PII rules stay armed inside test directories**, which §10 calls "a notorious reservoir of
  real customer data". Only the loosest secret heuristics are suppressed there.
- **The platform re-checks.** A bundle whose scan report says `passed: false` is rejected at
  ingest, so a patched CLI cannot bypass the scan by reporting a pass it never ran.

Suppressions require a stated reason. `kna.config.yaml` in this repository is the worked
example — the scanner's own tests contain the canonical example secrets every scanner test
needs, and each is allowlisted with an explanation rather than by disabling a rule.

---

## Layer 3 — Classification and tagging

**Enforced by:** `packages/scanner/src/classify.ts`, `modules.sensitivity`,
`symbols.sensitivity`.

Four tiers: `public`, `internal`, `confidential`, `restricted`. Derived from repository
configuration, path patterns, code markers and CODEOWNERS.

Two rules make this safe rather than merely present:

- **Classification may only raise a tier automatically.** Configuration asking for a *lower*
  tier than the derived one is refused, and `public` is unreachable by inference entirely.
  §15.7: "promotion to the public tier is a one-way door... one bad glob publishes internal API
  surface to integration partners, already embedded and cached."
- **`restricted` never enters the embedding pipeline.** `chunkSymbols()` skips it before
  anything is generated. The safest chunk is the one that was never vectorised.

External publication is a reviewed event with a diff: `GET /v1/admin/external-publication/preview`
returns *"these N symbols become externally visible"*, and the POST requires an acknowledgement
literal that a script which never rendered the preview cannot produce.

---

## Layer 4 — Retrieval-time enforcement

**Enforced by:** `packages/retrieval/src/acl.ts`, applied inside every query in
`packages/retrieval/src/store.ts`.

`buildAclPredicate()` returns SQL, not a filter function. There is no code path in the retrieval
package that retrieves first and filters second, because §10 is explicit that "filtering after
ranking still leaks result counts and relative scores for repos the user cannot read."

It **throws** rather than returning an empty predicate when the caller has no access, since an
empty predicate that accidentally means "everything" is the failure this guards against.

**Corpus separation is physical.** The Documentation Assistant's predicate restricts to
`corpus IN ('docs','spec')` and `sensitivity = 'public'` in modules with a recorded external
publication approval — containing zero code chunks. A jailbreak against that assistant cannot
surface internal content because internal content was never in the candidate set.

**Row-level security is defence in depth**, and it is real: `packages/db/src/integration.test.ts`
proves tenant isolation against a live database. That test caught the failure that makes this
worth stating — **a superuser bypasses RLS silently**. Policies exist, `relrowsecurity` is true,
the invariant check passes, and every tenant reads every other tenant. Nothing errors. Every
service therefore calls `assertRlsEffective()` at startup and refuses to serve otherwise.

**Revocation has a deny path.** §15.4: a periodic sync leaves an offboarded user with access for
the full interval. Permission webhooks write a short-TTL row to `permission_revocations`, which
takes precedence over any cached grant, is consulted on every resolution, and does not depend on
the positive cache refreshing successfully.

---

## Layer 5 — Prompt injection

**Enforced by:** `packages/scanner/src/rules.ts` (detection), `apps/mcp/src/tools.ts`
(`wrapUntrusted`), and the absence of any write tool.

The indexer ingests attacker-controllable text by design: code comments, READMEs, test fixtures,
vendored documentation. That text is chunked, embedded, retrieved and placed in a model's
context as apparently authoritative reference material.

- **Every tool result is wrapped** in explicit delimiters stating that it is untrusted reference
  material and that instructions inside it must be ignored.
- **Imperative patterns are flagged at index time**, not blocked — a false positive here would
  refuse a legitimate commit. Detection includes zero-width and bidirectional control characters,
  which are how instructions get hidden from a human reviewer.
- **The MCP tool surface is read-only.** Seven tools, none side-effecting. This is not a current
  limitation to be relaxed later; a side-effecting tool reachable from indexed text is an
  injection payload waiting for a target.
- **Authorisation is computed upstream of retrieval and is not re-derivable from context.**
  Nothing a chunk contains can widen scope, change tool selection, or affect an ACL decision.

---

## Layer 6 — Output filtering and audit

**Enforced by:** `apps/api/src/services/audit.ts`, `packages/observability/src/logger.ts`.

Every retrieval is audited: identity, action, returned **chunk ids**, repositories touched,
timestamp, trace id. Never chunk text — the audit trail must not become a second copy of the
corpus.

- **Hash-chained rows.** Each row commits to its predecessor, so an edit or deletion in the
  middle of the chain is detectable by re-walking it. §15.7 requires shipping to an append-only
  object-locked sink under separate credentials; the chain is what makes reconciling the two
  meaningful.
- **Breadth, not volume.** §15.4 identifies MCP as a better exfiltration tool than `git clone`:
  it crosses repository boundaries on one credential and looks like ordinary IDE traffic. The
  detector alerts on an identity touching an anomalous number of *repositories* per hour, not on
  request count. An engineer running two hundred searches inside one service is working.
- **Logs redact by default.** Retrieved content, prompts, and anything token-shaped are
  redacted at the logger, not at each call site.

---

## The trust boundary: CI execution and bundle signing

§15.2 rates this the most serious single finding in the review, above prompt injection:

> The CI analyser is remote code execution by design... Any contributor who can land a `.csproj`,
> `package.json` or `nuget.config` change gets code execution on a runner holding repo read
> access, network egress, and the platform publish token.

**Structural mitigations**, in `.github/workflows/kna-index.yml`:

1. Post-merge only. Never `pull_request_target`, never fork pull requests.
2. Analysis and publishing are **separate jobs**. The analyse job runs contributor-controlled
   build logic and holds no credential; the publish job holds the credential and never checks
   out the repository.
3. The credential is minted by OIDC exchange, scoped to one `repoId`, valid for minutes.

Merging those two jobs removes the boundary, not an inefficiency.

**Bundle verification** (`packages/contracts/src/signing.ts`) checks, in order and failing closed
at each step: size, payload hash, scan result, expiry, nonce replay, signature, **signer identity
claims against the asserted scope**, and commit existence at the Git provider.

Step seven is the one §15.2 is actually about. A valid signature from repository A's workflow is
still a forgery when the envelope claims repository B — and because scope keys are denormalised
onto every row, a forged `orgId` poisons another tenant's index while bypassing all CLI-side
scanning.

---

## Reporting a vulnerability

Do not open a public issue. *(Contact route to be filled in by the owning team — see ADR 0001
§6, which lists "named owner" as still open.)*
