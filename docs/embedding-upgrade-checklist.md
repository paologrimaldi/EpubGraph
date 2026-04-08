# Embedding & Recommendation Engine Upgrade Checklist

Based on [embedding-improvements.md](./embedding-improvements.md)

## Phase 1: Model Upgrade & Infrastructure

- [x] 1.1 Download `qwen3-embedding:8b` model via Ollama *(downloading in background)*
- [x] 1.2 Update `EMBEDDING_DIM` constant (768 → 2048, MRL-truncated from 7168)
- [x] 1.3 Update default model name in settings and state initialization
- [x] 1.4 Add MRL truncation + L2 normalization in embedding pipeline
- [x] 1.5 Update `store_embedding` to accept variable-dimension embeddings
- [x] 1.6 Update `compute_average_embedding` to use dynamic dimension
- [x] 1.7 Update `get_database_stats` hardcoded embedding size calculation
- [x] 1.8 Clear existing embeddings and reset book statuses (70,324 cleared)

## Phase 2: Embedding Input Enrichment

- [x] 2.1 Extract `<dc:subject>` tags from EPUB OPF metadata
- [x] 2.2 Add DB methods to store/retrieve book tags
- [x] 2.3 Extract chapter titles from EPUB TOC/nav document
- [x] 2.4 Add `book_summaries` table + `chapter_titles_json` column (migration v3)
- [x] 2.5 Implement LLM summary generation (one chat call per book)
- [x] 2.6 Update worker pipeline: generate summary → embed summary (with metadata fallback)
- [x] 2.7 Update `book_to_embedding_text` to include subjects and chapter titles
- [x] 2.8 Store tags and chapter titles during metadata parsing batch
- [x] 2.9 Increase description truncation limit (1000 → 4000 chars for 40K context model)

## Phase 3: Fix MMR Similarity Function (Bug)

- [x] 3.1 Replace score-difference MMR with cosine similarity via content edge weights

## Phase 4: Build & Test

- [x] 4.1 Verify project compiles with `cargo check` — clean
- [x] 4.2 Run existing tests with `cargo test` — 14/14 passed
