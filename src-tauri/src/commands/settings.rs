//! Settings commands

use crate::db::Settings;
use crate::state::AppState;
use std::sync::Arc;
use tauri::State;

/// Database statistics
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStats {
    pub database_size_bytes: u64,
    pub books_count: i64,
    pub embeddings_count: i64,
    pub embeddings_size_bytes: u64,
}

/// Get all settings
#[tauri::command]
pub async fn get_settings(
    state: State<'_, Arc<AppState>>,
) -> Result<Settings, String> {
    state.db.get_settings().map_err(|e| e.to_string())
}

/// Get the current database path
#[tauri::command]
pub async fn get_database_path(
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    Ok(state.db.path().to_string())
}

/// Get database statistics
#[tauri::command]
pub async fn get_database_stats(
    state: State<'_, Arc<AppState>>,
) -> Result<DatabaseStats, String> {
    // Get database file size
    let db_path = state.db.path();
    let database_size_bytes = std::fs::metadata(db_path)
        .map(|m| m.len())
        .unwrap_or(0);

    // Get books count
    let books_count = state.db.with_conn(|conn| {
        conn.query_row("SELECT COUNT(*) FROM books", [], |row| row.get::<_, i64>(0))
            .map_err(crate::AppError::Database)
    }).unwrap_or(0);

    // Get embeddings count and size
    let embeddings_count = state.vector_store.count().unwrap_or(0);
    // Each embedding is 768 floats * 4 bytes = 3072 bytes
    let embeddings_size_bytes = (embeddings_count as u64) * 768 * 4;

    Ok(DatabaseStats {
        database_size_bytes,
        books_count,
        embeddings_count,
        embeddings_size_bytes,
    })
}

/// Reset/clear the database (deletes all books, libraries, and settings)
#[tauri::command]
pub async fn reset_database(
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state.db.reset().map_err(|e| e.to_string())
}

/// Clear embeddings result
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearEmbeddingsResult {
    pub embeddings_cleared: i64,
    pub books_reset: i64,
}

/// Clear all embeddings and reset book embedding statuses
/// Use this when embeddings were created incorrectly (e.g., from titles only)
#[tauri::command]
pub async fn clear_embeddings(
    state: State<'_, Arc<AppState>>,
) -> Result<ClearEmbeddingsResult, String> {
    // Clear embeddings from vector store
    let embeddings_cleared = state.vector_store.clear_all().map_err(|e| e.to_string())?;

    // Reset all book embedding statuses to pending
    let books_reset = state.db.reset_all_embedding_statuses().map_err(|e| e.to_string())?;

    tracing::info!(
        "Cleared {} embeddings and reset {} book statuses",
        embeddings_cleared,
        books_reset
    );

    Ok(ClearEmbeddingsResult {
        embeddings_cleared,
        books_reset,
    })
}

/// Get the configured database path from preferences (may differ from current)
#[tauri::command]
pub async fn get_database_path_preference() -> Result<Option<String>, String> {
    // Read from a simple config file
    let config_path = get_config_path()?;
    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        let config: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();
        Ok(config.get("database_path").and_then(|v| v.as_str()).map(String::from))
    } else {
        Ok(None)
    }
}

/// Set the database path preference (requires app restart to take effect)
#[tauri::command]
pub async fn set_database_path_preference(path: String) -> Result<(), String> {
    // Validate path
    let path_buf = std::path::PathBuf::from(&path);

    // If it's a directory, append the database filename
    let db_path = if path_buf.is_dir() {
        path_buf.join("library.db")
    } else {
        path_buf.clone()
    };

    // Ensure parent directory exists
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    // Save to config file
    let config_path = get_config_path()?;
    let config = serde_json::json!({
        "database_path": db_path.to_string_lossy()
    });

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    std::fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| format!("Failed to save config: {}", e))?;

    Ok(())
}

/// Get the path to the config file
fn get_config_path() -> Result<std::path::PathBuf, String> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| "Could not determine config directory".to_string())?;
    Ok(config_dir.join("epub-graph").join("config.json"))
}

/// Update settings
#[tauri::command]
pub async fn update_settings(
    state: State<'_, Arc<AppState>>,
    settings: PartialSettings,
) -> Result<(), String> {
    if let Some(ref endpoint) = settings.ollama_endpoint {
        state.db.update_setting("ollama_endpoint", endpoint).map_err(|e| e.to_string())?;
        let mut ollama = state.ollama.write();
        let current_model = ollama.model().to_string();
        ollama.configure(endpoint.clone(), current_model);
    }

    if let Some(ref model) = settings.ollama_model {
        state.db.update_setting("ollama_model", model).map_err(|e| e.to_string())?;
        let mut ollama = state.ollama.write();
        let current_endpoint = ollama.endpoint().to_string();
        ollama.configure(current_endpoint, model.clone());
    }
    
    if let Some(batch_size) = settings.embedding_batch_size {
        state.db.update_setting("embedding_batch_size", &batch_size.to_string()).map_err(|e| e.to_string())?;
    }
    
    if let Some(max_recs) = settings.max_recommendations {
        state.db.update_setting("max_recommendations", &max_recs.to_string()).map_err(|e| e.to_string())?;
    }
    
    if let Some(auto_scan) = settings.auto_scan_enabled {
        state.db.update_setting("auto_scan_enabled", if auto_scan { "1" } else { "0" }).map_err(|e| e.to_string())?;
    }
    
    if let Some(interval) = settings.scan_interval_minutes {
        state.db.update_setting("scan_interval_minutes", &interval.to_string()).map_err(|e| e.to_string())?;
    }
    
    Ok(())
}

/// Partial settings for updates
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialSettings {
    pub ollama_endpoint: Option<String>,
    pub ollama_model: Option<String>,
    pub embedding_batch_size: Option<i32>,
    pub max_recommendations: Option<i32>,
    pub auto_scan_enabled: Option<bool>,
    pub scan_interval_minutes: Option<i32>,
}

/// Result of rebuilding graph edges
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildGraphResult {
    pub books_processed: i64,
    pub edges_created: i64,
    pub duration_ms: u64,
}

/// Progress event for graph rebuild
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRebuildProgress {
    pub current: i64,
    pub total: i64,
    pub edges_so_far: i64,
}

/// Rebuild graph edges from existing embeddings
/// This computes similarity between all books with embeddings and creates edges
#[tauri::command]
pub async fn rebuild_graph_edges(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<RebuildGraphResult, String> {
    use std::time::Instant;
    use tauri::Emitter;

    let start = Instant::now();

    tracing::info!("Starting graph edge rebuild...");

    // Clear existing edges
    state.db.with_conn(|conn| {
        conn.execute("DELETE FROM book_edges", [])
            .map_err(crate::AppError::Database)
    }).map_err(|e| e.to_string())?;

    // Get all book IDs with embeddings
    let book_ids: Vec<i64> = state.db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT b.id FROM books b
             INNER JOIN embeddings e ON b.id = e.book_id
             WHERE b.embedding_status = 'complete'"
        ).map_err(crate::AppError::Database)?;

        let ids = stmt.query_map([], |row| row.get(0))
            .map_err(crate::AppError::Database)?
            .collect::<Result<Vec<i64>, _>>()
            .map_err(crate::AppError::Database)?;

        Ok(ids)
    }).map_err(|e: crate::AppError| e.to_string())?;

    let total_books = book_ids.len() as i64;
    tracing::info!("Found {} books with embeddings", total_books);

    // Emit initial progress
    let _ = app.emit("graph-rebuild-progress", GraphRebuildProgress {
        current: 0,
        total: total_books,
        edges_so_far: 0,
    });

    let mut total_edges = 0i64;

    // Process books in batches to avoid memory issues
    for (idx, &book_id) in book_ids.iter().enumerate() {
        // Find similar books
        let similar = state.vector_store.find_similar_to_book(book_id, 30);

        if similar.is_empty() {
            continue;
        }

        // Get source book
        let source_book = match state.db.get_book(book_id) {
            Ok(b) => b,
            Err(_) => continue,
        };

        let mut edges_to_insert = Vec::new();

        for (target_id, similarity) in similar {
            if similarity < 0.3 {
                continue;
            }

            let target_book = match state.db.get_book(target_id) {
                Ok(b) => b,
                Err(_) => continue,
            };

            let (weight, edge_type) = crate::graph::compute_edge_weight(
                &source_book,
                &target_book,
                Some(similarity),
            );

            if weight >= 0.3 {
                edges_to_insert.push((book_id, target_id, edge_type, weight));
            }
        }

        if !edges_to_insert.is_empty() {
            if let Err(e) = state.db.insert_edges_batch(&edges_to_insert) {
                tracing::warn!("Failed to insert edges for book {}: {}", book_id, e);
            } else {
                total_edges += edges_to_insert.len() as i64;
            }
        }

        // Emit progress every 100 books
        if (idx + 1) % 100 == 0 || idx + 1 == book_ids.len() {
            let _ = app.emit("graph-rebuild-progress", GraphRebuildProgress {
                current: (idx + 1) as i64,
                total: total_books,
                edges_so_far: total_edges,
            });
        }

        // Log progress every 1000 books
        if (idx + 1) % 1000 == 0 {
            tracing::info!("Processed {}/{} books, {} edges so far", idx + 1, book_ids.len(), total_edges);
        }
    }

    let duration_ms = start.elapsed().as_millis() as u64;

    tracing::info!(
        "Graph rebuild complete: {} books, {} edges in {}ms",
        total_books, total_edges, duration_ms
    );

    Ok(RebuildGraphResult {
        books_processed: total_books,
        edges_created: total_edges,
        duration_ms,
    })
}
