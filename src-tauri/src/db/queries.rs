//! Database query functions

use super::{Book, BookEdge, BookQuery, Database, Library, PagedResult, Settings};
use crate::{AppError, AppResult};
use rusqlite::{params, Row};

impl Database {
    // ============================================
    // LIBRARY OPERATIONS
    // ============================================
    
    /// Get all libraries with book counts
    pub fn get_libraries(&self) -> AppResult<Vec<Library>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT l.id, l.name, l.path, l.is_calibre, l.calibre_db_path, 
                        l.last_scan, l.watch_enabled,
                        (SELECT COUNT(*) FROM books b WHERE b.path LIKE l.path || '%') as book_count
                 FROM libraries l
                 ORDER BY l.name"
            )?;
            
            let libraries = stmt.query_map([], |row| {
                Ok(Library {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    is_calibre: row.get::<_, i32>(3)? != 0,
                    calibre_db_path: row.get(4)?,
                    last_scan: row.get(5)?,
                    watch_enabled: row.get::<_, i32>(6)? != 0,
                    book_count: row.get(7)?,
                    accessible: true, // Will be updated by command layer
                })
            })?.collect::<Result<Vec<_>, _>>()?;
            
            Ok(libraries)
        })
    }
    
    /// Add a new library
    pub fn add_library(&self, name: &str, path: &str, is_calibre: bool, calibre_db_path: Option<&str>) -> AppResult<Library> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO libraries (name, path, is_calibre, calibre_db_path) VALUES (?, ?, ?, ?)",
                params![name, path, is_calibre as i32, calibre_db_path],
            )?;
            
            let id = conn.last_insert_rowid();
            
            Ok(Library {
                id,
                name: name.to_string(),
                path: path.to_string(),
                is_calibre,
                calibre_db_path: calibre_db_path.map(String::from),
                last_scan: None,
                watch_enabled: true,
                book_count: 0,
                accessible: true, // Just added, so path must exist
            })
        })
    }
    
    /// Remove a library (books are NOT deleted)
    pub fn remove_library(&self, id: i64) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM libraries WHERE id = ?", [id])?;
            Ok(())
        })
    }
    
    /// Update library last scan time
    pub fn update_library_scan_time(&self, id: i64) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE libraries SET last_scan = strftime('%s', 'now') WHERE id = ?",
                [id],
            )?;
            Ok(())
        })
    }
    
    // ============================================
    // BOOK OPERATIONS
    // ============================================
    
    /// Query books with filtering and pagination
    pub fn query_books(&self, query: &BookQuery) -> AppResult<PagedResult<Book>> {
        self.with_conn(|conn| {
            let mut sql = String::from(
                "SELECT b.*, r.rating, r.read_status 
                 FROM books b 
                 LEFT JOIN ratings r ON b.id = r.book_id"
            );
            
            let mut conditions = Vec::new();
            let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            
            // FTS search
            if let Some(ref search) = query.search {
                if !search.is_empty() {
                    conditions.push("b.id IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)");
                    params_vec.push(Box::new(search.clone()));
                }
            }
            
            // Author filter
            if let Some(ref author) = query.author {
                conditions.push("b.author = ?");
                params_vec.push(Box::new(author.clone()));
            }
            
            // Series filter
            if let Some(ref series) = query.series {
                conditions.push("b.series = ?");
                params_vec.push(Box::new(series.clone()));
            }
            
            // Read status filter
            if let Some(ref status) = query.read_status {
                conditions.push("r.read_status = ?");
                params_vec.push(Box::new(status.clone()));
            }
            
            // Min rating filter
            if let Some(min_rating) = query.min_rating {
                conditions.push("r.rating >= ?");
                params_vec.push(Box::new(min_rating));
            }
            
            // Embedding status filter
            if let Some(ref status) = query.embedding_status {
                conditions.push("b.embedding_status = ?");
                params_vec.push(Box::new(status.clone()));
            }
            
            // Build WHERE clause
            if !conditions.is_empty() {
                sql.push_str(" WHERE ");
                sql.push_str(&conditions.join(" AND "));
            }
            
            // Count total
            let count_sql = format!("SELECT COUNT(*) FROM ({}) AS subq", sql);
            let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
            let total: i64 = conn.query_row(&count_sql, params_refs.as_slice(), |row| row.get(0))?;
            
            // Sorting
            let sort_by = query.sort_by.as_deref().unwrap_or("date_added");
            let sort_order = query.sort_order.as_deref().unwrap_or("desc");
            let sort_column = match sort_by {
                "title" => "b.sort_title",
                "author" => "b.author_sort",
                "dateAdded" | "date_added" => "b.date_added",
                "rating" => "r.rating",
                "series" => "b.series, b.series_index",
                _ => "b.date_added",
            };
            sql.push_str(&format!(" ORDER BY {} {}", sort_column, sort_order.to_uppercase()));
            
            // Pagination
            let limit = query.limit.unwrap_or(50).min(1000);
            let offset = query.offset.unwrap_or(0);
            sql.push_str(&format!(" LIMIT {} OFFSET {}", limit, offset));
            
            // Execute query
            let mut stmt = conn.prepare(&sql)?;
            let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
            
            let books = stmt.query_map(params_refs.as_slice(), row_to_book)?
                .collect::<Result<Vec<_>, _>>()?;
            
            let has_more = (offset + limit) < total;
            
            Ok(PagedResult { items: books, total, has_more })
        })
    }
    
    /// Get a single book by ID
    pub fn get_book(&self, id: i64) -> AppResult<Book> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT b.*, r.rating, r.read_status 
                 FROM books b 
                 LEFT JOIN ratings r ON b.id = r.book_id
                 WHERE b.id = ?",
                [id],
                row_to_book,
            ).map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => AppError::NotFound(format!("Book {} not found", id)),
                _ => AppError::Database(e),
            })
        })
    }
    
    /// Get a book by path
    pub fn get_book_by_path(&self, path: &str) -> AppResult<Option<Book>> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT b.*, r.rating, r.read_status 
                 FROM books b 
                 LEFT JOIN ratings r ON b.id = r.book_id
                 WHERE b.path = ?",
                [path],
                row_to_book,
            ).optional().map_err(AppError::Database)
        })
    }
    
    /// Insert a new book
    pub fn insert_book(&self, book: &NewBook) -> AppResult<i64> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO books (path, cover_path, file_size, file_hash, title, sort_title, 
                                   author, author_sort, series, series_index, description, 
                                   language, publisher, publish_date, isbn, source)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    book.path,
                    book.cover_path,
                    book.file_size,
                    book.file_hash,
                    book.title,
                    book.sort_title,
                    book.author,
                    book.author_sort,
                    book.series,
                    book.series_index,
                    book.description,
                    book.language,
                    book.publisher,
                    book.publish_date,
                    book.isbn,
                    book.source,
                ],
            )?;
            
            Ok(conn.last_insert_rowid())
        })
    }
    
    /// Insert multiple books in a batch (for scanning)
    pub fn insert_books_batch(&self, books: &[NewBook]) -> AppResult<Vec<i64>> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        
        let mut ids = Vec::with_capacity(books.len());
        
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO books (path, cover_path, file_size, file_hash, title, sort_title, 
                                              author, author_sort, series, series_index, description, 
                                              language, publisher, publish_date, isbn, source)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            )?;
            
            for book in books {
                stmt.execute(params![
                    book.path,
                    book.cover_path,
                    book.file_size,
                    book.file_hash,
                    book.title,
                    book.sort_title,
                    book.author,
                    book.author_sort,
                    book.series,
                    book.series_index,
                    book.description,
                    book.language,
                    book.publisher,
                    book.publish_date,
                    book.isbn,
                    book.source,
                ])?;
                ids.push(tx.last_insert_rowid());
            }
        }
        
        tx.commit()?;
        Ok(ids)
    }
    
    /// Update a book
    pub fn update_book(&self, id: i64, updates: &BookUpdate) -> AppResult<()> {
        self.with_conn(|conn| {
            let mut sets = Vec::new();
            let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            
            if let Some(ref title) = updates.title {
                sets.push("title = ?");
                params_vec.push(Box::new(title.clone()));
            }
            if let Some(ref author) = updates.author {
                sets.push("author = ?");
                params_vec.push(Box::new(author.clone()));
            }
            if let Some(ref series) = updates.series {
                sets.push("series = ?");
                params_vec.push(Box::new(series.clone()));
            }
            if let Some(series_index) = updates.series_index {
                sets.push("series_index = ?");
                params_vec.push(Box::new(series_index));
            }
            if let Some(ref description) = updates.description {
                sets.push("description = ?");
                params_vec.push(Box::new(description.clone()));
            }
            
            if sets.is_empty() {
                return Ok(());
            }
            
            sets.push("date_modified = strftime('%s', 'now')");
            params_vec.push(Box::new(id));
            
            let sql = format!("UPDATE books SET {} WHERE id = ?", sets.join(", "));
            let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
            
            conn.execute(&sql, params_refs.as_slice())?;
            Ok(())
        })
    }
    
    /// Delete a book
    pub fn delete_book(&self, id: i64) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM books WHERE id = ?", [id])?;
            Ok(())
        })
    }
    
    // ============================================
    // RATINGS OPERATIONS
    // ============================================
    
    /// Set book rating
    pub fn set_rating(&self, book_id: i64, rating: i32) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO ratings (book_id, rating, date_rated) 
                 VALUES (?, ?, strftime('%s', 'now'))
                 ON CONFLICT(book_id) DO UPDATE SET rating = ?, date_rated = strftime('%s', 'now')",
                params![book_id, rating, rating],
            )?;
            Ok(())
        })
    }
    
    /// Set read status
    pub fn set_read_status(&self, book_id: i64, status: &str) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO ratings (book_id, read_status, date_rated) 
                 VALUES (?, ?, strftime('%s', 'now'))
                 ON CONFLICT(book_id) DO UPDATE SET read_status = ?, date_rated = strftime('%s', 'now')",
                params![book_id, status, status],
            )?;
            Ok(())
        })
    }
    
    // ============================================
    // GRAPH OPERATIONS
    // ============================================
    
    /// Insert or update a graph edge
    pub fn upsert_edge(&self, edge: &BookEdge) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO book_edges (source_id, target_id, edge_type, weight, model_version)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(source_id, target_id, edge_type) DO UPDATE SET 
                    weight = ?, computed_at = strftime('%s', 'now'), model_version = ?",
                params![
                    edge.source_id, edge.target_id, edge.edge_type, edge.weight, edge.model_version,
                    edge.weight, edge.model_version
                ],
            )?;
            Ok(())
        })
    }
    
    /// Get edges for a book
    pub fn get_edges(&self, book_id: i64, min_weight: f64) -> AppResult<Vec<BookEdge>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT source_id, target_id, edge_type, weight, computed_at, model_version
                 FROM book_edges
                 WHERE (source_id = ? OR target_id = ?) AND weight >= ?
                 ORDER BY weight DESC"
            )?;
            
            let edges = stmt.query_map(params![book_id, book_id, min_weight], |row| {
                Ok(BookEdge {
                    source_id: row.get(0)?,
                    target_id: row.get(1)?,
                    edge_type: row.get(2)?,
                    weight: row.get(3)?,
                    computed_at: row.get(4)?,
                    model_version: row.get(5)?,
                })
            })?.collect::<Result<Vec<_>, _>>()?;
            
            Ok(edges)
        })
    }
    
    // ============================================
    // SETTINGS OPERATIONS
    // ============================================
    
    /// Get all settings
    pub fn get_settings(&self) -> AppResult<Settings> {
        self.with_conn(|conn| {
            let mut settings = Settings::default();
            
            let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            
            for row in rows {
                let (key, value) = row?;
                match key.as_str() {
                    "ollama_endpoint" => settings.ollama_endpoint = value,
                    "ollama_model" => settings.ollama_model = value,
                    "embedding_batch_size" => settings.embedding_batch_size = value.parse().unwrap_or(10),
                    "max_recommendations" => settings.max_recommendations = value.parse().unwrap_or(20),
                    "auto_scan_enabled" => settings.auto_scan_enabled = value == "1",
                    "scan_interval_minutes" => settings.scan_interval_minutes = value.parse().unwrap_or(60),
                    _ => {}
                }
            }
            
            Ok(settings)
        })
    }
    
    /// Update a setting
    pub fn update_setting(&self, key: &str, value: &str) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s', 'now'))
                 ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = strftime('%s', 'now')",
                params![key, value, value],
            )?;
            Ok(())
        })
    }
    
    // ============================================
    // EMBEDDING OPERATIONS
    // ============================================

    /// Update embedding status for a book
    pub fn update_embedding_status(&self, book_id: i64, status: &str) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE books SET embedding_status = ?, date_indexed = strftime('%s', 'now') WHERE id = ?",
                params![status, book_id],
            )?;
            Ok(())
        })
    }

    /// Reset all embedding statuses to pending (used when clearing embeddings)
    pub fn reset_all_embedding_statuses(&self) -> AppResult<i64> {
        self.with_conn(|conn| {
            let updated = conn.execute(
                "UPDATE books SET embedding_status = 'pending', embedding_model = NULL, date_indexed = NULL",
                [],
            )?;
            Ok(updated as i64)
        })
    }

    /// Get books pending embedding generation
    pub fn get_pending_embedding_books(&self, limit: i64) -> AppResult<Vec<i64>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id FROM books WHERE embedding_status = 'pending' ORDER BY date_added DESC LIMIT ?"
            )?;
            let ids = stmt.query_map([limit], |row| row.get(0))?
                .collect::<Result<Vec<i64>, _>>()?;
            Ok(ids)
        })
    }

    /// Get books needing metadata parsing (no description, not failed/skipped)
    pub fn get_books_needing_metadata(&self, limit: i64) -> AppResult<Vec<(i64, String)>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, path FROM books
                 WHERE (description IS NULL OR description = '')
                 AND (embedding_status IS NULL OR embedding_status = '')
                 ORDER BY date_added DESC
                 LIMIT ?"
            )?;
            let results = stmt.query_map([limit], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?.collect::<Result<Vec<_>, _>>()?;
            Ok(results)
        })
    }

    /// Get all book IDs and paths for cleanup checking
    pub fn get_all_book_paths(&self) -> AppResult<Vec<(i64, String)>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT id, path FROM books")?;
            let results = stmt.query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?.collect::<Result<Vec<_>, _>>()?;
            Ok(results)
        })
    }

    /// Update book metadata from EPUB parsing
    pub fn update_book_metadata(
        &self,
        id: i64,
        title: Option<&str>,
        author: Option<&str>,
        author_sort: Option<&str>,
        description: Option<&str>,
        series: Option<&str>,
        series_index: Option<f64>,
        language: Option<&str>,
        publisher: Option<&str>,
        publish_date: Option<&str>,
        isbn: Option<&str>,
    ) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE books SET
                    title = COALESCE(?, title),
                    author = COALESCE(?, author),
                    author_sort = COALESCE(?, author_sort),
                    description = COALESCE(?, description),
                    series = COALESCE(?, series),
                    series_index = COALESCE(?, series_index),
                    language = COALESCE(?, language),
                    publisher = COALESCE(?, publisher),
                    publish_date = COALESCE(?, publish_date),
                    isbn = COALESCE(?, isbn),
                    date_modified = strftime('%s', 'now')
                 WHERE id = ?",
                params![title, author, author_sort, description, series, series_index,
                        language, publisher, publish_date, isbn, id],
            )?;
            Ok(())
        })
    }

    /// Insert multiple edges in a batch
    pub fn insert_edges_batch(&self, edges: &[(i64, i64, String, f64)]) -> AppResult<()> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;

        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO book_edges (source_id, target_id, edge_type, weight)
                 VALUES (?, ?, ?, ?)"
            )?;

            for (source, target, edge_type, weight) in edges {
                stmt.execute(params![source, target, edge_type, weight])?;
            }
        }

        tx.commit()?;
        Ok(())
    }

    // ============================================
    // STATISTICS
    // ============================================

    // ============================================
    // UP NEXT OPERATIONS
    // ============================================

    /// Get all books in the Up Next queue
    pub fn get_up_next_books(&self) -> AppResult<Vec<Book>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT b.*, r.rating, r.read_status
                 FROM books b
                 LEFT JOIN ratings r ON b.id = r.book_id
                 INNER JOIN up_next un ON b.id = un.book_id
                 ORDER BY un.position ASC, un.added_at ASC"
            )?;

            let books = stmt.query_map([], row_to_book)?
                .collect::<Result<Vec<_>, _>>()?;

            Ok(books)
        })
    }

    /// Add a book to the Up Next queue
    pub fn add_to_up_next(&self, book_id: i64) -> AppResult<()> {
        self.with_conn(|conn| {
            // Get the next position (max + 1)
            let next_position: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(position), -1) + 1 FROM up_next",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(0);

            conn.execute(
                "INSERT OR IGNORE INTO up_next (book_id, position) VALUES (?, ?)",
                params![book_id, next_position],
            )?;
            Ok(())
        })
    }

    /// Remove a book from the Up Next queue
    pub fn remove_from_up_next(&self, book_id: i64) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM up_next WHERE book_id = ?", [book_id])?;
            Ok(())
        })
    }

    /// Check if a book is in the Up Next queue
    pub fn is_in_up_next(&self, book_id: i64) -> AppResult<bool> {
        self.with_conn(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM up_next WHERE book_id = ?",
                [book_id],
                |row| row.get(0),
            )?;
            Ok(count > 0)
        })
    }

    /// Get the count of books in the Up Next queue
    pub fn get_up_next_count(&self) -> AppResult<i64> {
        self.with_conn(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM up_next",
                [],
                |row| row.get(0),
            )?;
            Ok(count)
        })
    }

    /// Get books with "want" read status (for automatic Up Next inclusion)
    pub fn get_want_to_read_books(&self) -> AppResult<Vec<Book>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT b.*, r.rating, r.read_status
                 FROM books b
                 LEFT JOIN ratings r ON b.id = r.book_id
                 WHERE r.read_status = 'want'
                 ORDER BY r.date_rated DESC"
            )?;

            let books = stmt.query_map([], row_to_book)?
                .collect::<Result<Vec<_>, _>>()?;

            Ok(books)
        })
    }

    // ============================================
    // STATISTICS
    // ============================================

    /// Get library statistics
    pub fn get_stats(&self) -> AppResult<LibraryStats> {
        self.with_conn(|conn| {
            let total_books: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))?;
            let total_authors: i64 = conn.query_row("SELECT COUNT(DISTINCT author) FROM books WHERE author IS NOT NULL", [], |r| r.get(0))?;
            let total_series: i64 = conn.query_row("SELECT COUNT(DISTINCT series) FROM books WHERE series IS NOT NULL", [], |r| r.get(0))?;
            let books_with_embeddings: i64 = conn.query_row("SELECT COUNT(*) FROM books WHERE embedding_status = 'complete'", [], |r| r.get(0))?;
            let pending_embeddings: i64 = conn.query_row("SELECT COUNT(*) FROM books WHERE embedding_status = 'pending'", [], |r| r.get(0))?;
            let books_needing_metadata: i64 = conn.query_row(
                "SELECT COUNT(*) FROM books
                 WHERE (description IS NULL OR description = '')
                 AND (embedding_status IS NULL OR embedding_status = '')",
                [],
                |r| r.get(0)
            )?;

            Ok(LibraryStats {
                total_books,
                total_authors,
                total_series,
                books_with_embeddings,
                pending_embeddings,
                books_needing_metadata,
            })
        })
    }
}

// ============================================
// HELPER TYPES AND FUNCTIONS
// ============================================

/// New book data for insertion
#[derive(Debug, Clone)]
pub struct NewBook {
    pub path: String,
    pub cover_path: Option<String>,
    pub file_size: i64,
    pub file_hash: Option<String>,
    pub title: String,
    pub sort_title: Option<String>,
    pub author: Option<String>,
    pub author_sort: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    pub description: Option<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub publish_date: Option<String>,
    pub isbn: Option<String>,
    pub source: String,
}

/// Book update data
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookUpdate {
    pub title: Option<String>,
    pub author: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    pub description: Option<String>,
}

/// Library statistics
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub total_books: i64,
    pub total_authors: i64,
    pub total_series: i64,
    pub books_with_embeddings: i64,
    pub pending_embeddings: i64,
    pub books_needing_metadata: i64,
}

/// Convert a database row to a Book struct
fn row_to_book(row: &Row<'_>) -> rusqlite::Result<Book> {
    Ok(Book {
        id: row.get(0)?,
        path: row.get(1)?,
        cover_path: row.get(2)?,
        file_size: row.get(3)?,
        file_hash: row.get(4)?,
        title: row.get(5)?,
        sort_title: row.get(6)?,
        author: row.get(7)?,
        author_sort: row.get(8)?,
        series: row.get(9)?,
        series_index: row.get(10)?,
        description: row.get(11)?,
        language: row.get(12)?,
        publisher: row.get(13)?,
        publish_date: row.get(14)?,
        isbn: row.get(15)?,
        calibre_id: row.get(16)?,
        source: row.get(17)?,
        date_added: row.get(18)?,
        date_modified: row.get(19)?,
        date_indexed: row.get(20)?,
        embedding_status: row.get(21)?,
        embedding_model: row.get(22)?,
        rating: row.get(23)?,
        read_status: row.get(24)?,
    })
}

// Extension trait for optional query results
trait OptionalExt<T> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error>;
}

impl<T> OptionalExt<T> for Result<T, rusqlite::Error> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}
