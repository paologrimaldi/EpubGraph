//! Ollama client module
//!
//! Integration with local Ollama for embedding generation

use crate::vector::EMBEDDING_DIM;
use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};

/// Ollama API client
pub struct OllamaClient {
    endpoint: String,
    model: String,
    client: reqwest::Client,
}

impl OllamaClient {
    /// Create a new Ollama client
    pub fn new(endpoint: String, model: String) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("Failed to create HTTP client");
        
        Self {
            endpoint,
            model,
            client,
        }
    }
    
    /// Update client configuration
    pub fn configure(&mut self, endpoint: String, model: String) {
        self.endpoint = endpoint;
        self.model = model;
    }
    
    /// Get current endpoint
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }
    
    /// Get current model
    pub fn model(&self) -> &str {
        &self.model
    }
    
    /// Check if Ollama is available and the model is loaded
    pub async fn health_check(&self) -> AppResult<OllamaStatus> {
        // Check if server is responding
        let tags_url = format!("{}/api/tags", self.endpoint);
        
        match self.client.get(&tags_url).send().await {
            Ok(response) => {
                if !response.status().is_success() {
                    return Ok(OllamaStatus {
                        connected: false,
                        endpoint: self.endpoint.clone(),
                        model: self.model.clone(),
                        models_available: vec![],
                        error: Some(format!("Server returned status: {}", response.status())),
                    });
                }
                
                let tags: TagsResponse = response.json().await
                    .map_err(|e| AppError::Ollama(format!("Failed to parse response: {}", e)))?;
                
                let models_available: Vec<String> = tags.models
                    .iter()
                    .map(|m| m.name.clone())
                    .collect();
                
                let model_loaded = models_available.iter()
                    .any(|m| m.starts_with(&self.model) || self.model.starts_with(m.split(':').next().unwrap_or("")));
                
                Ok(OllamaStatus {
                    connected: true,
                    endpoint: self.endpoint.clone(),
                    model: self.model.clone(),
                    models_available,
                    error: if model_loaded { None } else { Some(format!("Model {} not found", self.model)) },
                })
            }
            Err(e) => {
                Ok(OllamaStatus {
                    connected: false,
                    endpoint: self.endpoint.clone(),
                    model: self.model.clone(),
                    models_available: vec![],
                    error: Some(format!("Connection failed: {}", e)),
                })
            }
        }
    }
    
    /// Generate embeddings for text
    pub async fn embed(&self, text: &str) -> AppResult<Vec<f32>> {
        let url = format!("{}/api/embeddings", self.endpoint);
        
        let request = EmbeddingRequest {
            model: self.model.clone(),
            prompt: text.to_string(),
        };
        
        let response = self.client
            .post(&url)
            .json(&request)
            .send()
            .await
            .map_err(|e| AppError::Ollama(format!("Request failed: {}", e)))?;
        
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Ollama(format!("Embedding failed ({}): {}", status, body)));
        }
        
        let result: EmbeddingResponse = response.json().await
            .map_err(|e| AppError::Ollama(format!("Failed to parse response: {}", e)))?;

        // Apply MRL truncation and L2 normalization
        Ok(truncate_and_normalize(&result.embedding, EMBEDDING_DIM))
    }
    
    /// Generate embeddings for multiple texts (batched)
    pub async fn embed_batch(&self, texts: &[String]) -> AppResult<Vec<Vec<f32>>> {
        let mut embeddings = Vec::with_capacity(texts.len());

        for text in texts {
            let embedding = self.embed(text).await?;
            embeddings.push(embedding);
        }

        Ok(embeddings)
    }

    /// Generate a chat completion using a specified model
    pub async fn chat(&self, model: &str, prompt: &str) -> AppResult<String> {
        let url = format!("{}/api/generate", self.endpoint);

        let request = ChatRequest {
            model: model.to_string(),
            prompt: prompt.to_string(),
            stream: false,
        };

        let response = self.client
            .post(&url)
            .json(&request)
            .send()
            .await
            .map_err(|e| AppError::Ollama(format!("Chat request failed: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Ollama(format!("Chat failed ({}): {}", status, body)));
        }

        let result: ChatResponse = response.json().await
            .map_err(|e| AppError::Ollama(format!("Failed to parse chat response: {}", e)))?;

        Ok(result.response)
    }
}

/// Ollama server status
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
    pub connected: bool,
    pub endpoint: String,
    pub model: String,
    pub models_available: Vec<String>,
    pub error: Option<String>,
}

/// Processing status
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingStatus {
    pub total_books: i64,
    pub processed: i64,
    pub pending: i64,
    pub current_book: Option<String>,
    pub is_paused: bool,
    pub estimated_time_remaining: Option<i64>,
    pub books_needing_metadata: i64,
}

// API request/response types

#[derive(Serialize)]
struct EmbeddingRequest {
    model: String,
    prompt: String,
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct TagsResponse {
    models: Vec<ModelInfo>,
}

#[derive(Deserialize)]
struct ModelInfo {
    name: String,
    #[serde(default)]
    #[allow(dead_code)]
    size: i64,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    prompt: String,
    stream: bool,
}

#[derive(Deserialize)]
struct ChatResponse {
    response: String,
}

/// Generate embedding text from book metadata
pub fn book_to_embedding_text(
    title: &str,
    author: Option<&str>,
    description: Option<&str>,
    series: Option<&str>,
    subjects: Option<&[String]>,
    chapter_titles: Option<&[String]>,
) -> String {
    let mut parts = vec![format!("Title: {}", title)];

    if let Some(author) = author {
        parts.push(format!("Author: {}", author));
    }

    if let Some(series) = series {
        parts.push(format!("Series: {}", series));
    }

    if let Some(subjects) = subjects {
        if !subjects.is_empty() {
            parts.push(format!("Subjects: {}", subjects.join(", ")));
        }
    }

    if let Some(description) = description {
        // With 40K context model, we can use more description text
        let desc = truncate_str(description, 4000);
        if desc.len() < description.len() {
            parts.push(format!("Description: {}...", desc));
        } else {
            parts.push(format!("Description: {}", desc));
        }
    }

    if let Some(chapters) = chapter_titles {
        if !chapters.is_empty() {
            // Include up to 50 chapter titles
            let titles: Vec<&str> = chapters.iter().take(50).map(|s| s.as_str()).collect();
            parts.push(format!("Chapters: {}", titles.join(", ")));
        }
    }

    parts.join("\n")
}

/// Hash text for change detection. Uses SipHash (fast, non-cryptographic).
pub fn text_hash(text: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    format!("{:x}", hasher.finish() as u128)
}

/// Truncate a string at a UTF-8 safe boundary, returning at most `max_bytes` bytes.
pub fn truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let truncate_at = s
        .char_indices()
        .take_while(|(i, _)| *i < max_bytes)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    &s[..truncate_at]
}

/// Build the LLM prompt context string from book metadata.
/// Shared by all summary generation paths.
pub fn build_summary_context(
    book: &crate::db::Book,
    tags: &[String],
    chapter_titles: &[String],
) -> String {
    let mut context = format!("Title: {}\n", book.title);
    if let Some(ref author) = book.author {
        context.push_str(&format!("Author: {}\n", author));
    }
    if let Some(ref series) = book.series {
        context.push_str(&format!("Series: {}\n", series));
    }
    if !tags.is_empty() {
        context.push_str(&format!("Subjects: {}\n", tags.join(", ")));
    }
    if let Some(ref description) = book.description {
        context.push_str(&format!("Description: {}\n", truncate_str(description, 3000)));
    }
    if !chapter_titles.is_empty() {
        let titles: Vec<&str> = chapter_titles.iter().take(30).map(|s| s.as_str()).collect();
        context.push_str(&format!("Chapter titles: {}\n", titles.join(", ")));
    }
    context
}

const SUMMARY_PROMPT_PREFIX: &str =
    "Based on the following book information, write a concise 200-word summary focusing on \
     themes, genre, setting, writing style, target audience, and comparable works. \
     Do not include any preamble, just the summary.\n\n";

/// Get a cached summary or generate one via LLM chat.
/// `chat_model` and `endpoint` should be read once by the caller, not per-book.
pub async fn get_or_generate_summary(
    db: &crate::db::Database,
    endpoint: &str,
    chat_model: &str,
    book_id: i64,
    book: &crate::db::Book,
    tags: &[String],
    chapter_titles: &[String],
) -> crate::AppResult<String> {
    if let Some(summary) = db.get_book_summary(book_id)? {
        return Ok(summary);
    }

    let context = build_summary_context(book, tags, chapter_titles);
    let prompt = format!("{}{}", SUMMARY_PROMPT_PREFIX, context);

    let client = OllamaClient::new(endpoint.to_string(), chat_model.to_string());
    let summary = client.chat(chat_model, &prompt).await?;
    let summary = summary.trim().to_string();

    let hash = text_hash(&context);
    db.store_book_summary(book_id, &summary, chat_model, Some(&hash))?;

    tracing::info!("Generated LLM summary for book {}: {}", book_id, book.title);
    Ok(summary)
}

/// Truncate embedding to `target_dim` dimensions (MRL) and L2-normalize.
/// If the embedding is already <= target_dim, it is only normalized.
fn truncate_and_normalize(embedding: &[f32], target_dim: usize) -> Vec<f32> {
    let truncated = if embedding.len() > target_dim {
        &embedding[..target_dim]
    } else {
        embedding
    };

    // L2 normalize
    let norm: f32 = truncated.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        truncated.iter().map(|x| x / norm).collect()
    } else {
        truncated.to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_embedding_text_generation() {
        let subjects = vec!["Fiction".to_string(), "Classic".to_string()];
        let chapters = vec!["Chapter 1".to_string(), "Chapter 2".to_string()];
        let text = book_to_embedding_text(
            "The Great Gatsby",
            Some("F. Scott Fitzgerald"),
            Some("A story about the American Dream"),
            None,
            Some(&subjects),
            Some(&chapters),
        );

        assert!(text.contains("The Great Gatsby"));
        assert!(text.contains("F. Scott Fitzgerald"));
        assert!(text.contains("American Dream"));
        assert!(text.contains("Fiction, Classic"));
        assert!(text.contains("Chapter 1, Chapter 2"));
    }
}
