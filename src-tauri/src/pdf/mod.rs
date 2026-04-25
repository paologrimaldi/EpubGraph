//! PDF parsing module
//!
//! Extracts metadata and a bounded text sample from PDF files.

use crate::db::NewBook;
use crate::{AppError, AppResult};
use lopdf::{Dictionary, Document, Object};
use std::path::Path;

const MAX_FILE_BYTES: i64 = 200 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 3000;
const MAX_PAGES_FOR_TEXT: usize = 8;

/// PDF parser for metadata extraction
pub struct PdfParser;

impl PdfParser {
    /// Create a new parser
    pub fn new() -> Self {
        Self
    }

    /// Parse a PDF file and extract metadata + a bounded text sample
    pub fn parse(&self, path: &Path) -> AppResult<NewBook> {
        let file_size = std::fs::metadata(path)
            .map(|m| m.len() as i64)
            .unwrap_or(0);

        if file_size > MAX_FILE_BYTES {
            return Err(AppError::PdfParse(format!(
                "File too large ({}MB), skipping",
                file_size / 1024 / 1024
            )));
        }

        let doc = Document::load(path)
            .map_err(|e| AppError::PdfParse(format!("Failed to parse PDF: {}", e)))?;

        let info = extract_info_dict(&doc);

        let title = info
            .as_ref()
            .and_then(|d| get_info_string(d, b"Title"))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                path.file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Unknown".to_string())
            });

        let author = info
            .as_ref()
            .and_then(|d| get_info_string(d, b"Author"))
            .filter(|s| !s.is_empty());

        let subjects = info
            .as_ref()
            .and_then(|d| get_info_string(d, b"Keywords"))
            .map(|s| split_subjects(&s))
            .unwrap_or_default();

        let publisher = info
            .as_ref()
            .and_then(|d| get_info_string(d, b"Producer"))
            .filter(|s| !s.is_empty());

        let description = extract_text_sample(&doc)
            .map(|s| truncate_chars(&normalize_whitespace(&s), MAX_TEXT_CHARS).to_string())
            .filter(|s| !s.is_empty());

        let author_sort = author.as_ref().map(|a| generate_author_sort(a));

        Ok(NewBook {
            path: path.to_string_lossy().to_string(),
            cover_path: None,
            file_size,
            file_hash: None,
            title,
            sort_title: None,
            author,
            author_sort,
            series: None,
            series_index: None,
            description,
            language: None,
            publisher,
            publish_date: None,
            isbn: None,
            source: "scan".to_string(),
            subjects,
            chapter_titles: vec![],
        })
    }
}

impl Default for PdfParser {
    fn default() -> Self {
        Self::new()
    }
}

fn extract_info_dict(doc: &Document) -> Option<Dictionary> {
    let info_ref = doc.trailer.get(b"Info").ok()?;
    let obj = doc.get_object(info_ref.as_reference().ok()?).ok()?;
    obj.as_dict().ok().cloned()
}

fn get_info_string(dict: &Dictionary, key: &[u8]) -> Option<String> {
    let obj = dict.get(key).ok()?;
    match obj {
        Object::String(bytes, _) => Some(String::from_utf8_lossy(bytes).trim().to_string()),
        Object::Name(bytes) => Some(String::from_utf8_lossy(bytes).trim().to_string()),
        _ => None,
    }
}

fn extract_text_sample(doc: &Document) -> Option<String> {
    let pages = doc.get_pages();
    if pages.is_empty() {
        return None;
    }

    let page_numbers: Vec<u32> = pages.keys().take(MAX_PAGES_FOR_TEXT).copied().collect();
    if page_numbers.is_empty() {
        return None;
    }

    doc.extract_text(&page_numbers).ok()
}

fn normalize_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

fn split_subjects(s: &str) -> Vec<String> {
    s.split(&[',', ';', '|'][..])
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn generate_author_sort(author: &str) -> String {
    let author = author
        .split(&[',', ';', '&'][..])
        .next()
        .unwrap_or(author)
        .trim();

    if let Some(last_space) = author.rfind(' ') {
        let (first, last) = author.split_at(last_space);
        format!("{}, {}", last.trim(), first.trim())
    } else {
        author.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_subjects() {
        let tags = split_subjects("Sci-Fi, Space Opera; Adventure|Classic");
        assert_eq!(tags, vec!["Sci-Fi", "Space Opera", "Adventure", "Classic"]);
    }

    #[test]
    fn test_truncate_chars() {
        let text = "abcdef";
        assert_eq!(truncate_chars(text, 3), "abc");
        assert_eq!(truncate_chars(text, 10), "abcdef");
    }
}
