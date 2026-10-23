"""Precompute chunk embeddings for the Worker (worker/src/vectors.json).

Run after export_chunks.py. Uses CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID if set,
otherwise the token from `wrangler login`.
"""
import json
import os
import re
import urllib.request
from pathlib import Path

MODEL = "@cf/baai/bge-small-en-v1.5"  # must match EMBED_MODEL in worker/src/index.js
root = Path(__file__).resolve().parent.parent


def credentials():
    token, account = os.environ.get("CLOUDFLARE_API_TOKEN"), os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not token:
        cfg = Path(os.environ["APPDATA"]) / "xdg.config" / ".wrangler" / "config" / "default.toml"
        token = re.search(r'oauth_token\s*=\s*"([^"]+)"', cfg.read_text()).group(1)
    if not account:
        req = urllib.request.Request(
            "https://api.cloudflare.com/client/v4/accounts", headers={"Authorization": f"Bearer {token}"}
        )
        account = json.load(urllib.request.urlopen(req))["result"][0]["id"]
    return token, account


def embed(token, account, texts):
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{MODEL}",
        data=json.dumps({"text": texts}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    return json.load(urllib.request.urlopen(req))["result"]["data"]


chunks = json.loads((root / "worker" / "src" / "chunks.json").read_text(encoding="utf-8"))
token, account = credentials()
vectors = []
for i in range(0, len(chunks), 8):
    vectors += embed(token, account, [c["enriched"] for c in chunks[i : i + 8]])
assert len(vectors) == len(chunks)
out = root / "worker" / "src" / "vectors.json"
out.write_text(json.dumps([[round(x, 6) for x in v] for v in vectors]), encoding="utf-8")
print(f"wrote {len(vectors)} vectors of dim {len(vectors[0])} to {out}")
