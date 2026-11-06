// Optional local cross-encoder for the self-hosted server, the same model the Worker reranks with
// on Workers AI (bge-reranker-base). It is large (~280 MB quantized), so it is off unless RERANK=local.
export function localReranker({ model = "Xenova/bge-reranker-base", dtype = "q8", batchSize = 8, cacheDir } = {}) {
  let loaded;
  const load = async () => {
    if (!loaded) {
      const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import("@huggingface/transformers");
      if (cacheDir) env.cacheDir = cacheDir;
      loaded = { tok: await AutoTokenizer.from_pretrained(model), net: await AutoModelForSequenceClassification.from_pretrained(model, { dtype }) };
    }
    return loaded;
  };
  return {
    name: `local:${model}:${dtype}`,
    // -> [{ index, score }] best first; score is the sigmoid of the relevance logit, like Workers AI's.
    async rerank(query, texts) {
      const { tok, net } = await load();
      const scores = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const inputs = tok(new Array(batch.length).fill(query), { text_pair: batch, padding: true, truncation: true, max_length: 512 });
        const { logits } = await net(inputs);
        for (const x of logits.data) scores.push(1 / (1 + Math.exp(-x)));
      }
      return scores.map((score, index) => ({ index, score })).sort((a, b) => b.score - a.score);
    },
  };
}
