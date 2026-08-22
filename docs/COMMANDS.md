# Commands

Everything from a cold machine to an answer, in order. Every command here was run.

Two ways to invoke the helper script, depending on your terminal:

| Terminal | Prefix |
|---|---|
| PowerShell, cmd | `pnpm dev …` |
| Git Bash, macOS, Linux | `./scripts/dev.sh …` |

They do the same thing. PowerShell is used below; swap the prefix if you are in Git Bash.

Paths need **forward slashes** and quotes if they contain spaces.

---

## 1. Start everything

Once per machine, or after a reboot.

```bash
pnpm dev bootstrap
```

Containers, database, migrations, role passwords, build, tenant seed, and the three services —
in the order they have to happen. Takes a few minutes.

It prints three credentials **once** and saves them to `.kna/tokens.env`. They are not
interchangeable:

| Variable | What it is |
|---|---|
| `KNA_TOKEN` | You. Identity, and therefore what you may read |
| `KNA_INGEST_TOKEN` | Permission to publish **one** repository. Not an identity |
| `KNA_MCP_TOKEN` | Your editor's connection to the MCP server |

Check it came up:

```bash
pnpm dev status
```

---

## 2. Look at a repository before involving the platform

Offline. Writes nothing, needs no credential, sends nothing anywhere. Worth doing on any
repository first.

```bash
node apps/cli/dist/bin.js --cwd "C:/path/to/your-repo" describe --format summary
```

Read the **depth** line. `semantic` means types were resolved, `shallow` means signatures as
written. Only TypeScript reaches semantic today.

```bash
node apps/cli/dist/bin.js --cwd "C:/path/to/your-repo" scan
```

This is the gate that will block a publish. Better to see it now.

---

## 3. Register the repository

```bash
pnpm dev repo https://github.com/you/your-repo.git
```

Registers it, grants you read access, checks the project slug exists, and mints a publish
credential scoped to that one repository — saved alongside your other tokens.

Watch for `unknown project slug` in the output. It is not an error and the repository still
indexes, but it will answer nothing to project-scoped questions.

Same thing through the console if you prefer a form: **http://localhost:8080/admin**

---

## 4. Add the config file

In the root of the repository being indexed, create `kna.config.yaml`:

```yaml
version: 1
org: kna
projects:
  - platform
security:
  uploadSource: false
```

`org` must match the tenant, or the server rejects the upload as belonging to someone else.

---

## 5. Publish

```bash
pnpm dev publish "C:/path/to/your-repo"
```

Analyses the code, scans for secrets, signs the result, and sends it. It finds the right
credential from the repository's git remote.

Watch it being indexed:

```bash
pnpm dev logs worker
```

One `module indexed` line per module, then `documentation regenerated`. Ctrl-C stops watching;
the service keeps running.

Confirm what landed:

```bash
pnpm dev status
```

---

## 6. Ask it things

About the repository you are standing in:

```bash
node apps/cli/dist/bin.js ask "how does authentication work?"
```

About a specific repository:

```bash
pnpm dev ask --in "C:/path/to/your-repo" "what does this service do?"
```

Across everything you can read:

```bash
node apps/cli/dist/bin.js ask --scope org "where do we validate webhook signatures?"
```

You get a written answer with numbered citations, and the file and line behind each one. If the
evidence is weak it says so instead of guessing.

---

## 7. From your editor

No per-repository setup. Scope is inferred from the folder you have open.

```bash
setx KNA_MCP_TOKEN "<the mcp token from .kna/tokens.env>"
```

Restart the editor afterwards. `.mcp.json` in this repository already points at the server, and
reads that variable rather than embedding a token.

---

## 8. Read the documentation

List what exists:

```bash
curl "localhost:8080/v1/docs" -H "authorization: Bearer $KNA_TOKEN"
```

Fetch one as Markdown, diagrams intact:

```bash
curl "localhost:8080/v1/docs/architecture/overview?repoId=<repoId>&format=markdown" -H "authorization: Bearer $KNA_TOKEN"
```

`repoId` is needed because every repository has an `architecture/overview` — without it the
request returns 409 listing the candidates rather than guessing.

Or write the files into the repository itself:

```bash
node apps/cli/dist/bin.js --cwd "C:/path/to/your-repo" generate --no-prose
```

Nothing is committed. Review the diff and open a pull request.

---

## 9. Day to day

```bash
pnpm dev status
```

```bash
pnpm dev logs worker
```

```bash
pnpm dev restart
```

Run `restart` after `pnpm build`. Services keep running the old code until restarted, which looks
exactly like a fix that did not work.

```bash
pnpm dev stop
```

```bash
pnpm dev down
```

`down` stops the containers and keeps the data. Object storage holds the IR bundles, which are
the one thing that cannot be rebuilt.

---

## 10. When you change something

**Changed the code and want it re-indexed?** Publishing the same commit again does nothing — that
is the cost model working, since nothing changed. Commit your change and publish, or force it:

```bash
pnpm dev reindex <repoId>
```

That replays the stored bundle without re-analysing. Use it after changing the platform rather
than the code: a new embedding model, different chunk sizes, a fixed indexer bug.

**Starting over:**

```bash
pnpm dev reset
```

Drops the database, re-migrates, re-seeds, restarts. Asks for confirmation. Object storage is
left alone, so everything can be rebuilt from the bundles with `reindex`.

---

## Starting over from nothing

Every step, in order, for when the containers are gone and you are rebuilding from an empty
Docker. Nothing here is optional except where it says so.

### 1. Wipe

```bash
docker compose -f deploy/docker-compose.yml down -v
```

`-v` is the part that matters. Without it the containers go and the volumes stay, so your data
comes back when they restart.

| Volume | Holds | Recoverable |
|---|---|---|
| `kna_postgres-data` | tenant, credentials, the whole index | Yes — steps 3 and 6 rebuild it |
| `kna_minio-data` | **IR bundles: the system of record** | Only by publishing again from source |
| `kna_redis-data` | job queues | Nothing worth keeping |

### 2. Check `.env` survived

```bash
ls .env
```

It is gitignored and lives in no container, so it should still be there — your model provider
key with it. If it is missing, copy `.env.example` and set `OPENAI_API_KEY`. Without one the
services still start and pass their checks; search and indexing are what break.

### 3. Rebuild everything

```bash
pnpm dev bootstrap
```

Containers, wait for Postgres to be healthy, migrate, set the two role passwords, build, seed
the tenant, start api/worker/mcp — in the order they have to happen. A few minutes.

```bash
pnpm dev status
```

### 4. Re-point the editor's token

Seeding regenerates every credential and stores them hashed, so the previous ones stop working.
Two of the three are handled for you: `.kna/tokens.env` is rewritten, and the `KNA_TOKEN` and
`KNA_INGEST_TOKEN` lines in `.env` are pointed at the new values.

`KNA_MCP_TOKEN` is the exception, because it lives in your OS environment rather than in any
file here. Until you update it the editor connects and every tool call fails.

The seed prints a ready-to-paste line. Or read it out of the file yourself — **PowerShell**:

```powershell
$t = (Select-String -Path .kna\tokens.env -Pattern '^export KNA_MCP_TOKEN=').Line -replace '^export KNA_MCP_TOKEN=',''
setx KNA_MCP_TOKEN $t
```

Git Bash, macOS, Linux:

```bash
export KNA_MCP_TOKEN=$(grep '^export KNA_MCP_TOKEN=' .kna/tokens.env | cut -d= -f2)
```

`setx` only affects processes started after it runs, so **restart the editor**. `grep` and `cut`
do not exist in PowerShell — use the two-line form above there.

### 5. Re-register the other repositories

Bootstrap registers only this one, from its own git remote. Every other repository needs adding
back:

```bash
pnpm dev repo https://github.com/you/other-repo.git
```

### 6. Re-publish

The bundles went with `kna_minio-data`, so `reindex` has nothing to replay. Each repository has
to be analysed from source again:

```bash
pnpm dev publish .
```

```bash
pnpm dev publish "C:/path/to/other-repo"
```

Watch them land:

```bash
pnpm dev logs worker
```

### 7. Ask

```bash
node apps/cli/dist/bin.js ask "how does the ACL filter enforce tenant isolation?"
```

Or from the editor, once you have restarted it:

> use the kna tools — what does the abstention policy do?

---

## Administration

The console at **http://localhost:8080/admin** covers registering repositories, minting publish
credentials, triggering reindexes, and adding people. Sign in with `KNA_TOKEN`.

Adding someone from the command line instead:

```bash
curl -X POST localhost:8080/v1/admin/principals -H "authorization: Bearer $KNA_TOKEN" -H 'content-type: application/json' -d '{"subject":"alex@example.com","clearance":"internal","grantRepoIds":["<repoId>"],"reason":"joining the team"}'
```

Their token is returned once and stored hashed. A lost one is reissued, never recovered.

---

## When something looks wrong

**`No platform token`** — `KNA_TOKEN` is not set. Seeding writes it to both `.kna/tokens.env` and
`.env`, and the CLI reads `.env`.

**The publish is blocked by the scanner** — working as designed. Look at what it flagged: a real
secret needs removing, a false-positive class is worth fixing in the rules, a genuine one-off goes
in the allowlist with a written reason.

**Answers come from the wrong repository** — `ask` uses the folder you are standing in. Use
`--in <path>` to name one, or `--scope org` for everything.

**Results are empty although indexing succeeded** — check project membership:

```bash
docker exec kna-postgres-1 psql -U kna -d kna -c "SELECT project_ids, corpus, count(*) FROM chunks GROUP BY 1,2;"
```

A slug rather than a `prj_` id means project-scoped queries match nothing while `--scope org`
still works.

**`unknown or expired token`** or **`invalid_token`** — re-seeding mints new credentials and
invalidates the old ones. `pnpm dev seed` now repoints `.env` for you; the editor's
`KNA_MCP_TOKEN` lives in your OS environment and is the one you still have to set by hand.

**A fix did not take effect** — the service is still running old code. `pnpm dev restart`.

**`pnpm dev logs` says the file does not exist** — the service was started outside the script, so
it is logging elsewhere. `pnpm dev restart`.
