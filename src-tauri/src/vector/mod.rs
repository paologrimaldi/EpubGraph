//! Vector store module for embedding storage and similarity search
//!
//! Uses SQLite for storage with in-memory caching for fast similarity search.
//! Embeddings are stored as JSON-encoded float arrays.

use crate::{AppError, AppResult};
use dashmap::DashMap;
use parking_lot::RwLock;
use rusqlite::{params, Connection};
use std::sync::Arc;

/// Dimension of nomic-embed-text embeddings
pub const EMBEDDING_DIM: usize = 768;

/// Vector store for book embeddings
pub struct VectorStore {
    /// In-memory cache of embeddings for fast similarity search
    cache: DashMap<i64, Vec<f32>>,
    /// Database path for persistence
    db_path: String,
    /// Whether cache is fully loaded
    cache_loaded: RwLock<bool>,
}

impl VectorStore {
    /// Create a new vector store
    pub fn new(db_path: &str) -> AppResult<Self> {
        let store = Self {
            cache: DashMap::new(),
            db_path: db_path.to_string(),
            cache_loaded: RwLock::new(false),
        };

        // Ensure the embeddings table exists
        store.init_schema()?;

        Ok(store)
    }

    /// Initialize database schema for embeddings
    fn init_schema(&self) -> AppResult<()> {
        let conn = Connection::open(&self.db_path)?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS embeddings (
                book_id INTEGER PRIMARY KEY,
                embedding BLOB NOT NULL,
                model TEXT NOT NULL,
                text_hash TEXT,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
            )",
            [],
        )?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model)",
            [],
        )?;

        Ok(())
    }

    /// Load all embeddings into cache
    pub fn load_cache(&self) -> AppResult<usize> {
        let conn = Connection::open(&self.db_path)?;

        let mut stmt = conn.prepare("SELECT book_id, embedding FROM embeddings")?;
        let rows = stmt.query_map([], |row| {
            let book_id: i64 = row.get(0)?;
            let embedding_blob: Vec<u8> = row.get(1)?;
            Ok((book_id, embedding_blob))
        })?;

        let mut count = 0;
        for row in rows {
            let (book_id, blob) = row?;
            if let Ok(embedding) = deserialize_embedding(&blob) {
                self.cache.insert(book_id, embedding);
                count += 1;
            }
        }

        *self.cache_loaded.write() = true;
        tracing::info!("Loaded {} embeddings into cache", count);

        Ok(count)
    }

    /// Store an embedding for a book
    pub fn store_embedding(
        &self,
        book_id: i64,
        embedding: &[f32],
        model: &str,
        text_hash: Option<&str>,
    ) -> AppResult<()> {
        if embedding.len() != EMBEDDING_DIM {
            return Err(AppError::InvalidInput(format!(
                "Expected {} dimensions, got {}",
                EMBEDDING_DIM,
                embedding.len()
            )));
        }

        let conn = Connection::open(&self.db_path)?;
        let blob = serialize_embedding(embedding);

        conn.execute(
            "INSERT OR REPLACE INTO embeddings (book_id, embedding, model, text_hash)
             VALUES (?, ?, ?, ?)",
            params![book_id, blob, model, text_hash],
        )?;

        // Update cache
        self.cache.insert(book_id, embedding.to_vec());

        Ok(())
    }

    /// Get embedding for a book
    pub fn get_embedding(&self, book_id: i64) -> Option<Vec<f32>> {
        // Check cache first
        if let Some(embedding) = self.cache.get(&book_id) {
            return Some(embedding.clone());
        }

        // Load from database
        let conn = Connection::open(&self.db_path).ok()?;
        let blob: Vec<u8> = conn
            .query_row(
                "SELECT embedding FROM embeddings WHERE book_id = ?",
                [book_id],
                |row| row.get(0),
            )
            .ok()?;

        let embedding = deserialize_embedding(&blob).ok()?;
        self.cache.insert(book_id, embedding.clone());

        Some(embedding)
    }

    /// Delete embedding for a book
    pub fn delete_embedding(&self, book_id: i64) -> AppResult<()> {
        let conn = Connection::open(&self.db_path)?;
        conn.execute("DELETE FROM embeddings WHERE book_id = ?", [book_id])?;
        self.cache.remove(&book_id);
        Ok(())
    }

    /// Find k nearest neighbors by cosine similarity
    pub fn find_similar(&self, query_embedding: &[f32], k: usize, exclude_ids: &[i64]) -> Vec<(i64, f64)> {
        // Ensure cache is loaded
        if !*self.cache_loaded.read() {
            let _ = self.load_cache();
        }

        let mut similarities: Vec<(i64, f64)> = self
            .cache
            .iter()
            .filter(|entry| !exclude_ids.contains(entry.key()))
            .map(|entry| {
                let book_id = *entry.key();
                let similarity = cosine_similarity(query_embedding, entry.value());
                (book_id, similarity)
            })
            .collect();

        // Sort by similarity descending
        similarities.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        // Take top k
        similarities.truncate(k);
        similarities
    }

    /// Find books similar to a given book
    pub fn find_similar_to_book(&self, book_id: i64, k: usize) -> Vec<(i64, f64)> {
        if let Some(embedding) = self.get_embedding(book_id) {
            self.find_similar(&embedding, k, &[book_id])
        } else {
            vec![]
        }
    }

    /// Get count of stored embeddings
    pub fn count(&self) -> AppResult<i64> {
        let conn = Connection::open(&self.db_path)?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM embeddings", [], |row| row.get(0))?;
        Ok(count)
    }

    /// Check if book has embedding
    pub fn has_embedding(&self, book_id: i64) -> bool {
        if self.cache.contains_key(&book_id) {
            return true;
        }

        if let Ok(conn) = Connection::open(&self.db_path) {
            let result: Result<i64, _> = conn.query_row(
                "SELECT 1 FROM embeddings WHERE book_id = ?",
                [book_id],
                |row| row.get(0),
            );
            result.is_ok()
        } else {
            false
        }
    }

    /// Clear all embeddings from the database and cache
    pub fn clear_all(&self) -> AppResult<i64> {
        let conn = Connection::open(&self.db_path)?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM embeddings", [], |row| row.get(0))?;
        conn.execute("DELETE FROM embeddings", [])?;
        self.cache.clear();
        tracing::info!("Cleared {} embeddings", count);
        Ok(count)
    }

    /// Compute average embedding for multiple books (for user profile)
    pub fn compute_average_embedding(&self, book_ids: &[i64]) -> Option<Vec<f32>> {
        let embeddings: Vec<Vec<f32>> = book_ids
            .iter()
            .filter_map(|&id| self.get_embedding(id))
            .collect();

        if embeddings.is_empty() {
            return None;
        }

        let mut average = vec![0.0f32; EMBEDDING_DIM];
        for embedding in &embeddings {
            for (i, val) in embedding.iter().enumerate() {
                average[i] += val;
            }
        }

        let count = embeddings.len() as f32;
        for val in &mut average {
            *val /= count;
        }

        // Normalize
        let norm: f32 = average.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for val in &mut average {
                *val /= norm;
            }
        }

        Some(average)
    }
}

/// Compute cosine similarity between two vectors
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() {
        return 0.0;
    }

    let mut dot_product = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;

    for (x, y) in a.iter().zip(b.iter()) {
        let x = *x as f64;
        let y = *y as f64;
        dot_product += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }

    let norm_product = (norm_a * norm_b).sqrt();
    if norm_product > 0.0 {
        dot_product / norm_product
    } else {
        0.0
    }
}

/// Serialize embedding to bytes (little-endian f32 array)
fn serialize_embedding(embedding: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(embedding.len() * 4);
    for val in embedding {
        bytes.extend_from_slice(&val.to_le_bytes());
    }
    bytes
}

/// Deserialize embedding from bytes
fn deserialize_embedding(bytes: &[u8]) -> AppResult<Vec<f32>> {
    if bytes.len() % 4 != 0 {
        return Err(AppError::InvalidInput("Invalid embedding data".to_string()));
    }

    let mut embedding = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks(4) {
        let arr: [u8; 4] = chunk.try_into().map_err(|_| {
            AppError::InvalidInput("Invalid embedding chunk".to_string())
        })?;
        embedding.push(f32::from_le_bytes(arr));
    }

    Ok(embedding)
}

/// Wrapper for thread-safe vector store access
pub type SharedVectorStore = Arc<VectorStore>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cosine_similarity() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 0.0, 0.0];
        assert!((cosine_similarity(&a, &b) - 1.0).abs() < 1e-6);

        let c = vec![0.0, 1.0, 0.0];
        assert!(cosine_similarity(&a, &c).abs() < 1e-6);

        let d = vec![-1.0, 0.0, 0.0];
        assert!((cosine_similarity(&a, &d) + 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_serialization() {
        let original = vec![1.0f32, 2.0, 3.0, -4.5];
        let bytes = serialize_embedding(&original);
        let restored = deserialize_embedding(&bytes).unwrap();
        assert_eq!(original, restored);
    }
}
