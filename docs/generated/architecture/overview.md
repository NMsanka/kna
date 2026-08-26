---
title: "kna architecture"
docType: architecture-overview
generated: true
generator: kna-docgen
repoId: repo_3b52360b05e38e76b3db3583c2cb6aec
revision: master
analysisDepth: shallow
provenance:
  moduleIds:
    - mod_5bdb211a43046f19ca2ed8c4e3a662ca
    - mod_d4b7cb542aa0325c8670d5cc55f2a346
    - mod_60c6c3d09d17fe1b6c4635bbce85a4da
    - mod_bf87d3c81fe7c219d3ebcf9086ac795a
    - mod_059a7404d61707948d63d574a23b22c5
    - mod_a6d6b353ede56846d3b6628df43de776
    - mod_5ad4e42d509481ab472fb7e14415c7be
    - mod_d7bd19fc9cc601bc1fb7894d55770d01
    - mod_ea77493fddbabc61a22fc9301ccd5bd3
    - mod_627827a11e1b8647a8d1d3512bb1008c
    - mod_095c1135195b5ab97f79cc1523d4f37a
    - mod_7a00c0277ef5c28d76ffb0139703d101
    - mod_1f78830f9189e59a918cb6b012c825e7
    - mod_e934df0188a3716dda0ad3ad564013b4
    - mod_9a189635182a8361fe3d3ab5c044c601
    - mod_db9e3004a1a04564cf55e9eb719ad3d3
    - mod_f97af031ba2ebd388bca0f23eb2f345c
    - mod_d73a1a44210fb57290e06032b69a3729
    - mod_e61755422498968ae44eeedf6cb65c6a
    - mod_4658fcccdf0a526787cf6b39caf28dc0
  moduleKeys:
    - "pkg:npm/kna-platform"
    - "pkg:npm/@kna/api"
    - "pkg:npm/@kna/cli"
    - "pkg:npm/@kna/mcp"
    - "pkg:npm/@kna/worker"
    - "pkg:npm/@kna/analyzer-core"
    - "pkg:npm/@kna/analyzer-openapi"
    - "pkg:npm/@kna/analyzer-typescript"
    - "pkg:npm/@acme/billing"
    - "pkg:npm/@kna/audit"
    - "pkg:npm/@kna/chunking"
    - "pkg:npm/@kna/config"
    - "pkg:npm/@kna/contracts"
    - "pkg:npm/@kna/db"
    - "pkg:npm/@kna/docgen"
    - "pkg:npm/@kna/ir"
    - "pkg:npm/@kna/llm"
    - "pkg:npm/@kna/observability"
    - "pkg:npm/@kna/retrieval"
    - "pkg:npm/@kna/scanner"
  edgeCount: 65
  serviceCount: 10
  symbolIds:
    - sym_81a54a7f19231b3c761122c398b4df758c334a9f
    - sym_cabbf5ceedd3587f542cabd6521edf89bf0c0feb
    - sym_57d85190e0c1e489e83d36b04439b197db61eb2f
  signatureHashes:
    sym_81a54a7f19231b3c761122c398b4df758c334a9f: 6077cefafce1934fee281eaf1ec35e71a519caced23001d9aa8d8266f0e673cd
    sym_cabbf5ceedd3587f542cabd6521edf89bf0c0feb: 6077cefafce1934fee281eaf1ec35e71a519caced23001d9aa8d8266f0e673cd
    sym_57d85190e0c1e489e83d36b04439b197db61eb2f: 6077cefafce1934fee281eaf1ec35e71a519caced23001d9aa8d8266f0e673cd
---

# kna architecture

<!-- kna:generated:start id=architecture.summary hash=90dd005ce4b8f260 -->
| | |
|---|---|
| Repository | `github.com/nmsanka/kna` |
| Revision | `master` |
| Modules | 20 |
| Internal dependencies | 65 |
| Runtime services | 10 |
| HTTP endpoints | 3 |
| Languages | typescript, python |
<!-- kna:generated:end id=architecture.summary -->

<!-- kna:generated:start id=architecture.context hash=63ad7c0463de2068 -->
```mermaid
graph LR
  n22oq("api<br/>service")
  n30mnb3("litellm<br/>service")
  n2ba2("mcp<br/>service")
  n1puygo("minio<br/>service")
  n6hni9n("minio-init<br/>service")
  nmtsd7x("pgbouncer<br/>service")
  ncj1o55[("postgres<br/>database")]
  n1sj62j[["redis<br/>cache"]]
  n6bxjxw("reranker<br/>service")
  ncxmsua("worker<br/>job")
  n22oq --> ncj1o55
  n22oq --> n1sj62j
  n30mnb3 --> ncj1o55
  n2ba2 --> ncj1o55
  n6hni9n --> n1puygo
  nmtsd7x --> ncj1o55
  ncxmsua --> ncj1o55
  ncxmsua --> n1sj62j
```

<details>
<summary>Text description of the diagram above</summary>

Runtime topology: 10 service(s)

- api (service) depends on postgres, redis
- litellm (service) depends on postgres
- mcp (service) depends on postgres
- minio (service) depends on nothing in this repository
- minio-init (service) depends on minio
- pgbouncer (service) depends on postgres
- postgres (database) depends on nothing in this repository
- redis (cache) depends on nothing in this repository
- reranker (service) depends on nothing in this repository
- worker (job) depends on postgres, redis

</details>

| Service | Kind | Image | Declared in |
|---|---|---|---|
| `api` | service | — | `deploy/docker-compose.yml` |
| `litellm` | service | `ghcr.io/berriai/litellm:main-stable` | `deploy/docker-compose.yml` |
| `mcp` | service | — | `deploy/docker-compose.yml` |
| `minio` | service | `minio/minio:latest` | `deploy/docker-compose.yml` |
| `minio-init` | service | `minio/mc:latest` | `deploy/docker-compose.yml` |
| `pgbouncer` | service | `edoburu/pgbouncer:latest` | `deploy/docker-compose.yml` |
| `postgres` | database | `pgvector/pgvector:pg17` | `deploy/docker-compose.yml` |
| `redis` | cache | `redis:7-alpine` | `deploy/docker-compose.yml` |
| `reranker` | service | `ghcr.io/huggingface/text-embeddings-inference:cpu-1.6` | `deploy/docker-compose.yml` |
| `worker` | job | — | `deploy/docker-compose.yml` |
<!-- kna:generated:end id=architecture.context -->

<!-- kna:generated:start id=architecture.container hash=e6d7b46e1a9052d9 -->
```mermaid
graph LR
  nq79hr9["kna-platform"]
  nhlj2kt["@kna/api"]
  nszx0fb["@kna/cli"]
  nok97yi["@kna/mcp"]
  nmbkpwu["@kna/worker"]
  nekc84h["@kna/analyzer-core"]
  ng38xj1["@kna/analyzer-openapi"]
  n5t7t0m["@kna/analyzer-typescript"]
  npn4q8d["@acme/billing"]
  ngg1o6m["@kna/audit"]
  nky29sl["@kna/chunking"]
  nob0n5d["@kna/config"]
  nci1whn["@kna/contracts"]
  n8x7ko0["@kna/db"]
  nmgrrdj["@kna/docgen"]
  n5s5pyy["@kna/ir"]
  nwrz1ru["@kna/llm"]
  ny11cr7["@kna/observability"]
  nf7int7["@kna/retrieval"]
  n18dtev["@kna/scanner"]
  nmbkpwu --> nky29sl
  nmbkpwu --> nci1whn
  nmbkpwu --> nob0n5d
  nmbkpwu --> nmgrrdj
  nmbkpwu --> ny11cr7
  nmbkpwu --> n5s5pyy
  nmbkpwu --> nf7int7
  nmbkpwu --> n8x7ko0
  nmbkpwu --> nwrz1ru
  nky29sl --> n5s5pyy
  nky29sl --> nwrz1ru
  nci1whn --> n5s5pyy
  n18dtev --> n5s5pyy
  ng38xj1 --> nekc84h
  ng38xj1 --> n5s5pyy
  nszx0fb --> nci1whn
  nszx0fb --> n18dtev
  nszx0fb --> ng38xj1
  nszx0fb --> nob0n5d
  nszx0fb --> nmgrrdj
  nszx0fb --> nekc84h
  nszx0fb --> n5t7t0m
  nszx0fb --> n5s5pyy
  ngg1o6m --> ny11cr7
  ngg1o6m --> n8x7ko0
  nob0n5d --> n5s5pyy
  nmgrrdj --> nob0n5d
  nmgrrdj --> n5s5pyy
  nmgrrdj --> nwrz1ru
  nekc84h --> n18dtev
  nekc84h --> nob0n5d
  nekc84h --> ny11cr7
  nekc84h --> n5s5pyy
  nok97yi --> nci1whn
  nok97yi --> ngg1o6m
  nok97yi --> nob0n5d
  nok97yi --> ny11cr7
  nok97yi --> n5s5pyy
  nok97yi --> nf7int7
  nok97yi --> n8x7ko0
  nok97yi --> nwrz1ru
  nhlj2kt --> nky29sl
  nhlj2kt --> nci1whn
  nhlj2kt --> n18dtev
  nhlj2kt --> ngg1o6m
  nhlj2kt --> nob0n5d
  nhlj2kt --> ny11cr7
  nhlj2kt --> n5s5pyy
  nhlj2kt --> nf7int7
  nhlj2kt --> n8x7ko0
  nhlj2kt --> nwrz1ru
  n5t7t0m --> nekc84h
  n5t7t0m --> n5s5pyy
  nf7int7 --> nky29sl
  nf7int7 --> nob0n5d
  nf7int7 --> ny11cr7
  nf7int7 --> n5s5pyy
  nf7int7 --> n8x7ko0
  nf7int7 --> nwrz1ru
  n8x7ko0 --> nob0n5d
  n8x7ko0 --> ny11cr7
  n8x7ko0 --> n5s5pyy
  nwrz1ru --> nob0n5d
  nwrz1ru --> ny11cr7
  nwrz1ru --> n5s5pyy
```

<details>
<summary>Text description of the diagram above</summary>

Module graph: 20 module(s), 65 internal dependency edge(s). Solid arrows are runtime dependencies; dashed arrows are development-only.

- @kna/worker depends on @kna/chunking
- @kna/worker depends on @kna/contracts
- @kna/worker depends on @kna/config
- @kna/worker depends on @kna/docgen
- @kna/worker depends on @kna/observability
- @kna/worker depends on @kna/ir
- @kna/worker depends on @kna/retrieval
- @kna/worker depends on @kna/db
- @kna/worker depends on @kna/llm
- @kna/chunking depends on @kna/ir
- @kna/chunking depends on @kna/llm
- @kna/contracts depends on @kna/ir
- @kna/scanner depends on @kna/ir
- @kna/analyzer-openapi depends on @kna/analyzer-core
- @kna/analyzer-openapi depends on @kna/ir
- @kna/cli depends on @kna/contracts
- @kna/cli depends on @kna/scanner
- @kna/cli depends on @kna/analyzer-openapi
- @kna/cli depends on @kna/config
- @kna/cli depends on @kna/docgen
- @kna/cli depends on @kna/analyzer-core
- @kna/cli depends on @kna/analyzer-typescript
- @kna/cli depends on @kna/ir
- @kna/audit depends on @kna/observability
- @kna/audit depends on @kna/db
- @kna/config depends on @kna/ir
- @kna/docgen depends on @kna/config
- @kna/docgen depends on @kna/ir
- @kna/docgen depends on @kna/llm
- @kna/analyzer-core depends on @kna/scanner
- @kna/analyzer-core depends on @kna/config
- @kna/analyzer-core depends on @kna/observability
- @kna/analyzer-core depends on @kna/ir
- @kna/mcp depends on @kna/contracts
- @kna/mcp depends on @kna/audit
- @kna/mcp depends on @kna/config
- @kna/mcp depends on @kna/observability
- @kna/mcp depends on @kna/ir
- @kna/mcp depends on @kna/retrieval
- @kna/mcp depends on @kna/db
- @kna/mcp depends on @kna/llm
- @kna/api depends on @kna/chunking
- @kna/api depends on @kna/contracts
- @kna/api depends on @kna/scanner
- @kna/api depends on @kna/audit
- @kna/api depends on @kna/config
- @kna/api depends on @kna/observability
- @kna/api depends on @kna/ir
- @kna/api depends on @kna/retrieval
- @kna/api depends on @kna/db
- @kna/api depends on @kna/llm
- @kna/analyzer-typescript depends on @kna/analyzer-core
- @kna/analyzer-typescript depends on @kna/ir
- @kna/retrieval depends on @kna/chunking
- @kna/retrieval depends on @kna/config
- @kna/retrieval depends on @kna/observability
- @kna/retrieval depends on @kna/ir
- @kna/retrieval depends on @kna/db
- @kna/retrieval depends on @kna/llm
- @kna/db depends on @kna/config
- @kna/db depends on @kna/observability
- @kna/db depends on @kna/ir
- @kna/llm depends on @kna/config
- @kna/llm depends on @kna/observability
- @kna/llm depends on @kna/ir

</details>
<!-- kna:generated:end id=architecture.container -->

<!-- kna:generated:start id=architecture.component hash=0478d67c743a8505 -->
| Module | Depended on by | Public symbols | Endpoints | Languages | Owners |
|---|---:|---:|---:|---|---|
| `packages/ir` | 15 | 180 | 0 | typescript | — |
| `packages/config` | 9 | 31 | 0 | typescript | — |
| `packages/observability` | 8 | 37 | 0 | typescript | — |
| `packages/llm` | 6 | 98 | 0 | typescript | — |
| `packages/db` | 5 | 79 | 0 | typescript | — |
| `packages/contracts` | 4 | 70 | 0 | typescript | — |
| `packages/retrieval` | 3 | 328 | 0 | typescript | — |
| `packages/analyzer-core` | 3 | 124 | 0 | typescript | — |
| `packages/scanner` | 3 | 87 | 0 | typescript | — |
| `packages/chunking` | 3 | 71 | 0 | typescript | — |
| `packages/docgen` | 2 | 143 | 0 | typescript | — |
| `packages/audit` | 2 | 34 | 0 | typescript | — |
| `packages/analyzer-openapi` | 1 | 38 | 0 | typescript | — |
| `packages/analyzer-typescript` | 1 | 28 | 0 | typescript | — |
| `apps/api` | 0 | 219 | 1 | typescript | — |
| `apps/worker` | 0 | 95 | 1 | typescript | — |
| `apps/cli` | 0 | 93 | 0 | typescript | — |
| `apps/mcp` | 0 | 63 | 1 | typescript | — |
| `packages/analyzer-typescript/test/fixtures/billing` | 0 | 33 | 0 | typescript | — |
| `.` | 0 | 19 | 0 | typescript, python | — |

Ordered by in-degree. `packages/ir` is the most depended-upon module here, which makes it the one where a breaking change costs most.
<!-- kna:generated:end id=architecture.component -->

<!-- kna:generated:start id=architecture.confidence hash=fee125b5aad123bd -->
**1 of 20 module(s) were analysed at shallow depth.** Their
dependency edges come from declared manifests only; type references and call edges that
would appear at semantic depth are missing from the diagrams above.

| Module | Why |
|---|---|
| `.` | No analyser registered for python |

CI runners that build this repository have those toolchains by definition, so the
shared index is more complete than a local run. `kna doctor` explains a specific case.
<!-- kna:generated:end id=architecture.confidence -->

<!-- kna:generated:start id=architecture.api-surface hash=2da356d23a8c0c71 -->
| Method | Route | Module | Auth | Handler |
|---|---|---|---|---|
| `GET` | `/health` | `apps/api` | _none declared_ | `ApiContext.health` |
| `GET` | `/health` | `apps/mcp` | _none declared_ | `McpContext.health` |
| `GET` | `/health` | `apps/worker` | _none declared_ | `WorkerContext.health` |

> 3 endpoint(s) declare no authentication in their specification. That may be correct — health checks and public documentation routes usually are — but it is worth confirming rather than assuming the specification is incomplete.
<!-- kna:generated:end id=architecture.api-surface -->
