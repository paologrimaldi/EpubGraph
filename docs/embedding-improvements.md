# EpubGraph: Embedding & Recommendation Engine -- Technical Improvement Analysis

**Date:** 2026-04-07
**Scope:** Embedding generation, graph construction, recommendation pipeline
**Current stack:** Ollama + nomic-embed-text (768d), SQLite, petgraph, Tauri/Rust

---

## Table of Contents

1. [Current Architecture Summary](#1-current-architecture-summary)
2. [Embedding Model Upgrade](#2-embedding-model-upgrade)
3. [Embedding Input Enrichment](#3-embedding-input-enrichment)
4. [Long-Document Embedding Strategies](#4-long-document-embedding-strategies)
5. [Matryoshka Representation Learning (MRL)](#5-matryoshka-representation-learning-mrl)
6. [Graph Construction Improvements](#6-graph-construction-improvements)
7. [Recommendation Pipeline Improvements](#7-recommendation-pipeline-improvements)
8. [Similarity & Ranking Improvements](#8-similarity--ranking-improvements)
9. [Infrastructure: Eliminating Ollama](#9-infrastructure-eliminating-ollama)
10. [Prioritized Roadmap](#10-prioritized-roadmap)

---

## 1. Current Architecture Summary

### Pipeline

```
EPUB file
  -> fast_scan (filename, cover)
  -> parse_metadata (title, author, description, series, ISBN, ...)
  -> book_to_embedding_text() -> "Title: X\nAuthor: Y\nDescription: Z (truncated to 1000 chars)"
  -> Ollama /api/embeddings (nomic-embed-text, 768 dims)
  -> SQLite (binary blob, little-endian f32) + DashMap in-memory cache
  -> compute_all_edge_weights() -> petgraph DiGraph
      - content edges (cosine > 0.3)
      - author edges (0.85 constant)
      - series edges (0.70-0.95)
  -> Recommendation: multi-hop BFS + Personalized PageRank + MMR diversity
```

### What Works Well

- **Multi-hop traversal + PPR + MMR** is a solid hybrid recommendation architecture
- **In-memory DashMap cache** is appropriate for personal library scale (100-10k books)
- **Edge type separation** (content/author/series) provides explainability
- **Rating integration** into seed selection and PPR teleport distribution is well-designed
- **Brute-force cosine similarity** is correct at this scale (ANN indices add overhead without benefit under ~50k vectors)

### Key Weaknesses

| Area | Issue | Impact |
|---|---|---|
| Embedding input | Only metadata (title+author+1000 chars description) | Many books have sparse/missing descriptions; no actual content is used |
| Embedding model | nomic-embed-text is 137M params, MTEB ~62 | Lowest tier of viable embedding models |
| Embedding dims | 768 fixed | No MRL flexibility for fast filtering vs. accurate scoring |
| MMR diversity | Uses `1.0 - (score_a - score_b).abs()` as similarity | Measures score proximity, not semantic similarity -- defeats the purpose of MMR |
| Graph edges | No genre/tag/subject edges | Misses a major signal for book similarity |
| Content usage | Zero book content is embedded | Significant information loss, especially for books with poor metadata |

---

## 2. Embedding Model Upgrade

### Current: nomic-embed-text

- **Parameters:** 137M
- **Dimensions:** 768
- **Context window:** 8,192 tokens
- **MTEB score:** ~62
- **Ollama size:** 274MB
- **License:** Apache 2.0

### Recommended Upgrade Tiers

#### Tier 1: Drop-in replacement (minimal code change)

**`qwen3-embedding:0.6b`**

| Property | Value |
|---|---|
| Parameters | 0.6B |
| Dimensions | 1024 (MRL: truncatable to any size down to 32) |
| Context window | 32,768 tokens |
| MTEB score | ~65+ |
| Ollama size | 639MB |
| License | Apache 2.0 |

**Required code changes:**
- `EMBEDDING_DIM` constant: 768 -> 1024
- Model name in Ollama config
- Embedding storage size: 3072 bytes -> 4096 bytes per book
- Re-generate all embeddings (one-time migration)

The 32K context window (4x current) enables embedding substantially more content per book. The MRL support enables the optimization described in Section 5.

#### Tier 2: Quality-focused

**`qwen3-embedding:4b`**

| Property | Value |
|---|---|
| Parameters | 4B |
| Dimensions | 2048 (MRL-capable) |
| Context window | 40,960 tokens |
| MTEB score | ~68+ |
| Ollama size | 2.5GB |

Higher resource usage but significant quality improvement. The 40K context window can fit substantial book excerpts. 2048 dimensions provide richer semantic representation.

#### Tier 3: Maximum quality

**`qwen3-embedding:8b`**

| Property | Value |
|---|---|
| Parameters | 8B |
| Dimensions | 7168 (MRL: truncatable) |
| Context window | 40,960 tokens |
| MTEB score | 70.58 (multilingual) |
| Ollama size | 4.7GB |

Top-tier open-source embedding model. The 7168 native dimensions are overkill for book recommendation at personal library scale -- truncate to 1024 or 2048 via MRL.

#### Alternative: Multilingual + Hybrid Retrieval

**`bge-m3`** (BAAI)

| Property | Value |
|---|---|
| Parameters | 568M |
| Dimensions | 1024 |
| Context window | 8,192 |
| License | MIT |
| Special | Supports dense + sparse + ColBERT representations natively |

Valuable if the library contains books in multiple languages. The hybrid dense+sparse retrieval can capture both semantic meaning and keyword matches. However, Ollama only exposes the dense vector -- sparse/ColBERT would require custom integration.

### Model Comparison (MTEB Retrieval Benchmarks)

```
all-MiniLM-L6-v2  ===                                56.3
nomic-embed-text   ========                           ~62.0  (current)
Snowflake Arctic   =========                          ~64.0
Qwen3-0.6B        ===========                         ~65.0  (recommended)
E5-Mistral-7B     =============                        ~66.0
Qwen3-4B          ===============                      ~68.0
NV-Embed-v2       ================                     ~69.3
Qwen3-8B          =================                    ~70.6
```

---

## 3. Embedding Input Enrichment

This is the **highest-impact improvement** area. The quality of embeddings is bounded by the quality of input text.

### Current Input

```rust
fn book_to_embedding_text(book: &Book) -> String {
    // Title + Author + Series + Description (truncated to 1000 chars)
}
```

**Problems:**
- Many EPUBs have no or minimal description metadata
- 1000 character truncation may cut off important content
- No actual book content is used
- No genre/subject/tag information

### Improvement 3A: LLM-Generated Book Summaries

**Concept:** Use the existing `OllamaClient::chat()` to generate a semantically rich summary before embedding.

**Pipeline change:**

```
EPUB metadata + first chapter text
  -> OllamaClient::chat("Summarize this book in 200 words focusing on
     themes, genre, setting, writing style, and comparable works: ...")
  -> Embed the summary instead of raw metadata
```

**Why this works:** The LLM distills all available information into a semantically dense representation optimized for similarity matching. It captures genre, tone, themes, and comparable works -- exactly the signals needed for recommendations.

**Implementation details:**
- Prompt should request: themes, genre, setting, narrative style, target audience, comparable works
- Cache the summary in a new `book_summaries` table alongside the raw metadata
- Fall back to metadata-only embedding if chat model is unavailable
- Summary generation is a one-time cost per book (idempotent via `text_hash`)

**Cost:** One LLM chat call per book (~2-5 seconds on local hardware). For a 1000-book library, this is ~1-2 hours of one-time processing but can run in background.

### Improvement 3B: Extract Actual Book Content

**Concept:** Extract text from EPUB content documents, not just metadata.

The EPUB parser (`epub/mod.rs`) already reads the OPF manifest. Extend it to:

1. **Extract table of contents** (NCX/nav document) -- chapter titles are high-signal
2. **Extract first chapter** (first content document in spine) -- opening text establishes genre, tone, setting
3. **Extract all chapter titles** from heading elements

**Embedding text construction:**

```
Title: {title}
Author: {author}
Series: {series}
Chapters: {chapter_1_title}, {chapter_2_title}, ...
Description: {description}
Opening: {first 2000 tokens of chapter 1}
```

With a 32K context model (Qwen3-0.6B), this easily fits. With the current 8K context (nomic), approximately 6K tokens of content can be included alongside metadata.

### Improvement 3C: Subject/Genre Tags

EPUB metadata often includes `<dc:subject>` elements containing genre tags and Library of Congress subject headings. These are currently not extracted.

**Implementation:**
1. Parse `<dc:subject>` elements from OPF (multiple allowed)
2. Store in a `book_tags` junction table
3. Include in embedding text: `Subjects: Science Fiction, Space Opera, First Contact`
4. Create tag-based graph edges (books sharing tags get similarity boost)

---

## 4. Long-Document Embedding Strategies

If actual book content is embedded (Section 3B), strategies for handling long documents become relevant.

### 4.1 Late Chunking (Jina, 2024 -- ICLR 2025)

**How it works:**
1. Feed the entire document (up to model context window) through the transformer encoder
2. Obtain contextual token embeddings for all tokens
3. After encoding, split into logical chunks and mean-pool each chunk's tokens

**Key advantage:** Each chunk's embedding incorporates context from the entire document. Standard chunking embeds each chunk independently, losing cross-chunk context.

**Applicability to EpubGraph:** If feeding substantial book content through a 32K-context model, late chunking produces chapter-level embeddings that "know" about the rest of the book. However, this requires access to the model's internal token representations -- not available through the Ollama `/api/embeddings` endpoint. Would require native model integration (Section 9).

### 4.2 Hierarchical Embedding Aggregation

For book-to-book similarity, a single vector per book is needed. When content is chunked:

**Weighted mean pooling strategy:**

```
book_embedding = w_meta * embed(metadata_text)
              + w_desc * embed(description)
              + w_toc  * embed(chapter_titles)
              + w_open * embed(opening_content)

Suggested weights:
  w_meta = 0.20  (title, author, series)
  w_desc = 0.35  (description/abstract)
  w_toc  = 0.15  (chapter structure)
  w_open = 0.30  (opening content - establishes genre/tone)
```

**Implementation:** Generate separate embeddings for each component, compute weighted average, L2-normalize the result. Store the composite embedding as the book's canonical vector.

This is superior to embedding one concatenated text because it controls the relative importance of each signal.

### 4.3 Summary-then-Embed (Recommended for EpubGraph)

The most practical approach for this project:

1. Extract all available text (metadata + content excerpts)
2. Use chat model to generate a focused 200-300 word summary
3. Embed the summary

This avoids the complexity of chunking, aggregation, and late chunking while capturing the semantic essence of the full book. The LLM acts as an intelligent compression layer.

---

## 5. Matryoshka Representation Learning (MRL)

### What It Is

MRL trains embeddings such that the first N dimensions form a valid embedding at any dimensionality. A 1024-dim MRL embedding truncated to 256 dims retains most of its semantic quality.

### How to Use in EpubGraph

**Two-phase similarity search:**

```
Phase 1 (fast filter):
  - Keep 256-dim truncated embeddings in DashMap (1KB per book)
  - Compute cosine similarity against all books
  - Select top-100 candidates

Phase 2 (accurate scoring):
  - Load full 1024-dim embeddings from SQLite for top-100
  - Re-compute cosine similarity at full precision
  - Select top-k for recommendation
```

**Memory savings:**

| Dims | Bytes/book | 1000 books | 10000 books |
|---|---|---|---|
| 768 (current) | 3,072 | 3.0 MB | 30 MB |
| 256 (MRL filter) | 1,024 | 1.0 MB | 10 MB |
| 1024 (full Qwen3) | 4,096 | 4.0 MB | 40 MB |
| 2048 (Qwen3-4B) | 8,192 | 8.0 MB | 80 MB |

At personal library scale, memory is not a bottleneck, but MRL enables using higher-dimensional models without proportional memory cost.

### Models Supporting MRL

- Qwen3-Embedding (all sizes) -- native support
- nomic-embed-text v1.5 -- your current model already supports this
- Jina v3/v4
- OpenAI text-embedding-3-large

**Note:** `nomic-embed-text` v1.5 already supports MRL. You could implement the two-phase search today without switching models, using 256-dim truncated vectors for filtering and full 768-dim for scoring.

---

## 6. Graph Construction Improvements

### 6.1 Add Genre/Subject/Tag Edges

**Current edge types:** content (embedding cosine), author, series

**Proposed addition:** `tag` edge type

```rust
EdgeType::Tag {
    weight: shared_tag_jaccard_similarity,
    // Jaccard = |tags_A ∩ tags_B| / |tags_A ∪ tags_B|
    // Threshold: weight > 0.2
}
```

Books sharing EPUB `<dc:subject>` tags (or LLM-inferred genres) get additional edges. This is especially valuable for books with poor descriptions but good metadata.

### 6.2 Community Detection (Louvain Algorithm)

**Purpose:** Automatically cluster the book graph into genre/theme groups.

**Algorithm:** Louvain modularity optimization -- iteratively assigns nodes to communities that maximize modularity (internal edge density vs. expected density).

**Implementation in Rust:** The `louvain` or `community` crate, or implement directly on the petgraph structure. Louvain is O(n log n) and runs in milliseconds on graphs with <100k edges.

**Application to recommendations:**
- Community membership as a feature for graph visualization ("genre clusters")
- Intra-community recommendations get a small boost (same-cluster books likely share themes)
- Cross-community recommendations are flagged as "you might also like this different genre" for diversity

### 6.3 Edge Weight Refinement

**Current content edge:** Raw cosine similarity with 0.3 threshold.

**Proposed combined edge weight:**

```
final_weight = alpha * cosine_sim(emb_a, emb_b)
             + beta  * tag_jaccard(tags_a, tags_b)
             + gamma * metadata_similarity(a, b)

where:
  alpha = 0.6  (semantic similarity from embeddings)
  beta  = 0.2  (genre/subject overlap)
  gamma = 0.2  (metadata: same language, similar publish date, etc.)
```

This produces a richer, multi-signal edge weight that is more robust than pure embedding cosine.

---

## 7. Recommendation Pipeline Improvements

### 7.1 User Taste Profile Embedding

**Current approach:** Seeds are selected per-book (highly-rated books, up-next queue).

**Improvement:** Compute a single "taste profile" vector by averaging embeddings of all books the user has rated >= 4 stars, weighted by rating.

```
taste_vector = normalize(
    sum(rating_weight[r] * embedding[book] for book, r in rated_books)
)

where rating_weight = {5: 1.3, 4: 1.1, 3: 0.8, 2: 0.5, 1: 0.2}
```

Use this taste vector as an additional query in `find_similar()` to discover books that match the user's overall preference pattern, not just individual book similarity. This catches books that are "generally in the user's wheelhouse" even if they're not strongly similar to any single rated book.

### 7.2 Negative Signals from Ratings

**Current:** Abandoned books are excluded from recommendations. Low ratings are not used.

**Improvement:** Use 1-2 star ratings as negative signals:

- Compute a "dislike vector" from low-rated books
- Penalize candidates that are similar to the dislike vector
- `adjusted_score = base_score - penalty_weight * cosine_sim(candidate, dislike_vector)`
- Suggested `penalty_weight`: 0.3

This prevents recommending books similar to ones the user actively disliked.

### 7.3 Cross-Encoder Re-Ranking

**Two-stage pipeline:**

```
Stage 1 (bi-encoder, fast):
  Current pipeline -> top-50 candidates

Stage 2 (cross-encoder, accurate):
  For each candidate in top-50:
    score = cross_encoder(seed_text, candidate_text)
  Re-rank by cross-encoder score
  Return top-k
```

**Cross-encoders** process both texts jointly through a transformer, enabling richer token-level interaction than comparing independent embeddings. They are 10-100x slower but significantly more accurate for the final ranking.

**Practical implementation without a dedicated cross-encoder model:**
Use `OllamaClient::chat()` as a pseudo-cross-encoder:

```
Prompt: "On a scale of 1-10, how likely is a reader who enjoyed '{book_a.title}'
by {book_a.author} ({book_a.description}) to also enjoy '{book_b.title}' by
{book_b.author} ({book_b.description})? Consider themes, writing style, genre,
and target audience. Respond with only the number."
```

This is slow (~1-3 seconds per pair) but highly accurate. Apply only to the top-20 candidates to keep latency manageable (~30 seconds total for final recommendations).

### 7.4 Temporal Decay

**Concept:** Recent ratings should matter more than old ones.

```
temporal_weight = exp(-lambda * days_since_rated)
where lambda = 0.001 (half-life ~693 days / ~2 years)
```

Apply to seed selection weights. A book rated 5 stars two years ago contributes less to current recommendations than one rated 5 stars last week, reflecting evolving taste.

---

## 8. Similarity & Ranking Improvements

### 8.1 Fix MMR Diversity Function (Bug)

**Current implementation** in `graph/mod.rs`:

```rust
// Similarity function used in MMR
|a, b| 1.0 - (score_a - score_b).abs()
```

**Problem:** This measures how close two candidates' scores are, not how semantically similar they are. Two books with identical scores but completely different topics would be penalized as "redundant," while two nearly identical books with slightly different scores would not.

**Fix:**

```rust
|a_id, b_id| {
    match (vector_store.get_embedding(a_id), vector_store.get_embedding(b_id)) {
        (Some(emb_a), Some(emb_b)) => cosine_similarity(&emb_a, &emb_b),
        _ => 0.0
    }
}
```

This is a correctness fix, not an enhancement. The current MMR is not achieving its stated purpose of promoting diversity.

### 8.2 Hybrid Dense + Sparse Retrieval

If using BGE-M3 (which outputs both dense and sparse vectors):

```
hybrid_score = alpha * cosine_sim(dense_a, dense_b)
             + (1 - alpha) * sparse_score(sparse_a, sparse_b)

where alpha = 0.7 (semantic dominates, lexical supplements)
```

Dense captures semantic meaning ("books about coming-of-age in wartime"). Sparse captures keyword overlap ("World War II", "bildungsroman"). The combination is more robust than either alone.

**Limitation:** Ollama's `/api/embeddings` endpoint only returns dense vectors. Sparse/ColBERT from BGE-M3 requires direct model integration.

### 8.3 Determinantal Point Processes (DPP) for Diversity

**Alternative to MMR** for selecting a diverse subset:

DPP models the probability of selecting a subset S as proportional to det(L_S), where L is a kernel matrix combining quality and diversity. Items that are individually high-quality AND different from each other have higher joint probability.

**Advantages over MMR:**
- Considers all pairwise interactions simultaneously (MMR is greedy)
- Theoretically more principled diversity guarantee
- Better at avoiding "clumps" of similar recommendations

**Disadvantages:**
- O(k^3) per selection step (vs O(k^2) for MMR)
- More complex implementation

For a top-50 candidate set selecting top-10 recommendations, both are fast enough. DPP produces measurably better diversity in academic benchmarks.

---

## 9. Infrastructure: Eliminating Ollama

### Motivation

Ollama is an external process dependency that users must install and run separately. For a polished desktop app, embedding inference should be native.

### Option A: ONNX Runtime via `ort` crate

**Approach:** Export embedding model to ONNX format, bundle with app, run via `ort` Rust bindings.

```rust
// Pseudocode
use ort::{Environment, SessionBuilder, Value};

let session = SessionBuilder::new(&env)?
    .with_model_from_file("models/qwen3-embedding-0.6b.onnx")?;

let tokens = tokenizer.encode(text)?;
let outputs = session.run(vec![Value::from_array(tokens)])?;
let embedding: Vec<f32> = outputs[0].extract_tensor()?;
```

**Pros:**
- No external dependency
- Faster inference (no HTTP overhead)
- Can bundle tokenizer + model in app distribution
- ONNX exports available for nomic-embed-text, BGE-M3, and others

**Cons:**
- Larger app bundle (model files: 274MB-2.5GB)
- Must handle model download/caching
- No chat model for summaries/explanations (still need Ollama or similar for LLM features)
- GPU acceleration requires platform-specific ONNX Runtime builds

### Option B: `candle` (Hugging Face Rust ML framework)

**Approach:** Load transformer models natively in Rust.

**Pros:**
- Pure Rust, no C++ bindings
- Supports quantized models (GGUF)
- Metal (macOS GPU) and CUDA support
- Active development by Hugging Face

**Cons:**
- Fewer pre-built model integrations than ONNX
- More code to write for model loading/tokenization

### Option C: `llama-cpp-rs`

**Approach:** Bind to llama.cpp (the engine behind Ollama) as a Rust library.

**Pros:**
- Runs the same GGUF models as Ollama
- Supports both embeddings and chat
- Could replace both embedding and chat Ollama dependencies
- Well-optimized for consumer hardware

**Cons:**
- C/C++ dependency (build complexity)
- Must manage model files

### Recommendation

**Short-term:** Keep Ollama. The integration works and users who want recommendations likely already have Ollama installed. Focus engineering effort on embedding quality improvements (Sections 2-3).

**Medium-term:** Add `ort` (ONNX Runtime) as an optional embedding backend. Ship a small model (nomic-embed-text ONNX, 274MB) for users who don't want Ollama. Keep Ollama as the backend for chat features (summaries, explanations).

**Long-term:** Full `llama-cpp-rs` integration replacing Ollama entirely. Bundle quantized models. Zero external dependencies.

---

## 10. Prioritized Roadmap

### Priority 1: High Impact, Low Effort

| # | Change | Effort | Impact | Details |
|---|---|---|---|---|
| 1.1 | **Fix MMR similarity function** | ~1 hour | Correctness | Section 8.1 -- use cosine similarity between embeddings instead of score difference |
| 1.2 | **Switch to `qwen3-embedding:0.6b`** | ~2 hours | Significant | Change model name + EMBEDDING_DIM to 1024 + trigger re-embedding. Same Ollama API |
| 1.3 | **Extract `<dc:subject>` tags** | ~3 hours | Moderate | Parse from OPF, store in DB, include in embedding text |
| 1.4 | **Enrich embedding text with chapter titles** | ~4 hours | Moderate | Extract TOC/nav document, append chapter titles to embedding input |

### Priority 2: High Impact, Moderate Effort

| # | Change | Effort | Impact | Details |
|---|---|---|---|---|
| 2.1 | **LLM-generated book summaries** | ~1-2 days | High | Section 3A -- chat model produces 200-word summaries, embed summaries |
| 2.2 | **User taste profile vector** | ~4 hours | Moderate | Section 7.1 -- average embedding of highly-rated books as additional search query |
| 2.3 | **Negative signal from low ratings** | ~3 hours | Moderate | Section 7.2 -- penalize candidates similar to disliked books |
| 2.4 | **Tag-based graph edges** | ~4 hours | Moderate | Section 6.1 -- Jaccard similarity on shared tags |

### Priority 3: Moderate Impact, Higher Effort

| # | Change | Effort | Impact | Details |
|---|---|---|---|---|
| 3.1 | **Extract and embed first-chapter content** | ~2-3 days | Moderate | Section 3B -- read EPUB spine, extract opening content |
| 3.2 | **Hierarchical embedding aggregation** | ~1-2 days | Moderate | Section 4.2 -- weighted combination of metadata/description/content embeddings |
| 3.3 | **Community detection (Louvain)** | ~1-2 days | Moderate | Section 6.2 -- automatic genre clustering for visualization and recommendation boost |
| 3.4 | **LLM cross-encoder re-ranking** | ~1 day | Moderate | Section 7.3 -- use chat model to re-score top-20 candidates |
| 3.5 | **MRL two-phase search** | ~1 day | Minor | Section 5 -- truncated dims for fast filter, full dims for scoring |

### Priority 4: Long-Term Architecture

| # | Change | Effort | Impact | Details |
|---|---|---|---|---|
| 4.1 | **ONNX Runtime embedding backend** | ~1-2 weeks | UX | Section 9A -- eliminate Ollama dependency for embeddings |
| 4.2 | **Hybrid dense+sparse retrieval** | ~1-2 weeks | Moderate | Section 8.2 -- requires BGE-M3 + custom integration |
| 4.3 | **DPP diversity selection** | ~2-3 days | Minor | Section 8.3 -- replace MMR with theoretically superior method |
| 4.4 | **Full llama.cpp integration** | ~2-4 weeks | UX | Section 9C -- zero external dependencies |

---

## Appendix A: Model Quick-Reference

| Model | Ollama Tag | Dims | Context | Size | License |
|---|---|---|---|---|---|
| nomic-embed-text | `nomic-embed-text` | 768 | 8K | 274MB | Apache 2.0 |
| Qwen3-Embedding-0.6B | `qwen3-embedding:0.6b` | 1024 | 32K | 639MB | Apache 2.0 |
| Qwen3-Embedding-4B | `qwen3-embedding:4b` | 2048 | 40K | 2.5GB | Apache 2.0 |
| Qwen3-Embedding-8B | `qwen3-embedding:8b` | 7168 | 40K | 4.7GB | Apache 2.0 |
| BGE-M3 | `bge-m3` | 1024 | 8K | ~1.1GB | MIT |
| mxbai-embed-large | `mxbai-embed-large` | 1024 | 512 | 670MB | Apache 2.0 |

## Appendix B: Key Formulas

**Taste profile vector:**
```
taste = normalize(sum(w(r) * emb(b) for b, r in rated_books))
w(r) = {5: 1.3, 4: 1.1, 3: 0.8, 2: 0.5, 1: 0.2}
```

**Negative signal penalty:**
```
adjusted = base_score - 0.3 * cosine(candidate_emb, dislike_vector)
dislike_vector = normalize(mean(emb(b) for b in books where rating <= 2))
```

**Multi-signal edge weight:**
```
weight = 0.6 * cosine_sim + 0.2 * tag_jaccard + 0.2 * metadata_sim
```

**Temporal decay:**
```
temporal_weight = exp(-0.001 * days_since_rated)
```
