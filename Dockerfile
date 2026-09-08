# syntax=docker/dockerfile:1
# Support Voice Agent — production container.
#
#   docker build -t support-agent .
#   docker run --rm -p 8787:8787 --env-file .env -v agent-data:/data support-agent
#
# Runtime is tsx (no build step): the image ships sources, the policy bundle,
# and node_modules with the probed native better-sqlite3 binary. Two-stage so
# npm's caches and the toolchain stay out of the final image. Runs as a
# non-root user; all runtime state lives under the /data volume (DATA_DIR).

# ---- builder: install deps, probe the native module, rebuild if needed ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Same contract as CI: fail the build if the prebuilt better-sqlite3 binary
# cannot load on this Node ABI, after a from-source rebuild attempt. The
# toolchain (python3/make/g++) is installed here and discarded with the stage.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && (npx tsx scripts/check-sqlite.ts \
        || (npm rebuild better-sqlite3 --build-from-source && npx tsx scripts/check-sqlite.ts))

# ---- runtime: non-root, minimal, healthcheckable ----
FROM node:22-slim AS runtime
WORKDIR /app
RUN groupadd --system app && useradd --system --gid app app \
    && mkdir -p /data && chown app:app /data
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./
COPY --chown=app:app src ./src
COPY --chown=app:app scripts ./scripts
COPY --chown=app:app policies ./policies

# Container defaults: state under the volume, HTTP on all interfaces, and the
# detached-mode keep-alive (stdin is closed in a container; without this the
# REPL would exit and kill the server immediately).
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=8787 \
    SERVE_KEEP_ALIVE=1
VOLUME /data

# tsx from node_modules (devDependency — it is the runtime runner); tsconfig
# is not needed: tsx resolves the TS sources directly.
USER app
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node_modules/.bin/tsx", "scripts/serve.ts"]
