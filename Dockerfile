# syntax=docker/dockerfile:1

# llm-fw container image.
#
# Built for the gateway deployment: clients point their SDK base_url at this
# container, so they need neither the firewall's CA nor an HTTPS_PROXY setting.
# The forward proxy is in here too and can be exposed alongside it.
#
# The detection models are baked in at build time (see the warm step below).
# Downloading ~30 MB on first request instead would make the first call after
# every rollout slow, and would make the image unusable on an air-gapped
# network — which is exactly the kind of network that wants this product.

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- model warm ----------
# Separate stage so the (large) model cache is copied into the runtime image
# without dragging in dev dependencies or the TypeScript sources.
FROM node:22-bookworm-slim AS models
WORKDIR /app
ENV LLM_FW_MODEL_DIR=/models

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY data ./data
COPY docker/warm-models.mjs ./docker/warm-models.mjs
RUN node docker/warm-models.mjs

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

# State (CA key, config, suppressions, whitelist) lives on a volume so it
# survives a restart; the models are read-only and baked into the image.
ENV LLM_FW_DIR=/data
ENV LLM_FW_MODEL_DIR=/models

# Containers exist to be reached from outside, so every listener binds the
# wildcard address. That is also what turns the credential checks on (see
# src/auth.ts): this image demands a client token out of the box rather than
# being anonymously usable. Set LLM_FW_GATEWAY_TOKEN to pin it, or read the
# generated one from the startup logs.
ENV LLM_FW_GATEWAY_ENABLED=true
ENV LLM_FW_GATEWAY_BIND=0.0.0.0
ENV LLM_FW_PROXY_BIND=0.0.0.0
ENV LLM_FW_DASHBOARD_BIND=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=models /models /models
COPY data ./data

# Run unprivileged. The image never needs the hosts-file sinkhole (that mode
# only redirects traffic on its own host, which is meaningless in a container),
# so no capability beyond binding a high port is required.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

# gateway, forward proxy, dashboard
EXPOSE 8081 8080 7731

# The kubelet/compose probe. /readyz reports 503 until the embedding model is
# loaded, so traffic is never routed to an instance that cannot scan yet.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "const p=process.env.LLM_FW_GATEWAY_PORT||8081;fetch('http://127.0.0.1:'+p+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["start", "--gateway"]
