# Specification: analyser contract

**Status:** Active
**Version:** 1.0.0
**Implements:** `packages/analyzer-core/src/registry.ts`
**Conformance suite:** `CORE_CONFORMANCE` in the same file

> **Authorship.** Written by an LLM (Claude Opus 5), not by a human. Unusually for a document
> here, most of it is enforced rather than asserted: `runConformance()` checks the numbered
> requirements and the TypeScript analyser passes them. See [Authorship and
> evidence](../../../docs/AUTHORSHIP.md).

---

## Why this spec exists

§13 names this the single highest-value spec in the project:

> Three implementations — `ts-morph`, Griffe, Roslyn — must produce byte-identical IR semantics.
> Pair it with a shared conformance test suite every analyser must pass.

Three analysers written at different times, by different people, against different language
models, will drift within a quarter unless the contract is written down and mechanically
checked. Everything downstream — chunking, retrieval, drift detection, documentation — assumes
they agree.

---

## The contract

An analyser is a process that reads `AnalyzerRequest` on stdin and writes `AnalyzerResponse` on
stdout, both newline-free JSON, protocol `kna-analyzer/1`.

In-process analysers (the TypeScript one) implement the same interface directly. The boundary is
the schema, not the transport.

### Requirements

**R1. Emit raw symbols, never ids.**
Identity is minted during assembly (`assemble()` in `@kna/ir`). An analyser that mints its own
ids breaks the moment two analysers disagree about the algorithm — and they will, because the
algorithm is versioned and analysers ship independently.

**R2. Express edges as qualified names.**
`edges.calls`, `edges.extends`, `edges.implements`, `edges.references` are qualified names.
Assembly resolves them to ids and reports what it could not resolve.

**R3. Report `filesAnalyzed`.**
The pipeline supersedes Tier 0 output **per file** using this list. Superseding by symbol
identity does not work across tiers: Tier 0 reports `lines: InvoiceLine[]` as written while
Tier 1 reports the resolved type, so the two never agree on an overload discriminator and every
symbol is emitted twice — dragging the module's declared depth back to `shallow` and doubling
the chunk count.

A file listed here that produced no symbols is a valid answer. A file omitted keeps its Tier 0
symbols.

**R4. Do not overclaim depth.**
`analysisDepth: 'semantic'` asserts that types were resolved. The conformance suite checks it: a
symbol claiming `semantic` with parameters that all have `type: null` fails. §5 is unambiguous —
*"never let the assistant present shallow-analysis output with the same confidence as semantic
output."*

**R5. Never emit `sourceText` unless asked.**
§10 Layer 1. `options.includeSource` is false by default and the conformance suite fails any
emission that ignores it.

**R6. Degrade, never fail.**
A missing toolchain, an unparseable file, a broken project reference: report a `degradation` with
a reason a developer can act on, and emit what you have. §5 — *"If the .NET SDK is absent, do not
fail."* The reason surfaces verbatim in `kna doctor`.

**R7. Disambiguate overloads.**
`overloadDiscriminator` is the normalised parameter type list. Without it, C# and TypeScript
overload sets collapse into one symbol.

**R8. Emit 1-based, well-ordered source ranges.**
`startLine >= 1`, `endLine >= startLine`, paths repo-relative with forward slashes.

**R9. Parent references must resolve within the same emission.**
`parentQualifiedName` naming a symbol the analyser did not also emit is a contract violation.

**R10. Be deterministic.**
Two runs over the same commit produce identical IR. This is what makes an unchanged commit cost
nothing (§7); an analyser that reorders its output makes every commit look like a full rewrite.

---

## Conformance

```bash
pnpm conformance
```

Every analyser runs against the shared fixture repository and must pass `runConformance()`.
Adding a language means adding a fixture in the same shape, not a new suite.

The TypeScript analyser is the reference implementation. Where this spec is ambiguous, its
behaviour is the tiebreaker — and the ambiguity should be fixed here.

---

## Adding a language

1. Write the analyser as a subprocess speaking `kna-analyzer/1`.
2. Add a fixture repository under `test/fixtures/`, exercising the same shapes as the existing
   one: overloads, generics, inheritance, doc comments with parameters and throws, a deprecated
   member, and a non-exported helper.
3. Register it. `probe()` returns the toolchain version, or null so the pipeline degrades.
4. Run the conformance suite.

§5 estimates this at a week per language. That estimate holds only while this contract is
mechanically enforced; without the suite it becomes a month of reconciling disagreements
discovered downstream.

---

## Deliberately out of scope

- **Cross-repo edges.** They need the whole project's IR, so they are a separate pass (§4.3).
- **`usedBy`.** Computed at index time; analysers leave it empty.
- **Sensitivity.** Assigned by the classifier (§10 Layer 3), not by the analyser.
- **Chunking.** Consumes the IR; it is not the analyser's concern.

---

## Change process

This spec is versioned with the IR schema. A change is a proposal with a spec delta, reviewed
before implementation — §13: *"changes should be reviewed proposals, not commits, because every
downstream component reads it."*

Breaking changes bump the protocol version. The N-2 window in `upcastBundle()` applies to
bundles, not to this protocol: the coordinator and its analysers ship together.
