//! Export and backup commands

use crate::db::Book;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::Path;
use std::sync::Arc;
use tauri::State;

/// Exported library data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportData {
    pub version: String,
    pub exported_at: i64,
    pub books: Vec<ExportedBook>,
    pub ratings: Vec<ExportedRating>,
}

/// Exported book data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedBook {
    pub path: String,
    pub file_hash: Option<String>,
    pub title: String,
    pub author: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    pub description: Option<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub isbn: Option<String>,
}

/// Exported rating data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedRating {
    pub book_path: String,
    pub rating: Option<i32>,
    pub read_status: Option<String>,
}

impl From<&Book> for ExportedBook {
    fn from(book: &Book) -> Self {
        Self {
            path: book.path.clone(),
            file_hash: book.file_hash.clone(),
            title: book.title.clone(),
            author: book.author.clone(),
            series: book.series.clone(),
            series_index: book.series_index,
            description: book.description.clone(),
            language: book.language.clone(),
            publisher: book.publisher.clone(),
            isbn: book.isbn.clone(),
        }
    }
}

/// Export library to JSON file
#[tauri::command]
pub async fn export_library(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<ExportStats, String> {
    let db = &state.db;

    // Query all books
    let query = crate::db::BookQuery {
        limit: Some(100000), // High limit to get all
        ..Default::default()
    };
    let result = db.query_books(&query).map_err(|e| e.to_string())?;

    // Build export data
    let books: Vec<ExportedBook> = result.items.iter().map(ExportedBook::from).collect();

    let ratings: Vec<ExportedRating> = result
        .items
        .iter()
        .filter(|b| b.rating.is_some() || b.read_status.is_some())
        .map(|b| ExportedRating {
            book_path: b.path.clone(),
            rating: b.rating,
            read_status: b.read_status.clone(),
        })
        .collect();

    let export_data = ExportData {
        version: "1.0".to_string(),
        exported_at: chrono::Utc::now().timestamp(),
        books: books.clone(),
        ratings: ratings.clone(),
    };

    // Write to file
    let file = File::create(&path).map_err(|e| format!("Failed to create file: {}", e))?;
    let writer = BufWriter::new(file);
    serde_json::to_writer_pretty(writer, &export_data)
        .map_err(|e| format!("Failed to write JSON: {}", e))?;

    tracing::info!("Exported {} books to {}", books.len(), path);

    Ok(ExportStats {
        books_exported: books.len(),
        ratings_exported: ratings.len(),
        file_path: path,
    })
}

/// Import library from JSON file
#[tauri::command]
pub async fn import_library(
    state: State<'_, Arc<AppState>>,
    path: String,
    merge_mode: String, // "replace", "skip", "merge"
) -> Result<ImportStats, String> {
    let db = &state.db;

    // Read file
    let file = File::open(&path).map_err(|e| format!("Failed to open file: {}", e))?;
    let reader = BufReader::new(file);
    let export_data: ExportData =
        serde_json::from_reader(reader).map_err(|e| format!("Failed to parse JSON: {}", e))?;

    let mut books_imported = 0;
    let mut books_skipped = 0;
    let mut ratings_imported = 0;

    for exported_book in &export_data.books {
        // Check if book already exists
        let existing = db.get_book_by_path(&exported_book.path).ok().flatten();

        match (&existing, merge_mode.as_str()) {
            (Some(_), "skip") => {
                books_skipped += 1;
            }
            (Some(existing), "merge") => {
                // Update with imported metadata if missing
                let update = crate::db::BookUpdate {
                    title: Some(exported_book.title.clone()),
                    author: exported_book.author.clone().or(existing.author.clone()),
                    series: exported_book.series.clone().or(existing.series.clone()),
                    series_index: exported_book.series_index.or(existing.series_index),
                    description: exported_book.description.clone().or(existing.description.clone()),
                };
                let _ = db.update_book(existing.id, &update);
                books_imported += 1;
            }
            (Some(existing), "replace") | (Some(existing), _) => {
                // Replace with imported metadata
                let update = crate::db::BookUpdate {
                    title: Some(exported_book.title.clone()),
                    author: exported_book.author.clone(),
                    series: exported_book.series.clone(),
                    series_index: exported_book.series_index,
                    description: exported_book.description.clone(),
                };
                let _ = db.update_book(existing.id, &update);
                books_imported += 1;
            }
            (None, _) => {
                // Only import if file exists
                if Path::new(&exported_book.path).exists() {
                    let new_book = crate::db::NewBook {
                        path: exported_book.path.clone(),
                        cover_path: None,
                        file_size: std::fs::metadata(&exported_book.path)
                            .map(|m| m.len() as i64)
                            .unwrap_or(0),
                        file_hash: exported_book.file_hash.clone(),
                        title: exported_book.title.clone(),
                        sort_title: None,
                        author: exported_book.author.clone(),
                        author_sort: None,
                        series: exported_book.series.clone(),
                        series_index: exported_book.series_index,
                        description: exported_book.description.clone(),
                        language: exported_book.language.clone(),
                        publisher: exported_book.publisher.clone(),
                        publish_date: None,
                        isbn: exported_book.isbn.clone(),
                        source: "import".to_string(),
                    };
                    if db.insert_book(&new_book).is_ok() {
                        books_imported += 1;
                    }
                } else {
                    books_skipped += 1;
                }
            }
        }
    }

    // Import ratings
    for exported_rating in &export_data.ratings {
        if let Ok(Some(book)) = db.get_book_by_path(&exported_rating.book_path) {
            if let Some(rating) = exported_rating.rating {
                if db.set_rating(book.id, rating).is_ok() {
                    ratings_imported += 1;
                }
            }
            if let Some(ref status) = exported_rating.read_status {
                let _ = db.set_read_status(book.id, status);
            }
        }
    }

    tracing::info!(
        "Imported {} books, skipped {}, imported {} ratings",
        books_imported,
        books_skipped,
        ratings_imported
    );

    Ok(ImportStats {
        books_imported,
        books_skipped,
        ratings_imported,
    })
}

/// Export statistics
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportStats {
    pub books_exported: usize,
    pub ratings_exported: usize,
    pub file_path: String,
}

/// Import statistics
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStats {
    pub books_imported: usize,
    pub books_skipped: usize,
    pub ratings_imported: usize,
}

/// Create a backup of the entire database
#[tauri::command]
pub async fn create_backup(
    state: State<'_, Arc<AppState>>,
    backup_path: String,
) -> Result<String, String> {
    // Copy the database file
    let db_path = state.data_dir.join("library.db");

    std::fs::copy(&db_path, &backup_path)
        .map_err(|e| format!("Failed to create backup: {}", e))?;

    tracing::info!("Created database backup at {}", backup_path);

    Ok(backup_path)
}

/// Restore database from backup
#[tauri::command]
pub async fn restore_backup(
    state: State<'_, Arc<AppState>>,
    backup_path: String,
) -> Result<(), String> {
    let db_path = state.data_dir.join("library.db");

    // Verify backup is valid SQLite
    let _ = rusqlite::Connection::open(&backup_path)
        .map_err(|e| format!("Invalid backup file: {}", e))?;

    // Copy backup to database path
    std::fs::copy(&backup_path, &db_path)
        .map_err(|e| format!("Failed to restore backup: {}", e))?;

    tracing::info!("Restored database from backup: {}", backup_path);

    Ok(())
}
