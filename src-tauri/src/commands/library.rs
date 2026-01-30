//! Library management commands

use crate::db::Library;
use crate::epub::EpubParser;
use crate::scanner::{ScanProgress, ScanResult, Scanner};
use crate::state::AppState;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, State};
use tokio::time::timeout;

/// Get all libraries with accessibility status
#[tauri::command]
pub async fn get_libraries(state: State<'_, Arc<AppState>>) -> Result<Vec<Library>, String> {
    let mut libraries = state.db.get_libraries().map_err(|e| e.to_string())?;

    // Check if each library path is accessible
    for library in &mut libraries {
        library.accessible = std::path::Path::new(&library.path).exists();
    }

    Ok(libraries)
}

/// Add a new library
#[tauri::command]
pub async fn add_library(
    state: State<'_, Arc<AppState>>,
    path: String,
    name: Option<String>,
) -> Result<Library, String> {
    // Validate path exists
    let path_buf = std::path::PathBuf::from(&path);
    if !path_buf.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !path_buf.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    // Check for Calibre database
    let calibre_db = path_buf.join("metadata.db");
    let is_calibre = calibre_db.exists();
    let calibre_db_path = if is_calibre {
        Some(calibre_db.to_string_lossy().to_string())
    } else {
        None
    };

    // Use directory name if no name provided
    let name = name.unwrap_or_else(|| {
        path_buf
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "Library".to_string())
    });

    state.db
        .add_library(&name, &path, is_calibre, calibre_db_path.as_deref())
        .map_err(|e| e.to_string())
}

/// Remove a library
#[tauri::command]
pub async fn remove_library(
    state: State<'_, Arc<AppState>>,
    id: i64,
) -> Result<(), String> {
    state.db.remove_library(id).map_err(|e| e.to_string())
}

/// Scan a library for books
#[tauri::command]
pub async fn scan_library(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: i64,
) -> Result<ScanResult, String> {
    let start = Instant::now();

    // Get library path
    let libraries = state.db.get_libraries().map_err(|e| e.to_string())?;
    let library = libraries
        .into_iter()
        .find(|l| l.id == id)
        .ok_or_else(|| format!("Library {} not found", id))?;

    tracing::info!("Scanning library: {} at {}", library.name, library.path);

    // Emit start event
    let _ = app.emit("scan:start", &library.name);

    // Phase 1: Fast scan - find all EPUB files (no parsing)
    let _ = app.emit("scan:progress", ScanProgress {
        phase: "scanning".to_string(),
        found: 0,
        processed: 0,
        total: 0,
        current: Some("Discovering EPUB files...".to_string()),
        eta_seconds: None,
    });

    let scanner = Scanner::new();
    let path = std::path::PathBuf::from(&library.path);

    let books = scanner.fast_scan(&path).map_err(|e| e.to_string())?;
    let books_found = books.len();

    tracing::info!("Fast scan found {} books, inserting into database", books_found);

    // Phase 2: Insert into database in batches with progress
    let _ = app.emit("scan:progress", ScanProgress {
        phase: "inserting".to_string(),
        found: books_found,
        processed: 0,
        total: books_found,
        current: Some(format!("Preparing to insert {} books...", books_found)),
        eta_seconds: Some((books_found as u64) / 1000 + 1), // Rough estimate: ~1000 books/sec
    });

    const BATCH_SIZE: usize = 100; // Smaller batches for more frequent updates
    let mut total_inserted = 0;
    let insert_start = Instant::now();

    for (batch_idx, chunk) in books.chunks(BATCH_SIZE).enumerate() {
        let batch_start = Instant::now();
        let inserted = state.db.insert_books_batch(chunk).map_err(|e| e.to_string())?;
        total_inserted += inserted.len();

        // Calculate ETA based on current progress
        let elapsed_secs = insert_start.elapsed().as_secs_f64();
        let rate = if elapsed_secs > 0.0 {
            total_inserted as f64 / elapsed_secs
        } else {
            1000.0
        };
        let remaining = books_found - total_inserted;
        let eta_secs = if rate > 0.0 {
            (remaining as f64 / rate) as u64
        } else {
            0
        };

        // Emit progress every batch
        let _ = app.emit("scan:progress", ScanProgress {
            phase: "inserting".to_string(),
            found: books_found,
            processed: total_inserted,
            total: books_found,
            current: Some(format!(
                "Inserted {}/{} books ({:.0}/sec)",
                total_inserted,
                books_found,
                rate
            )),
            eta_seconds: Some(eta_secs),
        });

        // Log every 10 batches
        if batch_idx % 10 == 0 {
            tracing::info!(
                "Progress: {}/{} books ({:.1}%), batch took {:?}",
                total_inserted,
                books_found,
                (total_inserted as f64 / books_found as f64) * 100.0,
                batch_start.elapsed()
            );
        }

        // Yield to allow UI updates (prevents blocking)
        tokio::task::yield_now().await;
    }

    // Update library scan time
    state.db.update_library_scan_time(id).map_err(|e| e.to_string())?;

    // Emit completion event
    let _ = app.emit("scan:complete", ());

    let duration_ms = start.elapsed().as_millis() as u64;

    tracing::info!(
        "Scan complete: {} found, {} added in {}ms ({:.1} books/sec)",
        books_found,
        total_inserted,
        duration_ms,
        (total_inserted as f64) / (duration_ms as f64 / 1000.0)
    );

    Ok(ScanResult {
        books_found,
        books_added: total_inserted,
        books_updated: 0,
        errors: vec![],
        duration_ms,
    })
}

/// Result of metadata parsing batch
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataParsingResult {
    pub processed: i64,
    pub success: i64,
    pub failed: i64,
    pub remaining: i64,
    pub duration_ms: u64,
}

/// Parse metadata for books that are missing descriptions
/// This extracts full EPUB metadata including descriptions for embedding generation
#[tauri::command]
pub async fn parse_metadata_batch(
    state: State<'_, Arc<AppState>>,
    _app: tauri::AppHandle,
    batch_size: Option<i64>,
) -> Result<MetadataParsingResult, String> {
    let batch_size = batch_size.unwrap_or(20);
    let start = Instant::now();

    // Get books needing metadata
    let books_to_parse = state.db.get_books_needing_metadata(batch_size)
        .map_err(|e| e.to_string())?;

    if books_to_parse.is_empty() {
        let stats = state.db.get_stats().map_err(|e| e.to_string())?;
        return Ok(MetadataParsingResult {
            processed: 0,
            success: 0,
            failed: 0,
            remaining: stats.books_needing_metadata,
            duration_ms: 0,
        });
    }

    let mut success = 0;
    let mut failed = 0;

    // Timeout for parsing each file (10 seconds max)
    let parse_timeout = Duration::from_secs(10);

    for (book_id, book_path) in &books_to_parse {
        let path_str = book_path.clone();
        let book_id = *book_id;

        // Check if file exists first - mark as permanently failed if missing
        if !Path::new(&path_str).exists() {
            tracing::warn!("Book file not found, marking as skipped: {}", path_str);
            // Use "skipped" status for files that don't exist
            state.db.update_embedding_status(book_id, "skipped").map_err(|e| e.to_string())?;
            failed += 1;
            continue;
        }

        // Parse with timeout using spawn_blocking to avoid blocking the async runtime
        let parse_result = timeout(parse_timeout, tokio::task::spawn_blocking(move || {
            let parser = EpubParser::new();
            let path = Path::new(&path_str);
            parser.parse(path)
        })).await;

        match parse_result {
            Ok(Ok(Ok(parsed))) => {
                // Update book with parsed metadata
                if let Err(e) = state.db.update_book_metadata(
                    book_id,
                    Some(&parsed.title),
                    parsed.author.as_deref(),
                    parsed.author_sort.as_deref(),
                    parsed.description.as_deref(),
                    parsed.series.as_deref(),
                    parsed.series_index,
                    parsed.language.as_deref(),
                    parsed.publisher.as_deref(),
                    parsed.publish_date.as_deref(),
                    parsed.isbn.as_deref(),
                ) {
                    tracing::warn!("Failed to update metadata for book {}: {}", book_id, e);
                    state.db.update_embedding_status(book_id, "skipped").ok();
                    failed += 1;
                } else {
                    // If we got a description, mark it for embedding processing
                    if parsed.description.is_some() {
                        state.db.update_embedding_status(book_id, "pending").ok();
                    } else {
                        // No description in EPUB - mark as skipped
                        state.db.update_embedding_status(book_id, "no_description").ok();
                    }
                    success += 1;
                }
            }
            Ok(Ok(Err(_e))) => {
                // EPUB parsing failed - mark as skipped so it won't be retried
                state.db.update_embedding_status(book_id, "skipped").map_err(|e| e.to_string())?;
                failed += 1;
            }
            Ok(Err(_e)) => {
                // Task panic - mark as skipped
                state.db.update_embedding_status(book_id, "skipped").map_err(|e| e.to_string())?;
                failed += 1;
            }
            Err(_) => {
                // Timeout - mark as skipped
                state.db.update_embedding_status(book_id, "skipped").map_err(|e| e.to_string())?;
                failed += 1;
            }
        }
    }

    // Get remaining count
    let stats = state.db.get_stats().map_err(|e| e.to_string())?;

    Ok(MetadataParsingResult {
        processed: books_to_parse.len() as i64,
        success,
        failed,
        remaining: stats.books_needing_metadata,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

/// Result of cleaning up orphaned books
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupOrphanedResult {
    pub checked: i64,
    pub removed: i64,
    pub duration_ms: u64,
}

/// Remove books from database whose files no longer exist on disk
#[tauri::command]
pub async fn cleanup_orphaned_books(
    state: State<'_, Arc<AppState>>,
) -> Result<CleanupOrphanedResult, String> {
    let start = Instant::now();

    // Get all book paths from database
    let all_books = state.db.get_all_book_paths().map_err(|e| e.to_string())?;
    let total = all_books.len() as i64;

    let mut removed = 0;

    for (book_id, book_path) in all_books {
        let path = Path::new(&book_path);
        if !path.exists() {
            tracing::info!("Removing orphaned book (file missing): {}", book_path);
            if let Err(e) = state.db.delete_book(book_id) {
                tracing::warn!("Failed to delete orphaned book {}: {}", book_id, e);
            } else {
                removed += 1;
            }
        }
    }

    tracing::info!("Cleanup complete: checked {} books, removed {} orphaned", total, removed);

    Ok(CleanupOrphanedResult {
        checked: total,
        removed,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}
