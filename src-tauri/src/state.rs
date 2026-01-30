//! Application state management
//!
//! Manages shared state across the application including:
//! - Database connection pool
//! - Background task coordination
//! - Ollama client state
//! - Vector store for embeddings

use crate::db::Database;
use crate::ollama::OllamaClient;
use crate::vector::VectorStore;
use crate::AppResult;
use parking_lot::RwLock;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Global application state shared across all Tauri commands
pub struct AppState {
    /// SQLite database connection pool
    pub db: Database,

    /// Vector store for embeddings
    pub vector_store: Arc<VectorStore>,

    /// Ollama client for embedding generation
    pub ollama: RwLock<OllamaClient>,

    /// Flag to pause/resume background processing
    pub processing_paused: AtomicBool,

    /// Application data directory
    pub data_dir: PathBuf,

    /// Channel for background job coordination
    pub job_sender: async_channel::Sender<BackgroundJob>,
    pub job_receiver: async_channel::Receiver<BackgroundJob>,
}

/// Background job types
#[derive(Debug, Clone)]
pub enum BackgroundJob {
    /// Scan a library for new books
    ScanLibrary { library_id: i64 },
    /// Generate embedding for a book
    GenerateEmbedding { book_id: i64, priority: i32 },
    /// Recompute graph edges for a book
    UpdateGraphEdges { book_id: i64 },
    /// Stop all background processing
    Shutdown,
}

impl AppState {
    /// Create a new application state
    pub fn new() -> AppResult<Self> {
        // Determine data directory
        let data_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("epub-graph");

        std::fs::create_dir_all(&data_dir)?;

        let db_path = data_dir.join("library.db");
        tracing::info!("Database path: {:?}", db_path);

        // Initialize database
        let db = Database::new(&db_path)?;

        // Initialize vector store (uses same database)
        let vector_store = Arc::new(VectorStore::new(db_path.to_str().unwrap_or("library.db"))?);

        // Load embeddings cache in background
        let vs_clone = vector_store.clone();
        std::thread::spawn(move || {
            if let Err(e) = vs_clone.load_cache() {
                tracing::warn!("Failed to load embedding cache: {}", e);
            }
        });

        // Initialize Ollama client with default settings
        let ollama = RwLock::new(OllamaClient::new(
            "http://localhost:11434".to_string(),
            "nomic-embed-text".to_string(),
        ));

        // Create job channel (unbounded for simplicity)
        let (job_sender, job_receiver) = async_channel::unbounded();

        Ok(Self {
            db,
            vector_store,
            ollama,
            processing_paused: AtomicBool::new(false),
            data_dir,
            job_sender,
            job_receiver,
        })
    }
    
    /// Start background services
    pub async fn start_background_services(&self) -> AppResult<()> {
        tracing::info!("Starting background services...");

        // The embedding processor runs in a loop, checking for pending books
        // and generating embeddings when Ollama is available

        Ok(())
    }
    
    /// Check if processing is paused
    pub fn is_processing_paused(&self) -> bool {
        self.processing_paused.load(Ordering::Relaxed)
    }
    
    /// Pause background processing
    pub fn pause_processing(&self) {
        self.processing_paused.store(true, Ordering::Relaxed);
        tracing::info!("Background processing paused");
    }
    
    /// Resume background processing
    pub fn resume_processing(&self) {
        self.processing_paused.store(false, Ordering::Relaxed);
        tracing::info!("Background processing resumed");
    }
    
    /// Queue a background job
    pub fn queue_job(&self, job: BackgroundJob) {
        if let Err(e) = self.job_sender.try_send(job) {
            tracing::error!("Failed to queue job: {}", e);
        }
    }
}

// Platform-specific data directory helper
mod dirs {
    use std::path::PathBuf;
    
    pub fn data_dir() -> Option<PathBuf> {
        #[cfg(target_os = "macos")]
        {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|p| p.join("Library/Application Support"))
        }
        
        #[cfg(target_os = "windows")]
        {
            std::env::var_os("APPDATA").map(PathBuf::from)
        }
        
        #[cfg(target_os = "linux")]
        {
            std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME")
                        .map(PathBuf::from)
                        .map(|p| p.join(".local/share"))
                })
        }
    }
}
