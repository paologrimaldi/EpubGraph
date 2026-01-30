# EpubGraph - Implementation Plan

## Executive Summary

**EpubGraph** is a high-performance, cross-platform ebook library manager with AI-powered recommendations. Built with Tauri (Rust + SvelteKit), it provides millisecond queries on 100K+ books while progressively building a knowledge graph via local Ollama models.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [macOS Development Setup](#macos-development-setup)
3. [Technology Stack](#technology-stack)
4. [Database Design](#database-design)
5. [Recommendation Algorithm](#recommendation-algorithm)
6. [Implementation Phases](#implementation-phases)
7. [API Specifications](#api-specifications)
8. [Performance Targets](#performance-targets)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              TAURI APPLICATION                                │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    FRONTEND (SvelteKit + TypeScript)                 │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────┐  │    │
│  │  │   Library    │  │    Book      │  │    Graph     │  │ Settings│  │    │
│  │  │   Browser    │  │   Details    │  │    View      │  │  Panel  │  │    │
│  │  │ (Virtual     │  │ + Recommend  │  │  (Sigma.js)  │  │         │  │    │
│  │  │  Scroll)     │  │              │  │              │  │         │  │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  └─────────┘  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
│                          Tauri IPC (invoke/events)                          │
│                                    │                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                      RUST BACKEND (Tauri Core)                       │    │
│  │                                                                      │    │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────┐   │    │
│  │  │ FileSystem │  │   EPUB     │  │  Calibre   │  │    Ollama    │   │    │
│  │  │  Scanner   │  │  Parser    │  │  Importer  │  │    Client    │   │    │
│  │  │ (walkdir + │  │ (epub-rs)  │  │            │  │ (reqwest)    │   │    │
│  │  │  rayon)    │  │            │  │            │  │              │   │    │
│  │  └────────────┘  └────────────┘  └────────────┘  └──────────────┘   │    │
│  │                                                                      │    │
│  │  ┌────────────────────────────────────────────────────────────────┐ │    │
│  │  │                    DATA LAYER                                   │ │    │
│  │  │  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────┐  │ │    │
│  │  │  │    SQLite       │  │    LanceDB      │  │   In-Memory    │  │ │    │
│  │  │  │  + FTS5         │  │  (Embeddings)   │  │   Graph Cache  │  │ │    │
│  │  │  │  (Metadata,     │  │                 │  │  (petgraph)    │  │ │    │
│  │  │  │   Jobs, Edges)  │  │                 │  │                │  │ │    │
│  │  │  └─────────────────┘  └─────────────────┘  └────────────────┘  │ │    │
│  │  └────────────────────────────────────────────────────────────────┘ │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                    ┌──────────────────────────────────┐
                    │         OLLAMA (Local)           │
                    │   nomic-embed-text model         │
                    │   localhost:11434                │
                    └──────────────────────────────────┘
```

---

## macOS Development Setup

### Prerequisites Installation

```bash
# 1. Install Homebrew (if not installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. Install Xcode Command Line Tools
xcode-select --install

# 3. Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# 4. Install Node.js (LTS)
brew install node@20
# Or use nvm for version management:
# brew install nvm && nvm install 20

# 5. Install pnpm (faster than npm)
npm install -g pnpm

# 6. Install Tauri CLI
cargo install tauri-cli

# 7. Install Ollama
brew install ollama

# 8. Pull the embedding model
ollama pull nomic-embed-text

# 9. Optional: Install additional dev tools
brew install sqlite           # SQLite CLI for debugging
brew install jq               # JSON processing
brew install watchman         # File watching (optional, for faster HMR)
```

### Verify Installation

```bash
# Check all tools are installed
rustc --version      # Should be 1.75+
node --version       # Should be 20+
pnpm --version       # Should be 8+
cargo tauri --version # Should be 2.0+
ollama --version     # Should be 0.1+

# Verify Ollama is running
ollama list          # Should show nomic-embed-text
```

### Environment Configuration

Create `~/.zshrc` or `~/.bashrc` additions:

```bash
# Rust
export PATH="$HOME/.cargo/bin:$PATH"

# Node (if using Homebrew)
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"

# Tauri development
export TAURI_PRIVATE_KEY=""  # For signing (production)
export TAURI_KEY_PASSWORD=""
```

### IDE Setup (VS Code Recommended)

```bash
# Install VS Code extensions
code --install-extension rust-lang.rust-analyzer
code --install-extension svelte.svelte-vscode
code --install-extension tauri-apps.tauri-vscode
code --install-extension bradlc.vscode-tailwindcss
code --install-extension esbenp.prettier-vscode
```

### Windows Development Setup (Reference)

```powershell
# 1. Install Visual Studio Build Tools
# Download from: https://visualstudio.microsoft.com/visual-cpp-build-tools/
# Select "Desktop development with C++"

# 2. Install Rust
# Download rustup-init.exe from https://rustup.rs

# 3. Install Node.js
# Download from https://nodejs.org (LTS version)

# 4. Install pnpm
npm install -g pnpm

# 5. Install Tauri CLI
cargo install tauri-cli

# 6. Install Ollama
# Download from https://ollama.ai/download/windows
```

---

## Technology Stack

### Core Dependencies

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| **Framework** | Tauri | 2.0+ | Cross-platform app shell |
| **Frontend** | SvelteKit | 2.0+ | UI framework |
| **Styling** | TailwindCSS | 3.4+ | Utility CSS |
| **Backend** | Rust | 1.75+ | Core engine |
| **Primary DB** | SQLite | 3.45+ | Metadata + FTS |
| **Vector DB** | LanceDB | 0.4+ | Embeddings |
| **Graph** | petgraph | 0.6+ | In-memory graph |
| **AI** | Ollama | 0.1+ | Local embeddings |

### Rust Crates (Cargo.toml)

```toml
[package]
name = "epub-graph"
version = "0.1.0"
edition = "2021"

[dependencies]
# Tauri
tauri = { version = "2", features = ["tray-icon", "devtools"] }
tauri-plugin-shell = "2"
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
tauri-plugin-notification = "2"

# Async runtime
tokio = { version = "1", features = ["full"] }

# Serialization
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# Database
rusqlite = { version = "0.31", features = ["bundled", "backup", "functions"] }
r2d2 = "0.8"
r2d2_sqlite = "0.24"

# Vector store
lancedb = "0.4"
arrow = "50"

# Filesystem
walkdir = "2"
notify = "6"                    # File watching
rayon = "1"                     # Parallel processing

# EPUB parsing
epub = "2"
quick-xml = "0.31"
zip = "0.6"

# HTTP client (for Ollama)
reqwest = { version = "0.11", features = ["json", "stream"] }

# Graph
petgraph = "0.6"

# Utilities
chrono = { version = "0.4", features = ["serde"] }
uuid = { version = "1", features = ["v4", "serde"] }
thiserror = "1"
anyhow = "1"
tracing = "0.1"
tracing-subscriber = "0.3"
sha2 = "0.10"                   # File hashing
base64 = "0.21"
parking_lot = "0.12"           # Fast mutexes
dashmap = "5"                  # Concurrent hashmap
once_cell = "1"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[profile.release]
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

### Frontend Dependencies (package.json)

```json
{
  "name": "epub-graph",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "tauri": "tauri"
  },
  "devDependencies": {
    "@sveltejs/adapter-static": "^3.0.0",
    "@sveltejs/kit": "^2.0.0",
    "@sveltejs/vite-plugin-svelte": "^3.0.0",
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/cli": "^2.0.0",
    "@types/node": "^20.0.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "svelte": "^4.2.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.3.0",
    "vite": "^5.0.0"
  },
  "dependencies": {
    "@tanstack/svelte-virtual": "^3.0.0",
    "sigma": "^3.0.0",
    "graphology": "^0.25.0",
    "d3-force": "^3.0.0",
    "fuse.js": "^7.0.0",
    "date-fns": "^3.0.0",
    "svelte-sonner": "^0.3.0"
  }
}
```

---

## Database Design

### SQLite Schema

```sql
-- ============================================
-- CORE TABLES
-- ============================================

-- Books table - pointer-based (no file copying)
CREATE TABLE books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- File information (pointers only)
    path TEXT UNIQUE NOT NULL,
    cover_path TEXT,
    file_size INTEGER NOT NULL,
    file_hash TEXT,                      -- SHA-256 for dedup
    
    -- Core metadata
    title TEXT NOT NULL,
    sort_title TEXT,                     -- For sorting (stripped articles)
    author TEXT,
    author_sort TEXT,
    
    -- Series information
    series TEXT,
    series_index REAL,
    
    -- Extended metadata
    description TEXT,
    language TEXT,
    publisher TEXT,
    publish_date TEXT,
    isbn TEXT,
    
    -- Import tracking
    calibre_id INTEGER,                  -- If imported from Calibre
    source TEXT DEFAULT 'scan',          -- 'scan', 'calibre', 'manual'
    
    -- Timestamps
    date_added INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    date_modified INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    date_indexed INTEGER,                -- When AI processing completed
    
    -- Processing state
    embedding_status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'complete', 'failed'
    embedding_model TEXT,                    -- Model used for embedding
    
    -- Indexes
    UNIQUE(file_hash)
);

-- Full-text search index
CREATE VIRTUAL TABLE books_fts USING fts5(
    title,
    author,
    series,
    description,
    content='books',
    content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER books_ai AFTER INSERT ON books BEGIN
    INSERT INTO books_fts(rowid, title, author, series, description)
    VALUES (new.id, new.title, new.author, new.series, new.description);
END;

CREATE TRIGGER books_ad AFTER DELETE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, title, author, series, description)
    VALUES ('delete', old.id, old.title, old.author, old.series, old.description);
END;

CREATE TRIGGER books_au AFTER UPDATE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, title, author, series, description)
    VALUES ('delete', old.id, old.title, old.author, old.series, old.description);
    INSERT INTO books_fts(rowid, title, author, series, description)
    VALUES (new.id, new.title, new.author, new.series, new.description);
END;

-- ============================================
-- TAXONOMY TABLES
-- ============================================

CREATE TABLE authors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    sort_name TEXT,
    bio TEXT,
    link TEXT
);

CREATE TABLE book_authors (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'author',          -- 'author', 'editor', 'translator'
    PRIMARY KEY (book_id, author_id)
);

CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    parent_id INTEGER REFERENCES tags(id)
);

CREATE TABLE book_tags (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, tag_id)
);

-- ============================================
-- USER DATA
-- ============================================

CREATE TABLE ratings (
    book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    read_status TEXT DEFAULT 'unread',   -- 'unread', 'want', 'reading', 'finished', 'abandoned'
    date_started INTEGER,
    date_finished INTEGER,
    notes TEXT,
    date_rated INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE reading_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    progress REAL                         -- 0-1 percentage
);

-- ============================================
-- GRAPH EDGES (Recommendation Engine)
-- ============================================

CREATE TABLE book_edges (
    source_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    
    -- Edge properties
    edge_type TEXT NOT NULL,              -- 'content', 'author', 'series', 'tag', 'user_similar'
    weight REAL NOT NULL,                 -- 0.0 - 1.0 similarity score
    
    -- Metadata
    computed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    model_version TEXT,
    
    PRIMARY KEY (source_id, target_id, edge_type),
    CHECK (source_id != target_id),
    CHECK (weight >= 0 AND weight <= 1)
);

-- Optimized indexes for graph traversal
CREATE INDEX idx_edges_source ON book_edges(source_id, weight DESC);
CREATE INDEX idx_edges_target ON book_edges(target_id, weight DESC);
CREATE INDEX idx_edges_type ON book_edges(edge_type, weight DESC);

-- ============================================
-- AI PROCESSING QUEUE
-- ============================================

CREATE TABLE embedding_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    
    -- Job state
    status TEXT DEFAULT 'pending',        -- 'pending', 'processing', 'complete', 'failed'
    priority INTEGER DEFAULT 0,           -- Higher = process first
    
    -- Processing info
    stage TEXT DEFAULT 'metadata',        -- 'metadata', 'description', 'content'
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    
    -- Timestamps
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    started_at INTEGER,
    completed_at INTEGER,
    
    UNIQUE(book_id)
);

CREATE INDEX idx_jobs_status ON embedding_jobs(status, priority DESC);

-- ============================================
-- LIBRARY MANAGEMENT
-- ============================================

CREATE TABLE libraries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT UNIQUE NOT NULL,
    is_calibre INTEGER DEFAULT 0,
    calibre_db_path TEXT,
    last_scan INTEGER,
    watch_enabled INTEGER DEFAULT 1
);

CREATE TABLE scan_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER REFERENCES libraries(id),
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    books_found INTEGER,
    books_added INTEGER,
    books_updated INTEGER,
    errors TEXT                           -- JSON array of error messages
);

-- ============================================
-- SETTINGS
-- ============================================

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Default settings
INSERT INTO settings (key, value) VALUES
    ('ollama_endpoint', 'http://localhost:11434'),
    ('ollama_model', 'nomic-embed-text'),
    ('embedding_batch_size', '10'),
    ('max_recommendations', '20'),
    ('auto_scan_enabled', '1'),
    ('scan_interval_minutes', '60');

-- ============================================
-- PERFORMANCE INDEXES
-- ============================================

CREATE INDEX idx_books_path ON books(path);
CREATE INDEX idx_books_author ON books(author);
CREATE INDEX idx_books_series ON books(series, series_index);
CREATE INDEX idx_books_date_added ON books(date_added DESC);
CREATE INDEX idx_books_embedding_status ON books(embedding_status);
CREATE INDEX idx_ratings_status ON ratings(read_status);
```

### LanceDB Schema (Vector Store)

```python
# Conceptual schema - stored as Arrow tables
book_embeddings:
    id: int64           # FK to books.id
    embedding: vector[768]  # nomic-embed-text dimension
    text_hash: string   # Hash of text used for embedding
    created_at: timestamp
```

---

## Recommendation Algorithm

### Overview: Hybrid Multi-Hop Graph Neural Approach

The recommendation system uses a **state-of-the-art hybrid approach** combining:

1. **Content-based similarity** (via embeddings)
2. **Collaborative filtering** (user ratings)
3. **Knowledge graph traversal** (multi-hop exploration)
4. **Personalized PageRank** for relevance scoring

### Algorithm: Personalized Multi-Hop Recommendations

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    RECOMMENDATION PIPELINE                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  INPUT: Target book or user profile                                     │
│                    │                                                    │
│                    ▼                                                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  STAGE 1: SEED GENERATION                                        │   │
│  │  - If target is book: use book's embedding                       │   │
│  │  - If target is user: aggregate embeddings of highly-rated books │   │
│  │  - Find k nearest neighbors in embedding space (ANN search)      │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                    │                                                    │
│                    ▼ Seeds (top 50 candidates)                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  STAGE 2: MULTI-HOP GRAPH EXPANSION                              │   │
│  │                                                                   │   │
│  │  For each seed, traverse graph edges:                            │   │
│  │    Hop 1: Direct connections (weight > 0.7)                      │   │
│  │    Hop 2: Indirect connections (weight > 0.5)                    │   │
│  │    Hop 3+: Diminishing returns, weight > 0.6                     │   │
│  │                                                                   │   │
│  │  Edge types considered:                                          │   │
│  │    - content_similarity (embedding cosine sim)                   │   │
│  │    - same_author (weight = 0.8 if same author)                   │   │
│  │    - same_series (weight = 0.9, higher for adjacent)             │   │
│  │    - tag_overlap (Jaccard similarity of tags)                    │   │
│  │    - user_path (other users who liked A also liked B)            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                    │                                                    │
│                    ▼ Expanded candidates (up to 500)                   │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  STAGE 3: PERSONALIZED PAGERANK SCORING                          │   │
│  │                                                                   │   │
│  │  Run PPR from seed nodes with:                                   │   │
│  │    - Damping factor α = 0.85                                     │   │
│  │    - Teleport probability to highly-rated books = 0.3            │   │
│  │    - Edge weight = combined similarity score                     │   │
│  │                                                                   │   │
│  │  Score formula per candidate:                                    │   │
│  │    score = PPR_rank * edge_diversity_bonus * recency_factor      │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                    │                                                    │
│                    ▼ Scored candidates                                 │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  STAGE 4: DIVERSITY-AWARE RERANKING (MMR)                        │   │
│  │                                                                   │   │
│  │  Maximal Marginal Relevance to avoid redundancy:                 │   │
│  │    MMR = λ * sim(book, query) - (1-λ) * max(sim(book, selected)) │   │
│  │                                                                   │   │
│  │  Also apply:                                                     │   │
│  │    - Author diversity cap (max 2 books per author)               │   │
│  │    - Series continuity boost (next in series = +0.2)             │   │
│  │    - Novelty factor (penalize already-read books)                │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                    │                                                    │
│                    ▼                                                    │
│  OUTPUT: Top N recommendations with explanations                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Edge Weight Computation

```rust
// Pseudo-code for edge weight computation

fn compute_edge_weight(book_a: &Book, book_b: &Book) -> EdgeWeight {
    let mut weights = Vec::new();
    
    // 1. Content similarity (embedding cosine similarity)
    if let (Some(emb_a), Some(emb_b)) = (book_a.embedding, book_b.embedding) {
        let content_sim = cosine_similarity(emb_a, emb_b);
        weights.push(("content", content_sim, 0.4)); // 40% weight
    }
    
    // 2. Author match
    if book_a.author == book_b.author {
        weights.push(("author", 0.85, 0.2)); // 20% weight
    }
    
    // 3. Series relationship
    if book_a.series == book_b.series && book_a.series.is_some() {
        let series_sim = if (book_a.series_index - book_b.series_index).abs() <= 1.0 {
            0.95 // Adjacent in series
        } else {
            0.75 // Same series, not adjacent
        };
        weights.push(("series", series_sim, 0.15)); // 15% weight
    }
    
    // 4. Tag overlap (Jaccard similarity)
    let tag_sim = jaccard_similarity(&book_a.tags, &book_b.tags);
    if tag_sim > 0.2 {
        weights.push(("tag", tag_sim, 0.15)); // 15% weight
    }
    
    // 5. User collaborative signal
    let user_sim = compute_user_similarity(book_a.id, book_b.id);
    if user_sim > 0.0 {
        weights.push(("user", user_sim, 0.1)); // 10% weight
    }
    
    // Weighted combination
    let total_weight = weights.iter().map(|(_, s, w)| s * w).sum();
    let total_w = weights.iter().map(|(_, _, w)| w).sum();
    
    EdgeWeight {
        combined: total_weight / total_w,
        components: weights,
    }
}
```

### Personalized PageRank Implementation

```rust
/// Personalized PageRank for recommendation scoring
fn personalized_pagerank(
    graph: &Graph,
    seed_nodes: &[NodeId],
    user_preferences: &[NodeId], // Highly-rated books
    alpha: f64,                   // Damping factor (0.85)
    teleport_weight: f64,         // Preference teleport (0.3)
    iterations: usize,            // Convergence iterations (20)
) -> HashMap<NodeId, f64> {
    let n = graph.node_count();
    let mut scores: HashMap<NodeId, f64> = HashMap::new();
    
    // Initialize with uniform distribution
    for node in graph.nodes() {
        scores.insert(node, 1.0 / n as f64);
    }
    
    // Personalization vector (seeds + preferences)
    let mut personalization: HashMap<NodeId, f64> = HashMap::new();
    let total_seeds = seed_nodes.len() + user_preferences.len();
    
    for seed in seed_nodes {
        personalization.insert(*seed, (1.0 - teleport_weight) / seed_nodes.len() as f64);
    }
    for pref in user_preferences {
        *personalization.entry(*pref).or_insert(0.0) += teleport_weight / user_preferences.len() as f64;
    }
    
    // Power iteration
    for _ in 0..iterations {
        let mut new_scores: HashMap<NodeId, f64> = HashMap::new();
        
        for node in graph.nodes() {
            let mut score = 0.0;
            
            // Sum of weighted incoming edges
            for (neighbor, edge_weight) in graph.neighbors_incoming(node) {
                let neighbor_score = scores.get(&neighbor).unwrap_or(&0.0);
                let out_degree = graph.out_degree(neighbor) as f64;
                score += (neighbor_score * edge_weight) / out_degree;
            }
            
            // Apply damping and personalization
            score = alpha * score + (1.0 - alpha) * personalization.get(&node).unwrap_or(&(1.0 / n as f64));
            new_scores.insert(node, score);
        }
        
        scores = new_scores;
    }
    
    scores
}
```

### Multi-Hop Traversal

```rust
/// Multi-hop graph traversal for candidate expansion
fn expand_candidates_multi_hop(
    graph: &Graph,
    seeds: &[NodeId],
    max_hops: usize,
    min_weight_per_hop: &[f64], // e.g., [0.7, 0.5, 0.6] for hops 1, 2, 3
) -> Vec<(NodeId, f64, Vec<NodeId>)> {
    let mut candidates: HashMap<NodeId, (f64, Vec<NodeId>)> = HashMap::new();
    let mut frontier: VecDeque<(NodeId, f64, Vec<NodeId>, usize)> = VecDeque::new();
    
    // Initialize with seeds
    for seed in seeds {
        frontier.push_back((*seed, 1.0, vec![*seed], 0));
    }
    
    while let Some((node, accumulated_weight, path, hop)) = frontier.pop_front() {
        if hop >= max_hops {
            continue;
        }
        
        let min_weight = min_weight_per_hop.get(hop).unwrap_or(&0.5);
        
        for (neighbor, edge_weight) in graph.neighbors_outgoing(node) {
            if edge_weight < *min_weight {
                continue;
            }
            
            // Decay factor for longer paths
            let decay = 0.8_f64.powi(hop as i32);
            let new_weight = accumulated_weight * edge_weight * decay;
            
            let mut new_path = path.clone();
            new_path.push(neighbor);
            
            // Keep best path to each candidate
            candidates
                .entry(neighbor)
                .and_modify(|(w, p)| {
                    if new_weight > *w {
                        *w = new_weight;
                        *p = new_path.clone();
                    }
                })
                .or_insert((new_weight, new_path.clone()));
            
            frontier.push_back((neighbor, new_weight, new_path, hop + 1));
        }
    }
    
    candidates
        .into_iter()
        .map(|(node, (weight, path))| (node, weight, path))
        .collect()
}
```

### Recommendation Explanation Generation

```rust
struct Recommendation {
    book_id: i64,
    score: f64,
    reasons: Vec<RecommendationReason>,
}

enum RecommendationReason {
    SimilarContent { similarity: f64 },
    SameAuthor { author: String },
    SameSeries { series: String, position: String },
    TagOverlap { tags: Vec<String> },
    ReadersAlsoLiked { based_on: String },
    NextInSeries { previous: String },
}

fn generate_explanation(
    book: &Book,
    source: &Book,
    path: &[NodeId],
    edge_types: &[(String, f64)],
) -> Vec<RecommendationReason> {
    let mut reasons = Vec::new();
    
    // Analyze path and edge types to generate human-readable explanations
    for (edge_type, weight) in edge_types {
        match edge_type.as_str() {
            "content" if *weight > 0.7 => {
                reasons.push(RecommendationReason::SimilarContent { 
                    similarity: *weight 
                });
            }
            "author" => {
                reasons.push(RecommendationReason::SameAuthor { 
                    author: book.author.clone() 
                });
            }
            "series" => {
                reasons.push(RecommendationReason::SameSeries { 
                    series: book.series.clone().unwrap_or_default(),
                    position: format_series_position(source, book),
                });
            }
            _ => {}
        }
    }
    
    reasons
}
```

---

## Implementation Phases

### Phase 1: Core Foundation (Week 1-2)

**Goal:** Fast indexing + search without AI

#### 1.1 Project Scaffolding

```bash
# Create Tauri + SvelteKit project
pnpm create tauri-app epub-graph --template sveltekit-ts

# Add dependencies
cd epub-graph
pnpm add @tanstack/svelte-virtual sigma graphology d3-force fuse.js date-fns svelte-sonner
pnpm add -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

#### 1.2 Filesystem Scanner (Rust)

- Parallel directory traversal with `walkdir` + `rayon`
- EPUB detection and cover association
- Progress streaming to frontend
- Target: 100K files in <10 seconds

#### 1.3 EPUB Metadata Extraction

- Title, author, series from OPF
- Description extraction
- Cover image extraction
- Fallback to filename parsing

#### 1.4 SQLite Database Layer

- Connection pooling with r2d2
- Prepared statements for hot paths
- FTS5 search integration
- Batch insert optimization

#### 1.5 Basic Frontend

- Library grid view with virtual scrolling
- Search bar with instant results
- Book detail panel
- Settings for library paths

**Deliverable:** Working app that scans and searches books in <100ms

---

### Phase 2: Calibre Integration (Week 2-3)

**Goal:** Import from existing Calibre libraries

#### 2.1 Calibre DB Reader

- Detect Calibre libraries
- Read metadata from calibre.db
- Import ratings, tags, series

#### 2.2 Merge Logic

- Match by path or content hash
- Conflict resolution UI
- Preference for Calibre metadata

#### 2.3 Watch Mode

- Monitor Calibre DB for changes
- Incremental sync

**Deliverable:** Seamless import from Calibre

---

### Phase 3: Ollama Integration (Week 3-4)

**Goal:** Background embedding generation

#### 3.1 Ollama Client

- Health check and model verification
- Batch embedding requests
- Rate limiting and retry logic
- Graceful degradation

#### 3.2 Job Queue System

- Priority-based processing
- Resume after app restart
- Progress tracking

#### 3.3 LanceDB Integration

- Vector storage
- Approximate nearest neighbor search
- Index optimization

#### 3.4 Progressive Processing

- Stage 1: Title + Author (fast)
- Stage 2: + Description (medium)
- Stage 3: + Chapter extract (slow, opt-in)

**Deliverable:** Continuous background embedding with Ollama

---

### Phase 4: Graph Engine (Week 4-5)

**Goal:** Build and query recommendation graph

#### 4.1 Edge Computation

- Content similarity from embeddings
- Author/series/tag relationships
- Store in SQLite edge table

#### 4.2 In-Memory Graph

- Load hot subgraph into petgraph
- Cache recently accessed nodes
- Lazy loading for cold nodes

#### 4.3 Recommendation API

- Multi-hop traversal
- Personalized PageRank
- MMR reranking

#### 4.4 Explanation Generation

- Human-readable reasons
- Path visualization data

**Deliverable:** Working recommendations with explanations

---

### Phase 5: Advanced UI (Week 5-6)

**Goal:** Polish and graph visualization

#### 5.1 Recommendation Panel

- "Because you liked X" sections
- Series completion suggestions
- Discover new authors

#### 5.2 Graph Visualization

- Sigma.js force-directed layout
- Interactive exploration
- Cluster highlighting

#### 5.3 Performance Polish

- Precomputed recommendation cache
- Lazy image loading
- Animation smoothness

#### 5.4 Export/Backup

- Export library to JSON
- Backup embeddings
- Sync settings

**Deliverable:** Production-ready application

---

## API Specifications

### Tauri Commands (Frontend ↔ Backend)

```typescript
// src/lib/api/commands.ts

// ============================================
// LIBRARY MANAGEMENT
// ============================================

interface Library {
  id: number;
  name: string;
  path: string;
  isCalibre: boolean;
  lastScan: number | null;
  bookCount: number;
}

invoke<Library[]>('get_libraries');
invoke<Library>('add_library', { path: string, name?: string });
invoke<void>('remove_library', { id: number });
invoke<ScanResult>('scan_library', { id: number });

// ============================================
// BOOK QUERIES
// ============================================

interface Book {
  id: number;
  path: string;
  coverPath: string | null;
  title: string;
  author: string;
  series: string | null;
  seriesIndex: number | null;
  description: string | null;
  language: string | null;
  fileSize: number;
  dateAdded: number;
  rating: number | null;
  readStatus: ReadStatus;
  embeddingStatus: EmbeddingStatus;
}

type ReadStatus = 'unread' | 'want' | 'reading' | 'finished' | 'abandoned';
type EmbeddingStatus = 'pending' | 'processing' | 'complete' | 'failed';

interface BookQuery {
  search?: string;        // FTS query
  author?: string;
  series?: string;
  tags?: string[];
  readStatus?: ReadStatus;
  minRating?: number;
  sortBy?: 'title' | 'author' | 'dateAdded' | 'rating';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

interface PagedResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

invoke<PagedResult<Book>>('query_books', { query: BookQuery });
invoke<Book>('get_book', { id: number });
invoke<void>('update_book', { id: number, updates: Partial<Book> });
invoke<void>('delete_book', { id: number });

// ============================================
// RATINGS & USER DATA
// ============================================

invoke<void>('set_rating', { bookId: number, rating: number });
invoke<void>('set_read_status', { bookId: number, status: ReadStatus });

// ============================================
// RECOMMENDATIONS
// ============================================

interface Recommendation {
  book: Book;
  score: number;
  reasons: RecommendationReason[];
}

type RecommendationReason =
  | { type: 'similar_content'; similarity: number }
  | { type: 'same_author'; author: string }
  | { type: 'same_series'; series: string; position: string }
  | { type: 'tag_overlap'; tags: string[] }
  | { type: 'readers_also_liked'; basedOn: string }
  | { type: 'next_in_series'; previous: string };

invoke<Recommendation[]>('get_recommendations', { 
  bookId?: number;      // Similar to this book
  limit?: number;       // Default 20
});

invoke<Recommendation[]>('get_personalized_recommendations', {
  limit?: number;       // Based on user's ratings
});

// ============================================
// GRAPH DATA (for visualization)
// ============================================

interface GraphNode {
  id: number;
  title: string;
  author: string;
  coverPath: string | null;
  rating: number | null;
}

interface GraphEdge {
  source: number;
  target: number;
  weight: number;
  type: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

invoke<GraphData>('get_book_graph', { 
  centerId: number;     // Center book
  depth: number;        // Hops (1-3)
  maxNodes?: number;    // Limit for performance
});

// ============================================
// OLLAMA / AI STATUS
// ============================================

interface OllamaStatus {
  connected: boolean;
  endpoint: string;
  model: string;
  modelsAvailable: string[];
}

interface ProcessingStatus {
  totalBooks: number;
  processed: number;
  pending: number;
  currentBook: string | null;
  estimatedTimeRemaining: number | null;
}

invoke<OllamaStatus>('get_ollama_status');
invoke<void>('configure_ollama', { endpoint: string, model: string });
invoke<ProcessingStatus>('get_processing_status');
invoke<void>('pause_processing');
invoke<void>('resume_processing');
invoke<void>('prioritize_book', { bookId: number });

// ============================================
// SETTINGS
// ============================================

interface Settings {
  ollamaEndpoint: string;
  ollamaModel: string;
  embeddingBatchSize: number;
  maxRecommendations: number;
  autoScanEnabled: boolean;
  scanIntervalMinutes: number;
  theme: 'light' | 'dark' | 'system';
}

invoke<Settings>('get_settings');
invoke<void>('update_settings', { settings: Partial<Settings> });
```

### Tauri Events (Backend → Frontend)

```typescript
// Real-time updates

listen<ScanProgress>('scan:progress', (event) => {
  // { found: number, processed: number, current: string }
});

listen<void>('scan:complete', () => {});

listen<EmbeddingProgress>('embedding:progress', (event) => {
  // { bookId: number, stage: string, progress: number }
});

listen<Book>('book:updated', (event) => {});

listen<void>('ollama:connected', () => {});
listen<string>('ollama:error', (event) => {});
```

---

## Performance Targets

| Operation | Target | Measurement |
|-----------|--------|-------------|
| Initial scan (10K books) | <10s | Wall clock |
| Initial scan (100K books) | <60s | Wall clock |
| FTS search query | <50ms | P99 latency |
| Load book list (1000 items) | <100ms | Time to render |
| Virtual scroll (100K items) | 60fps | Frame rate |
| Get recommendations | <200ms | Including graph traversal |
| Single embedding | <2s | Depends on Ollama |
| Batch embeddings (100) | <60s | With batching |
| App cold start | <2s | To interactive |
| Memory usage | <500MB | With 100K books loaded |
| Database size | <100MB | Per 100K books (no files) |

---

## File Structure

```
epub-graph/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs                 # Entry point
│   │   ├── lib.rs                  # Library exports
│   │   ├── commands/               # Tauri command handlers
│   │   │   ├── mod.rs
│   │   │   ├── library.rs
│   │   │   ├── books.rs
│   │   │   ├── recommendations.rs
│   │   │   ├── ollama.rs
│   │   │   └── settings.rs
│   │   ├── scanner/                # Filesystem operations
│   │   │   ├── mod.rs
│   │   │   ├── walker.rs
│   │   │   └── watcher.rs
│   │   ├── epub/                   # EPUB parsing
│   │   │   ├── mod.rs
│   │   │   ├── parser.rs
│   │   │   └── metadata.rs
│   │   ├── db/                     # Database layer
│   │   │   ├── mod.rs
│   │   │   ├── sqlite.rs
│   │   │   ├── migrations.rs
│   │   │   └── queries.rs
│   │   ├── vector/                 # LanceDB integration
│   │   │   ├── mod.rs
│   │   │   ├── store.rs
│   │   │   └── search.rs
│   │   ├── graph/                  # Recommendation engine
│   │   │   ├── mod.rs
│   │   │   ├── builder.rs
│   │   │   ├── traversal.rs
│   │   │   ├── pagerank.rs
│   │   │   └── recommendations.rs
│   │   ├── ollama/                 # AI client
│   │   │   ├── mod.rs
│   │   │   ├── client.rs
│   │   │   └── embeddings.rs
│   │   ├── calibre/                # Calibre import
│   │   │   ├── mod.rs
│   │   │   └── importer.rs
│   │   └── state.rs                # App state management
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── build.rs
├── src/
│   ├── lib/
│   │   ├── api/                    # Tauri invoke wrappers
│   │   │   ├── index.ts
│   │   │   ├── commands.ts
│   │   │   └── events.ts
│   │   ├── stores/                 # Svelte stores
│   │   │   ├── library.ts
│   │   │   ├── books.ts
│   │   │   ├── recommendations.ts
│   │   │   └── settings.ts
│   │   ├── components/
│   │   │   ├── BookCard.svelte
│   │   │   ├── BookGrid.svelte
│   │   │   ├── BookDetail.svelte
│   │   │   ├── SearchBar.svelte
│   │   │   ├── RecommendationPanel.svelte
│   │   │   ├── GraphView.svelte
│   │   │   └── ...
│   │   └── utils/
│   │       ├── format.ts
│   │       └── debounce.ts
│   ├── routes/
│   │   ├── +layout.svelte
│   │   ├── +page.svelte            # Library view
│   │   ├── book/
│   │   │   └── [id]/
│   │   │       └── +page.svelte    # Book detail
│   │   ├── graph/
│   │   │   └── +page.svelte        # Graph visualization
│   │   └── settings/
│   │       └── +page.svelte
│   └── app.html
├── static/
│   └── favicon.png
├── package.json
├── svelte.config.js
├── tailwind.config.js
├── tsconfig.json
└── README.md
```

---

## Next Steps

1. **Approve this plan** or request modifications
2. **Set up development environment** following macOS instructions
3. **Begin Phase 1** implementation:
   - Scaffold Tauri + SvelteKit project
   - Implement filesystem scanner
   - Create SQLite schema and queries
   - Build basic frontend

Ready to start coding when you are!
