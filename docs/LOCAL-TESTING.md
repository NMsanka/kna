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

## Running the script

From **Git Bash**, run it directly:

```bash
./scripts/dev.sh status
```

From **PowerShell** or **cmd**, go through pnpm:

```bash
pnpm dev status
```

Both do the same thing. `pnpm dev` exists because `bash` on the Windows PATH is usually WSL's
bash, which cannot see the filesystem the way this script expects — so `bash scripts/dev.sh`
fails there with an error from a Linux subsystem you did not ask for. The launcher finds Git Bash
instead.

---

## The short version

One script holds every local setting and every step:

```bash
./scripts/dev.sh bootstrap
```

That starts the containers, migrates, sets the role passwords, builds, seeds a tenant, and starts
the three services — in the order they have to happen. Then:

```bash
./scripts/dev.sh publish
```

```bash
./scripts/dev.sh ask "how does the ACL filter work?"
```

`./scripts/dev.sh help` lists the rest. `pnpm dev <command>` is the same thing if you prefer.

**Where things live.** Runtime configuration stays in `.env`, because the services read it
themselves — duplicating it into a script would only create a second place to be wrong. What the
script holds is the handful of values that are *not* runtime config: the owner database URL,
the tenant slugs, and the role password. They are at the top of the file, under a comment saying
so.

Credentials from the seed go to `.kna/tokens.env`, which is gitignored. The seed prints them once
and stores them hashed, so anything not captured there is gone.

Seeding also repoints `KNA_TOKEN` and `KNA_INGEST_TOKEN` in `.env`, because the CLI reads that
file and a stale value there fails as `invalid_token` — which reads like a bug rather than "you
re-seeded". The editor's `KNA_MCP_TOKEN` lives in your OS environment instead, so the seed prints
the line to set it rather than setting it for you.

---

## Adding a repository

Three commands, whatever the repository.

```bash
./scripts/dev.sh repo https://github.com/you/your-repo.git
```

Registers it, grants you read access, checks the project slug exists, and mints a publish
credential scoped to that one repository. The credential is stored under a key derived from the
repository, so several repositories can be registered without their credentials being confused.

Then add `kna.config.yaml` to that repository — `org` must match the tenant:

```yaml
version: 1
org: kna
projects:
  - platform
security:
  uploadSource: false
```

```bash
./scripts/dev.sh publish "C:/path/to/your-repo"
```

`publish` works out which credential belongs to that repository from its git remote. If there
isn't one it says so, rather than falling back to another repository's and failing later with an
error about scope.

Watch it work:

```bash
./scripts/dev.sh logs worker
```

And check what landed:

```bash
./scripts/dev.sh status
```

```
==> Corpus
    kna: 20 modules, 2139 symbols, 1850 chunks
    layered: 1 modules, 388 symbols, 388 chunks
```

---

## Look before you publish

Both of these are offline. They write nothing, need no credential, and are worth running on any
repository before you involve the platform at all.

```bash
node apps/cli/dist/bin.js --cwd "C:/path/to/repo" describe --format summary
```

Read the **depth** line. `semantic` means types were resolved; `shallow` means signatures as
written. Only TypeScript reaches semantic today, so a Python or C# repository will say `shallow`,
and that is the honest answer rather than a misconfiguration.

```bash
node apps/cli/dist/bin.js --cwd "C:/path/to/repo" scan
```

This is the gate that will block a publish. Better to see it now than in the middle of one.

---

## What the script is doing

Useful when something goes wrong, or if you would rather run the steps yourself.

| Command | Underneath |
|---|---|
| `up` | `docker compose --env-file .env -f deploy/docker-compose.yml up -d …` |
| `db` | migrations as the **owner** role, then `ALTER ROLE … PASSWORD` for the two application roles |
| `seed` | inserts the org, project, principal and repos; captures the printed credentials |
| `start` | runs the three `dist` entry points with `nohup`, logging to `.kna/logs/` |
| `stop` | kills them — via PowerShell on Windows, where `pkill` silently does nothing |
| `repo` | `POST /v1/admin/repos`, then `POST …/ingest-credential` |
| `publish` | matches the repo to its credential, then runs the CLI with `--cwd` |
| `reindex` | `POST /v1/admin/reindex` — rebuilds from the stored bundle, no republish |

Two things it bridges that would otherwise catch you out, both real:

- The CLI signs bundles with `KNA_INGEST_HMAC_SECRET` while the server verifies them with
  `INGEST_HMAC_SECRET`. One shared value, two names, and only the server's is in `.env` — so a
  publish quietly produces an unsigned bundle unless the other is set too.
- `docker compose` resolves `.env` relative to the compose file. Without `--env-file .env` every
  `${VAR}` comes from `deploy/.env` and the OpenAI key silently becomes the placeholder.

---

## In a browser

The least setup of anything here. `pnpm dev bootstrap` builds it, so it is already running:

```bash
start http://localhost:8080/chat
```

Sign in with the `KNA_TOKEN` from `.kna/tokens.env`. `/chat` scopes to one project or repository,
`/chat/all` asks across everything you can read, and `/admin` is the same registration and
credential minting the script does — useful for checking that a repository landed where you
expected it to.

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

MCP scope defaults to the project associated with the current user's token. Clients that support
workspace-aware token minting can associate that token with the project inferred from the open
repository's git remote.

When the client cannot provide a reliable workspace repository, the agent can call the read-only
`list_repositories` MCP tool. It returns only repositories granted to the user represented by the
current MCP token, with active revocations removed. The agent should pass an exact returned name
as `scope.repo` when one entry clearly matches, or ask which repository the user means when
several entries could match.

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

For a genuinely clean slate:

```bash
./scripts/dev.sh reset
```

That drops the database, re-migrates, re-seeds and restarts. It asks for confirmation first, and
it leaves object storage alone — the bundles are the one thing that cannot be rebuilt, and
re-indexing from them is the fastest way back.

```bash
./scripts/dev.sh down
```

Stops the containers and keeps the volumes. `docker compose … down -v` would destroy them,
including every stored bundle.

---

## What two repositories still will not tell you

**Cross-repo symbol resolution**, unless one of them imports the other. Two unrelated
repositories exercise scoping and isolation, but the linking pass has nothing to link. To test it
properly you need a library and something that depends on it.

**Anything about non-TypeScript quality**, unless one of them is Python or C#. That is the most
informative repository you can add, because it decides whether the Griffe or Roslyn analyser
moves up the list.
