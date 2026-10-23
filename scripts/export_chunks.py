"""Export the cached chunks to worker/src/chunks.json for the Cloudflare Worker."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
chunks = []
for f in sorted((root / ".rag_cache" / "docs").glob("*.json")):
    for c in json.loads(f.read_text(encoding="utf-8")):
        chunks.append(
            {
                "id": c["id"],
                "source": c["metadata"]["source"],
                "page": c["metadata"]["page"],
                "text": c["text"],
                "enriched": c["enriched_text"],
            }
        )
out = root / "worker" / "src" / "chunks.json"
out.write_text(json.dumps(chunks, ensure_ascii=False), encoding="utf-8")
print(f"wrote {len(chunks)} chunks to {out}")
