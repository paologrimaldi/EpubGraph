//! Background worker for embedding generation and graph updates
//!
//! Processes jobs from the queue to:
//! - Generate embeddings via Ollama
//! - Update graph edges based on similarity
//! - Handle library scanning

use crate::db::Database;
use crate::graph::compute_all_edge_weights;
use crate::ollama::{book_to_embedding_text, OllamaClient};
use crate::state::BackgroundJob;
use crate::vector::VectorStore;
use crate::AppResult;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use parking_lot::RwLock;

/// Background worker configuration
pub struct WorkerConfig {
    /// Minimum delay between jobs (rate limiting)
    pub job_delay_ms: u64,
    /// Maximum retries for failed jobs
    pub max_retries: u32,
    /// Batch size for edge computation
    pub edge_batch_size: usize,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            job_delay_ms: 100,
            max_retries: 3,
            edge_batch_size: 100,
        }
    }
}

/// Background worker that processes embedding and graph jobs
pub struct BackgroundWorker {
    db: Database,
    vector_store: Arc<VectorStore>,
    ollama: Arc<RwLock<OllamaClient>>,
    job_receiver: async_channel::Receiver<BackgroundJob>,
    paused: Arc<AtomicBool>,
    config: WorkerConfig,
}

impl BackgroundWorker {
    pub fn new(
        db: Database,
        vector_store: Arc<VectorStore>,
        ollama: Arc<RwLock<OllamaClient>>,
        job_receiver: async_channel::Receiver<BackgroundJob>,
        paused: Arc<AtomicBool>,
    ) -> Self {
        Self {
            db,
            vector_store,
            ollama,
            job_receiver,
            paused,
            config: WorkerConfig::default(),
        }
    }

    /// Run the worker loop
    pub async fn run(&self) {
        tracing::info!("Background worker started");

        loop {
            // Check for shutdown or pause
            if self.paused.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }

            // Wait for next job
            match self.job_receiver.recv().await {
                Ok(job) => {
                    if matches!(job, BackgroundJob::Shutdown) {
                        tracing::info!("Background worker shutting down");
                        break;
                    }

                    if let Err(e) = self.process_job(job).await {
                        tracing::error!("Job processing error: {}", e);
                    }

                    // Rate limiting
                    tokio::time::sleep(Duration::from_millis(self.config.job_delay_ms)).await;
                }
                Err(_) => {
                    // Channel closed, exit
                    break;
                }
            }
        }
    }

    /// Process a single job
    async fn process_job(&self, job: BackgroundJob) -> AppResult<()> {
        match job {
            BackgroundJob::GenerateEmbedding { book_id, priority: _ } => {
                self.generate_embedding(book_id).await
            }
            BackgroundJob::UpdateGraphEdges { book_id } => {
                self.update_graph_edges(book_id).await
            }
            BackgroundJob::ScanLibrary { library_id } => {
                tracing::info!("Library scan requested for {}", library_id);
                // Scanning is handled by the command directly
                Ok(())
            }
            BackgroundJob::Shutdown => Ok(()),
        }
    }

    /// Generate embedding for a book
    async fn generate_embedding(&self, book_id: i64) -> AppResult<()> {
        // Check if already has embedding
        if self.vector_store.has_embedding(book_id) {
            tracing::debug!("Book {} already has embedding", book_id);
            return Ok(());
        }

        // Get book metadata
        let book = self.db.get_book(book_id)?;

        // Build text for embedding
        let text = book_to_embedding_text(
            &book.title,
            book.author.as_deref(),
            book.description.as_deref(),
            book.series.as_deref(),
        );

        // Generate embedding
        let embedding = {
            let ollama = self.ollama.read();
            let endpoint = ollama.endpoint().to_string();
            let model = ollama.model().to_string();
            drop(ollama); // Release lock before async call

            let client = OllamaClient::new(endpoint, model.clone());
            match client.embed(&text).await {
                Ok(emb) => emb,
                Err(e) => {
                    tracing::warn!("Failed to generate embedding for book {}: {}", book_id, e);
                    // Update book status to failed
                    self.db.update_embedding_status(book_id, "failed")?;
                    return Err(e);
                }
            }
        };

        // Store embedding
        let model = self.ollama.read().model().to_string();
        let text_hash = format!("{:x}", md5_hash(&text));
        self.vector_store.store_embedding(book_id, &embedding, &model, Some(&text_hash))?;

        // Update book status
        self.db.update_embedding_status(book_id, "complete")?;

        tracing::info!("Generated embedding for book {}: {}", book_id, book.title);

        // Queue edge update
        let _ = self.update_graph_edges(book_id).await;

        Ok(())
    }

    /// Update graph edges for a book based on embedding similarity
    async fn update_graph_edges(&self, book_id: i64) -> AppResult<()> {
        // Find similar books by embedding
        let similar = self.vector_store.find_similar_to_book(book_id, 50);

        if similar.is_empty() {
            return Ok(());
        }

        // Get book metadata for edge weight computation
        let source_book = self.db.get_book(book_id)?;

        let mut edges_to_insert = Vec::new();

        for (target_id, embedding_sim) in similar {
            if embedding_sim < 0.3 {
                continue; // Skip low similarity
            }

            if let Ok(target_book) = self.db.get_book(target_id) {
                // Get ALL qualifying edge types (content, author, series)
                let all_edges = compute_all_edge_weights(
                    &source_book,
                    &target_book,
                    Some(embedding_sim),
                );

                // Store each qualifying edge type separately
                for (weight, edge_type) in all_edges {
                    if weight >= 0.3 {
                        edges_to_insert.push((book_id, target_id, edge_type, weight));
                    }
                }
            }
        }

        // Batch insert edges
        if !edges_to_insert.is_empty() {
            self.db.insert_edges_batch(&edges_to_insert)?;
            tracing::debug!("Inserted {} edges for book {}", edges_to_insert.len(), book_id);
        }

        Ok(())
    }
}

/// Process pending embedding jobs from database
pub async fn process_pending_embeddings(
    db: &Database,
    vector_store: &Arc<VectorStore>,
    ollama: &Arc<RwLock<OllamaClient>>,
    paused: &Arc<AtomicBool>,
    batch_size: usize,
) -> AppResult<usize> {
    // Get pending books
    let pending_books = db.get_pending_embedding_books(batch_size as i64)?;

    if pending_books.is_empty() {
        return Ok(0);
    }

    let mut processed = 0;

    for book_id in pending_books {
        if paused.load(Ordering::Relaxed) {
            break;
        }

        // Check if already has embedding
        if vector_store.has_embedding(book_id) {
            db.update_embedding_status(book_id, "complete")?;
            processed += 1;
            continue;
        }

        // Get book and generate embedding
        if let Ok(book) = db.get_book(book_id) {
            let text = book_to_embedding_text(
                &book.title,
                book.author.as_deref(),
                book.description.as_deref(),
                book.series.as_deref(),
            );

            let (endpoint, model) = {
                let o = ollama.read();
                (o.endpoint().to_string(), o.model().to_string())
            };

            let client = OllamaClient::new(endpoint, model.clone());

            match client.embed(&text).await {
                Ok(embedding) => {
                    let text_hash = format!("{:x}", md5_hash(&text));
                    if vector_store.store_embedding(book_id, &embedding, &model, Some(&text_hash)).is_ok() {
                        db.update_embedding_status(book_id, "complete")?;
                        processed += 1;
                    }
                }
                Err(e) => {
                    tracing::warn!("Embedding failed for book {}: {}", book_id, e);
                    db.update_embedding_status(book_id, "failed")?;
                }
            }

            // Small delay between API calls
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    Ok(processed)
}

/// Simple MD5 hash for text (used for change detection)
fn md5_hash(text: &str) -> u128 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish() as u128
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_md5_hash() {
        let hash1 = md5_hash("hello world");
        let hash2 = md5_hash("hello world");
        let hash3 = md5_hash("different text");

        assert_eq!(hash1, hash2);
        assert_ne!(hash1, hash3);
    }
}
