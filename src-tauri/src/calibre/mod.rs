//! Calibre library import module
//!
//! Reads metadata from Calibre's metadata.db SQLite database

use crate::db::{Database, NewBook};
use crate::{AppError, AppResult};
use rusqlite::Connection;
use std::path::Path;

/// Calibre library metadata
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibreLibrary {
    pub path: String,
    pub db_path: String,
    pub book_count: i64,
    pub author_count: i64,
}

/// Calibre book metadata extracted from metadata.db
#[derive(Debug, Clone)]
pub struct CalibreBook {
    pub id: i64,
    pub title: String,
    pub sort_title: Option<String>,
    pub author: Option<String>,
    pub author_sort: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    pub description: Option<String>,
    pub path: String,           // Relative path in Calibre library
    pub isbn: Option<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub pubdate: Option<String>,
    pub rating: Option<i32>,    // 0-10 in Calibre
    pub tags: Vec<String>,
}

/// Calibre importer
pub struct CalibreImporter {
    library_path: String,
}

impl CalibreImporter {
    /// Create a new importer for a Calibre library
    pub fn new(library_path: &str) -> Self {
        Self {
            library_path: library_path.to_string(),
        }
    }

    /// Check if a path contains a Calibre library
    pub fn is_calibre_library(path: &Path) -> bool {
        path.join("metadata.db").exists()
    }

    /// Get library statistics
    pub fn get_library_info(&self) -> AppResult<CalibreLibrary> {
        let db_path = Path::new(&self.library_path).join("metadata.db");
        let conn = Connection::open(&db_path)?;

        let book_count: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))?;
        let author_count: i64 = conn.query_row("SELECT COUNT(*) FROM authors", [], |r| r.get(0))?;

        Ok(CalibreLibrary {
            path: self.library_path.clone(),
            db_path: db_path.to_string_lossy().to_string(),
            book_count,
            author_count,
        })
    }

    /// Import all books from Calibre library
    pub fn import_books(&self) -> AppResult<Vec<CalibreBook>> {
        let db_path = Path::new(&self.library_path).join("metadata.db");
        let conn = Connection::open(&db_path)?;

        // Main query joining books with authors and series
        let mut stmt = conn.prepare(
            "SELECT 
                b.id,
                b.title,
                b.sort,
                b.path,
                b.isbn,
                b.pubdate,
                (SELECT name FROM authors a 
                 JOIN books_authors_link bal ON a.id = bal.author 
                 WHERE bal.book = b.id LIMIT 1) as author,
                (SELECT sort FROM authors a 
                 JOIN books_authors_link bal ON a.id = bal.author 
                 WHERE bal.book = b.id LIMIT 1) as author_sort,
                (SELECT name FROM series s 
                 JOIN books_series_link bsl ON s.id = bsl.series 
                 WHERE bsl.book = b.id LIMIT 1) as series,
                b.series_index,
                (SELECT text FROM comments WHERE book = b.id) as description,
                (SELECT rating FROM ratings WHERE book = b.id) as rating,
                (SELECT lang_code FROM languages l 
                 JOIN books_languages_link bll ON l.id = bll.lang_code 
                 WHERE bll.book = b.id LIMIT 1) as language,
                (SELECT name FROM publishers p 
                 JOIN books_publishers_link bpl ON p.id = bpl.publisher 
                 WHERE bpl.book = b.id LIMIT 1) as publisher
             FROM books b"
        )?;

        let books: Vec<CalibreBook> = stmt
            .query_map([], |row| {
                Ok(CalibreBook {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    sort_title: row.get(2)?,
                    path: row.get(3)?,
                    isbn: row.get(4)?,
                    pubdate: row.get(5)?,
                    author: row.get(6)?,
                    author_sort: row.get(7)?,
                    series: row.get(8)?,
                    series_index: row.get(9)?,
                    description: row.get(10)?,
                    rating: row.get::<_, Option<i32>>(11)?.map(|r| r / 2), // Convert 0-10 to 0-5
                    language: row.get(12)?,
                    publisher: row.get(13)?,
                    tags: vec![], // Loaded separately
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        // Load tags for each book
        let books_with_tags: Vec<CalibreBook> = books
            .into_iter()
            .map(|mut book| {
                if let Ok(tags) = self.load_tags(&conn, book.id) {
                    book.tags = tags;
                }
                book
            })
            .collect();

        Ok(books_with_tags)
    }

    /// Load tags for a specific book
    fn load_tags(&self, conn: &Connection, book_id: i64) -> AppResult<Vec<String>> {
        let mut stmt = conn.prepare(
            "SELECT t.name FROM tags t
             JOIN books_tags_link btl ON t.id = btl.tag
             WHERE btl.book = ?"
        )?;

        let tags = stmt
            .query_map([book_id], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(tags)
    }

    /// Find the EPUB file path for a Calibre book
    pub fn find_epub_path(&self, book: &CalibreBook) -> Option<String> {
        let book_dir = Path::new(&self.library_path).join(&book.path);
        
        // Calibre stores files as {title} - {author}/{title}.epub
        // but the path column contains the relative directory path
        
        if let Ok(entries) = std::fs::read_dir(&book_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map_or(false, |e| e == "epub") {
                    return Some(path.to_string_lossy().to_string());
                }
            }
        }

        None
    }

    /// Find the cover image path for a Calibre book
    pub fn find_cover_path(&self, book: &CalibreBook) -> Option<String> {
        let book_dir = Path::new(&self.library_path).join(&book.path);
        let cover_path = book_dir.join("cover.jpg");
        
        if cover_path.exists() {
            Some(cover_path.to_string_lossy().to_string())
        } else {
            None
        }
    }

    /// Convert Calibre books to NewBook format for database insertion
    pub fn to_new_books(&self, calibre_books: &[CalibreBook]) -> Vec<NewBook> {
        calibre_books
            .iter()
            .filter_map(|cb| {
                let epub_path = self.find_epub_path(cb)?;
                let cover_path = self.find_cover_path(cb);

                Some(NewBook {
                    path: epub_path,
                    cover_path,
                    file_size: 0, // Will be calculated during processing
                    file_hash: None,
                    title: cb.title.clone(),
                    sort_title: cb.sort_title.clone(),
                    author: cb.author.clone(),
                    author_sort: cb.author_sort.clone(),
                    series: cb.series.clone(),
                    series_index: cb.series_index,
                    description: cb.description.clone(),
                    language: cb.language.clone(),
                    publisher: cb.publisher.clone(),
                    publish_date: cb.pubdate.clone(),
                    isbn: cb.isbn.clone(),
                    source: "calibre".to_string(),
                })
            })
            .collect()
    }

    /// Import Calibre library into our database
    pub fn import_to_database(&self, db: &Database) -> AppResult<ImportResult> {
        let calibre_books = self.import_books()?;
        let new_books = self.to_new_books(&calibre_books);
        
        let total = new_books.len();
        let inserted = db.insert_books_batch(&new_books)?;
        
        // Import ratings
        let mut ratings_imported = 0;
        for cb in &calibre_books {
            if let (Some(rating), Some(epub_path)) = (cb.rating, self.find_epub_path(cb)) {
                if let Ok(Some(book)) = db.get_book_by_path(&epub_path) {
                    if let Ok(()) = db.set_rating(book.id, rating) {
                        ratings_imported += 1;
                    }
                }
            }
        }

        Ok(ImportResult {
            books_found: total,
            books_imported: inserted.len(),
            ratings_imported,
            errors: vec![],
        })
    }
}

/// Result of Calibre import
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub books_found: usize,
    pub books_imported: usize,
    pub ratings_imported: usize,
    pub errors: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_is_calibre_library() {
        // This test requires a real Calibre library
        let path = PathBuf::from("/tmp/not_a_library");
        assert!(!CalibreImporter::is_calibre_library(&path));
    }
}
