//! Filesystem scanner module
//!
//! High-performance parallel scanning for EPUB files

use crate::db::NewBook;
use crate::AppResult;
use std::path::{Path, PathBuf};
use walkdir::{DirEntry, WalkDir};

/// Scan result
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub books_found: usize,
    pub books_added: usize,
    pub books_updated: usize,
    pub errors: Vec<String>,
    pub duration_ms: u64,
}

/// Scan progress update
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub phase: String,
    pub found: usize,
    pub processed: usize,
    pub total: usize,
    pub current: Option<String>,
    pub eta_seconds: Option<u64>,
}

/// Scanner configuration
pub struct ScannerConfig {
    /// Maximum directory depth to scan
    pub max_depth: usize,
    /// Whether to follow symbolic links
    pub follow_links: bool,
    /// File extensions to scan (lowercase)
    pub extensions: Vec<String>,
    /// Cover image extensions (lowercase)
    pub cover_extensions: Vec<String>,
}

impl Default for ScannerConfig {
    fn default() -> Self {
        Self {
            max_depth: 20,
            follow_links: false,
            extensions: vec!["epub".to_string()],
            cover_extensions: vec!["jpg".to_string(), "jpeg".to_string(), "png".to_string()],
        }
    }
}

/// High-performance filesystem scanner
pub struct Scanner {
    config: ScannerConfig,
}

impl Scanner {
    /// Create a new scanner with default configuration
    pub fn new() -> Self {
        Self {
            config: ScannerConfig::default(),
        }
    }

    /// Create a scanner with custom configuration
    pub fn with_config(config: ScannerConfig) -> Self {
        Self { config }
    }

    /// Fast scan - only discover EPUB files without parsing metadata
    /// Returns minimal book records that can be quickly inserted into DB
    pub fn fast_scan(&self, root: &Path) -> AppResult<Vec<NewBook>> {
        tracing::info!("Fast scanning directory: {:?}", root);
        let start = std::time::Instant::now();

        let mut books = Vec::new();

        for entry in WalkDir::new(root)
            .max_depth(self.config.max_depth)
            .follow_links(self.config.follow_links)
            .into_iter()
            .filter_entry(|e| !is_hidden(e))
            .filter_map(|e| e.ok())
            .filter(|e| self.is_epub(e))
        {
            let path = entry.path();
            let file_size = entry.metadata().map(|m| m.len() as i64).unwrap_or(0);

            // Extract title from filename (fast, no file parsing)
            let title = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "Unknown".to_string());

            // Try to find cover in same directory
            let cover_path = self.find_cover(path);

            books.push(NewBook {
                path: path.to_string_lossy().to_string(),
                cover_path: cover_path.map(|p| p.to_string_lossy().to_string()),
                file_size,
                file_hash: None,
                title,
                sort_title: None,
                author: None,
                author_sort: None,
                series: None,
                series_index: None,
                description: None,
                language: None,
                publisher: None,
                publish_date: None,
                isbn: None,
                source: "scan".to_string(),
            });
        }

        tracing::info!(
            "Fast scan found {} EPUB files in {:?}",
            books.len(),
            start.elapsed()
        );

        Ok(books)
    }

    /// Check if a directory entry is an EPUB file
    fn is_epub(&self, entry: &DirEntry) -> bool {
        if !entry.file_type().is_file() {
            return false;
        }

        entry
            .path()
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| self.config.extensions.contains(&ext.to_lowercase()))
            .unwrap_or(false)
    }

    /// Find a cover image in the same directory or parent directory
    fn find_cover(&self, epub_path: &Path) -> Option<PathBuf> {
        let parent = epub_path.parent()?;
        let stem = epub_path.file_stem()?.to_string_lossy().to_lowercase();

        // Look for cover in same directory
        for ext in &self.config.cover_extensions {
            // Try exact name match (e.g., "book.jpg" for "book.epub")
            let exact = parent.join(format!("{}.{}", stem, ext));
            if exact.exists() {
                return Some(exact);
            }

            // Try "cover.jpg" in same directory
            let cover = parent.join(format!("cover.{}", ext));
            if cover.exists() {
                return Some(cover);
            }
        }

        // Look in parent directory (for Calibre-style layouts)
        if let Some(grandparent) = parent.parent() {
            for ext in &self.config.cover_extensions {
                let cover = grandparent.join(format!("cover.{}", ext));
                if cover.exists() {
                    return Some(cover);
                }
            }
        }

        None
    }
}

impl Default for Scanner {
    fn default() -> Self {
        Self::new()
    }
}

/// Check if a directory entry is hidden
fn is_hidden(entry: &DirEntry) -> bool {
    entry
        .file_name()
        .to_str()
        .map(|s| s.starts_with('.'))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_scanner_finds_epub() {
        let temp = TempDir::new().unwrap();
        let epub_path = temp.path().join("test.epub");
        fs::write(&epub_path, b"fake epub content").unwrap();

        let scanner = Scanner::new();
        let results = scanner.fast_scan(temp.path()).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, epub_path.to_string_lossy());
    }

    #[test]
    fn test_scanner_finds_cover() {
        let temp = TempDir::new().unwrap();
        let epub_path = temp.path().join("book.epub");
        let cover_path = temp.path().join("book.jpg");

        fs::write(&epub_path, b"fake epub").unwrap();
        fs::write(&cover_path, b"fake jpg").unwrap();

        let scanner = Scanner::new();
        let results = scanner.fast_scan(temp.path()).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0].cover_path,
            Some(cover_path.to_string_lossy().to_string())
        );
    }

    #[test]
    fn test_scanner_ignores_hidden() {
        let temp = TempDir::new().unwrap();
        let hidden_dir = temp.path().join(".hidden");
        fs::create_dir(&hidden_dir).unwrap();
        fs::write(hidden_dir.join("test.epub"), b"hidden epub").unwrap();
        fs::write(temp.path().join("visible.epub"), b"visible epub").unwrap();

        let scanner = Scanner::new();
        let results = scanner.fast_scan(temp.path()).unwrap();

        assert_eq!(results.len(), 1);
        assert!(results[0].path.contains("visible"));
    }
}
