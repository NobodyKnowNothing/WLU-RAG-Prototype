# Hosting the policy index for free

Research notes, checked 2026-11-05. Free tiers change often, so re-check the linked pages before relying on a number.

## What has to be hosted

| | Measured |
|---|---|
| Pages | 183: 167 policies, procedures and other governance documents from the wlu.ca sitemap, and the assistant's 16 hand-picked calendar and student pages |
| Section chunks | 2,390, averaging 698 characters (at most 1,703) |
| Vectors | 2,390 × 384 dims (bge-small-en-v1.5) = 0.92M stored dimensions, 3.7 MB as float32 |
| Text and keyword index | 12.4 MB SQLite file in total, vectors included |
| Queries | dozens to hundreds a day, so up to ~9,000 a month at 300 a day |
| Writes | first build: every chunk; a weekly update: only edited sections, usually a few dozen at most |

That's small for any vector database. The deciding factors are what the free tier does when nobody uses it (summer, reading week), whether it does keyword and vector search together (the assistant fuses both), and whether a Cloudflare Worker can call it.

## Options

| Option | Free allowance that matters here | Fits? | When idle | Keyword + vector | From the Worker |
|---|---|---|---|---|---|
| **Cloudflare Vectorize + D1** (recommended) | Vectorize: 5M stored dims, 30M queried dims/month. D1: 5 GB, 5M rows read/day, 100k rows written/day | Yes: 0.92M of 5M stored; 4.4M of 30M queried at 300 questions/day | No pausing | Yes: FTS5 in D1 plus Vectorize, fused in the Worker | Native bindings |
| Upstash Vector | 200M vectors×dims, 10k queries+updates a day, 1 GB, 10 indexes | Yes | Not stated | Hybrid indexes with built-in BM25 | REST |
| Pinecone Starter | 2 GB, 1M read units and 2M write units a month, 5 indexes, AWS us-east-1 only | Yes | Unclear: a 2025 tracker reports pausing after 3 weeks idle; Pinecone's own pricing page doesn't say | Dense, sparse and full-text index types | REST |
| Qdrant Cloud free cluster | 1 node: 1 GB RAM, 0.5 vCPU, 4 GB disk | Yes | **Suspended after 1 week unused, deleted after 4 weeks** | Sparse vectors | REST |
| Zilliz Cloud (Milvus) free | ~1M 768-dim vectors, 5 collections, 2.5M vCU a month | Yes | **Suspended after 7 days idle** (can be resumed) | Sparse/BM25 | REST |
| Neon (Postgres + pgvector) | 1 GB per project, 100 CU-hours a month | Yes | Compute sleeps after 5 min and wakes in a few hundred ms; projects are never paused | pgvector + Postgres full-text | HTTP serverless driver |
| Supabase (Postgres + pgvector) | 500 MB database | Yes | **Paused after 7 days idle, restored by hand** | pgvector + full-text | REST |
| Turso (libSQL) | 5 GB, 500M rows read and 10M written a month, 100 databases | Yes | Not stated | Native vector columns (DiskANN); SQLite, closest to this schema | HTTP |
| Self-hosted on Hugging Face Spaces (CPU basic) | 2 vCPU, 16 GB RAM, 50 GB disk | Yes: the SQLite store and model fit easily | **Sleeps after 48 h idle**; the next visit restarts it (cold start) | This project's own hybrid search | HTTP |

Not checked in this session: Render, Google Cloud Run, Oracle Cloud Always Free, MongoDB Atlas, Chroma Cloud, Weaviate Cloud.

## Recommendation: stay on Cloudflare, with Vectorize + D1

1. **No new account, and it never pauses.** The assistant already runs on the Workers free plan. A second Worker (`policy_index/cloudflare/worker.js`) binds to D1, Vectorize and Workers AI directly, with no API keys to manage.
2. **The free tier covers this load several times over.** Vectorize counts queried dimensions as (stored vectors + queries) × dims a month: (2,390 + 9,000) × 384 ≈ 4.4M of the 30M allowance at 300 questions a day. The allowance runs out at roughly 2,500 questions a day. Stored vectors use 18% of the 5M allowance, so the index could grow about 5× (for example by adding faculty pages) before hitting it.
3. **Keyword search stays.** D1 is SQLite with FTS5, so the BM25 half of the assistant's hybrid retrieval moves into the database. The same SQL runs locally on `node:sqlite`, which is how it was tested here. Measured on the deployed database, a search reads about 3,100 rows (2,950 for the FTS5 query, 120 for its candidates). D1's free 5M rows a day therefore allows roughly 1,600 searches, a lower cap than Vectorize's but still well above hundreds of questions a day.
4. **It makes the assistant lighter.** Today the Worker fetches and regex-parses up to 7 wlu.ca pages per question (each cached for 6 hours). That's the expensive part on a free plan with 10 ms of CPU and 50 subrequests per request. A search against the index is 1 embedding call, 1 Vectorize query and 2 D1 queries, plus 1 rerank call if `RERANK` is on. It's off by default, since hybrid retrieval alone did better on the eval questions.
5. **The binding limit is still Workers AI's daily neuron allowance**, almost all of it spent by Llama 3.3 70B writing answers (see the main README). The index doesn't change that: query embeddings are a few dozen tokens. The index itself is embedded locally (or in GitHub Actions), not with Workers AI, so building it costs no neurons.

**Second choice: Neon** if you want to leave Cloudflare's database products. It doesn't pause idle free projects, has a serverless HTTP driver that works from a Worker, and Postgres can do both halves of the search (pgvector and `tsvector` full-text). Turso is also worth a look: it's SQLite with native vector columns, so `schema.mjs` would mostly carry over, but its pricing page doesn't say what happens to idle free databases. **Self-hosting the Node server** (`src/server.mjs`, Dockerfile) on Hugging Face Spaces suits a demo or an agent sandbox. Its 48-hour sleep and cold start don't suit a student-facing assistant.

**Avoid for this use:** Qdrant Cloud, Zilliz and Supabase free tiers. Each suspends after about a week without traffic, which a course assistant will see over every break. Qdrant deletes the cluster after four weeks suspended.

## Weekly updates: GitHub Actions

`.github/workflows/policy-index.yml` runs the sync every Monday. GitHub Actions minutes are free for public repositories. The job crawls about 190 pages at one request a second and embeds changed sections with the local model (cached between runs). It then writes to D1 and Vectorize over the Cloudflare REST API. A Workers Cron Trigger isn't a good fit, because the free plan gives 10 ms of CPU and 50 subrequests per invocation and a sync makes about 190 requests.

One caveat: GitHub disables scheduled workflows in a public repository after 60 days without repository activity. They have to be re-enabled from the Actions tab, or something has to keep the repository active.

## Sources

- Cloudflare Vectorize [pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) and [limits](https://developers.cloudflare.com/vectorize/platform/limits/); D1 [limits](https://developers.cloudflare.com/d1/platform/limits/), [pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [supported SQL (FTS5)](https://developers.cloudflare.com/d1/sql-api/sql-statements/); [Workers limits](https://developers.cloudflare.com/workers/platform/limits/); [bge-small-en-v1.5 on Workers AI](https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/); Vectorize REST [upsert](https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/upsert/), [delete_by_ids](https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/delete_by_ids/), [inserting vectors](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/); [D1 REST query](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
- [Upstash Vector pricing](https://upstash.com/pricing/vector), [Upstash hybrid indexes](https://upstash.com/blog/sparse-and-hybrid-indexes.md)
- [Pinecone pricing](https://www.pinecone.io/pricing/); pause-after-3-weeks report: [pricingsaas.com](https://pricingsaas.com/companies/pinecone/diffs/2025Q1)
- [Qdrant Cloud](https://qdrant.tech/cloud), [Qdrant: create a cluster](https://qdrant.tech/documentation/cloud/create-cluster/)
- [Zilliz: inactive clusters](https://support.zilliz.com/hc/en-us/articles/18062224916251-What-happens-to-my-inactive-clusters), [Zilliz limits](https://docs.zilliz.com/docs/limits)
- [Neon pricing](https://neon.com/pricing)
- Supabase free-tier pause (third-party summaries): [jetadmin.io](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/), [automationatlas.io](https://automationatlas.io/answers/supabase-free-tier-limits-2026/)
- [Turso pricing](https://turso.tech/pricing), [Turso vector search](https://docs.turso.tech/features/ai-and-embeddings)
- [Hugging Face Spaces hardware](https://huggingface.co/docs/hub/en/spaces-gpus), [Spaces sleep time](https://huggingface.co/docs/huggingface_hub/main/guides/manage-spaces)
- [GitHub: disabling and enabling workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)
