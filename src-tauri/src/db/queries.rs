//! Database query functions

use super::{Book, BookEdge, BookQuery, Database, Library, PagedResult, Settings};
use crate::{AppError, AppResult};
use rusqlite::{params, Row};

/// Explicit column list for book queries (excludes chapter_titles_json added in v3).
/// Must match the order expected by `row_to_book`.
const BOOK_COLUMNS: &str = "b.id, b.path, b.cover_path, b.file_size, b.file_hash,
    b.title, b.sort_title, b.author, b.author_sort,
    b.series, b.series_index, b.description, b.language,
    b.publisher, b.publish_date, b.isbn, b.calibre_id,
    b.source, b.date_added, b.date_modified, b.date_indexed,
    b.embedding_status, b.embedding_model, b.hidden";

/// How many times an embedding may fail before the book is left alone.
/// Bounded so a genuinely un-embeddable book cannot spin forever, but high
/// enough that transient outages (Ollama restart, model swap) always recover.
pub const MAX_EMBEDDING_ATTEMPTS: i64 = 3;

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
    /// When searching, uses FTS5 bm25() ranking with column weights:
    /// title=10, author=5, series=3, description=1
    pub fn query_books(&self, query: &BookQuery) -> AppResult<PagedResult<Book>> {
        self.with_conn(|conn| {
            let mut conditions = Vec::new();
            let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            let mut is_search = false;

            // Check if we have a search query
            let search_term = query.search.as_ref().filter(|s| !s.is_empty());

            // Build base SQL - different structure when searching (JOIN with FTS for ranking)
            let base_sql = if let Some(search) = search_term {
                is_search = true;
                // Escape quotes in search term and wrap for phrase matching with prefix
                let escaped = search.replace("\"", "\"\"");
                params_vec.push(Box::new(format!("\"{}\"*", escaped)));

                // JOIN with FTS for ranking using bm25()
                // Column order in FTS: title, author, series, description
                // Weights: title=10, author=5, series=3, description=1
                // bm25() returns negative values where lower = better match
                String::from(
                    "SELECT b.id, b.path, b.cover_path, b.file_size, b.file_hash,
                            b.title, b.sort_title, b.author, b.author_sort,
                            b.series, b.series_index, b.description, b.language,
                            b.publisher, b.publish_date, b.isbn, b.calibre_id,
                            b.source, b.date_added, b.date_modified, b.date_indexed,
                            b.embedding_status, b.embedding_model, b.hidden,
                            r.rating, r.read_status,
                            bm25(books_fts, 10.0, 5.0, 3.0, 1.0) as rank
                     FROM books b
                     LEFT JOIN ratings r ON b.id = r.book_id
                     INNER JOIN books_fts ON b.id = books_fts.rowid
                     WHERE books_fts MATCH ?"
                )
            } else {
                String::from(
                    "SELECT b.id, b.path, b.cover_path, b.file_size, b.file_hash,
                            b.title, b.sort_title, b.author, b.author_sort,
                            b.series, b.series_index, b.description, b.language,
                            b.publisher, b.publish_date, b.isbn, b.calibre_id,
                            b.source, b.date_added, b.date_modified, b.date_indexed,
                            b.embedding_status, b.embedding_model, b.hidden,
                            r.rating, r.read_status
                     FROM books b
                     LEFT JOIN ratings r ON b.id = r.book_id"
                )
            };

            let mut sql = base_sql;

            // Hidden filter (exclude hidden books by default)
            if !query.show_hidden.unwrap_or(false) {
                conditions.push("b.hidden = 0");
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

            // Build WHERE/AND clause for additional conditions
            if !conditions.is_empty() {
                // If searching, we already have WHERE from the FTS MATCH
                sql.push_str(if is_search { " AND " } else { " WHERE " });
                sql.push_str(&conditions.join(" AND "));
            }

            // Count total (need to remove rank column for count query when searching)
            let count_sql = if is_search {
                format!("SELECT COUNT(*) FROM ({}) AS subq", sql.replace(", bm25(books_fts, 10.0, 5.0, 3.0, 1.0) as rank", ""))
            } else {
                format!("SELECT COUNT(*) FROM ({}) AS subq", sql)
            };
            let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
            let total: i64 = conn.query_row(&count_sql, params_refs.as_slice(), |row| row.get(0))?;

            // Sorting - use rank for search queries, otherwise use user's sort preference
            if is_search {
                // bm25 returns negative values, lower = better match, so ORDER BY rank ASC
                sql.push_str(" ORDER BY rank");
            } else {
                let sort_by = query.sort_by.as_deref().unwrap_or("date_added");
                let sort_order = match query.sort_order.as_deref().unwrap_or("desc") {
                    "asc" | "ASC" => "ASC",
                    _ => "DESC",
                };
                let order_clause = if sort_by == "random" {
                    let seed = query.seed.unwrap_or(42);
                    format!(" ORDER BY ((b.id * {}) % 2147483647)", seed)
                } else {
                    let sort_column = match sort_by {
                        "title" => "b.sort_title",
                        "author" => "b.author_sort",
                        "dateAdded" | "date_added" => "b.date_added",
                        "rating" => "r.rating",
                        "series" => "b.series, b.series_index",
                        "publishDate" | "publish_date" => "b.publish_date",
                        _ => "b.date_added",
                    };
                    format!(" ORDER BY {} {}", sort_column, sort_order)
                };
                sql.push_str(&order_clause);
            }

            // Pagination
            let limit = query.limit.unwrap_or(50).min(1000);
            let offset = query.offset.unwrap_or(0);
            sql.push_str(&format!(" LIMIT {} OFFSET {}", limit, offset));

            // Execute query
            let mut stmt = conn.prepare(&sql)?;
            let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

            // Use row_to_book which reads columns by index - we've explicitly listed
            // the columns in the same order for both search and non-search queries
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
                &format!("SELECT {}, r.rating, r.read_status
                 FROM books b
                 LEFT JOIN ratings r ON b.id = r.book_id
                 WHERE b.id = ?", BOOK_COLUMNS),
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
                &format!("SELECT {}, r.rating, r.read_status
                 FROM books b
                 LEFT JOIN ratings r ON b.id = r.book_id
                 WHERE b.path = ?", BOOK_COLUMNS),
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

    /// Set the hidden flag on a book
    pub fn set_book_hidden(&self, id: i64, hidden: bool) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE books SET hidden = ? WHERE id = ?",
                params![hidden as i32, id],
            )?;
            Ok(())
        })
    }

    /// Set the hidden flag on all books by an author, returns affected count
    pub fn set_books_hidden_by_author(&self, author: &str, hidden: bool) -> AppResult<i64> {
        self.with_conn(|conn| {
            let affected = conn.execute(
                "UPDATE books SET hidden = ? WHERE author = ?",
                params![hidden as i32, author],
            )?;
            Ok(affected as i64)
        })
    }

    /// Get all book IDs and paths for an author (for batch delete + trash)
    pub fn get_books_by_author(&self, author: &str) -> AppResult<Vec<(i64, String)>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, path FROM books WHERE author = ?"
            )?;
            let results = stmt.query_map([author], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
            Ok(results)
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
                    "ollama_chat_model" => settings.ollama_chat_model = value,
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
    // SUMMARY OPERATIONS
    // ============================================

    /// Store an LLM-generated summary for a book
    pub fn store_book_summary(&self, book_id: i64, summary: &str, model: &str, text_hash: Option<&str>) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO book_summaries (book_id, summary, model, text_hash)
                 VALUES (?, ?, ?, ?)",
                params![book_id, summary, model, text_hash],
            )?;
            Ok(())
        })
    }

    /// Get the LLM-generated summary for a book
    pub fn get_book_summary(&self, book_id: i64) -> AppResult<Option<String>> {
        self.with_conn(|conn| {
            let result = conn.query_row(
                "SELECT summary FROM book_summaries WHERE book_id = ?",
                [book_id],
                |row| row.get::<_, String>(0),
            );
            match result {
                Ok(summary) => Ok(Some(summary)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(AppError::Database(e)),
            }
        })
    }

    // ============================================
    // EMBEDDING OPERATIONS
    // ============================================

    /// Update embedding status for a book
    pub fn update_embedding_status(&self, book_id: i64, status: &str) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE books
                 SET embedding_status = ?,
                     embedding_attempts = CASE WHEN ? = 'complete' THEN 0 ELSE embedding_attempts END,
                     date_indexed = strftime('%s', 'now')
                 WHERE id = ?",
                params![status, status, book_id],
            )?;
            Ok(())
        })
    }

    /// Reset all embedding statuses to pending (used when clearing embeddings)
    pub fn reset_all_embedding_statuses(&self) -> AppResult<i64> {
        self.with_conn(|conn| {
            let updated = conn.execute(
                "UPDATE books SET embedding_status = 'pending', embedding_model = NULL, date_indexed = NULL, embedding_attempts = 0",
                [],
            )?;
            Ok(updated as i64)
        })
    }

    /// Get books pending embedding generation.
    ///
    /// Also picks up previously-failed books that still have attempts left, but
    /// orders them strictly after the never-tried ones (`embedding_status =
    /// 'failed'` sorts 0 before 1 in SQLite) so a book that fails repeatedly can
    /// never head-of-line block the 56k-deep pending queue.
    pub fn get_pending_embedding_books(&self, limit: i64) -> AppResult<Vec<i64>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id FROM books
                 WHERE embedding_status = 'pending'
                    OR (embedding_status = 'failed' AND embedding_attempts < ?)
                 ORDER BY embedding_status = 'failed', hidden ASC, date_added DESC
                 LIMIT ?"
            )?;
            let ids = stmt.query_map(params![MAX_EMBEDDING_ATTEMPTS, limit], |row| row.get(0))?
                .collect::<Result<Vec<i64>, _>>()?;
            Ok(ids)
        })
    }

    /// Record a failed embedding attempt, incrementing the bounded retry counter.
    ///
    /// Use this rather than `update_embedding_status(id, "failed")` so the book
    /// stays eligible for retry until it has burned MAX_EMBEDDING_ATTEMPTS.
    pub fn mark_embedding_failed(&self, book_id: i64) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE books
                 SET embedding_status = 'failed',
                     embedding_attempts = embedding_attempts + 1,
                     date_indexed = strftime('%s', 'now')
                 WHERE id = ?",
                [book_id],
            )?;
            Ok(())
        })
    }

    /// Books that have exhausted their retries and need manual attention.
    pub fn count_exhausted_embedding_books(&self) -> AppResult<i64> {
        self.with_conn(|conn| {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM books
                 WHERE embedding_status = 'failed' AND embedding_attempts >= ?",
                [MAX_EMBEDDING_ATTEMPTS],
                |r| r.get(0),
            )?;
            Ok(n)
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
    // TAG OPERATIONS
    // ============================================

    /// Store tags for a book (inserts tag if not exists, then links)
    pub fn store_book_tags(&self, book_id: i64, tags: &[String]) -> AppResult<()> {
        if tags.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;

        for tag_name in tags {
            let trimmed = tag_name.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Insert tag if not exists
            tx.execute(
                "INSERT OR IGNORE INTO tags (name) VALUES (?)",
                params![trimmed],
            )?;
            // Get tag id
            let tag_id: i64 = tx.query_row(
                "SELECT id FROM tags WHERE name = ?",
                params![trimmed],
                |row| row.get(0),
            )?;
            // Link book to tag
            tx.execute(
                "INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)",
                params![book_id, tag_id],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    /// Store chapter titles for a book (as JSON in chapter_titles_json column)
    pub fn store_book_chapter_titles(&self, book_id: i64, titles: &[String]) -> AppResult<()> {
        if titles.is_empty() {
            return Ok(());
        }
        let json = serde_json::to_string(titles)
            .map_err(|e| AppError::InvalidInput(format!("JSON serialize error: {}", e)))?;
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE books SET chapter_titles_json = ? WHERE id = ?",
                params![json, book_id],
            )?;
            Ok(())
        })
    }

    /// Get chapter titles for a book
    pub fn get_book_chapter_titles(&self, book_id: i64) -> AppResult<Vec<String>> {
        self.with_conn(|conn| {
            let json: Option<String> = conn.query_row(
                "SELECT chapter_titles_json FROM books WHERE id = ?",
                [book_id],
                |row| row.get(0),
            ).unwrap_or(None);

            match json {
                Some(j) if !j.is_empty() => {
                    serde_json::from_str(&j)
                        .map_err(|e| AppError::InvalidInput(format!("JSON parse error: {}", e)))
                }
                _ => Ok(vec![]),
            }
        })
    }

    /// Get tags for a book
    pub fn get_book_tags(&self, book_id: i64) -> AppResult<Vec<String>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT t.name FROM tags t
                 INNER JOIN book_tags bt ON t.id = bt.tag_id
                 WHERE bt.book_id = ?
                 ORDER BY t.name"
            )?;
            let tags = stmt.query_map([book_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(tags)
        })
    }

    // ============================================
    // UP NEXT OPERATIONS
    // ============================================

    /// Get all books in the Up Next queue
    pub fn get_up_next_books(&self) -> AppResult<Vec<Book>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                &format!("SELECT {}, r.rating, r.read_status
                 FROM books b
                 LEFT JOIN ratings r ON b.id = r.book_id
                 INNER JOIN up_next un ON b.id = un.book_id
                 ORDER BY un.position ASC, un.added_at ASC", BOOK_COLUMNS)
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
                &format!("SELECT {}, r.rating, r.read_status
                 FROM books b
                 LEFT JOIN ratings r ON b.id = r.book_id
                 WHERE r.read_status = 'want'
                 ORDER BY r.date_rated DESC", BOOK_COLUMNS)
            )?;

            let books = stmt.query_map([], row_to_book)?
                .collect::<Result<Vec<_>, _>>()?;

            Ok(books)
        })
    }

    /// Get books rated at or above a minimum rating
    pub fn get_highly_rated_books(&self, min_rating: i32, limit: i64) -> AppResult<Vec<Book>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                &format!("SELECT {}, r.rating, r.read_status
                 FROM books b
                 INNER JOIN ratings r ON b.id = r.book_id
                 WHERE r.rating >= ?
                 ORDER BY r.rating DESC, r.date_rated DESC
                 LIMIT ?", BOOK_COLUMNS)
            )?;

            let books = stmt.query_map(params![min_rating, limit], row_to_book)?
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
            // Must mirror get_pending_embedding_books' WHERE clause exactly: the
            // UI loop halts when this reaches 0, so if retryable failures were
            // excluded here they would be queued but never actually retried.
            let pending_embeddings: i64 = conn.query_row(
                "SELECT COUNT(*) FROM books
                 WHERE embedding_status = 'pending'
                    OR (embedding_status = 'failed' AND embedding_attempts < ?)",
                [MAX_EMBEDDING_ATTEMPTS],
                |r| r.get(0),
            )?;
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
    /// dc:subject tags extracted from EPUB metadata
    pub subjects: Vec<String>,
    /// Chapter titles extracted from EPUB TOC/nav
    pub chapter_titles: Vec<String>,
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
        hidden: row.get(23)?,
        rating: row.get(24)?,
        read_status: row.get(25)?,
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
