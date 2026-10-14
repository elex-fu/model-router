# Managed SaaS multi-role image (Phase 4, sub2api parity plan).
#
# One image serves every workload role; the role is selected at runtime via
# `start --role <role>` (compose `command:`), mirroring the systemd units in
# deploy/systemd/managed-saas/. Unlike deploy/docker/Dockerfile (local-mode
# proxy with a /data config volume), this image has no config volume, no
# bootstrap helper and no container-level HEALTHCHECK: managed SaaS startup is
# fail-closed (PG ping -> schema -> runtime privilege ACL -> KMS readiness)
# before any listener binds, and per-role healthchecks live in compose because
# the credential-validation-worker role owns no listener at all.

FROM node:22.16.0-bookworm-slim AS build

WORKDIR /opt/model-router
# python3/make/g++ are only needed to build better-sqlite3 native bindings.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.json ./
COPY web/package.json web/package.json
RUN npm ci
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev
# tsc does not emit the pure-ESM rewrap entry (the rewrap loader contract
# rejects transpiled CJS interop exports), so stage it next to the build
# output where the trusted-module specifier ./dist/saas/runtime/... finds it.
RUN cp src/saas/runtime/software-provider-credential-rewrapping-kms.mjs dist/saas/runtime/

FROM node:22.16.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /opt/model-router
COPY --from=build /opt/model-router/package.json ./package.json
COPY --from=build /opt/model-router/node_modules ./node_modules
COPY --from=build /opt/model-router/dist ./dist
COPY --from=build /opt/model-router/web/dist ./web/dist
# Trusted operator modules (platform TOTP KMS provider, gateway runtime
# module, optional capability modules) are bind-mounted read-only from
# ./modules at /opt/model-router-modules; the image never bakes them in.
RUN mkdir -p /opt/model-router-modules && chown node:node /opt/model-router-modules
USER node
EXPOSE 15005 15006 15007
ENTRYPOINT ["node", "dist/cli/index.js"]
