//! Ollama client module
//!
//! Integration with local Ollama for embedding generation

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
        
        Ok(result.embedding)
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
    size: i64,
}

/// Generate embedding text from book metadata
pub fn book_to_embedding_text(
    title: &str,
    author: Option<&str>,
    description: Option<&str>,
    series: Option<&str>,
) -> String {
    let mut parts = vec![format!("Title: {}", title)];
    
    if let Some(author) = author {
        parts.push(format!("Author: {}", author));
    }
    
    if let Some(series) = series {
        parts.push(format!("Series: {}", series));
    }
    
    if let Some(description) = description {
        // Truncate description to avoid token limits
        // Use char_indices to find a valid UTF-8 boundary
        let desc = if description.len() > 1000 {
            let truncate_at = description
                .char_indices()
                .take_while(|(i, _)| *i < 1000)
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);
            format!("{}...", &description[..truncate_at])
        } else {
            description.to_string()
        };
        parts.push(format!("Description: {}", desc));
    }
    
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_embedding_text_generation() {
        let text = book_to_embedding_text(
            "The Great Gatsby",
            Some("F. Scott Fitzgerald"),
            Some("A story about the American Dream"),
            None,
        );
        
        assert!(text.contains("The Great Gatsby"));
        assert!(text.contains("F. Scott Fitzgerald"));
        assert!(text.contains("American Dream"));
    }
}
