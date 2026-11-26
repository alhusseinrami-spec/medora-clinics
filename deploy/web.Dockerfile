# syntax=docker/dockerfile:1
# MEDORA web image (Next.js standalone server). Build from the repository root:
#   docker build -f deploy/web.Dockerfile -t medora-web .
# API_URL is where the web server forwards /api when a request reaches it (the reverse proxy normally sends /api straight to the API).
FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG API_URL=http://api:4000
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1 API_URL=${API_URL}
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Optional build secret "ca": an extra CA certificate for networks that inspect HTTPS (corporate proxies). Not needed otherwise.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --workspace @medora/shared --workspace @medora/web --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @medora/shared && npm run build -w @medora/web

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
