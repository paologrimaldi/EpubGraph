//! Database module
//!
//! SQLite database with FTS5 for fast full-text search

mod migrations;
mod queries;

pub use queries::*;

use crate::{AppError, AppResult};
use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
use std::path::Path;

/// Database wrapper with connection pooling
pub struct Database {
    pool: Pool<SqliteConnectionManager>,
    db_path: String,
}

impl Database {
    /// Create a new database connection pool
    pub fn new(path: &Path) -> AppResult<Self> {
        let db_path = path.to_string_lossy().to_string();

        let manager = SqliteConnectionManager::file(path)
            .with_init(|conn| {
                // Enable WAL mode for better concurrent access
                conn.execute_batch(
                    "PRAGMA journal_mode = WAL;
                     PRAGMA synchronous = NORMAL;
                     PRAGMA foreign_keys = ON;
                     PRAGMA cache_size = -64000;  -- 64MB cache
                     PRAGMA temp_store = MEMORY;"
                )?;
                Ok(())
            });

        let pool = Pool::builder()
            .max_size(16)
            .build(manager)
            .map_err(|e| AppError::Database(rusqlite::Error::InvalidParameterName(e.to_string())))?;

        // Run migrations
        {
            let conn = pool.get()
                .map_err(|e| AppError::Database(rusqlite::Error::InvalidParameterName(e.to_string())))?;
            migrations::run_migrations(&conn)?;
        }

        Ok(Self { pool, db_path })
    }

    /// Get the database file path
    pub fn path(&self) -> &str {
        &self.db_path
    }

    /// Reset the database by deleting all data
    pub fn reset(&self) -> AppResult<()> {
        let conn = self.conn()?;

        // Delete all data from tables in correct order (respecting foreign keys)
        conn.execute_batch(
            "DELETE FROM book_edges;
             DELETE FROM book_tags;
             DELETE FROM tags;
             DELETE FROM user_book_data;
             DELETE FROM book_embeddings;
             DELETE FROM books;
             DELETE FROM libraries;
             DELETE FROM settings;
             VACUUM;"
        ).map_err(AppError::Database)?;

        Ok(())
    }
    
    /// Get a connection from the pool
    pub fn conn(&self) -> AppResult<PooledConnection<SqliteConnectionManager>> {
        self.pool.get()
            .map_err(|e| AppError::Database(rusqlite::Error::InvalidParameterName(e.to_string())))
    }
    
    /// Execute a function with a connection
    pub fn with_conn<F, T>(&self, f: F) -> AppResult<T>
    where
        F: FnOnce(&Connection) -> AppResult<T>,
    {
        let conn = self.conn()?;
        f(&conn)
    }
    
    /// Execute a function with a mutable connection (for transactions)
    pub fn with_conn_mut<F, T>(&self, f: F) -> AppResult<T>
    where
        F: FnOnce(&mut Connection) -> AppResult<T>,
    {
        let mut conn = self.conn()?;
        f(&mut conn)
    }
}

/// Book record from database
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: i64,
    pub path: String,
    pub cover_path: Option<String>,
    pub title: String,
    pub sort_title: Option<String>,
    pub author: Option<String>,
    pub author_sort: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    pub description: Option<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub publish_date: Option<String>,
    pub isbn: Option<String>,
    pub file_size: i64,
    pub file_hash: Option<String>,
    pub calibre_id: Option<i64>,
    pub source: String,
    pub date_added: i64,
    pub date_modified: i64,
    pub date_indexed: Option<i64>,
    pub embedding_status: String,
    pub embedding_model: Option<String>,
    // User data (from join)
    pub rating: Option<i32>,
    pub read_status: Option<String>,
}

/// Library record
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub is_calibre: bool,
    pub calibre_db_path: Option<String>,
    pub last_scan: Option<i64>,
    pub watch_enabled: bool,
    pub book_count: i64,
    /// Whether the library path is currently accessible (e.g., external drive connected)
    #[serde(default = "default_accessible")]
    pub accessible: bool,
}

fn default_accessible() -> bool {
    true
}

/// Graph edge record
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookEdge {
    pub source_id: i64,
    pub target_id: i64,
    pub edge_type: String,
    pub weight: f64,
    pub computed_at: i64,
    pub model_version: Option<String>,
}

/// Paged query result
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagedResult<T> {
    pub items: Vec<T>,
    pub total: i64,
    pub has_more: bool,
}

/// Book query parameters
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookQuery {
    pub search: Option<String>,
    pub author: Option<String>,
    pub series: Option<String>,
    pub tags: Option<Vec<String>>,
    pub read_status: Option<String>,
    pub min_rating: Option<i32>,
    pub embedding_status: Option<String>,
    pub sort_by: Option<String>,
    pub sort_order: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Settings record
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub ollama_endpoint: String,
    pub ollama_model: String,
    pub embedding_batch_size: i32,
    pub max_recommendations: i32,
    pub auto_scan_enabled: bool,
    pub scan_interval_minutes: i32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ollama_endpoint: "http://localhost:11434".to_string(),
            ollama_model: "nomic-embed-text".to_string(),
            embedding_batch_size: 10,
            max_recommendations: 20,
            auto_scan_enabled: true,
            scan_interval_minutes: 60,
        }
    }
}
