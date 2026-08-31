ARG III_VERSION=0.11.2

FROM node:22-slim AS builder

WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-fund --no-audit
COPY . .
RUN npm run build \
 && npm prune --omit=dev --omit=optional --ignore-scripts --no-fund --no-audit

FROM iiidev/iii:${III_VERSION} AS iii-image

FROM node:22-slim

ARG III_VERSION=0.11.2

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini gosu curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=iii-image /app/iii /usr/local/bin/iii

WORKDIR /opt/agentmemory
COPY --from=builder /src/node_modules ./node_modules
COPY --from=builder /src/dist ./dist
COPY --from=builder /src/package.json ./package.json
RUN chmod 0755 /opt/agentmemory/dist/cli.mjs \
 && ln -s /opt/agentmemory/dist/cli.mjs /usr/local/bin/agentmemory

ENV AGENTMEMORY_III_VERSION=${III_VERSION} \
    NODE_ENV=production \
    TINI_SUBREAPER=1

COPY --chmod=0755 deploy/coolify/entrypoint.sh /usr/local/bin/agentmemory-entrypoint.sh

EXPOSE 3111

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3111/agentmemory/livez || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agentmemory-entrypoint.sh"]
