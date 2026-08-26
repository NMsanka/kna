# syntax=docker/dockerfile:1.7
#
# One Dockerfile, three targets. The build is shared because the services share almost all of
# their code; the runtime stages are separate because they should not share a process, a
# database role, or a provider quota (§15.6).

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ── Dependencies ────────────────────────────────────────────────────────────────────────────
# Manifests first so a source-only change does not re-resolve the whole dependency graph.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/ir/package.json packages/ir/
COPY packages/config/package.json packages/config/
COPY packages/observability/package.json packages/observability/
COPY packages/contracts/package.json packages/contracts/
COPY packages/scanner/package.json packages/scanner/
COPY packages/analyzer-core/package.json packages/analyzer-core/
COPY packages/analyzer-typescript/package.json packages/analyzer-typescript/
COPY packages/analyzer-openapi/package.json packages/analyzer-openapi/
COPY packages/audit/package.json packages/audit/
COPY packages/db/package.json packages/db/
COPY packages/llm/package.json packages/llm/
COPY packages/chunking/package.json packages/chunking/
COPY packages/retrieval/package.json packages/retrieval/
COPY packages/docgen/package.json packages/docgen/
COPY apps/cli/package.json apps/cli/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/mcp/package.json apps/mcp/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── Build ───────────────────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
# `pnpm build` rather than `tsc -b`: the web application is bundled by Vite, which tsc knows
# nothing about. One definition of what building means, in the root package.json.
RUN pnpm run build

# Production dependency tree only. Dev dependencies are a meaningful share of the image and an
# unnecessary share of the attack surface.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# ── Runtime base ────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# Non-root by default. These services hold the most valuable read credential in the estate
# (§15.7); running them as root because the base image does is not a decision worth inheriting.
RUN groupadd --system --gid 1001 kna && useradd --system --uid 1001 --gid kna kna
WORKDIR /app
COPY --from=build --chown=kna:kna /app/node_modules ./node_modules
COPY --from=build --chown=kna:kna /app/packages ./packages
COPY --from=build --chown=kna:kna /app/package.json ./package.json
USER kna

# Liveness never touches a dependency (§15.6): a slow query must not become a restart loop.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# ── API ─────────────────────────────────────────────────────────────────────────────────────
FROM runtime AS api
COPY --from=build --chown=kna:kna /app/apps/api ./apps/api
# The API serves the web application; `web-static.ts` resolves this path relative to its own
# location. Without it the service starts, says so in a warning, and 404s /chat and /admin.
COPY --from=build --chown=kna:kna /app/apps/web/dist ./apps/web/dist
EXPOSE 8080
# Signals reach Node directly — no shell wrapper — so SIGTERM triggers the graceful drain
# rather than being swallowed by /bin/sh.
CMD ["node", "apps/api/dist/server.js"]

# ── Worker ──────────────────────────────────────────────────────────────────────────────────
FROM runtime AS worker
COPY --from=build --chown=kna:kna /app/apps/worker ./apps/worker
# Indexing has no HTTP surface; the healthcheck would fail permanently and mask real problems.
HEALTHCHECK NONE
CMD ["node", "apps/worker/dist/main.js"]

# ── MCP ─────────────────────────────────────────────────────────────────────────────────────
FROM runtime AS mcp
COPY --from=build --chown=kna:kna /app/apps/mcp ./apps/mcp
ENV PORT=8081
EXPOSE 8081
CMD ["node", "apps/mcp/dist/server.js"]

# ── Migrations ──────────────────────────────────────────────────────────────────────────────
# A separate image so migrations run as a job with the *owner* role, while the services run as
# the non-superuser application roles that RLS actually applies to (migration 0005).
FROM build AS migrate
WORKDIR /app/packages/db
HEALTHCHECK NONE
CMD ["node", "--experimental-strip-types", "bin/migrate.ts"]
