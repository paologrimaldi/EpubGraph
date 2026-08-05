//! Database migrations

use crate::AppResult;
use rusqlite::Connection;

/// Current schema version
const SCHEMA_VERSION: i32 = 5;

/// Run all pending migrations
pub fn run_migrations(conn: &Connection) -> AppResult<()> {
    // Create migrations table if not exists
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER DEFAULT (strftime('%s', 'now'))
        )",
        [],
    )?;
    
    // Get current version
    let current_version: i32 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    
    tracing::info!("Current schema version: {}, target: {}", current_version, SCHEMA_VERSION);
    
    // Apply migrations
    if current_version < 1 {
        migrate_v1(conn)?;
    }
    if current_version < 2 {
        migrate_v2(conn)?;
    }
    if current_version < 3 {
        migrate_v3(conn)?;
    }
    if current_version < 4 {
        migrate_v4(conn)?;
    }
    if current_version < 5 {
        migrate_v5(conn)?;
    }

    Ok(())
}

/// Initial schema migration
fn migrate_v1(conn: &Connection) -> AppResult<()> {
    tracing::info!("Applying migration v1: Initial schema");
    
    conn.execute_batch(r#"
        -- ============================================
        -- CORE TABLES
        -- ============================================
        
        -- Books table - pointer-based (no file copying)
        CREATE TABLE IF NOT EXISTS books (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            
            -- File information (pointers only)
            path TEXT UNIQUE NOT NULL,
            cover_path TEXT,
            file_size INTEGER NOT NULL DEFAULT 0,
            file_hash TEXT,
            
            -- Core metadata
            title TEXT NOT NULL,
            sort_title TEXT,
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
            calibre_id INTEGER,
            source TEXT DEFAULT 'scan',
            
            -- Timestamps
            date_added INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            date_modified INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            date_indexed INTEGER,
            
            -- Processing state
            embedding_status TEXT DEFAULT 'pending',
            embedding_model TEXT
        );
        
        -- Full-text search index
        CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
            title,
            author,
            series,
            description,
            content='books',
            content_rowid='id',
            tokenize='porter unicode61 remove_diacritics 2'
        );
        
        -- Triggers to keep FTS in sync
        CREATE TRIGGER IF NOT EXISTS books_ai AFTER INSERT ON books BEGIN
            INSERT INTO books_fts(rowid, title, author, series, description)
            VALUES (new.id, new.title, new.author, new.series, new.description);
        END;
        
        CREATE TRIGGER IF NOT EXISTS books_ad AFTER DELETE ON books BEGIN
            INSERT INTO books_fts(books_fts, rowid, title, author, series, description)
            VALUES ('delete', old.id, old.title, old.author, old.series, old.description);
        END;
        
        CREATE TRIGGER IF NOT EXISTS books_au AFTER UPDATE ON books BEGIN
            INSERT INTO books_fts(books_fts, rowid, title, author, series, description)
            VALUES ('delete', old.id, old.title, old.author, old.series, old.description);
            INSERT INTO books_fts(rowid, title, author, series, description)
            VALUES (new.id, new.title, new.author, new.series, new.description);
        END;
        
        -- ============================================
        -- TAXONOMY TABLES
        -- ============================================
        
        CREATE TABLE IF NOT EXISTS authors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            sort_name TEXT,
            bio TEXT,
            link TEXT
        );
        
        CREATE TABLE IF NOT EXISTS book_authors (
            book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
            role TEXT DEFAULT 'author',
            PRIMARY KEY (book_id, author_id)
        );
        
        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            parent_id INTEGER REFERENCES tags(id)
        );
        
        CREATE TABLE IF NOT EXISTS book_tags (
            book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (book_id, tag_id)
        );
        
        -- ============================================
        -- USER DATA
        -- ============================================
        
        CREATE TABLE IF NOT EXISTS ratings (
            book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
            rating INTEGER CHECK (rating >= 1 AND rating <= 5),
            read_status TEXT DEFAULT 'unread',
            date_started INTEGER,
            date_finished INTEGER,
            notes TEXT,
            date_rated INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );
        
        -- ============================================
        -- GRAPH EDGES
        -- ============================================
        
        CREATE TABLE IF NOT EXISTS book_edges (
            source_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            target_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            edge_type TEXT NOT NULL,
            weight REAL NOT NULL,
            computed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            model_version TEXT,
            PRIMARY KEY (source_id, target_id, edge_type),
            CHECK (source_id != target_id),
            CHECK (weight >= 0 AND weight <= 1)
        );
        
        -- ============================================
        -- AI PROCESSING QUEUE
        -- ============================================
        
        CREATE TABLE IF NOT EXISTS embedding_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            status TEXT DEFAULT 'pending',
            priority INTEGER DEFAULT 0,
            stage TEXT DEFAULT 'metadata',
            attempts INTEGER DEFAULT 0,
            last_error TEXT,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            started_at INTEGER,
            completed_at INTEGER,
            UNIQUE(book_id)
        );
        
        -- ============================================
        -- LIBRARY MANAGEMENT
        -- ============================================
        
        CREATE TABLE IF NOT EXISTS libraries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            path TEXT UNIQUE NOT NULL,
            is_calibre INTEGER DEFAULT 0,
            calibre_db_path TEXT,
            last_scan INTEGER,
            watch_enabled INTEGER DEFAULT 1
        );
        
        CREATE TABLE IF NOT EXISTS scan_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id INTEGER REFERENCES libraries(id),
            started_at INTEGER NOT NULL,
            completed_at INTEGER,
            books_found INTEGER,
            books_added INTEGER,
            books_updated INTEGER,
            errors TEXT
        );
        
        -- ============================================
        -- SETTINGS
        -- ============================================
        
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        );
        
        -- Default settings
        INSERT OR IGNORE INTO settings (key, value) VALUES
            ('ollama_endpoint', 'http://localhost:11434'),
            ('ollama_model', 'qwen3-embedding:8b'),
            ('embedding_batch_size', '10'),
            ('max_recommendations', '20'),
            ('auto_scan_enabled', '1'),
            ('scan_interval_minutes', '60');
        
        -- ============================================
        -- PERFORMANCE INDEXES
        -- ============================================
        
        CREATE INDEX IF NOT EXISTS idx_books_path ON books(path);
        CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
        CREATE INDEX IF NOT EXISTS idx_books_series ON books(series, series_index);
        CREATE INDEX IF NOT EXISTS idx_books_date_added ON books(date_added DESC);
        CREATE INDEX IF NOT EXISTS idx_books_embedding_status ON books(embedding_status);
        CREATE INDEX IF NOT EXISTS idx_ratings_status ON ratings(read_status);
        CREATE INDEX IF NOT EXISTS idx_edges_source ON book_edges(source_id, weight DESC);
        CREATE INDEX IF NOT EXISTS idx_edges_target ON book_edges(target_id, weight DESC);
        CREATE INDEX IF NOT EXISTS idx_edges_type ON book_edges(edge_type, weight DESC);
        CREATE INDEX IF NOT EXISTS idx_jobs_status ON embedding_jobs(status, priority DESC);
    "#)?;
    
    // Record migration
    conn.execute(
        "INSERT INTO schema_version (version) VALUES (?)",
        [1],
    )?;
    
    tracing::info!("Migration v1 applied successfully");
    Ok(())
}

/// Up Next feature migration
fn migrate_v2(conn: &Connection) -> AppResult<()> {
    tracing::info!("Applying migration v2: Up Next table");

    conn.execute_batch(r#"
        -- ============================================
        -- UP NEXT TABLE
        -- ============================================

        -- Up Next reading queue
        CREATE TABLE IF NOT EXISTS up_next (
            book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
            added_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            position INTEGER NOT NULL DEFAULT 0
        );

        -- Index for ordering
        CREATE INDEX IF NOT EXISTS idx_up_next_position ON up_next(position ASC);
    "#)?;

    // Record migration
    conn.execute(
        "INSERT INTO schema_version (version) VALUES (?)",
        [2],
    )?;

    tracing::info!("Migration v2 applied successfully");
    Ok(())
}

/// Embedding enrichment migration: book summaries, chapter titles storage
fn migrate_v3(conn: &Connection) -> AppResult<()> {
    tracing::info!("Applying migration v3: Embedding enrichment tables");

    conn.execute_batch(r#"
        -- ============================================
        -- BOOK SUMMARIES (LLM-generated for embedding)
        -- ============================================

        CREATE TABLE IF NOT EXISTS book_summaries (
            book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
            summary TEXT NOT NULL,
            model TEXT NOT NULL,
            text_hash TEXT,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );

        -- ============================================
        -- CHAPTER TITLES (extracted from EPUB TOC)
        -- ============================================

        -- Store chapter titles as JSON array on the books table
        ALTER TABLE books ADD COLUMN chapter_titles_json TEXT;

        -- Update default embedding model setting
        INSERT OR REPLACE INTO settings (key, value, updated_at)
            VALUES ('ollama_model', 'qwen3-embedding:8b', strftime('%s', 'now'));
    "#)?;

    // Record migration
    conn.execute(
        "INSERT INTO schema_version (version) VALUES (?)",
        [3],
    )?;

    tracing::info!("Migration v3 applied successfully");
    Ok(())
}

/// Hidden books feature migration
fn migrate_v4(conn: &Connection) -> AppResult<()> {
    tracing::info!("Applying migration v4: Hidden books column");

    conn.execute_batch(r#"
        -- Add hidden flag to books (0 = visible, 1 = hidden)
        ALTER TABLE books ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

        -- Index for filtering hidden books
        CREATE INDEX IF NOT EXISTS idx_books_hidden ON books(hidden);
    "#)?;

    // Record migration
    conn.execute(
        "INSERT INTO schema_version (version) VALUES (?)",
        [4],
    )?;

    tracing::info!("Migration v4 applied successfully");
    Ok(())
}

/// Retryable embedding failures.
///
/// Before v5 an embedding failure set `embedding_status = 'failed'` and nothing
/// ever selected that status again, so a book was stranded permanently. A single
/// Ollama restart mid-run could strand a whole batch in under a second, because
/// connection-refused fails instantly rather than after the 120s timeout. v5 adds
/// a bounded attempt counter, and rescues anything already stranded.
fn migrate_v5(conn: &Connection) -> AppResult<()> {
    tracing::info!("Applying migration v5: retryable embedding failures");

    conn.execute_batch(r#"
        ALTER TABLE books ADD COLUMN embedding_attempts INTEGER NOT NULL DEFAULT 0;

        -- Rescue books stranded by the pre-v5 permanent-'failed' behaviour.
        UPDATE books SET embedding_status = 'pending' WHERE embedding_status = 'failed';

        -- Serves the retry arm of get_pending_embedding_books.
        CREATE INDEX IF NOT EXISTS idx_books_embedding_retry
            ON books(embedding_status, embedding_attempts);
    "#)?;

    conn.execute(
        "INSERT INTO schema_version (version) VALUES (?)",
        [5],
    )?;

    tracing::info!("Migration v5 applied successfully");
    Ok(())
}
