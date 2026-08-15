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

# Install, then drop the parts of the ONNX runtime this image can never
# execute — in the SAME layer as the install, which is the whole trick.
#
# A production install is 387 MB, of which llm-fw's own code is 2.1 MB. The
# rest is the ML stack, and most of it cannot run here:
#
#   onnxruntime-web                    130 MB  browser backend
#   onnxruntime-node/bin/.../win32     124 MB  wrong platform
#   onnxruntime-node/bin/.../darwin     35 MB  wrong platform
#
# onnxruntime-node ships every platform's native binary in one tarball rather
# than using per-platform optionalDependencies the way sharp does, so npm has
# no way to install only the matching one. And @huggingface/transformers
# BUNDLES the web runtime's code into dist/transformers.node.mjs, so the
# onnxruntime-web package on disk is never resolved at runtime in Node.
#
# Deleting in a separate RUN removes nothing: layers are additive, so the files
# would still sit in the npm ci layer and the image would be byte-for-byte the
# same size. Measured that mistake before fixing it — pruned and unpruned both
# came out at 1.51GB. The `&&` chain is load-bearing, not style.
#
# Verified rather than assumed: with all three removed the same scan returns an
# identical embedding similarity (0.8380 on Windows and inside this image),
# which only happens if the ONNX model still loaded and ran.
RUN npm ci --omit=dev \
 && npm cache clean --force \
 && rm -rf node_modules/onnxruntime-web \
      node_modules/onnxruntime-node/bin/napi-v6/win32 \
      node_modules/onnxruntime-node/bin/napi-v6/darwin

COPY --from=build /app/dist ./dist
COPY --from=models /models /models
COPY data ./data

# Fail the build if the prune above broke the semantic stage. A non-zero
# similarity can only come from the ONNX model having loaded and run.
RUN node -e "import('./dist/api.js').then(async m=>{const fw=await m.createFirewall({});const v=await fw.scan({text:'Summarize this article for me in three bullet points.',surface:'prompt'});await fw.close();if(!(v.similarity>0)){console.error('embedding stage dead after prune: similarity='+v.similarity);process.exit(1)}console.log('post-prune embedding check ok, similarity='+v.similarity.toFixed(4))})"

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
