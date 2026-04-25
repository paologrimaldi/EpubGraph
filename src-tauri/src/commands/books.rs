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

/// Check if a book lives in a dedicated folder (Calibre-style: folder contains
/// the epub plus cover/metadata files, no other epub files from different books).
fn get_book_folder(book_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let parent = book_path.parent()?;

    // Don't trash folders that look like a library root (too many items)
    let entries: Vec<_> = std::fs::read_dir(parent).ok()?.collect::<Result<Vec<_>, _>>().ok()?;
    if entries.len() > 10 {
        return None;
    }

    // Check that all files in the folder are book-related (book, cover, metadata, etc.)
    let book_extensions = ["epub", "pdf", "jpg", "jpeg", "png", "gif", "opf", "xml", "json", "txt"];
    let all_book_related = entries.iter().all(|e| {
        let path = e.path();
        if path.is_dir() {
            return false; // Subdirectories suggest this isn't a simple book folder
        }
        match path.extension().and_then(|ext| ext.to_str()) {
            Some(ext) => book_extensions.contains(&ext.to_lowercase().as_str()),
            None => false,
        }
    });

    if all_book_related {
        Some(parent.to_path_buf())
    } else {
        None
    }
}

/// Get info about a book's file structure for delete confirmation
#[tauri::command]
pub async fn get_book_delete_info(
    state: State<'_, Arc<AppState>>,
    id: i64,
) -> Result<BookDeleteInfo, String> {
    let book = state.db.get_book(id).map_err(|e| e.to_string())?;
    let book_path = std::path::Path::new(&book.path);
    let folder = get_book_folder(book_path);

    let folder_name = folder.as_ref().and_then(|f| {
        f.file_name().map(|n| n.to_string_lossy().to_string())
    });

    Ok(BookDeleteInfo {
        has_book_folder: folder.is_some(),
        folder_name,
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookDeleteInfo {
    pub has_book_folder: bool,
    pub folder_name: Option<String>,
}

/// Delete a book from the database and send the file (or folder) to OS trash
#[tauri::command]
pub async fn delete_book(
    state: State<'_, Arc<AppState>>,
    id: i64,
    trash_folder: Option<bool>,
) -> Result<(), String> {
    let book = state.db.get_book(id).map_err(|e| e.to_string())?;

    // Clean up vector store embedding (separate DB, not covered by CASCADE)
    if let Err(e) = state.vector_store.delete_embedding(id) {
        tracing::warn!("Could not delete embedding for book {}: {}", id, e);
    }

    state.db.delete_book(id).map_err(|e| e.to_string())?;

    let book_path = std::path::Path::new(&book.path);
    let trash_folder = trash_folder.unwrap_or(false);

    if trash_folder {
        // Try to trash the parent folder if it's a book-specific folder
        if let Some(folder) = get_book_folder(book_path) {
            if let Err(e) = trash::delete(&folder) {
                tracing::warn!("Could not send folder to trash ({}): {}", folder.display(), e);
                // Fall back to trashing just the file
                if let Err(e) = trash::delete(&book.path) {
                    tracing::warn!("Could not send file to trash ({}): {}", book.path, e);
                }
            }
        } else {
            // No book folder found, just trash the file
            if let Err(e) = trash::delete(&book.path) {
                tracing::warn!("Could not send file to trash ({}): {}", book.path, e);
            }
        }
    } else {
        // Just trash the epub file
        if let Err(e) = trash::delete(&book.path) {
            tracing::warn!("Could not send file to trash ({}): {}", book.path, e);
        }
    }

    Ok(())
}

/// Set book hidden status
#[tauri::command]
pub async fn set_book_hidden(
    state: State<'_, Arc<AppState>>,
    id: i64,
    hidden: bool,
) -> Result<(), String> {
    state.db.set_book_hidden(id, hidden).map_err(|e| e.to_string())
}

/// Set hidden status for all books by an author, returns count of affected books
#[tauri::command]
pub async fn set_books_hidden_by_author(
    state: State<'_, Arc<AppState>>,
    author: String,
    hidden: bool,
) -> Result<i64, String> {
    state.db.set_books_hidden_by_author(&author, hidden).map_err(|e| e.to_string())
}

/// Delete all books by an author (DB + trash files/folders)
#[tauri::command]
pub async fn delete_books_by_author(
    state: State<'_, Arc<AppState>>,
    author: String,
    trash_folder: Option<bool>,
) -> Result<DeleteBatchResult, String> {
    let books = state.db.get_books_by_author(&author).map_err(|e| e.to_string())?;
    let trash_folder = trash_folder.unwrap_or(false);
    let mut deleted = 0i64;
    let mut trashed = 0i64;

    for (id, path) in &books {
        // Clean up vector store embedding
        let _ = state.vector_store.delete_embedding(*id);
        if state.db.delete_book(*id).is_ok() {
            deleted += 1;
            let book_path = std::path::Path::new(path);
            let trash_target = if trash_folder {
                get_book_folder(book_path).unwrap_or_else(|| book_path.to_path_buf())
            } else {
                book_path.to_path_buf()
            };
            if trash::delete(&trash_target).is_ok() {
                trashed += 1;
            }
        }
    }

    Ok(DeleteBatchResult { deleted, trashed })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeleteBatchResult {
    pub deleted: i64,
    pub trashed: i64,
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

