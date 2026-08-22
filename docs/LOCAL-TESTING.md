# Testing locally with several repositories

> **Authorship.** Written by an LLM (Claude Opus 5) in the session that did this. Unlike
> [HOSTING.md](HOSTING.md), every command here was run: two repositories were indexed into one
> tenant and queried, and the failures in the last section are ones that actually happened. See
> [Authorship and evidence](AUTHORSHIP.md).

Indexing a second repository is the cheapest useful test there is. It found three real bugs in
twenty minutes the first time — a parser defect, a stale-row sweep that never fired, and a
false-positive in the secret scanner that blocked the publish outright. A repository unlike the
one the code was written against is worth more than another test suite.

---

## Once, for the machine

Bring up the stack. `--env-file .env` is not optional — compose resolves `.env` relative to the
compose file, so without it every `${VAR}` comes from `deploy/.env` and your OpenAI key silently
becomes the placeholder.

```bash
pnpm install && pnpm build
```

```bash
pnpm dev:infra
```

```bash
DATABASE_URL=postgres://kna:kna@localhost:5432/kna pnpm db:migrate
```

```bash
docker exec kna-postgres-1 psql -U kna -d kna -c "ALTER ROLE kna_interactive WITH PASSWORD 'devpass'; ALTER ROLE kna_batch WITH PASSWORD 'devpass';"
```

Seed a tenant. `SEED_ORG_ID` must match the `org:` value your repositories will declare.

```bash
DATABASE_URL=postgres://kna:kna@localhost:5432/kna SEED_ORG_ID=kna SEED_ORG=kna SEED_PROJECT=platform pnpm db:seed
```

Save the three tokens it prints. They are **three different kinds of credential** and are not
interchangeable: `KNA_TOKEN` is a principal identity, `KNA_INGEST_TOKEN` is an HMAC claim scoped
to one repository, `KNA_MCP_TOKEN` is bound to the MCP resource. Re-seeding mints new ones and
invalidates the old, because they are stored hashed.

Start the three services, each in its own terminal:

```bash
pnpm dev:api
```

```bash
pnpm dev:worker
```

```bash
pnpm dev:mcp
```

An alias saves a lot of typing, since the CLI is not installed globally:

```bash
alias kna='node "'"$PWD"'/apps/cli/dist/bin.js"'
```

`kna --cwd <path>` operates on any repository without changing directory.

---

## Per repository, four steps

Repeat for each repository. Nothing is shared between them except the tenant.

### 1. Look before you publish

Entirely offline. Writes nothing, needs no credential.

```bash
kna --cwd "C:/path/to/repo" describe --format summary
```

Read the **depth** line. `semantic` means types were resolved; `shallow` means signatures as
written. Only TypeScript reaches semantic today, so a Python or C# repository will say `shallow`
and that is the honest answer rather than a misconfiguration.

```bash
kna --cwd "C:/path/to/repo" scan
```

This is the gate that will block a publish. Better to see it now.

### 2. Register it

```bash
curl -s -X POST http://localhost:8080/v1/admin/repos \
  -H "authorization: Bearer $KNA_TOKEN" -H 'content-type: application/json' \
  -d '{"remote":"https://github.com/you/your-repo.git","projectSlugs":["platform"],"openPullRequest":false}'
```

Keep the `repoId` it returns, and check `unknownProjectSlugs` is empty. A slug that matches
nothing is not an error — the repo still indexes — but it will be invisible to every
project-scoped question, which looks exactly like nothing having been indexed.

### 3. Mint a credential for it

```bash
curl -s -X POST http://localhost:8080/v1/admin/repos/<repoId>/ingest-credential \
  -H "authorization: Bearer $KNA_TOKEN" -H 'content-type: application/json' \
  -d '{"reason":"local testing","ttlHours":8}'
```

Scoped to that one repository. It refuses outright in production, where CI exchanges its OIDC
identity instead.

### 4. Configure and publish

`kna.config.yaml` in the repository — `org` must match `SEED_ORG_ID`:

```yaml
version: 1
org: kna
projects:
  - platform
security:
  uploadSource: false
```

```bash
KNA_INGEST_TOKEN="<token from step 3>" KNA_INGEST_HMAC_SECRET=development-ingest-secret \
  kna --cwd "C:/path/to/repo" publish
```

Watch the worker: one `module indexed` line per module, then `documentation regenerated`.

Confirm what landed:

```bash
docker exec kna-postgres-1 psql -U kna -d kna -c "SELECT r.name AS repo, (SELECT count(*) FROM modules m WHERE m.repo_id=r.id) modules, (SELECT count(*) FROM symbols s WHERE s.repo_id=r.id) symbols, (SELECT count(*) FROM chunks c WHERE c.repo_id=r.id) chunks FROM repos r ORDER BY 3 DESC;"
```

Write that query with subqueries, not joins. A four-way `LEFT JOIN` with `count(DISTINCT)` is a
cartesian blowup that will appear to hang.

---

## Querying across repositories

This is the part that only a multi-repo setup can exercise. Four scopes:

| Scope | Searches | Use when |
|---|---|---|
| `project` (default) | Repos in the inferred project | Normal developer questions |
| `repo` | Named repos only | "How does *this* service do X" |
| `org` | Everything you may read | Cross-cutting questions |
| `expanded` | Project plus its dependency edges | Tracing a call across a boundary |

Narrow to one repository:

```bash
curl -s -X POST http://localhost:8080/v1/search \
  -H "authorization: Bearer $KNA_TOKEN" -H 'content-type: application/json' \
  -d '{"query":"how is autoplay controlled","scope":{"kind":"repo","repoIds":["<repoId>"]},"topN":5}'
```

Across everything:

```bash
curl -s -X POST http://localhost:8080/v1/search \
  -H "authorization: Bearer $KNA_TOKEN" -H 'content-type: application/json' \
  -d '{"query":"how is configuration loaded","scope":{"kind":"org"},"topN":8}'
```

Or from the CLI, where scope is a flag:

```bash
KNA_TOKEN=... kna ask --scope org "where do we validate webhook signatures?"
```

**A useful check:** ask something only one repository could answer and confirm the results come
only from it. Ranking, not scoping, decides what surfaces at `org` scope — so a question that
matches one repo strongly will return only that repo's symbols even though both were searched.
That is correct behaviour, and worth seeing once so you do not mistake it for a scoping bug later.

---

## From an editor

The MCP server needs no per-repo setup, because it infers scope from the working directory's git
remote. Open one repository in Cursor or Claude Code and questions are scoped to it; open the
other and they are scoped to that one. No project picker.

`.mcp.json` in this repository points at `localhost:8081` and reads `${KNA_MCP_TOKEN}` from the
environment, so the file is shareable and each developer's own token filters results to what they
are allowed to see. On Windows the variable has to exist before the editor starts:

```bash
setx KNA_MCP_TOKEN "<your mcp token>"
```

---

## When something looks wrong

Every one of these happened.

**The publish is blocked by the scanner.** Working as designed — findings mean refusal, not a
warning. Decide whether it is a real secret (fix it), or a false-positive class worth fixing in
the rules, or genuinely one-off (allowlist it *with a written reason*). A long numeric identifier
tripping the card-number rule is the common case.

**Results are empty but indexing succeeded.** Check project membership first:

```bash
docker exec kna-postgres-1 psql -U kna -d kna -c "SELECT project_ids, corpus, count(*) FROM chunks GROUP BY 1,2;"
```

If `project_ids` holds a slug rather than a `prj_` id, or is empty, project-scoped queries will
match nothing while `org` scope still works. That is the single most confusing failure in the
system, because nothing errors.

**Documentation questions return nothing.** Check `documents` is non-empty and that doc chunks
exist. Regeneration is a separate job from indexing and can fail on its own.

**Re-publishing does nothing.** Correct — unchanged IR is skipped, which is the entire cost model.
To force it after changing the platform rather than the code:

```bash
curl -s -X POST http://localhost:8080/v1/admin/reindex \
  -H "authorization: Bearer $KNA_TOKEN" -H 'content-type: application/json' \
  -d '{"repoIds":["<repoId>"],"reason":"why"}'
```

**A fix does not take effect.** On Windows `pkill` does not reach node processes — the old
service keeps running with the old code. Use the PowerShell `Get-CimInstance` command in
[CLAUDE.md](../CLAUDE.md#windows-pkill-does-not-reach-node-processes).

**Services die with `password authentication failed`.** Postgres roles are cluster-wide. Setting
a role password against a scratch database changes it for every database on that server.

---

## Starting over

Drop the derived data and re-index from the bundles already in object storage — no re-publish
needed, because the bundles are the system of record:

```bash
curl -s -X POST http://localhost:8080/v1/admin/reindex \
  -H "authorization: Bearer $KNA_TOKEN" -H 'content-type: application/json' \
  -d '{"repoIds":["<repoId>"],"reason":"rebuild"}'
```

For a genuinely clean slate, drop the database and repeat the one-time setup. Keep the object
storage volume — that is the part you cannot rebuild, and re-indexing from it is the fastest way
back.

```bash
pnpm dev:infra:down
```

Note that this leaves volumes intact. `down -v` destroys them, including every stored bundle.

---

## What two repositories still will not tell you

**Cross-repo symbol resolution**, unless one of them imports the other. Two unrelated
repositories exercise scoping and isolation, but the linking pass has nothing to link. To test it
properly you need a library and something that depends on it.

**Anything about non-TypeScript quality**, unless one of them is Python or C#. That is the most
informative repository you can add, because it decides whether the Griffe or Roslyn analyser
moves up the list.
