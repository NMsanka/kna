# The golden eval set

> **Authorship.** Written by an LLM (Claude Opus 5), not by a human. **The eval set it
> describes does not exist yet**, and neither does the runner. This is a specification for
> something to build, written before building it. See [Authorship and
> evidence](../../docs/AUTHORSHIP.md).

§15.5 BLOCKER:

> The eval set as specified is statistically underpowered. At n=100 unstratified, a paired
> bootstrap resolves recall@10 deltas of only ~5–8 points; most real changes move 1–3 points and
> will be invisible or look like wins. Build 300+ items **stratified by intent class**
> (exact-identifier lookup, cross-repo call path, why/rationale, how-to-integrate, and
> *unanswerable*), and bind each gold item to symbol IDs so the nightly IR diff can quarantine
> items whose targets were renamed or deleted.

§16 adds the timing: build it in Phase 1, *before you need it*. You cannot improve retrieval you
cannot measure, and an eval set written after quality plateaus is written to explain the plateau
rather than to detect it.

---

## Strata, and why each exists

| Stratum | Target | What it catches |
|---|---|---|
| `exact-identifier` | 70 | The dense arm returning five semantically similar but wrong functions (§8) |
| `cross-repo-call-path` | 60 | Whether cross-repo edges resolved at all — the capability ADR 0001 uses to justify building |
| `why-rationale` | 50 | Whether ADRs and specs are reachable, or only code is |
| `how-to-integrate` | 60 | The customer-facing surface. Regressions here are the most expensive |
| `unanswerable` | 60 | **Confidently-wrong answers.** Invisible to recall, and the failure §16 says loses a team permanently |

**300 total, minimum.** The report prints the minimum detectable effect; if it exceeds 3 points,
the set is too small to trust a small improvement and the report says so.

The `unanswerable` stratum is the one teams skip and the one that matters most. Without it, the
abstention threshold is uncalibrated and the false-answer rate is unmeasured.

---

## Item format

```yaml
- id: exact-001
  question: What does getUserByTenantId do?
  intentClass: exact-identifier
  scope: { kind: project, project: billing }

  # Bound to symbol ids, not to text. The nightly maintenance job quarantines items whose
  # targets were renamed or deleted, so the set does not rot invisibly (§15.5).
  expectedSymbolIds:
    - sym_a1b2c3d4e5f6

  # Optional. The grounding judge checks the answer against retrieved facts; this is for a
  # human reading a failure report.
  expectedAnswer: >
    Looks up a user scoped to a tenant, returning null when not found.

  createdBy: nalaka
```

Unanswerable items assert refusal:

```yaml
- id: unanswerable-001
  question: What is the SLA for the payments reconciliation job?
  intentClass: unanswerable
  unanswerable: true
  expectedSymbolIds: []
  # Correct behaviour is abstention. Answering this is a first-class failure, and the CI gate
  # fails the build when the rate exceeds 10%.
```

Multi-turn items carry prior turns, because §15.5 is explicit that *"a single-turn eval shows
green while multi-turn quality goes unmeasured"* — and turn three is where most real sessions
live:

```yaml
- id: multiturn-001
  question: What about the async version?
  intentClass: exact-identifier
  priorTurns:
    - { role: user, content: What does InvoiceService.create do? }
    - { role: assistant, content: It creates a draft invoice and persists it. }
  expectedSymbolIds:
    - sym_createasync_id
```

---

## Where items come from

**Real questions, not invented ones.** The most valuable source is the feedback table, and in
particular the triage bucket §15.5 identifies as uniquely actionable:

```sql
-- Questions people actually asked and did not get a good answer to.
SELECT t.raw_query, f.triage, f.comment, t.intent_class
FROM feedback f
JOIN query_traces t ON t.id = f.query_trace_id
WHERE f.signal = 'down' AND f.created_at > now() - interval '30 days'
ORDER BY f.created_at DESC;
```

A `knowledge-absent` finding becomes two things: an eval item, and a documentation backlog
ticket. That second one is the loop this platform is uniquely able to close.

Seed the set from a Phase 1 pilot team's real questions. Invented questions test the retrieval
you imagined rather than the retrieval you have.

---

## Running

```bash
pnpm eval
```

```bash
pnpm eval --compare origin/main
```

The comparison is a **paired bootstrap with confidence intervals, per stratum**. A delta whose
interval straddles zero is noise, whatever the point estimate says — that distinction is the
difference between tuning and guessing.

The gate is deliberately asymmetric: a significant regression in any stratum fails the build; a
non-significant improvement passes and is reported as "no evidence of change". A shipped
regression degrades every query until someone notices; an unshipped improvement costs one
iteration.

---

## Maintenance

The nightly maintenance job quarantines items whose expected symbols were renamed or deleted,
following the alias table first so a rename is not treated as a deletion. Quarantined items are
released automatically if their targets return — a revert should not permanently retire a gold
item.

```sql
SELECT intent_class, count(*) FILTER (WHERE NOT quarantined) AS active,
       count(*) FILTER (WHERE quarantined) AS quarantined
FROM eval_items WHERE org_id = $1 GROUP BY intent_class;
```

Watch the active count per stratum. A stratum that quietly drops below 30 stops gating —
`evaluateGate` warns rather than failing, because a regression measured on eight items is not a
measurement.
