//! Recommendation commands

use crate::db::Book;
use crate::state::AppState;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

/// A book recommendation with score and reasons
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub book: Book,
    pub score: f64,
    pub reasons: Vec<RecommendationReason>,
}

/// Reason for a recommendation
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RecommendationReason {
    #[serde(rename_all = "camelCase")]
    SimilarContent { similarity: f64 },
    #[serde(rename_all = "camelCase")]
    SameAuthor { author: String },
    #[serde(rename_all = "camelCase")]
    SameSeries { series: String, position: String },
    #[serde(rename_all = "camelCase")]
    TagOverlap { tags: Vec<String> },
    #[serde(rename_all = "camelCase")]
    ReadersAlsoLiked { based_on: String },
    #[serde(rename_all = "camelCase")]
    NextInSeries { previous: String },
}

/// Graph data for visualization
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: i64,
    pub title: String,
    pub author: Option<String>,
    pub cover_path: Option<String>,
    pub rating: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: i64,
    pub target: i64,
    pub weight: f64,
    pub edge_type: String,
}

/// Get recommendations similar to a specific book
#[tauri::command]
pub async fn get_recommendations(
    state: State<'_, Arc<AppState>>,
    book_id: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<Recommendation>, String> {
    let limit = limit.unwrap_or(20).min(100);
    
    let book_id = match book_id {
        Some(id) => id,
        None => return Ok(vec![]), // No book specified, return empty
    };
    
    // Get the source book
    let source_book = state.db.get_book(book_id).map_err(|e| e.to_string())?;
    
    // Get edges from this book
    let edges = state.db.get_edges(book_id, 0.3).map_err(|e| e.to_string())?;

    tracing::debug!("get_recommendations: book_id={}, found {} edges", book_id, edges.len());

    if edges.is_empty() {
        // No graph edges yet, fall back to simple matching
        tracing::debug!("get_recommendations: falling back to simple matching");
        return get_simple_recommendations(&state, &source_book, limit);
    }
    
    // Build recommendations from edges
    let mut recommendations = Vec::new();
    
    for edge in edges.iter().take(limit as usize) {
        let target_id = if edge.source_id == book_id {
            edge.target_id
        } else {
            edge.source_id
        };
        
        if let Ok(book) = state.db.get_book(target_id) {
            let reasons = build_reasons(&source_book, &book, &edge.edge_type, edge.weight);
            recommendations.push(Recommendation {
                book,
                score: edge.weight,
                reasons,
            });
        }
    }
    
    // Sort by score descending
    recommendations.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    
    Ok(recommendations)
}

/// Get personalized recommendations based on user's ratings
#[tauri::command]
pub async fn get_personalized_recommendations(
    state: State<'_, Arc<AppState>>,
    limit: Option<i64>,
) -> Result<Vec<Recommendation>, String> {
    let limit = limit.unwrap_or(20).min(100);
    
    // For now, return recommendations based on highly-rated books
    // In Phase 4, this will use the full graph traversal algorithm
    
    // Query books the user rated highly
    let query = crate::db::BookQuery {
        min_rating: Some(4),
        limit: Some(10),
        sort_by: Some("rating".to_string()),
        sort_order: Some("desc".to_string()),
        ..Default::default()
    };
    
    let rated_books = state.db.query_books(&query).map_err(|e| e.to_string())?;
    
    if rated_books.items.is_empty() {
        // No rated books, return recent additions
        let query = crate::db::BookQuery {
            limit: Some(limit),
            sort_by: Some("dateAdded".to_string()),
            sort_order: Some("desc".to_string()),
            ..Default::default()
        };
        let recent = state.db.query_books(&query).map_err(|e| e.to_string())?;
        return Ok(recent.items.into_iter().map(|book| Recommendation {
            book,
            score: 0.5,
            reasons: vec![],
        }).collect());
    }
    
    // Aggregate recommendations from each rated book
    let mut all_recs: Vec<Recommendation> = Vec::new();
    
    for rated_book in &rated_books.items {
        if let Ok(recs) = get_recommendations(state.clone(), Some(rated_book.id), Some(5)).await {
            for rec in recs {
                // Skip books already rated
                if rated_books.items.iter().any(|b| b.id == rec.book.id) {
                    continue;
                }
                all_recs.push(rec);
            }
        }
    }
    
    // Deduplicate and sort
    all_recs.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    all_recs.dedup_by(|a, b| a.book.id == b.book.id);
    all_recs.truncate(limit as usize);
    
    Ok(all_recs)
}

/// Get graph data for visualization centered on a book
#[tauri::command]
pub async fn get_book_graph(
    state: State<'_, Arc<AppState>>,
    center_id: i64,
    depth: Option<i32>,
    max_nodes: Option<i32>,
) -> Result<GraphData, String> {
    let depth = depth.unwrap_or(2).min(3);
    let max_nodes = max_nodes.unwrap_or(50).min(200) as usize;

    let mut nodes: Vec<GraphNode> = Vec::new();
    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut visited: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut frontier: Vec<i64> = vec![center_id];

    // Check if we have any edges for this book (use same threshold as recommendations)
    let has_stored_edges = state.db.get_edges(center_id, 0.3)
        .map(|e| !e.is_empty())
        .unwrap_or(false);

    tracing::debug!("get_book_graph: center_id={}, has_stored_edges={}", center_id, has_stored_edges);

    for current_depth in 0..depth {
        let mut next_frontier = Vec::new();

        for book_id in frontier {
            if visited.contains(&book_id) || nodes.len() >= max_nodes {
                continue;
            }
            visited.insert(book_id);

            // Add node
            if let Ok(book) = state.db.get_book(book_id) {
                nodes.push(GraphNode {
                    id: book.id,
                    title: book.title.clone(),
                    author: book.author.clone(),
                    cover_path: book.cover_path.clone(),
                    rating: book.rating,
                });

                // Try to get stored edges first (use 0.3 threshold like recommendations)
                let book_edges = state.db.get_edges(book_id, 0.3).unwrap_or_default();

                tracing::debug!("get_book_graph: book_id={}, found {} stored edges", book_id, book_edges.len());

                if !book_edges.is_empty() {
                    // Use stored edges
                    for edge in book_edges {
                        let target_id = if edge.source_id == book_id {
                            edge.target_id
                        } else {
                            edge.source_id
                        };

                        edges.push(GraphEdge {
                            source: edge.source_id,
                            target: edge.target_id,
                            weight: edge.weight,
                            edge_type: edge.edge_type,
                        });

                        if !visited.contains(&target_id) {
                            next_frontier.push(target_id);
                        }
                    }
                } else if !has_stored_edges && current_depth == 0 {
                    // No stored edges anywhere - fallback to vector similarity search
                    // Only do this for the center node to avoid expensive searches
                    let similar = state.vector_store.find_similar_to_book(book_id, 20);

                    for (target_id, similarity) in similar {
                        if similarity < 0.3 || visited.contains(&target_id) {
                            continue;
                        }

                        if let Ok(target_book) = state.db.get_book(target_id) {
                            let (weight, edge_type) = crate::graph::compute_edge_weight(
                                &book,
                                &target_book,
                                Some(similarity),
                            );

                            if weight >= 0.3 {
                                edges.push(GraphEdge {
                                    source: book_id,
                                    target: target_id,
                                    weight,
                                    edge_type,
                                });
                                next_frontier.push(target_id);
                            }
                        }
                    }

                    // Also add same author/series as fallback
                    if let Some(ref author) = book.author {
                        let query = crate::db::BookQuery {
                            author: Some(author.clone()),
                            limit: Some(10),
                            ..Default::default()
                        };
                        if let Ok(result) = state.db.query_books(&query) {
                            for other in result.items {
                                if other.id != book_id && !visited.contains(&other.id) {
                                    edges.push(GraphEdge {
                                        source: book_id,
                                        target: other.id,
                                        weight: 0.7,
                                        edge_type: "author".to_string(),
                                    });
                                    next_frontier.push(other.id);
                                }
                            }
                        }
                    }

                    if let Some(ref series) = book.series {
                        let query = crate::db::BookQuery {
                            series: Some(series.clone()),
                            limit: Some(10),
                            ..Default::default()
                        };
                        if let Ok(result) = state.db.query_books(&query) {
                            for other in result.items {
                                if other.id != book_id && !visited.contains(&other.id) {
                                    // Check if edge already exists
                                    if !edges.iter().any(|e|
                                        (e.source == book_id && e.target == other.id) ||
                                        (e.source == other.id && e.target == book_id)
                                    ) {
                                        edges.push(GraphEdge {
                                            source: book_id,
                                            target: other.id,
                                            weight: 0.9,
                                            edge_type: "series".to_string(),
                                        });
                                        next_frontier.push(other.id);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        frontier = next_frontier;
    }

    // Deduplicate edges
    edges.sort_by(|a, b| {
        (a.source, a.target).cmp(&(b.source, b.target))
    });
    edges.dedup_by(|a, b| a.source == b.source && a.target == b.target);

    Ok(GraphData { nodes, edges })
}

/// Simple recommendations based on author/series matching
fn get_simple_recommendations(
    state: &State<'_, Arc<AppState>>,
    source: &Book,
    limit: i64,
) -> Result<Vec<Recommendation>, String> {
    let mut recommendations = Vec::new();
    
    // Find books by same author
    if let Some(ref author) = source.author {
        let query = crate::db::BookQuery {
            author: Some(author.clone()),
            limit: Some(limit / 2),
            ..Default::default()
        };
        
        if let Ok(result) = state.db.query_books(&query) {
            for book in result.items {
                if book.id != source.id {
                    recommendations.push(Recommendation {
                        score: 0.8,
                        reasons: vec![RecommendationReason::SameAuthor {
                            author: author.clone(),
                        }],
                        book,
                    });
                }
            }
        }
    }
    
    // Find books in same series
    if let Some(ref series) = source.series {
        let query = crate::db::BookQuery {
            series: Some(series.clone()),
            limit: Some(limit / 2),
            ..Default::default()
        };
        
        if let Ok(result) = state.db.query_books(&query) {
            for book in result.items {
                if book.id != source.id {
                    // Check if already added
                    if recommendations.iter().any(|r| r.book.id == book.id) {
                        continue;
                    }
                    
                    let position = if book.series_index > source.series_index {
                        "later".to_string()
                    } else {
                        "earlier".to_string()
                    };
                    
                    recommendations.push(Recommendation {
                        score: 0.9,
                        reasons: vec![RecommendationReason::SameSeries {
                            series: series.clone(),
                            position,
                        }],
                        book,
                    });
                }
            }
        }
    }
    
    recommendations.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    recommendations.truncate(limit as usize);
    
    Ok(recommendations)
}

/// Build recommendation reasons from edge data
fn build_reasons(source: &Book, target: &Book, edge_type: &str, weight: f64) -> Vec<RecommendationReason> {
    let mut reasons = Vec::new();
    
    match edge_type {
        "content" => {
            reasons.push(RecommendationReason::SimilarContent {
                similarity: weight,
            });
        }
        "author" => {
            if let Some(ref author) = target.author {
                reasons.push(RecommendationReason::SameAuthor {
                    author: author.clone(),
                });
            }
        }
        "series" => {
            if let Some(ref series) = target.series {
                let position = match (source.series_index, target.series_index) {
                    (Some(src), Some(tgt)) if tgt > src => "next".to_string(),
                    (Some(src), Some(tgt)) if tgt < src => "previous".to_string(),
                    _ => "in series".to_string(),
                };
                reasons.push(RecommendationReason::SameSeries {
                    series: series.clone(),
                    position,
                });
            }
        }
        "tag" => {
            reasons.push(RecommendationReason::TagOverlap {
                tags: vec![], // TODO: include actual overlapping tags
            });
        }
        _ => {
            reasons.push(RecommendationReason::SimilarContent {
                similarity: weight,
            });
        }
    }
    
    reasons
}
