//! EPUB parsing module
//!
//! Extracts metadata from EPUB files

use crate::db::NewBook;
use crate::{AppError, AppResult};
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

/// EPUB parser for metadata extraction
pub struct EpubParser;

impl EpubParser {
    /// Create a new parser
    pub fn new() -> Self {
        Self
    }
    
    /// Parse an EPUB file and extract metadata
    pub fn parse(&self, path: &Path) -> AppResult<NewBook> {
        // Skip very large files (>100MB) - likely audiobooks or corrupted
        let file_size = std::fs::metadata(path)
            .map(|m| m.len() as i64)
            .unwrap_or(0);

        if file_size > 100 * 1024 * 1024 {
            return Err(AppError::EpubParse(format!(
                "File too large ({}MB), skipping",
                file_size / 1024 / 1024
            )));
        }

        let file = File::open(path)
            .map_err(|e| AppError::EpubParse(format!("Failed to open file: {}", e)))?;

        let reader = BufReader::new(file);

        let doc = epub::doc::EpubDoc::from_reader(reader)
            .map_err(|e| AppError::EpubParse(format!("Failed to parse EPUB: {}", e)))?;

        // Extract metadata - epub crate returns Option<&MetadataItem> from mdata
        // We need to access the .value field for the actual string content
        let title = doc
            .mdata("title")
            .map(|m| m.value.clone())
            .unwrap_or_else(|| {
                // Fallback to filename
                path.file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Unknown".to_string())
            });

        let author = doc.mdata("creator").map(|m| m.value.clone());
        let description = doc.mdata("description").map(|m| m.value.clone());
        let language = doc.mdata("language").map(|m| m.value.clone());
        let publisher = doc.mdata("publisher").map(|m| m.value.clone());
        let publish_date = doc.mdata("date").map(|m| m.value.clone());
        let isbn = doc.mdata("identifier")
            .map(|m| m.value.clone())
            .filter(|id| id.starts_with("978") || id.starts_with("979") || id.contains("isbn"));

        // Extract series info from calibre metadata or title parsing
        let (series, series_index) = extract_series_info(&title, &doc);

        // Generate sort title (strip leading articles)
        let sort_title = generate_sort_title(&title);

        // Generate author sort name
        let author_sort = author.as_ref().map(|a| generate_author_sort(a));

        Ok(NewBook {
            path: path.to_string_lossy().to_string(),
            cover_path: None, // Set by scanner
            file_size,
            file_hash: None, // Skip hash during metadata parsing - too slow for large files
            title,
            sort_title: Some(sort_title),
            author,
            author_sort,
            series,
            series_index,
            description,
            language,
            publisher,
            publish_date,
            isbn,
            source: "scan".to_string(),
        })
    }
    
    /// Extract cover image data from EPUB (returns raw bytes)
    pub fn extract_cover(&self, path: &Path) -> AppResult<Option<Vec<u8>>> {
        let file = File::open(path)
            .map_err(|e| AppError::EpubParse(format!("Failed to open file: {}", e)))?;

        let reader = BufReader::new(file);

        let mut doc = epub::doc::EpubDoc::from_reader(reader)
            .map_err(|e| AppError::EpubParse(format!("Failed to parse EPUB: {}", e)))?;

        // Try to get cover image - get_cover returns (Vec<u8>, String)
        if let Some((cover_data, _mime_type)) = doc.get_cover() {
            return Ok(Some(cover_data));
        }

        Ok(None)
    }
}

impl Default for EpubParser {
    fn default() -> Self {
        Self::new()
    }
}

/// Extract series information from title or calibre metadata
fn extract_series_info(title: &str, doc: &epub::doc::EpubDoc<BufReader<File>>) -> (Option<String>, Option<f64>) {
    // Try calibre:series metadata first
    if let Some(series) = doc.mdata("calibre:series").map(|m| m.value.clone()) {
        let index = doc
            .mdata("calibre:series_index")
            .and_then(|m| m.value.parse::<f64>().ok());
        return (Some(series), index);
    }
    
    // Try to parse from title patterns like:
    // "Series Name #1 - Book Title"
    // "Book Title (Series Name, #1)"
    // "Book Title (Series Name Book 1)"
    
    // Pattern: (Series Name, #N)
    if let Some(captures) = regex_lite::Regex::new(r"\(([^,]+),\s*#?(\d+(?:\.\d+)?)\)")
        .ok()
        .and_then(|re| re.captures(title))
    {
        let series = captures.get(1).map(|m| m.as_str().trim().to_string());
        let index = captures.get(2).and_then(|m| m.as_str().parse::<f64>().ok());
        if series.is_some() {
            return (series, index);
        }
    }
    
    // Pattern: Series Name #N -
    if let Some(captures) = regex_lite::Regex::new(r"^(.+?)\s*#(\d+(?:\.\d+)?)\s*[-–:]")
        .ok()
        .and_then(|re| re.captures(title))
    {
        let series = captures.get(1).map(|m| m.as_str().trim().to_string());
        let index = captures.get(2).and_then(|m| m.as_str().parse::<f64>().ok());
        if series.is_some() {
            return (series, index);
        }
    }
    
    // Pattern: (Series Name Book N)
    if let Some(captures) = regex_lite::Regex::new(r"\((.+?)\s+Book\s+(\d+(?:\.\d+)?)\)")
        .ok()
        .and_then(|re| re.captures(title))
    {
        let series = captures.get(1).map(|m| m.as_str().trim().to_string());
        let index = captures.get(2).and_then(|m| m.as_str().parse::<f64>().ok());
        if series.is_some() {
            return (series, index);
        }
    }
    
    (None, None)
}

/// Generate a sort-friendly title (strip leading articles)
fn generate_sort_title(title: &str) -> String {
    let lower = title.to_lowercase();
    
    let articles = ["the ", "a ", "an ", "le ", "la ", "les ", "un ", "une ", "el ", "los ", "las "];
    
    for article in articles {
        if lower.starts_with(article) {
            return title[article.len()..].to_string();
        }
    }
    
    title.to_string()
}

/// Generate author sort name (Last, First)
fn generate_author_sort(author: &str) -> String {
    // Handle multiple authors (take first)
    let author = author.split(&[',', ';', '&'][..]).next().unwrap_or(author).trim();
    
    // Split by last space
    if let Some(last_space) = author.rfind(' ') {
        let (first, last) = author.split_at(last_space);
        format!("{}, {}", last.trim(), first.trim())
    } else {
        author.to_string()
    }
}

/// Calculate SHA-256 hash of file for deduplication
fn calculate_file_hash(path: &Path) -> AppResult<String> {
    use sha2::{Sha256, Digest};
    
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    
    std::io::copy(&mut file, &mut hasher)?;
    
    let hash = hasher.finalize();
    Ok(format!("{:x}", hash))
}

// Minimal regex support for series parsing
mod regex_lite {
    use std::collections::HashMap;
    
    pub struct Regex {
        pattern: String,
    }
    
    pub struct Captures<'a> {
        text: &'a str,
        groups: HashMap<usize, (usize, usize)>,
    }
    
    impl Regex {
        pub fn new(pattern: &str) -> Result<Self, ()> {
            Ok(Self { pattern: pattern.to_string() })
        }
        
        pub fn captures<'a>(&self, text: &'a str) -> Option<Captures<'a>> {
            // Simple pattern matching for our specific use cases
            // This is a simplified implementation - in production, use the regex crate
            
            if self.pattern.contains(r"\(([^,]+),\s*#?(\d+(?:\.\d+)?)\)") {
                // Match (Series Name, #N) pattern
                if let Some(start) = text.find('(') {
                    if let Some(end) = text[start..].find(')') {
                        let inner = &text[start + 1..start + end];
                        if let Some(comma) = inner.find(',') {
                            let series = &inner[..comma];
                            let rest = inner[comma + 1..].trim();
                            let rest = rest.trim_start_matches('#');
                            if let Ok(_num) = rest.parse::<f64>() {
                                let mut groups = HashMap::new();
                                groups.insert(1, (start + 1, start + 1 + comma));
                                groups.insert(2, (start + comma + 2, start + end));
                                return Some(Captures { text, groups });
                            }
                        }
                    }
                }
            }
            
            None
        }
    }
    
    impl<'a> Captures<'a> {
        pub fn get(&self, index: usize) -> Option<Match<'a>> {
            self.groups.get(&index).map(|(start, end)| Match {
                text: &self.text[*start..*end],
            })
        }
    }
    
    pub struct Match<'a> {
        text: &'a str,
    }
    
    impl<'a> Match<'a> {
        pub fn as_str(&self) -> &'a str {
            self.text.trim()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_sort_title() {
        assert_eq!(generate_sort_title("The Great Gatsby"), "Great Gatsby");
        assert_eq!(generate_sort_title("A Tale of Two Cities"), "Tale of Two Cities");
        assert_eq!(generate_sort_title("1984"), "1984");
    }
    
    #[test]
    fn test_author_sort() {
        assert_eq!(generate_author_sort("John Smith"), "Smith, John");
        assert_eq!(generate_author_sort("J.R.R. Tolkien"), "Tolkien, J.R.R.");
        assert_eq!(generate_author_sort("Plato"), "Plato");
    }
}
