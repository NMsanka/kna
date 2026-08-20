# ADR 0002 — Distributing the CLI to CI runners

> **Status: Proposed.** Not decided. Written while the interim answer (build from source in CI)
> was being put in place, so the real decision has the constraints in front of it.

> **Authorship.** Written by an LLM (Claude Opus 5) in the session that built the CI path. The
> constraints below were verified against the code; the recommendation is judgement. See
> [Authorship and evidence](../AUTHORSHIP.md).

---

## Context

Indexing runs in CI, because analysis executes the repository's own build logic and that needs
the repo's toolchain present (§5). The generated workflow therefore has to get the `kna` CLI onto
a GitHub-hosted runner that has never heard of this repository.

The generated workflow originally said:

```yaml
- run: npx --yes @kna/cli describe --format json --output kna-ir.json
```

`@kna/cli` is a workspace package. It exists in this monorepo and nowhere else, so `npx` resolves
nothing and the job fails on every push. The workflow was written as though distribution were
solved; it is not.

Two options, and this ADR exists because the obvious one has a constraint that changes its shape.

---

## The constraint that decides this

**The CLI cannot be published as a single package without work.** It depends on eight workspace
packages:

```
@kna/ir  @kna/config  @kna/scanner  @kna/analyzer-core
@kna/analyzer-typescript  @kna/analyzer-openapi  @kna/contracts  @kna/docgen
```

`workspace:*` is a pnpm protocol with no meaning to a registry. `npm install @kna/cli` would fail
on the first of them. So publishing the CLI means one of:

**Publish all nine.** Standard, and the version burden is real: nine packages that must be
released together and stay compatible, or a consumer ends up with `@kna/cli@1.2` against
`@kna/ir@1.1` and an IR schema mismatch at the worst moment.

**Bundle into one.** Compile the CLI and its workspace dependencies into a single file, publish
one package. The external dependency surface is small enough to make this easy — `commander`,
`picocolors`, `simple-git`, all pure JavaScript with nothing native to relocate.

Bundling is the recommendation. A CLI is an application, not a library: nobody imports
`@kna/scanner` from outside this repo, so publishing it as a library is cost with no consumer.

The cost of bundling is worse stack traces, which source maps address, and a large artifact —
`ts-morph` arrives through the TypeScript analyser and is not small. Neither matters much for a
tool that runs in CI.

---

## Where to publish

**GitHub Packages** is the recommendation.

| | GitHub Packages | npm private org | Azure Artifacts |
|---|---|---|---|
| New vendor | No | Yes | Yes, unless already on Azure |
| Private packages | Free | ~$7/user/month | Included in Azure DevOps |
| CI authentication | `GITHUB_TOKEN` already present | Token in secrets | Token in secrets |
| Developer setup | `.npmrc` with a PAT | `npm login` | `.npmrc` with a PAT |

The deciding factor is that CI needs no new credential. The workflow already has `GITHUB_TOKEN`,
and it can read packages in the same organisation without anything being configured. Every other
option starts with "add a registry token to every repository's secrets", which is a static
credential in CI settings — the thing §15.2 spends its length arguing against.

### The scope constraint

GitHub Packages requires an npm scope matching the repository owner. Under `NMsanka`, `@kna/cli`
cannot be published; it would have to be `@nmsanka/kna-cli`.

Two ways out:

1. **Publish as `@nmsanka/kna-cli`.** Nothing internal changes — the workspace packages keep
   their `@kna/*` names because bundling means they are never published. Only the workflow and
   the install instructions mention the published name.
2. **Create a GitHub organisation named `kna`** and host the platform there. `@kna/cli` then
   works unchanged, and the naming stays consistent everywhere.

(1) is faster. (2) is tidier and is where this ends up anyway if the platform gets its own
repository and its own team, which §15.8's "named owner and funding line" implies.

### What developers pay

Private packages are not anonymously installable. Every developer running `npx @kna/cli` locally
needs a personal access token in their `.npmrc`.

That friction is worth stating because it has a workaround that undermines the whole thing:
someone will suggest making the package public to avoid it. Publishing this CLI publicly exposes
the analyser and scanner internals, and the scanner's ruleset is classified `confidential` in this
repository's own config precisely because "an attacker who reads these learns what the scanner
does not catch".

Developers mostly do not need the published CLI anyway — they run it from a checkout. The
published artifact exists for CI.

---

## Interim: build from source in CI

Until the above happens, the workflow checks out the platform repository, builds the CLI, and runs
it from `apps/cli/dist/bin.js`.

Honest about what it costs: an install and build of the whole workspace on every indexing run,
roughly a minute or two with a warm pnpm cache, in *both* the analyse and publish jobs, since the
job split means neither can hand a built binary to the other. It also means every indexed
repository needs read access to the platform repository.

Fine for a handful of repositories. It scales badly, and the failure mode when it does is
irritating rather than dangerous — slow builds, and repos pinned to whatever `main` happened to
be that morning.

**Migration is a two-line change.** The workflow selects its CLI source; switching from `source`
to `registry` swaps the checkout-and-build steps for a single `npx`.

---

## Consequences

**If bundled and published to GitHub Packages:**

- One package to version, not nine.
- CI needs no credential beyond what it already has.
- The published name is `@nmsanka/kna-cli` unless a `kna` organisation is created first.
- Developers who want it locally need a PAT in `.npmrc`; most should use a checkout instead.
- A release step is needed — publishing on tag, with the version matching the IR schema version
  it speaks, so a stale CLI against a newer platform is a visible mismatch rather than a
  confusing failure.

**Deferred deliberately:** publishing the eight library packages. There is no consumer outside
this repository, and inventing one creates a compatibility surface nobody asked for.

---

## Open question

**Version compatibility between CLI and platform.** A runner may cache a CLI for weeks while the
platform moves. The envelope carries `irSchemaVersion` and ingest upcasts older bundles, so there
is a mechanism — but nothing yet decides how old is too old, or what a rejection tells the
developer whose build just failed. Worth answering with the release step rather than after the
first mismatch.
