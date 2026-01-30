//! Ollama AI integration commands

use crate::ollama::{OllamaStatus, ProcessingStatus};
use crate::state::AppState;
use std::sync::Arc;
use tauri::State;

/// Get Ollama connection status
#[tauri::command]
pub async fn get_ollama_status(
    state: State<'_, Arc<AppState>>,
) -> Result<OllamaStatus, String> {
    // Clone the endpoint and model before the async operation
    // to avoid holding the lock across await points
    let (endpoint, model) = {
        let ollama = state.ollama.read();
        (ollama.endpoint().to_string(), ollama.model().to_string())
    };

    // Create a temporary client for the health check
    let temp_client = crate::ollama::OllamaClient::new(endpoint, model);
    temp_client.health_check().await.map_err(|e| e.to_string())
}

/// Configure Ollama endpoint and model
#[tauri::command]
pub async fn configure_ollama(
    state: State<'_, Arc<AppState>>,
    endpoint: String,
    model: String,
) -> Result<(), String> {
    // Update Ollama client
    {
        let mut ollama = state.ollama.write();
        ollama.configure(endpoint.clone(), model.clone());
    }
    
    // Persist to settings
    state.db.update_setting("ollama_endpoint", &endpoint).map_err(|e| e.to_string())?;
    state.db.update_setting("ollama_model", &model).map_err(|e| e.to_string())?;
    
    Ok(())
}

/// Get current processing status
#[tauri::command]
pub async fn get_processing_status(
    state: State<'_, Arc<AppState>>,
) -> Result<ProcessingStatus, String> {
    let stats = state.db.get_stats().map_err(|e| e.to_string())?;

    Ok(ProcessingStatus {
        total_books: stats.total_books,
        processed: stats.books_with_embeddings,
        pending: stats.pending_embeddings,
        current_book: None, // TODO: track in state
        is_paused: state.is_processing_paused(),
        estimated_time_remaining: None, // TODO: calculate based on rate
        books_needing_metadata: stats.books_needing_metadata,
    })
}

/// Pause background embedding processing
#[tauri::command]
pub async fn pause_processing(
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state.pause_processing();
    Ok(())
}

/// Resume background embedding processing
#[tauri::command]
pub async fn resume_processing(
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state.resume_processing();
    Ok(())
}

/// Prioritize embedding generation for a specific book
#[tauri::command]
pub async fn prioritize_book(
    state: State<'_, Arc<AppState>>,
    book_id: i64,
) -> Result<(), String> {
    use crate::state::BackgroundJob;

    state.queue_job(BackgroundJob::GenerateEmbedding {
        book_id,
        priority: 100, // High priority
    });

    Ok(())
}

/// Process a batch of pending embeddings
/// Returns the number of embeddings processed
#[tauri::command]
pub async fn process_embeddings_batch(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    batch_size: Option<i64>,
) -> Result<ProcessingResult, String> {
    use crate::ollama::OllamaClient;
    use std::time::Instant;

    let batch_size = batch_size.unwrap_or(10) as usize;
    let start = Instant::now();

    // Get pending books
    let pending_books = state.db.get_pending_embedding_books(batch_size as i64)
        .map_err(|e| e.to_string())?;

    if pending_books.is_empty() {
        return Ok(ProcessingResult {
            processed: 0,
            failed: 0,
            remaining: 0,
            duration_ms: 0,
        });
    }

    // Get Ollama config
    let (endpoint, model) = {
        let ollama = state.ollama.read();
        (ollama.endpoint().to_string(), ollama.model().to_string())
    };

    let client = OllamaClient::new(endpoint, model.clone());

    let mut processed = 0;
    let mut failed = 0;

    for book_id in &pending_books {
        // Check if already has embedding
        if state.vector_store.has_embedding(*book_id) {
            state.db.update_embedding_status(*book_id, "complete").ok();
            processed += 1;
            continue;
        }

        // Get book and generate embedding
        if let Ok(book) = state.db.get_book(*book_id) {
            // PROTECTION: Skip books without description - embeddings from titles only are meaningless
            if book.description.is_none() || book.description.as_ref().map(|d| d.trim().is_empty()).unwrap_or(true) {
                // Mark as "needs_metadata" so it's not retried until metadata is parsed
                state.db.update_embedding_status(*book_id, "needs_metadata").ok();
                tracing::debug!("Skipping book {} - no description available", book.title);
                continue;
            }

            let text = crate::ollama::book_to_embedding_text(
                &book.title,
                book.author.as_deref(),
                book.description.as_deref(),
                book.series.as_deref(),
            );

            match client.embed(&text).await {
                Ok(embedding) => {
                    if state.vector_store.store_embedding(*book_id, &embedding, &model, None).is_ok() {
                        state.db.update_embedding_status(*book_id, "complete").ok();
                        processed += 1;
                        tracing::info!("Generated embedding for: {}", book.title);

                        // Create graph edges to similar books
                        let similar = state.vector_store.find_similar_to_book(*book_id, 20);
                        if !similar.is_empty() {
                            let mut edges_to_insert = Vec::new();
                            for (target_id, similarity) in similar {
                                if similarity < 0.3 {
                                    continue;
                                }
                                if let Ok(target_book) = state.db.get_book(target_id) {
                                    let (weight, edge_type) = crate::graph::compute_edge_weight(
                                        &book,
                                        &target_book,
                                        Some(similarity),
                                    );
                                    if weight >= 0.3 {
                                        edges_to_insert.push((*book_id, target_id, edge_type, weight));
                                    }
                                }
                            }
                            if let Err(e) = state.db.insert_edges_batch(&edges_to_insert) {
                                tracing::warn!("Failed to insert edges for book {}: {}", book_id, e);
                            }
                        }
                    } else {
                        failed += 1;
                    }
                }
                Err(e) => {
                    tracing::warn!("Embedding failed for book {}: {}", book_id, e);
                    state.db.update_embedding_status(*book_id, "failed").ok();
                    failed += 1;
                }
            }
        }
    }

    // Get remaining count
    let stats = state.db.get_stats().map_err(|e| e.to_string())?;

    Ok(ProcessingResult {
        processed,
        failed,
        remaining: stats.pending_embeddings,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

/// Result of batch embedding processing
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingResult {
    pub processed: i64,
    pub failed: i64,
    pub remaining: i64,
    pub duration_ms: u64,
}
