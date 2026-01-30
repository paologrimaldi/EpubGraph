//! File system watcher for automatic library updates
//!
//! Monitors library directories for changes and triggers incremental updates.

use crate::db::Database;
use crate::epub::EpubParser;
use crate::AppResult;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::time::Duration;
use parking_lot::RwLock;

/// File system watcher for library directories
pub struct LibraryWatcher {
    watcher: Option<RecommendedWatcher>,
    watched_paths: Arc<RwLock<HashSet<PathBuf>>>,
    event_receiver: Option<Receiver<Result<Event, notify::Error>>>,
}

impl LibraryWatcher {
    /// Create a new library watcher
    pub fn new() -> AppResult<Self> {
        Ok(Self {
            watcher: None,
            watched_paths: Arc::new(RwLock::new(HashSet::new())),
            event_receiver: None,
        })
    }

    /// Start watching with event channel
    pub fn start(&mut self) -> AppResult<()> {
        let (tx, rx) = channel();

        let watcher = RecommendedWatcher::new(
            move |res| {
                let _ = tx.send(res);
            },
            Config::default().with_poll_interval(Duration::from_secs(2)),
        )
        .map_err(|e| crate::AppError::Config(format!("Failed to create watcher: {}", e)))?;

        self.watcher = Some(watcher);
        self.event_receiver = Some(rx);

        tracing::info!("File watcher started");
        Ok(())
    }

    /// Add a library path to watch
    pub fn watch_path(&mut self, path: &Path) -> AppResult<()> {
        if let Some(ref mut watcher) = self.watcher {
            watcher
                .watch(path, RecursiveMode::Recursive)
                .map_err(|e| crate::AppError::Config(format!("Failed to watch path: {}", e)))?;

            self.watched_paths.write().insert(path.to_path_buf());
            tracing::info!("Now watching: {:?}", path);
        }
        Ok(())
    }

    /// Remove a library path from watching
    pub fn unwatch_path(&mut self, path: &Path) -> AppResult<()> {
        if let Some(ref mut watcher) = self.watcher {
            let _ = watcher.unwatch(path);
            self.watched_paths.write().remove(path);
            tracing::info!("Stopped watching: {:?}", path);
        }
        Ok(())
    }

    /// Process pending events (non-blocking)
    pub fn process_events(&self, db: &Database) -> Vec<WatcherEvent> {
        let mut events = Vec::new();

        if let Some(ref rx) = self.event_receiver {
            // Drain all available events
            while let Ok(result) = rx.try_recv() {
                match result {
                    Ok(event) => {
                        if let Some(watch_event) = self.process_notify_event(event) {
                            events.push(watch_event);
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Watch error: {:?}", e);
                    }
                }
            }
        }

        // Process events and update database
        for event in &events {
            if let Err(e) = self.handle_event(event, db) {
                tracing::error!("Failed to handle watch event: {}", e);
            }
        }

        events
    }

    /// Convert notify event to our event type
    fn process_notify_event(&self, event: Event) -> Option<WatcherEvent> {
        let paths: Vec<_> = event
            .paths
            .into_iter()
            .filter(|p| is_epub_file(p))
            .collect();

        if paths.is_empty() {
            return None;
        }

        match event.kind {
            EventKind::Create(_) => Some(WatcherEvent::FileCreated(paths)),
            EventKind::Modify(_) => Some(WatcherEvent::FileModified(paths)),
            EventKind::Remove(_) => Some(WatcherEvent::FileDeleted(paths)),
            _ => None,
        }
    }

    /// Handle a watcher event
    fn handle_event(&self, event: &WatcherEvent, db: &Database) -> AppResult<()> {
        match event {
            WatcherEvent::FileCreated(paths) => {
                let parser = EpubParser::new();
                for path in paths {
                    // Check if already in database
                    if db.get_book_by_path(path.to_string_lossy().as_ref())?.is_some() {
                        continue;
                    }

                    // Parse and insert new book
                    match parser.parse(path) {
                        Ok(new_book) => {
                            if let Ok(id) = db.insert_book(&new_book) {
                                tracing::info!("Added new book from watcher: {} (id: {})", new_book.title, id);
                            }
                        }
                        Err(e) => {
                            tracing::warn!("Failed to parse new EPUB {:?}: {}", path, e);
                        }
                    }
                }
            }
            WatcherEvent::FileModified(paths) => {
                let parser = EpubParser::new();
                for path in paths {
                    let path_str = path.to_string_lossy();

                    // Check if in database
                    if let Some(existing) = db.get_book_by_path(&path_str)? {
                        // Re-parse and update metadata
                        if let Ok(new_book) = parser.parse(path) {
                            let update = crate::db::BookUpdate {
                                title: Some(new_book.title),
                                author: new_book.author,
                                series: new_book.series,
                                series_index: new_book.series_index,
                                description: new_book.description,
                            };
                            if let Err(e) = db.update_book(existing.id, &update) {
                                tracing::warn!("Failed to update book {}: {}", existing.id, e);
                            } else {
                                tracing::info!("Updated book from watcher: {}", existing.title);
                            }
                        }
                    }
                }
            }
            WatcherEvent::FileDeleted(paths) => {
                for path in paths {
                    let path_str = path.to_string_lossy();

                    // Remove from database
                    if let Some(existing) = db.get_book_by_path(&path_str)? {
                        if let Err(e) = db.delete_book(existing.id) {
                            tracing::warn!("Failed to delete book {}: {}", existing.id, e);
                        } else {
                            tracing::info!("Removed deleted book from watcher: {}", existing.title);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Stop watching all paths
    pub fn stop(&mut self) {
        if let Some(ref mut watcher) = self.watcher {
            for path in self.watched_paths.read().iter() {
                let _ = watcher.unwatch(path);
            }
        }
        self.watched_paths.write().clear();
        self.watcher = None;
        self.event_receiver = None;
        tracing::info!("File watcher stopped");
    }
}

impl Default for LibraryWatcher {
    fn default() -> Self {
        Self::new().unwrap_or_else(|_| Self {
            watcher: None,
            watched_paths: Arc::new(RwLock::new(HashSet::new())),
            event_receiver: None,
        })
    }
}

impl Drop for LibraryWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Watcher event types
#[derive(Debug, Clone)]
pub enum WatcherEvent {
    FileCreated(Vec<PathBuf>),
    FileModified(Vec<PathBuf>),
    FileDeleted(Vec<PathBuf>),
}

/// Check if a path is an EPUB file
fn is_epub_file(path: &Path) -> bool {
    path.extension()
        .map(|ext| ext.eq_ignore_ascii_case("epub"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_epub_file() {
        assert!(is_epub_file(Path::new("book.epub")));
        assert!(is_epub_file(Path::new("Book.EPUB")));
        assert!(!is_epub_file(Path::new("book.pdf")));
        assert!(!is_epub_file(Path::new("book")));
    }
}
