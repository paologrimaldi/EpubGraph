# Embedding & Recommendation Engine Upgrade -- Technical Notes

**Date:** 2026-04-07
**Scope:** Full implementation of priority 1 and 2 improvements from `embedding-improvements.md`

---

## Overview

This session upgraded the entire embedding and recommendation pipeline of EpubGraph. The changes span the embedding model, the input enrichment strategy, the embedding generation workflow, and a correctness fix in the recommendation diversity algorithm. The goal was to produce substantially better book-to-book similarity by improving both the quality of the embedding model and the richness of what gets embedded.

---

## 1. Embedding Model Upgrade

### Decision: qwen3-embedding:8b with MRL truncation to 2048 dimensions

The previous model was `nomic-embed-text` (137M parameters, 768 dimensions, MTEB ~62). The upgrade target was `qwen3-embedding:8b` (8B parameters, 7168 native dimensions, MTEB ~70.6), the maximum quality tier available through Ollama.

The 7168 native dimensions are excessive for a personal library recommendation system. Qwen3-Embedding supports Matryoshka Representation Learning (MRL), meaning the first N dimensions of any embedding form a valid, self-contained embedding at that dimensionality. We truncate to 2048 dimensions, which provides a strong quality-to-size tradeoff: roughly 3x the semantic capacity of the old 768-dim vectors while keeping memory usage reasonable (~8KB per book vs ~3KB previously).

### MRL truncation and normalization

After receiving the full 7168-dimensional vector from Ollama, the pipeline truncates it to the first 2048 dimensions and applies L2 normalization. This normalization step is critical because truncation changes the vector magnitude, and cosine similarity (used throughout the graph construction) is sensitive to unnormalized vectors. The truncation and normalization happen inside the Ollama client's `embed()` method, so all downstream code transparently receives 2048-dim normalized vectors.

### Storage impact

Each embedding grows from 3,072 bytes (768 x 4 bytes) to 8,192 bytes (2048 x 4 bytes). For 70K books, total embedding storage increases from ~205 MB to ~547 MB. At personal library scale this is negligible.

---

## 2. Embedding Input Enrichment

### Decision: Summary-then-Embed (one LLM chat call per book)

The document analyzed three approaches for enriching embedding input: raw metadata concatenation, hierarchical embedding aggregation, and summary-then-embed. We implemented the third option as the recommended approach.

The core insight is that an LLM can distill all available information about a book (title, author, description, subjects, chapter structure) into a semantically dense ~200-word summary optimized for similarity matching. This summary captures genre, themes, tone, narrative style, target audience, and comparable works -- exactly the signals that drive good recommendations. Embedding this summary produces a much richer vector than embedding raw metadata fields.

### Pipeline architecture

The new embedding pipeline for each book is:

1. **Check for cached summary** in the `book_summaries` table. If found, skip to step 4.
2. **Build context** from all available metadata: title, author, series, dc:subject tags, description (safely truncated to 3000 chars at a UTF-8 boundary), and chapter titles (up to 30).
3. **Generate summary** via a single Ollama chat call using the configured chat model (default: `mistral:7b`). The prompt requests a 200-word summary focusing on themes, genre, setting, writing style, target audience, and comparable works.
4. **Cache the summary** in `book_summaries` with a text hash for change detection.
5. **Embed the summary** using `qwen3-embedding:8b` through the standard embedding pipeline (which applies MRL truncation and normalization).
6. **Store the embedding** and update graph edges.

If the chat model is unavailable (Ollama not running, model not loaded), the pipeline falls back to embedding enriched metadata directly. This fallback uses the new `book_to_embedding_text` function which now includes subjects and chapter titles alongside the original title/author/series/description fields.

### Metadata extraction improvements

Two new metadata sources are extracted from EPUB files during parsing:

**dc:subject tags** -- The EPUB OPF manifest can contain multiple `<dc:subject>` elements representing genre, topic, and Library of Congress subject headings. These are now extracted by iterating the epub crate's `metadata` vector, filtering for entries with `property == "subject"`. Tags are stored in the existing `tags` and `book_tags` junction tables and included in both the summary context and the fallback embedding text.

**Chapter titles** -- The EPUB Table of Contents (NCX/nav document) is accessed via the epub crate's `toc: Vec<NavPoint>` field. A recursive function flattens the navigation tree (which can have nested sections) into a list of chapter title strings. These are stored as a JSON array in a new `chapter_titles_json` column on the books table and included in the embedding input.

### Database schema changes (migration v3)

- `book_summaries` table: stores LLM-generated summaries keyed by `book_id`, with the chat model name, a text hash for invalidation, and a timestamp.
- `chapter_titles_json` column on `books`: stores chapter titles as a JSON string array.
- Default `ollama_model` setting updated to `qwen3-embedding:8b`.

---

## 3. MMR Similarity Function Fix

### The bug

The Maximal Marginal Relevance (MMR) algorithm is supposed to balance relevance with diversity. It works by penalizing candidates that are semantically similar to already-selected recommendations. The key formula is:

    MMR(item) = lambda * relevance(item) - (1 - lambda) * max_similarity(item, selected)

The `max_similarity` term should measure semantic similarity between the candidate and each already-selected item. The previous implementation used `1.0 - (score_a - score_b).abs()` -- this measures how close two candidates' *scores* are, not how semantically similar their *content* is. Two completely unrelated books with similar scores would be incorrectly penalized as redundant, while two near-identical books with slightly different scores would not.

### The fix

The MMR similarity function now uses the actual content edge weights from the book graph. Before running MMR, the code builds a lookup map of pairwise cosine similarities by scanning the content-type edges in the graph for all candidate books. The MMR similarity function queries this map, returning 0.0 for pairs with no content edge (correctly treating them as dissimilar).

This is an approximation -- it uses pre-computed graph edges rather than computing cosine similarity on-the-fly -- but it's efficient and correct for the candidate set, since any candidates close enough to matter will have content edges in the graph.

---

## 4. Pause/Resume Safety

### Problem

With 70K+ books to re-embed using a pipeline that includes an LLM chat call per book (~2-5 seconds each), the full regeneration takes many hours. The process must be safely pausable (user closes the app, goes to sleep, etc.) and resumable without losing progress or creating duplicates.

### Design

All three embedding processing paths (BackgroundWorker job handler, `process_pending_embeddings` batch function, and the `process_embeddings_batch` Tauri command) now check the pause flag between each book. The key invariant is:

- A book's status transitions atomically: `pending` -> `complete` (or `failed`).
- The status is only updated to `complete` *after* the embedding is fully stored.
- A pause simply stops picking up new books from the pending queue.
- On resume, the pending query picks up where it left off.
- Summaries are cached independently of embeddings, so a book that got a summary before a pause won't regenerate it.
- The `has_embedding` check at the top of each processing function prevents duplicate work.

The `process_embeddings_batch` command also checks the pause flag before starting, returning immediately with the remaining count so the frontend can display accurate status.

---

## 5. Code Architecture Decisions

### Shared summary generation

The summary generation logic (build context, format prompt, call chat, cache result) was initially implemented in three separate locations due to different access patterns (struct method vs standalone function vs Tauri command handler). During code review, this was consolidated into a single public function `get_or_generate_summary()` in the `ollama` module. The function takes `&Database`, endpoint, chat model, book data, tags, and chapter titles as parameters, making it callable from any context.

Supporting shared utilities were also extracted:
- `build_summary_context()` -- formats book metadata into the LLM prompt context string
- `text_hash()` -- computes a SipHash for change detection (renamed from the misleading `md5_hash`)
- `truncate_str()` -- safely truncates a string at a UTF-8 character boundary

### Edge computation consistency

The batch embedding command was using `compute_edge_weight()` (returns only the single highest-weighted edge type per pair), while the background worker used `compute_all_edge_weights()` (returns all qualifying edge types). This meant the same pair of books could have different graph representations depending on which code path processed them. All paths now use `compute_all_edge_weights()` for consistent multi-edge graphs.

### Settings read optimization

The chat model name and Ollama endpoint are read from the database settings. Previously, each summary generation call read settings independently, resulting in up to 70K redundant reads during a full regeneration. These reads are now hoisted to before the batch loop, reading once and passing the values as parameters.

---

## 6. Cleared State

All 70,324 existing embeddings and 381,630 graph edges were cleared from the database. All 70,345 books were reset to `pending` embedding status. The database was vacuumed to reclaim disk space. Regeneration will happen automatically when the app is launched with Ollama running.

---

## 7. Files Changed

| File | Changes |
|------|---------|
| `ollama/mod.rs` | MRL truncation, shared summary functions, `text_hash`, `truncate_str`, enriched `book_to_embedding_text` |
| `vector/mod.rs` | `EMBEDDING_DIM` 768 -> 2048, dynamic dimension in `compute_average_embedding` |
| `worker/mod.rs` | LLM summary pipeline, delegated to shared functions, pause-aware processing |
| `commands/ollama.rs` | Pause checking, shared summary function, `compute_all_edge_weights`, hoisted settings |
| `commands/settings.rs` | Dynamic embedding size calculation |
| `commands/library.rs` | Store tags and chapters during metadata parsing, removed description-required gate |
| `epub/mod.rs` | Extract dc:subject tags, extract chapter titles from TOC |
| `graph/mod.rs` | Fixed MMR similarity to use content edge weights instead of score difference |
| `db/migrations.rs` | Migration v3: `book_summaries` table, `chapter_titles_json` column |
| `db/queries.rs` | Tag storage/retrieval, chapter title storage/retrieval, summary caching, `NewBook` extended |
| `db/mod.rs` | Default model updated |
| `state.rs` | Default model updated |
| `scanner/mod.rs` | NewBook field defaults |
| `calibre/mod.rs` | NewBook field defaults |
| `commands/export.rs` | NewBook field defaults |
