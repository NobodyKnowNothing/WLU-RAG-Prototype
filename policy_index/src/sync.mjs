// The weekly update: discover pages, re-read them, and bring the store in line.
//
// Change detection works on the parsed text, not on HTTP headers or the sitemap: wlu.ca republishes
// every page nightly (new Last-Modified and ETag each day) and sitemap dates are not always moved
// when a policy is edited. For each page:
//   - same text as last time            -> nothing written, only checked_at moves
//   - a section's text changed           -> that chunk is re-embedded and rewritten
//   - a section is new / gone            -> its chunk is embedded / deleted (vector and row)
//   - the page left the sitemap/register -> all its chunks are deleted
// A fingerprint of the embedding model and chunker is part of every chunk hash, so changing
// either re-embeds everything on the next run.
import { CHUNKER_VERSION, chunkPage, sha } from "./chunk.mjs";
import { EMBEDDING_FINGERPRINT } from "./embed.mjs";
import { CHUNK_COLUMNS } from "./schema.mjs";
import { discover, pageRecord } from "./sources.mjs";

export const FINGERPRINT = `${EMBEDDING_FINGERPRINT}/chunker-v${CHUNKER_VERSION}`;
const STABLE_PAGE_FIELDS = ["page_id", "url", "title", "publisher", "authority", "kind", "number", "approved", "revised", "office", "origin"];
const HASHED_CHUNK_FIELDS = CHUNK_COLUMNS.filter((c) => !["row_hash", "updated_at"].includes(c));

// Chunk rows for a page with their two hashes: `hash` (what gets embedded, so a change means
// re-embedding) and `row_hash` (every stored field, so a change means rewriting the row).
export function prepareRows(chunks, title, fingerprint = FINGERPRINT) {
  return chunks.map((c) => {
    const row = { ...c, title, hash: sha(`${fingerprint}\n${c.enriched}`) };
    row.row_hash = sha(JSON.stringify(HASHED_CHUNK_FIELDS.map((k) => row[k] ?? null)));
    return row;
  });
}

const label = (r) => (r.clauses && !r.section.endsWith(r.clauses) ? `${r.section} (${r.clauses})` : r.section);

export async function sync({
  store,
  get,
  embedder,
  curated,
  only,
  limit,
  changedOnly = false,
  dryRun = false,
  force = false,
  maxRemovalShare = 0.2,
  log = () => {},
  now = () => new Date().toISOString(),
}) {
  const t0 = Date.now();
  const report = { started: now(), fingerprint: FINGERPRINT, store: store.kind, embedder: embedder?.name, dryRun, discovered: 0, added: [], changed: [], removed: [], unchanged: 0, skipped: 0, errors: [], embedded: 0, rowsWritten: 0, chunksDeleted: 0 };
  const previousFingerprint = await store.getMeta("fingerprint");
  const rebuild = previousFingerprint !== null && previousFingerprint !== FINGERPRINT;
  if (rebuild) log(`fingerprint changed (${previousFingerprint} -> ${FINGERPRINT}): every chunk will be re-embedded`);

  let targets = await discover(get, { curated });
  if (only) targets = targets.filter((t) => t.url.includes(only) || t.pageId.includes(only));
  if (limit) targets = targets.slice(0, limit);
  report.discovered = targets.length;
  const existing = new Map((await store.listPages()).map((p) => [p.page_id, p]));

  for (const [n, t] of targets.entries()) {
    const old = existing.get(t.pageId);
    const tag = `[${n + 1}/${targets.length}] ${t.pageId}`;
    if (changedOnly && old?.content_hash && t.lastmod && old.lastmod === t.lastmod && !rebuild) {
      report.skipped++;
      continue;
    }
    let res;
    try {
      res = await get(t.url);
    } catch (e) {
      res = { status: 0, error: String(e.message || e) };
    }
    const failure = res.error || (res.status !== 200 ? `HTTP ${res.status}` : /\/404\//.test(res.url || "") ? "redirected to a 404 page" : null);
    if (failure) {
      // Keep what we have: a page that fails once is more likely a hiccup than a deletion.
      report.errors.push({ page_id: t.pageId, url: t.url, error: failure });
      if (old && !dryRun) await store.touchPage(t.pageId, now(), t.lastmod, failure);
      log(`${tag} error: ${failure}`);
      continue;
    }
    const { title, chunks } = chunkPage(res.text, { pageId: t.pageId, url: t.url, title: t.title });
    if (!chunks.length) {
      report.errors.push({ page_id: t.pageId, url: t.url, error: "no readable content" });
      log(`${tag} error: no readable content`);
      continue;
    }
    const page = pageRecord(t, res.text, title);
    const rows = prepareRows(chunks, title);
    const contentHash = sha(JSON.stringify([STABLE_PAGE_FIELDS.map((k) => page[k] ?? null), rows.map((r) => r.row_hash)]));
    if (old?.content_hash === contentHash) {
      report.unchanged++;
      if (!dryRun) await store.touchPage(t.pageId, now(), t.lastmod, null);
      continue;
    }

    const state = old ? await store.chunkState(t.pageId) : new Map();
    const ids = new Set(rows.map((r) => r.id));
    const deleted = [...state.values()].filter((s) => !ids.has(s.id));
    const toEmbed = rows.filter((r) => state.get(r.id)?.hash !== r.hash);
    const toWrite = rows.filter((r) => state.get(r.id)?.row_hash !== r.row_hash);
    const vectors = new Map();
    if (toEmbed.length && !dryRun) {
      const vs = await embedder.embed(toEmbed.map((r) => r.enriched));
      toEmbed.forEach((r, i) => vectors.set(r.id, vs[i]));
    }
    const ts = now();
    for (const r of toWrite) r.updated_at = ts;
    const pageRow = { ...page, content_hash: contentHash, chunk_count: rows.length, fetched_at: ts, changed_at: ts, checked_at: ts, error: null };
    if (!dryRun) await store.applyPage(pageRow, toWrite, vectors, deleted.map((s) => s.id));

    report.embedded += toEmbed.length;
    report.rowsWritten += toWrite.length;
    report.chunksDeleted += deleted.length;
    const entry = { page_id: t.pageId, title, url: t.url, chunks: rows.length };
    if (old) {
      entry.sections = {
        added: toEmbed.filter((r) => !state.has(r.id)).map(label),
        changed: toEmbed.filter((r) => state.has(r.id)).map(label),
        removed: deleted.map(label),
        relabelled: toWrite.filter((r) => state.has(r.id) && !toEmbed.includes(r)).length,
      };
      report.changed.push(entry);
    } else {
      report.added.push(entry);
    }
    log(`${tag} ${old ? "changed" : "added"}: ${rows.length} chunks, ${toEmbed.length} embedded, ${deleted.length} deleted`);
  }

  // Pages that are no longer listed anywhere. A partial run (--only/--limit) can't tell, and a
  // sitemap that suddenly lost many pages is more likely broken than a mass repeal.
  if (!only && !limit) {
    const seen = new Set(targets.map((t) => t.pageId));
    const gone = [...existing.values()].filter((p) => !seen.has(p.page_id));
    if (gone.length && gone.length > existing.size * maxRemovalShare && !force) {
      report.errors.push({ error: `refusing to delete ${gone.length} of ${existing.size} pages that are no longer listed (more than ${maxRemovalShare * 100}%); re-run with --force if that is right` });
    } else {
      for (const p of gone) {
        const removedIds = dryRun ? [] : await store.deletePage(p.page_id);
        report.chunksDeleted += removedIds.length;
        report.removed.push({ page_id: p.page_id, title: p.title, url: p.url, chunks: p.chunk_count });
        log(`removed ${p.page_id} (${p.chunk_count} chunks)`);
      }
    }
  }

  if (!dryRun) {
    await store.setMeta("fingerprint", FINGERPRINT);
    await store.setMeta("last_sync", report.started);
  }
  report.finished = now();
  report.seconds = Math.round((Date.now() - t0) / 100) / 10;
  return report;
}

export function summarize(r) {
  const lines = [
    `${r.dryRun ? "[dry run] " : ""}${r.discovered} pages checked in ${r.seconds}s: ${r.added.length} added, ${r.changed.length} changed, ${r.removed.length} removed, ${r.unchanged} unchanged${r.skipped ? `, ${r.skipped} skipped (sitemap date unchanged)` : ""}, ${r.errors.length} errors`,
    `${r.embedded} chunks embedded, ${r.rowsWritten} rows written, ${r.chunksDeleted} chunks deleted`,
  ];
  for (const c of r.changed) {
    const s = c.sections;
    lines.push(`  changed ${c.title}: ${[s.changed.length && `${s.changed.length} edited`, s.added.length && `${s.added.length} new`, s.removed.length && `${s.removed.length} removed`, s.relabelled && `${s.relabelled} relabelled or relinked (not re-embedded)`].filter(Boolean).join(", ")}`);
    for (const x of s.changed) lines.push(`    ~ ${x}`);
    for (const x of s.added) lines.push(`    + ${x}`);
    for (const x of s.removed) lines.push(`    - ${x}`);
  }
  for (const a of r.removed) lines.push(`  removed ${a.title} (${a.url})`);
  for (const e of r.errors) lines.push(`  error ${e.page_id || ""} ${e.error}`);
  return lines.join("\n");
}
