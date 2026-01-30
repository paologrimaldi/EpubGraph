//! EpubGraph - High-performance ebook library with AI-powered recommendations
//!
//! This library provides the core functionality for:
//! - Fast filesystem scanning for EPUB files
//! - Metadata extraction from EPUB files
//! - SQLite database with FTS5 for fast search
//! - Ollama integration for embedding generation
//! - Graph-based recommendation engine

pub mod calibre;
pub mod commands;
pub mod db;
pub mod epub;
pub mod graph;
pub mod ollama;
pub mod scanner;
pub mod state;
pub mod vector;
pub mod watcher;
pub mod worker;

// Re-export commonly used types
pub use state::AppState;

/// Application-wide error type
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),
    
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    
    #[error("EPUB parsing error: {0}")]
    EpubParse(String),
    
    #[error("Ollama error: {0}")]
    Ollama(String),
    
    #[error("Configuration error: {0}")]
    Config(String),
    
    #[error("Not found: {0}")]
    NotFound(String),
    
    #[error("Invalid input: {0}")]
    InvalidInput(String),
    
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Result type alias for application operations
pub type AppResult<T> = Result<T, AppError>;
