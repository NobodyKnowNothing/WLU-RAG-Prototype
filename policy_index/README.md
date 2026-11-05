# Laurier policy index

A section-level vector index of every Laurier policy and procedure, plus the Academic Calendar and student pages the PC141 assistant already uses. It re-checks wlu.ca weekly and re-embeds only the sections that changed. An agent can search it over HTTP or MCP, and each result cites one section of a policy (for example *12.2 Student Code of Conduct: Academic Misconduct > 4.04 Penalties for Academic Misconduct, 4.04.01*) with a link that opens the page at that section.

It runs locally (SQLite file, local embedding model) or on Cloudflare's free plan (D1 + Vectorize + Workers AI). See [HOSTING.md](HOSTING.md) for why Cloudflare and what else was considered.

```
              weekly (GitHub Actions)                         per question
 wlu.ca ──► discover ─► fetch ─► chunk ─► diff ─► embed ─► store ◄── search ◄── agent / assistant
 sitemap,    191 pages   1/s     html.js   hashes  bge-small  SQLite or     FTS5 + vectors    HTTP or MCP
 register,                       + policy  vs last  (local)   D1 + Vectorize  → RRF → rerank
 16 curated                      fixes     run
```

## What gets indexed

- Every policy and procedure under `/about/governance/assets/resources/` in the wlu.ca sitemap, except pension-fund investment statements. Procedures are only linked from their policies, so the sitemap lists 65 pages that the [policy register](https://www.wlu.ca/about/governance/policies.html) doesn't.
- Anything else the register's main content links to in an `assets/resources/` folder (currently nothing beyond the sitemap, but the register is checked in case a policy is added there first).
- The assistant's 16 hand-picked pages from `worker/src/laurier.js` (Academic Calendar sections and dates, students.wlu.ca pages on academic integrity, exams, petitions, absences and Accessible Learning), with the same ids, titles and publishers the Worker uses.

## Chunking: one chunk per section

Pages are parsed by the assistant's own `worker/src/html.js`, so section names match what the live Worker cites. On top of that, `src/chunk.mjs`:

- **Splits by section, and long sections by clause.** A section over 1,500 characters (about 350 tokens, under bge-small's 512) is split into parts of roughly equal size. Once a part is most of the way to its share, it breaks before the next numbered clause (`4.02.08 …`). Each part records the clauses it holds, so a citation can say *4.01 Academic Misconduct, 4.02.03–4.02.07* instead of only the section name.
- **Fixes numbered heading paths.** Policy pages mix heading levels, so html.js nests *5.00 Roles and Responsibilities* under *4.00 Policy*. A numbered heading now stays above another one only when its number is a prefix of the other's.
- **Keeps table cells with their headers.** The penalty grids in Policy 12.2's appendix used to flatten into an unlabelled list. They now read `Minor – First Offence: Written official warning in Central Registry. …`, so the first-offence column stays attached to its penalties.
- **Drops repeated boilerplate.** The disclaimer every policy page repeats ("This online version is for convenience…") is removed so it doesn't make all pages look alike. The approval and revision dates stay.
- **Embeds in the same style as the PDF chunks:** `"<document title> | <section path>\n<text>"`, with `bge-small-en-v1.5` (384 dims, mean pooling) — the model the Worker uses for query embeddings.
- **Gives each chunk a deep link:** the heading's anchor if it has one, otherwise a [text fragment](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment/Text_fragments) (`#:~:text=4.04%20Penalties…`) for the heading or, for a later part, its first words.

Chunk ids come from the page and the section's position, not from its text. An edited section keeps its id and is re-embedded; a new one gets a new id.

## Weekly updates

`node src/cli.mjs sync` (run every Monday by `.github/workflows/policy-index.yml`):

1. Reads the sitemap and the register, then fetches every page at one request a second (about 4 minutes).
2. Parses and chunks each page, then compares its chunks with the stored ones:
   - same text → nothing is written;
   - edited section → re-embedded and rewritten;
   - new section → embedded;
   - removed section → its row and vector are deleted.
3. Deletes pages that are no longer listed anywhere. As a safeguard, it refuses to delete more than 20% of pages in one run unless `--force` is given, since that is more likely a broken sitemap than a mass repeal.
4. Keeps a page as it was if it fails to load, and records the error.
5. Writes a report of what changed, section by section (`--report`, and the GitHub job summary).

Change detection compares the parsed text, not HTTP headers. wlu.ca republishes every page nightly (a new `Last-Modified` and `ETag` each day), and sitemap dates don't always move when a policy is edited. `--changed-only` trusts the sitemap dates instead, for a quick run. The embedding model and chunker version are part of every chunk's hash, so changing either re-embeds everything on the next run.

## Search

`src/search.mjs` runs the same code locally and in the Worker:

1. The question gets the assistant's synonym expansion (ChatGPT → "AI-based systems", …).
2. FTS5 BM25 (title and section path weighted above body text) and vector similarity each return their top 50.
3. Reciprocal rank fusion merges the two lists.
4. Optionally, the top 30 are reranked with `bge-reranker-base`.
5. At most 2 sections per page are kept, so one long policy can't fill every slot.

Results include a `citation`, a deep `url`, the page's `authority` (university policy, Academic Calendar or guidance page), `revised` date and `fetched_at`. `toAssistantSource()` converts a result into the source shape `worker/src/answer.js` already expects, so the assistant's prompt and quote checks work unchanged.

## Using it from an agent

Three tools (`src/tool.mjs`): `search_policies`, `get_policy_section` (a section with its neighbours, for reading a rule in full) and `list_policies`. They are served over MCP and plain HTTP:

| | Local | Cloudflare |
|---|---|---|
| MCP (stdio) | `node policy_index/src/cli.mjs mcp` | — |
| MCP (Streamable HTTP) | `POST http://127.0.0.1:8790/mcp` | `POST https://wlu-policy-search.<account>.workers.dev/mcp` |
| HTTP | `POST /search {"query", "k", "kinds"}`, `GET /section/:id`, `GET /policies` | same routes |

For example, in Claude Code:

```bash
claude mcp add wlu-policies -- node policy_index/src/cli.mjs mcp
```

```bash
claude mcp add --transport http wlu-policies https://wlu-policy-search.<account>.workers.dev/mcp
```

To use the index in the existing assistant instead of fetching catalog pages live, call `/search` from `searchLaurier` in `worker/src/laurier.js` (or bind the search Worker as a service binding) and map the results with `toAssistantSource`. Laurier site search can stay as it is for pages outside the index.

## Running it locally

```bash
cd policy_index
npm install
node src/cli.mjs sync                  # build or update data/policies.sqlite (~6 min the first time)
node src/cli.mjs search "What is the penalty for a first plagiarism offence?"
node src/cli.mjs eval                  # retrieval check on the Laurier questions in data/web_eval.json
node src/cli.mjs serve                 # HTTP + MCP on http://127.0.0.1:8790
npm test                               # 21 tests, no network
```

The first run downloads the embedding model (`Xenova/bge-small-en-v1.5`, ~130 MB) from Hugging Face. Set `RERANK=local` (or pass `--rerank`) to rerank with `Xenova/bge-reranker-base` (~280 MB) as well.

## Deploying on Cloudflare (free plan)

```bash
cd policy_index
npx wrangler d1 create wlu-policies              # copy the database_id into cloudflare/wrangler.jsonc
npx wrangler vectorize create wlu-policies --dimensions=384 --metric=cosine
npx wrangler vectorize create-metadata-index wlu-policies --propertyName=kind --type=string
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... D1_DATABASE_ID=...   # token: D1 Edit + Vectorize Edit
node src/cli.mjs init --store cloudflare
node src/cli.mjs sync --store cloudflare         # first full build
npx wrangler deploy --config cloudflare/wrangler.jsonc
```

Create the metadata index before the first sync: Vectorize only indexes `kind` for vectors inserted after the index exists. For the weekly job, add the repository secrets `CLOUDFLARE_ACCOUNT_ID` and `POLICY_INDEX_API_TOKEN`, and the variable `D1_DATABASE_ID`. Without them, the job keeps a SQLite index in the Actions cache and uploads it as an artifact.

To self-host instead, build `policy_index/Dockerfile` from the repository root. It bakes the model and a fresh index into the image and re-syncs weekly while running. It suits Hugging Face Spaces (Docker, port 7860), Render or Cloud Run.

## Files

| | |
|---|---|
| `src/sources.mjs` | discovery (sitemap, register, curated pages), polite fetcher, page metadata |
| `src/chunk.mjs` | page → section chunks, clause ranges, deep links |
| `src/embed.mjs` | local and Workers AI embedders (the same vectors) |
| `src/sync.mjs` | the weekly diff-and-update, and its report |
| `src/schema.mjs` | the SQLite/D1 schema and every SQL statement, shared by both stores |
| `src/store-sqlite.mjs`, `src/store-cloudflare.mjs` | local file store; D1 + Vectorize over REST |
| `src/search.mjs`, `src/tool.mjs` | hybrid search; tool definitions and MCP handler (no Node built-ins, so the Worker bundles them) |
| `src/server.mjs`, `src/cli.mjs` | HTTP/MCP server; command line |
| `cloudflare/worker.js`, `cloudflare/wrangler.jsonc` | the search Worker |

## Measured (2026-11-05, on a laptop CPU, against live wlu.ca)

**Index.** 183 pages, 2,390 chunks averaging 698 characters, 12.4 MB SQLite file (3.7 MB of it vectors).

**First build: 268 s** (191 pages at one request a second, 2,649 chunks embedded locally, no errors). The first discovery also picked up 6 pension-fund investment statements and 2 site-menu pages from the register page. Discovery was then fixed, and the next run removed them.

**Weekly update, tested on live pages.** The index was edited to look like an older copy: one 12.2 section reworded, one extra 12.2 section, one 10.1 section missing, and one repealed policy. A normal sync then took 206 s:

```
183 pages checked: 0 added, 2 changed, 9 removed, 181 unchanged, 0 errors
2 chunks embedded, 2 rows written, 261 chunks deleted
  changed Policy 12.2 Student Code of Conduct: Academic Misconduct: 1 edited, 1 removed
    ~ 4.04 Penalties for Academic Misconduct (4.04.01)
    - 9.00 Transitional Provisions (9.01)
  changed 10.1 Privacy Protection and Information Access Policy: 1 new
    + 4.00 Policy > 4.01 General (non-personal) Information > 4.01.01 Custody and Authority
  removed 99.9 Repealed Test Policy, 6 investment statements, 2 site-menu pages
```

wlu.ca's nightly republish caused no re-embedding, and FTS5's integrity check passed afterwards. A later change to the link format rewrote 359 rows on 105 pages, again with no re-embedding: only a chunk's own text decides whether it is embedded again.

**Retrieval.** These are the 17 questions in `data/web_eval.json` whose expected pages are in the index (E4, L1–L10, P1–P6; the S questions need site search). Results are in `results/policy_index_eval.json`.

| Mode | Expected page in top 3 | Ranked first | MRR | Median time per search |
|---|---|---|---|---|
| Keyword only (FTS5) | 17/17 | 15/17 | 0.94 | 5 ms |
| **Hybrid (keyword + vectors)** | **17/17** | **17/17** | **1.00** | 25 ms |
| Hybrid + bge-reranker-base (local, 8-bit) | 17/17 | 14/17 | 0.91 | 4.6 s |

Every question searched all 183 pages, not a pre-picked handful. The reranker didn't help here, so it is off by default (`RERANK=on` in the Worker or `--rerank` locally turns it on). The Workers AI copy of the model isn't quantized and wasn't measured.

**Sections, not pages.** Some examples:
- *What is the penalty for a first plagiarism offence?* → 12.2's appendix grid *A. Misappropriation of Another's Work* (with its first-offence column intact), 12.2 *A First Offence*, and *Procedures for Student Code of Conduct > 5.0 First Offence of Academic Misconduct: Application of Penalty*.
- *How long does the university keep my personal health information?* → *10.1 > 4.03.05 Retention and Disposal of Personal Health Information*.

Three deep links were opened in a browser by clicking them:
- a heading;
- a one-word heading, which links to its body;
- the second part of a split section.

Each scrolled the cited clause into the middle of the window. wlu.ca writes `4.03.05&nbsp;Retention`, and the plain-space fragment still matched.

**Agent use.** The official MCP SDK client connected over Streamable HTTP (69 ms) and over stdio (232 ms), listed the three tools and called each one against the built index (`test/live-agent.mjs`).

**Embedding compatibility.** Local `bge-small-en-v1.5` (mean pooling, fp32) reproduces the Workers AI vectors in `worker/src/vectors.json` to cosine 0.9999 once Workers AI's batching is replicated (next section). So the index can be built locally and searched with Workers AI query embeddings.

**Tests.** 21 unit tests (`npm test`, no network):
- chunking, discovery, and every sync case: edit, add, remove, a failed fetch, the mass-deletion guard, dry runs, `--changed-only`, fingerprint changes;
- the Cloudflare store against a fake REST API that runs its SQL on real SQLite;
- the Worker on stand-in D1, Vectorize and Workers AI bindings;
- the MCP SDK client.

`wrangler deploy --dry-run` bundles the Worker (21 KiB) with all three bindings.

**Not tested:** a real Cloudflare deployment (no resources were created on the account), D1 rows read per search, the Docker image (Docker isn't installed here) and the GitHub Actions run.

## Found along the way: Workers AI batches skew short embeddings

Workers AI's `bge-small-en-v1.5` pads a batch to its longest text and includes the padding in the mean. A text embedded in a batch of 8 doesn't get the vector it would get alone. `scripts/embed_chunks.py` sends batches of 8, so the short PC141 chunks in `worker/src/vectors.json` sit at cosine 0.92–0.97 from their true vectors, while long chunks match exactly. Query embeddings (one text per call) are unaffected, so the mismatch slightly weakens Full mode's vector search for short sections. The fix is to embed one chunk per call, or locally with `src/embed.mjs`. This project's Workers AI embedder sends one text per call for this reason.
