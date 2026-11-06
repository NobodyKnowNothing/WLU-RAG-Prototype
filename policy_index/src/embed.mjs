// Embedding models for the index. Both produce the same 384-dim vectors as the Worker's query
// embeddings (Workers AI @cf/baai/bge-small-en-v1.5, mean pooling, unit length), so an index built
// with either one can be searched by the other:
//   - local: the same model run on this machine with transformers.js (no account, no quota)
//   - workers-ai: Cloudflare's REST API (spends Workers AI neurons shared with the live assistant)

export const MODEL = "bge-small-en-v1.5";
export const DIMS = 384;
export const POOLING = "mean"; // Workers AI's default for this model; cls vectors are not compatible
export const MAX_TOKENS = 512;

// Part of every chunk's hash: changing the model or pooling re-embeds the whole index.
export const EMBEDDING_FINGERPRINT = `${MODEL}/${POOLING}/${DIMS}`;

export function localEmbedder({ model = "Xenova/bge-small-en-v1.5", dtype = "fp32", batchSize = 16, cacheDir } = {}) {
  let extractor;
  const load = async () => {
    if (!extractor) {
      const { pipeline, env } = await import("@huggingface/transformers");
      if (cacheDir) env.cacheDir = cacheDir;
      extractor = await pipeline("feature-extraction", model, { dtype });
    }
    return extractor;
  };
  return {
    name: `local:${model}:${dtype}`,
    dims: DIMS,
    async embed(texts) {
      const fx = await load();
      const out = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const t = await fx(texts.slice(i, i + batchSize), { pooling: POOLING, normalize: true });
        out.push(...t.tolist().map((v) => Float32Array.from(v)));
      }
      return out;
    },
  };
}

// One text per request on purpose: Workers AI pads a batch to its longest text and averages the
// padding into every shorter text's vector (measured against worker/src/vectors.json, which was
// embedded 8 at a time: short chunks there sit at cosine ~0.92-0.97 from their true vector). A
// single text has no padding, so it matches both the local model and the Worker's query vectors.
export function workersAiEmbedder({ accountId, apiToken, batchSize = 1, fetchImpl = fetch } = {}) {
  if (!accountId || !apiToken) throw new Error("workers-ai embedder needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/${MODEL}`;
  return {
    name: `workers-ai:@cf/baai/${MODEL}`,
    dims: DIMS,
    async embed(texts) {
      const out = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text: texts.slice(i, i + batchSize), pooling: POOLING }),
        });
        const body = await res.json();
        if (!res.ok || !body.success) throw new Error(`Workers AI embed failed: HTTP ${res.status} ${JSON.stringify(body.errors || body).slice(0, 300)}`);
        out.push(...body.result.data.map((v) => Float32Array.from(v)));
      }
      return out;
    },
  };
}

export function embedderFromEnv(kind = process.env.EMBEDDER || "local") {
  if (kind === "workers-ai") return workersAiEmbedder({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, apiToken: process.env.CLOUDFLARE_API_TOKEN });
  if (kind === "local") return localEmbedder({ cacheDir: process.env.MODEL_CACHE_DIR });
  throw new Error(`unknown embedder "${kind}" (use local or workers-ai)`);
}

export const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

// Float32 vectors <-> SQLite BLOBs (little-endian, 4 bytes per dimension).
export const toBlob = (v) => new Uint8Array(Float32Array.from(v).buffer);
export const fromBlob = (b) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
