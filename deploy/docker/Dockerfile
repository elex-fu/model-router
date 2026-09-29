FROM node:22.16.0-bookworm-slim AS build

WORKDIR /opt/model-router
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.json ./
COPY web/package.json ./web/package.json
RUN npm ci
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:22.16.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /opt/model-router
COPY --from=build /opt/model-router/package.json ./package.json
COPY --from=build /opt/model-router/node_modules ./node_modules
COPY --from=build /opt/model-router/dist ./dist
COPY --from=build /opt/model-router/web/package.json ./web/package.json
COPY --from=build /opt/model-router/web/dist ./web/dist
COPY deploy/docker/config.example.json ./config.example.json
COPY deploy/docker/bootstrap.mjs ./bootstrap.mjs
COPY deploy/docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 15005 15006
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:15005/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["sh", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/cli/index.js", "start", "--config", "/data/config.json"]
