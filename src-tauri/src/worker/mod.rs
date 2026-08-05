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
use crate::{AppError, AppResult};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use parking_lot::RwLock;

/// Background worker configuration
pub struct WorkerConfig {
    /// Minimum delay between jobs (rate limiting)
    pub job_delay_ms: u64,
    /// Batch size for edge computation
    pub edge_batch_size: usize,
}

// Retry policy deliberately does NOT live here. It used to, as a `max_retries`
// field that nothing ever read, which made failures look bounded while they were
// in fact permanent. Retries are now enforced in the query layer via
// db::MAX_EMBEDDING_ATTEMPTS and books.embedding_attempts, so the budget travels
// with the book instead of with an in-memory worker that restarts.
impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            job_delay_ms: 100,
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

    /// Generate embedding for a book using LLM summary enrichment
    async fn generate_embedding(&self, book_id: i64) -> AppResult<()> {
        // Check if already has embedding
        if self.vector_store.has_embedding(book_id) {
            tracing::debug!("Book {} already has embedding", book_id);
            return Ok(());
        }

        // Get book metadata
        let book = self.db.get_book(book_id)?;

        // Get tags and chapter titles for enriched embedding
        let tags = self.db.get_book_tags(book_id).unwrap_or_default();
        let chapter_titles = self.db.get_book_chapter_titles(book_id).unwrap_or_default();

        // Build the text to embed: prefer LLM summary if available/generable
        let text = match self.get_or_generate_summary(book_id, &book, &tags, &chapter_titles).await {
            Ok(summary) => summary,
            Err(e) => {
                tracing::debug!("Summary generation unavailable for book {}: {}, falling back to metadata", book_id, e);
                // Fall back to metadata-only embedding
                book_to_embedding_text(
                    &book.title,
                    book.author.as_deref(),
                    book.description.as_deref(),
                    book.series.as_deref(),
                    Some(&tags),
                    Some(&chapter_titles),
                )
            }
        };

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
                    // An unreachable server is not this book's fault, so it must
                    // not spend the book's retry budget — leave it 'pending'.
                    if !matches!(e, AppError::OllamaUnavailable(_)) {
                        self.db.mark_embedding_failed(book_id)?;
                    }
                    tracing::warn!("Failed to generate embedding for book {}: {}", book_id, e);
                    return Err(e);
                }
            }
        };

        // Store embedding
        let model = self.ollama.read().model().to_string();
        let text_hash = text_hash(&text);
        self.vector_store.store_embedding(book_id, &embedding, &model, Some(&text_hash))?;

        // Update book status
        self.db.update_embedding_status(book_id, "complete")?;

        tracing::info!("Generated embedding for book {}: {}", book_id, book.title);

        // Queue edge update
        let _ = self.update_graph_edges(book_id).await;

        Ok(())
    }

    /// Get an existing summary or generate one via LLM chat
    async fn get_or_generate_summary(
        &self,
        book_id: i64,
        book: &crate::db::Book,
        tags: &[String],
        chapter_titles: &[String],
    ) -> AppResult<String> {
        let settings = self.db.get_settings()?;
        let endpoint = self.ollama.read().endpoint().to_string();
        crate::ollama::get_or_generate_summary(
            &self.db, &endpoint, &settings.ollama_chat_model,
            book_id, book, tags, chapter_titles,
        ).await
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
/// Generates LLM summaries then embeds them. Respects pause flag for safe stop/resume.
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

    // Read config once before the loop to avoid per-book DB/lock reads
    let settings = db.get_settings()?;
    let chat_model_for_summary = settings.ollama_chat_model;
    let endpoint_for_summary = ollama.read().endpoint().to_string();

    let mut processed = 0;

    for book_id in pending_books {
        if paused.load(Ordering::Relaxed) {
            tracing::info!("Processing paused after {} books", processed);
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
            let tags = db.get_book_tags(book_id).unwrap_or_default();
            let chapter_titles = db.get_book_chapter_titles(book_id).unwrap_or_default();

            // Try LLM summary first, fall back to metadata
            let text = match crate::ollama::get_or_generate_summary(db, &endpoint_for_summary, &chat_model_for_summary, book_id, &book, &tags, &chapter_titles).await {
                Ok(summary) => summary,
                // Stop instead of quietly baking in a metadata-only embedding
                // and marking the book 'complete' — see commands/ollama.rs.
                Err(AppError::OllamaUnavailable(msg)) => {
                    tracing::warn!("Ollama unreachable during summary ({}) — stopping after {} books", msg, processed);
                    break;
                }
                Err(e) => {
                    tracing::debug!("Summary unavailable for book {}: {}, using metadata", book_id, e);
                    book_to_embedding_text(
                        &book.title,
                        book.author.as_deref(),
                        book.description.as_deref(),
                        book.series.as_deref(),
                        Some(&tags),
                        Some(&chapter_titles),
                    )
                }
            };

            let (endpoint, model) = {
                let o = ollama.read();
                (o.endpoint().to_string(), o.model().to_string())
            };

            let client = OllamaClient::new(endpoint, model.clone());

            match client.embed(&text).await {
                Ok(embedding) => {
                    let text_hash = text_hash(&text);
                    if vector_store.store_embedding(book_id, &embedding, &model, Some(&text_hash)).is_ok() {
                        db.update_embedding_status(book_id, "complete")?;
                        processed += 1;
                    }
                }
                Err(AppError::OllamaUnavailable(msg)) => {
                    tracing::warn!(
                        "Ollama unreachable during embed ({}) — stopping after {} books; \
                         untouched books stay 'pending' with their retry budget intact",
                        msg, processed
                    );
                    break;
                }
                Err(e) => {
                    tracing::warn!("Embedding failed for book {}: {}", book_id, e);
                    db.mark_embedding_failed(book_id)?;
                }
            }

            // Small delay between API calls
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    Ok(processed)
}

/// Simple hash for text change detection (delegates to shared function)
fn text_hash(text: &str) -> String {
    crate::ollama::text_hash(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_hash() {
        let hash1 = text_hash("hello world");
        let hash2 = text_hash("hello world");
        let hash3 = text_hash("different text");

        assert_eq!(hash1, hash2);
        assert_ne!(hash1, hash3);
    }
}
