//! Up Next queue commands

use crate::db::Book;
use crate::state::AppState;
use std::sync::Arc;
use tauri::State;

/// Get all books in the Up Next queue
#[tauri::command]
pub async fn get_up_next_books(state: State<'_, Arc<AppState>>) -> Result<Vec<Book>, String> {
    state.db.get_up_next_books().map_err(|e| e.to_string())
}

/// Add a book to the Up Next queue
#[tauri::command]
pub async fn add_to_up_next(book_id: i64, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.db.add_to_up_next(book_id).map_err(|e| e.to_string())
}

/// Remove a book from the Up Next queue
#[tauri::command]
pub async fn remove_from_up_next(
    book_id: i64,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state.db.remove_from_up_next(book_id).map_err(|e| e.to_string())
}

/// Check if a book is in the Up Next queue
#[tauri::command]
pub async fn is_in_up_next(book_id: i64, state: State<'_, Arc<AppState>>) -> Result<bool, String> {
    state.db.is_in_up_next(book_id).map_err(|e| e.to_string())
}

/// Get the count of books in the Up Next queue
#[tauri::command]
pub async fn get_up_next_count(state: State<'_, Arc<AppState>>) -> Result<i64, String> {
    state.db.get_up_next_count().map_err(|e| e.to_string())
}

/// Get books with "want" read status (automatically included in Up Next view)
#[tauri::command]
pub async fn get_want_to_read_books(state: State<'_, Arc<AppState>>) -> Result<Vec<Book>, String> {
    state.db.get_want_to_read_books().map_err(|e| e.to_string())
}
