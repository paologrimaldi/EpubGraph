//! Book query and management commands

use crate::db::{Book, BookQuery, BookUpdate, PagedResult};
use crate::epub::EpubParser;
use crate::state::AppState;
use std::sync::Arc;
use tauri::State;

/// Query books with filtering and pagination
#[tauri::command]
pub async fn query_books(
    state: State<'_, Arc<AppState>>,
    query: BookQuery,
) -> Result<PagedResult<Book>, String> {
    state.db.query_books(&query).map_err(|e| e.to_string())
}

/// Get a single book by ID
#[tauri::command]
pub async fn get_book(
    state: State<'_, Arc<AppState>>,
    id: i64,
) -> Result<Book, String> {
    state.db.get_book(id).map_err(|e| e.to_string())
}

/// Update book metadata
#[tauri::command]
pub async fn update_book(
    state: State<'_, Arc<AppState>>,
    id: i64,
    updates: BookUpdate,
) -> Result<(), String> {
    state.db.update_book(id, &updates).map_err(|e| e.to_string())
}

/// Delete a book from the database (does not delete the file)
#[tauri::command]
pub async fn delete_book(
    state: State<'_, Arc<AppState>>,
    id: i64,
) -> Result<(), String> {
    state.db.delete_book(id).map_err(|e| e.to_string())
}

/// Set book rating (1-5)
#[tauri::command]
pub async fn set_rating(
    state: State<'_, Arc<AppState>>,
    book_id: i64,
    rating: i32,
) -> Result<(), String> {
    if !(1..=5).contains(&rating) {
        return Err("Rating must be between 1 and 5".to_string());
    }
    state.db.set_rating(book_id, rating).map_err(|e| e.to_string())
}

/// Set read status
#[tauri::command]
pub async fn set_read_status(
    state: State<'_, Arc<AppState>>,
    book_id: i64,
    status: String,
) -> Result<(), String> {
    let valid_statuses = ["unread", "want", "reading", "finished", "abandoned"];
    if !valid_statuses.contains(&status.as_str()) {
        return Err(format!("Invalid status. Must be one of: {:?}", valid_statuses));
    }
    state.db.set_read_status(book_id, &status).map_err(|e| e.to_string())
}

/// Get cover image for a book (returns base64 encoded image data)
#[tauri::command]
pub async fn get_cover_image(
    state: State<'_, Arc<AppState>>,
    book_id: i64,
) -> Result<Option<String>, String> {
    let book = state.db.get_book(book_id).map_err(|e| e.to_string())?;

    // First, try external cover file
    if let Some(ref cover_path) = book.cover_path {
        let path = std::path::PathBuf::from(cover_path);
        if path.exists() {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            let mime = match path.extension().and_then(|e| e.to_str()) {
                Some("jpg") | Some("jpeg") => "image/jpeg",
                Some("png") => "image/png",
                _ => "image/jpeg",
            };
            use ::base64::Engine;
            let base64_str = ::base64::engine::general_purpose::STANDARD.encode(&data);
            return Ok(Some(format!("data:{};base64,{}", mime, base64_str)));
        }
    }

    // Try to extract from EPUB
    let parser = EpubParser::new();
    let epub_path = std::path::PathBuf::from(&book.path);

    if let Ok(Some(cover_data)) = parser.extract_cover(&epub_path) {
        // Detect image type from magic bytes
        let mime = if cover_data.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
            "image/png"
        } else {
            "image/jpeg"
        };
        use ::base64::Engine;
        let base64_str = ::base64::engine::general_purpose::STANDARD.encode(&cover_data);
        return Ok(Some(format!("data:{};base64,{}", mime, base64_str)));
    }

    Ok(None)
}

