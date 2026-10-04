# syntax=docker/dockerfile:1.7
# One image per Cloud Run service or job, from the repo root:
#   docker build -f docker/service.Dockerfile --build-arg APP=api .
#   (APP = api | notifier | orchestrator | mcp-gateway | avatar-jobs; ENTRY defaults to src/server.ts)
# Base images are pinned by digest; bump them deliberately (docs/RUNBOOK.md §1.2).

# ---- build: install with the lockfile, then a production-only tree for the one app
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build
ARG APP
ARG ENTRY=src/server.ts
RUN test -n "$APP" || (echo "build-arg APP is required" && exit 1)
ENV CI=true PNPM_HOME=/pnpm
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile \
 && pnpm --filter "@chalito/${APP}" deploy --prod --legacy /out \
 && rm -rf /out/test /out/vitest*.config.ts \
 && test -f "/out/${ENTRY}" \
 && ln -s "${ENTRY}" /out/entry.ts

# ---- run: distroless Node (no shell, no package manager), non-root
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e
WORKDIR /app
# Owned by root, run as nonroot: the app can't modify its own code.
COPY --from=build --chown=0:0 /out /app
# The services run TypeScript through tsx (workspace packages export .ts sources), with no transform
# cache. The root filesystem can be read-only; /tmp must stay writable (tsx makes a temp dir there):
# Cloud Run always provides an in-memory /tmp, and elsewhere mount a tmpfs at /tmp.
ENV NODE_ENV=production TSX_DISABLE_CACHE=1
USER nonroot:nonroot
# distroless runs `node` with these arguments; entry.ts links to the app's ENTRY.
CMD ["/app/node_modules/tsx/dist/cli.mjs", "/app/entry.ts"]
