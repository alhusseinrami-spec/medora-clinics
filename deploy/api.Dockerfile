# syntax=docker/dockerfile:1
# MEDORA API image. Build from the repository root:  docker build -f deploy/api.Dockerfile -t medora-api .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Optional build secret "ca": an extra CA certificate for networks that inspect HTTPS (corporate proxies). Not needed otherwise.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --workspace @medora/shared --workspace @medora/api --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @medora/shared && npm run build -w @medora/api \
 && npm prune --omit=dev --workspace @medora/shared --workspace @medora/api --include-workspace-root

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=4000 STORAGE_DIR=/data/storage
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist/src apps/api/dist/src
# Schema tools for the one-off "migrate" service (migrations, preset sync, platform admin script).
COPY db/migrate.js db/sync_presets.js db/platform_admin.js db/seed_synthetic.mjs db/
COPY db/migrations db/migrations
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /app/apps/api
CMD ["node", "dist/src/main.js"]
