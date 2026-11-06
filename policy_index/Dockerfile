# Self-hosted policy search (Hugging Face Spaces, Render, Cloud Run, any VM).
# Build from the repository root, since the index reuses the Worker's parser:
#   docker build -f policy_index/Dockerfile -t wlu-policy-index .
#   docker run -p 7860:7860 wlu-policy-index
#
# The embedding model and a freshly built index are baked into the image (BAKE_INDEX=1), so a
# container that was asleep starts serving at once instead of re-crawling wlu.ca. While running it
# re-checks the policies every SYNC_EVERY_DAYS days; rebuilding the image also refreshes them.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production MODEL_CACHE_DIR=/app/models POLICY_DB=/app/policy_index/data/policies.sqlite \
    PORT=7860 HOST=0.0.0.0 SYNC_EVERY_DAYS=7

COPY worker/src/html.js worker/src/laurier.js worker/src/retrieval.js worker/src/policies.json worker/src/
COPY scripts/build_policy_index.mjs scripts/
COPY policy_index/package.json policy_index/package-lock.json policy_index/
RUN cd policy_index && npm ci --omit=dev
COPY policy_index/src policy_index/src

RUN cd policy_index && node -e "import('./src/embed.mjs').then((m) => m.localEmbedder({ cacheDir: process.env.MODEL_CACHE_DIR }).embed(['warm up']))"
ARG BAKE_INDEX=1
RUN if [ "$BAKE_INDEX" = "1" ]; then cd policy_index && node src/cli.mjs sync; fi

# Hugging Face Spaces runs containers as uid 1000; let it write the index during weekly syncs.
RUN mkdir -p /app/policy_index/data && chown -R 1000:1000 /app/policy_index/data
USER 1000
EXPOSE 7860
CMD ["node", "policy_index/src/cli.mjs", "serve"]
