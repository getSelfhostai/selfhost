# The selfhost API server. Build from the repository root (needs BuildKit, the default builder
# since Docker Engine 23):
#   docker build -f deploy/docker/Dockerfile -t selfhost:dev .

ARG NODE_IMAGE=node:22.23.4-trixie-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm at the version pinned in packageManager.
RUN corepack enable
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@selfhost/server..."
RUN pnpm --filter @selfhost/server build
# Production dependencies only: the bundle keeps hono, postgres and pglite external.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @selfhost/server deploy --prod --legacy /out

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4400 \
    SELFHOST_DATA_DIR=/data
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
# The data dir holds the generated API token when SELFHOST_TOKEN is unset, and the embedded
# database when DATABASE_URL is unset.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4400
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4400)+'/v1/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
