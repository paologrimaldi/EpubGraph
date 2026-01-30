//! Graph-based recommendation engine
//!
//! Implements state-of-the-art hybrid multi-hop recommendation algorithm:
//! 1. Content-based similarity via embeddings (nomic-embed-text)
//! 2. Collaborative filtering from user ratings
//! 3. Multi-hop graph traversal (2+ hops)
//! 4. Personalized PageRank for relevance scoring
//! 5. Maximal Marginal Relevance for diversity

use crate::db::{Book, Database};
use crate::AppResult;
use petgraph::graph::{DiGraph, NodeIndex};
use petgraph::visit::EdgeRef;
use std::collections::{HashMap, HashSet, VecDeque};

/// In-memory graph representation for fast traversal
pub struct BookGraph {
    /// Directed graph: nodes = book IDs, edges = similarity weights
    graph: DiGraph<i64, EdgeData>,
    /// Map from book ID to node index
    id_to_node: HashMap<i64, NodeIndex>,
    /// Map from node index to book ID
    node_to_id: HashMap<NodeIndex, i64>,
}

/// Edge data containing weight and type
#[derive(Debug, Clone)]
pub struct EdgeData {
    pub weight: f64,
    pub edge_type: String,
}

impl BookGraph {
    /// Create a new empty graph
    pub fn new() -> Self {
        Self {
            graph: DiGraph::new(),
            id_to_node: HashMap::new(),
            node_to_id: HashMap::new(),
        }
    }

    /// Build graph from database edges
    pub fn from_database(db: &Database, min_weight: f64) -> AppResult<Self> {
        let mut graph = Self::new();

        // Load all edges above threshold
        db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT source_id, target_id, edge_type, weight 
                 FROM book_edges 
                 WHERE weight >= ?
                 ORDER BY weight DESC",
            )?;

            let edges = stmt.query_map([min_weight], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            })?;

            for edge in edges {
                let (source, target, edge_type, weight) = edge?;
                graph.add_edge(source, target, weight, edge_type);
            }

            Ok(())
        })?;

        Ok(graph)
    }

    /// Add or get a node for a book ID
    fn get_or_create_node(&mut self, book_id: i64) -> NodeIndex {
        if let Some(&idx) = self.id_to_node.get(&book_id) {
            idx
        } else {
            let idx = self.graph.add_node(book_id);
            self.id_to_node.insert(book_id, idx);
            self.node_to_id.insert(idx, book_id);
            idx
        }
    }

    /// Add a directed edge between books
    pub fn add_edge(&mut self, source: i64, target: i64, weight: f64, edge_type: String) {
        let source_idx = self.get_or_create_node(source);
        let target_idx = self.get_or_create_node(target);

        self.graph.add_edge(
            source_idx,
            target_idx,
            EdgeData { weight, edge_type },
        );
    }

    /// Get neighbors of a node with their edge weights
    pub fn neighbors(&self, book_id: i64) -> Vec<(i64, f64, String)> {
        if let Some(&idx) = self.id_to_node.get(&book_id) {
            self.graph
                .edges(idx)
                .map(|edge| {
                    let target_id = self.node_to_id[&edge.target()];
                    (target_id, edge.weight().weight, edge.weight().edge_type.clone())
                })
                .collect()
        } else {
            vec![]
        }
    }

    /// Get node count
    pub fn node_count(&self) -> usize {
        self.graph.node_count()
    }
}

impl Default for BookGraph {
    fn default() -> Self {
        Self::new()
    }
}

/// Multi-hop graph traversal configuration
#[derive(Debug, Clone)]
pub struct TraversalConfig {
    /// Maximum number of hops (2+ for state-of-the-art)
    pub max_hops: usize,
    /// Minimum edge weight per hop level
    pub min_weights: Vec<f64>,
    /// Weight decay factor per hop (0-1)
    pub decay_factor: f64,
    /// Maximum candidates to expand
    pub max_candidates: usize,
}

impl Default for TraversalConfig {
    fn default() -> Self {
        Self {
            max_hops: 3,                           // 3 hops for deeper exploration
            min_weights: vec![0.5, 0.4, 0.3],      // Decreasing thresholds
            decay_factor: 0.75,                    // 25% decay per hop
            max_candidates: 500,
        }
    }
}

/// Candidate from graph traversal
#[derive(Debug, Clone)]
pub struct TraversalCandidate {
    pub book_id: i64,
    pub score: f64,
    pub path: Vec<i64>,
    pub edge_types: Vec<String>,
}

/// Multi-hop graph traversal for candidate expansion
///
/// This is a key component of the state-of-the-art recommendation algorithm.
/// It explores the graph beyond direct connections to find:
/// - Books similar to books you liked
/// - Books by authors who wrote books similar to yours
/// - Series connections through shared themes
pub fn multi_hop_traversal(
    graph: &BookGraph,
    seeds: &[i64],
    config: &TraversalConfig,
) -> Vec<TraversalCandidate> {
    let mut candidates: HashMap<i64, TraversalCandidate> = HashMap::new();
    let mut visited: HashSet<i64> = HashSet::new();
    let mut frontier: VecDeque<(i64, f64, Vec<i64>, Vec<String>, usize)> = VecDeque::new();

    // Initialize frontier with seeds
    for &seed in seeds {
        visited.insert(seed);
        frontier.push_back((seed, 1.0, vec![seed], vec![], 0));
    }

    while let Some((node, accumulated_score, path, edge_types, hop)) = frontier.pop_front() {
        if hop >= config.max_hops || candidates.len() >= config.max_candidates {
            continue;
        }

        let min_weight = config.min_weights.get(hop).copied().unwrap_or(0.3);

        for (neighbor, edge_weight, edge_type) in graph.neighbors(node) {
            if edge_weight < min_weight {
                continue;
            }

            // Calculate decayed score
            let decay = config.decay_factor.powi(hop as i32);
            let new_score = accumulated_score * edge_weight * decay;

            // Build path
            let mut new_path = path.clone();
            new_path.push(neighbor);

            let mut new_edge_types = edge_types.clone();
            new_edge_types.push(edge_type.clone());

            // Update candidate if better score found
            candidates
                .entry(neighbor)
                .and_modify(|c| {
                    if new_score > c.score {
                        c.score = new_score;
                        c.path = new_path.clone();
                        c.edge_types = new_edge_types.clone();
                    }
                })
                .or_insert(TraversalCandidate {
                    book_id: neighbor,
                    score: new_score,
                    path: new_path.clone(),
                    edge_types: new_edge_types.clone(),
                });

            // Add to frontier if not visited
            if !visited.contains(&neighbor) {
                visited.insert(neighbor);
                frontier.push_back((neighbor, new_score, new_path, new_edge_types, hop + 1));
            }
        }
    }

    // Remove seed books from candidates
    for seed in seeds {
        candidates.remove(seed);
    }

    let mut result: Vec<_> = candidates.into_values().collect();
    result.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    result
}

/// Personalized PageRank configuration
#[derive(Debug, Clone)]
pub struct PageRankConfig {
    /// Damping factor (typically 0.85)
    pub damping: f64,
    /// Teleport weight to preference nodes
    pub preference_weight: f64,
    /// Number of iterations
    pub iterations: usize,
    /// Convergence threshold
    pub epsilon: f64,
}

impl Default for PageRankConfig {
    fn default() -> Self {
        Self {
            damping: 0.85,
            preference_weight: 0.3,
            iterations: 20,
            epsilon: 1e-6,
        }
    }
}

/// Personalized PageRank for relevance scoring
///
/// Combines:
/// - Graph structure (random walk probability)
/// - User preferences (teleport to highly-rated books)
/// - Seed relevance (teleport to query-similar books)
pub fn personalized_pagerank(
    graph: &BookGraph,
    seeds: &[i64],
    preferences: &[i64],
    config: &PageRankConfig,
) -> HashMap<i64, f64> {
    let n = graph.node_count();
    if n == 0 {
        return HashMap::new();
    }

    let mut scores: HashMap<i64, f64> = HashMap::new();
    let all_nodes: Vec<i64> = graph.id_to_node.keys().copied().collect();

    // Initialize uniform distribution
    let initial_score = 1.0 / n as f64;
    for &node in &all_nodes {
        scores.insert(node, initial_score);
    }

    // Build personalization vector
    let mut personalization: HashMap<i64, f64> = HashMap::new();
    let total_personalization = seeds.len() + preferences.len();

    if total_personalization > 0 {
        let seed_weight = (1.0 - config.preference_weight) / seeds.len().max(1) as f64;
        let pref_weight = config.preference_weight / preferences.len().max(1) as f64;

        for &seed in seeds {
            *personalization.entry(seed).or_default() += seed_weight;
        }
        for &pref in preferences {
            *personalization.entry(pref).or_default() += pref_weight;
        }
    } else {
        // Uniform personalization if no seeds/preferences
        for &node in &all_nodes {
            personalization.insert(node, initial_score);
        }
    }

    // Power iteration
    for _iter in 0..config.iterations {
        let mut new_scores: HashMap<i64, f64> = HashMap::new();
        let mut max_diff: f64 = 0.0;

        for &node in &all_nodes {
            let mut score = 0.0;

            // Sum contributions from incoming edges
            for (&other_node, &other_score) in &scores {
                for (neighbor, weight, _) in graph.neighbors(other_node) {
                    if neighbor == node {
                        let out_degree = graph.neighbors(other_node).len().max(1) as f64;
                        score += (other_score * weight) / out_degree;
                    }
                }
            }

            // Apply damping and personalization
            let personalization_score = personalization.get(&node).copied().unwrap_or(initial_score);
            score = config.damping * score + (1.0 - config.damping) * personalization_score;

            let old_score = scores.get(&node).copied().unwrap_or(0.0);
            max_diff = max_diff.max((score - old_score).abs());

            new_scores.insert(node, score);
        }

        scores = new_scores;

        // Check convergence
        if max_diff < config.epsilon {
            break;
        }
    }

    scores
}

/// Maximal Marginal Relevance for diversity
///
/// Balances relevance with novelty to avoid redundant recommendations.
/// Formula: MMR = λ * sim(item, query) - (1-λ) * max(sim(item, selected))
pub fn maximal_marginal_relevance(
    candidates: &[TraversalCandidate],
    similarity_fn: impl Fn(i64, i64) -> f64,
    lambda: f64,
    top_k: usize,
) -> Vec<TraversalCandidate> {
    if candidates.is_empty() {
        return vec![];
    }

    let mut selected: Vec<TraversalCandidate> = Vec::new();
    let mut remaining: Vec<_> = candidates.to_vec();

    while selected.len() < top_k && !remaining.is_empty() {
        let mut best_idx = 0;
        let mut best_mmr = f64::NEG_INFINITY;

        for (idx, candidate) in remaining.iter().enumerate() {
            // Relevance score (from traversal)
            let relevance = candidate.score;

            // Maximum similarity to already selected items
            let max_sim = if selected.is_empty() {
                0.0
            } else {
                selected
                    .iter()
                    .map(|s| similarity_fn(candidate.book_id, s.book_id))
                    .fold(0.0, f64::max)
            };

            // MMR score
            let mmr = lambda * relevance - (1.0 - lambda) * max_sim;

            if mmr > best_mmr {
                best_mmr = mmr;
                best_idx = idx;
            }
        }

        selected.push(remaining.remove(best_idx));
    }

    selected
}

/// Combined recommendation scoring
#[derive(Debug, Clone)]
pub struct RecommendationScore {
    pub book_id: i64,
    pub traversal_score: f64,
    pub pagerank_score: f64,
    pub combined_score: f64,
    pub path: Vec<i64>,
    pub edge_types: Vec<String>,
}

/// Generate recommendations using the full hybrid pipeline
pub fn generate_recommendations(
    graph: &BookGraph,
    source_book_id: i64,
    user_highly_rated: &[i64],
    limit: usize,
) -> Vec<RecommendationScore> {
    // Stage 1: Multi-hop traversal from source
    let traversal_config = TraversalConfig::default();
    let candidates = multi_hop_traversal(graph, &[source_book_id], &traversal_config);

    if candidates.is_empty() {
        return vec![];
    }

    // Stage 2: Personalized PageRank for global relevance
    let pagerank_config = PageRankConfig::default();
    let pagerank_scores = personalized_pagerank(
        graph,
        &[source_book_id],
        user_highly_rated,
        &pagerank_config,
    );

    // Stage 3: Combine scores
    let scored: Vec<RecommendationScore> = candidates
        .into_iter()
        .map(|c| {
            let pr_score = pagerank_scores.get(&c.book_id).copied().unwrap_or(0.0);
            let combined = 0.7 * c.score + 0.3 * pr_score; // Weight traversal higher

            RecommendationScore {
                book_id: c.book_id,
                traversal_score: c.score,
                pagerank_score: pr_score,
                combined_score: combined,
                path: c.path,
                edge_types: c.edge_types,
            }
        })
        .collect();

    // Stage 4: Apply MMR for diversity
    let scored_candidates: Vec<_> = scored
        .iter()
        .map(|s| TraversalCandidate {
            book_id: s.book_id,
            score: s.combined_score,
            path: s.path.clone(),
            edge_types: s.edge_types.clone(),
        })
        .collect();

    let diverse = maximal_marginal_relevance(
        &scored_candidates,
        |a, b| {
            // Simple similarity: inverse of score difference
            let score_a = scored.iter().find(|s| s.book_id == a).map(|s| s.combined_score).unwrap_or(0.0);
            let score_b = scored.iter().find(|s| s.book_id == b).map(|s| s.combined_score).unwrap_or(0.0);
            1.0 - (score_a - score_b).abs()
        },
        0.7, // Lambda: 70% relevance, 30% diversity
        limit,
    );

    // Return final recommendations
    diverse
        .into_iter()
        .filter_map(|c| {
            scored
                .iter()
                .find(|s| s.book_id == c.book_id)
                .cloned()
        })
        .collect()
}

/// Compute edge weight between two books based on multiple signals
/// Returns the primary edge (combined score, primary type)
pub fn compute_edge_weight(
    book_a: &Book,
    book_b: &Book,
    embedding_similarity: Option<f64>,
) -> (f64, String) {
    let edges = compute_all_edge_weights(book_a, book_b, embedding_similarity);

    if edges.is_empty() {
        return (0.0, "none".to_string());
    }

    // Return the highest weighted edge
    edges.into_iter()
        .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap_or((0.0, "none".to_string()))
}

/// Compute ALL qualifying edge weights between two books
/// Returns a vector of (weight, edge_type) for each qualifying relationship
pub fn compute_all_edge_weights(
    book_a: &Book,
    book_b: &Book,
    embedding_similarity: Option<f64>,
) -> Vec<(f64, String)> {
    let mut edges: Vec<(f64, String)> = Vec::new();

    // Content similarity from embeddings
    if let Some(sim) = embedding_similarity {
        if sim > 0.3 {
            edges.push((sim, "content".to_string()));
        }
    }

    // Same author
    if book_a.author.is_some() && book_a.author == book_b.author {
        edges.push((0.85, "author".to_string()));
    }

    // Same series
    if book_a.series.is_some() && book_a.series == book_b.series {
        let series_sim = match (book_a.series_index, book_b.series_index) {
            (Some(a), Some(b)) if (a - b).abs() <= 1.0 => 0.95, // Adjacent
            (Some(_), Some(_)) => 0.75,                         // Same series
            _ => 0.7,
        };
        edges.push((series_sim, "series".to_string()));
    }

    edges
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_graph_operations() {
        let mut graph = BookGraph::new();
        graph.add_edge(1, 2, 0.8, "content".to_string());
        graph.add_edge(1, 3, 0.6, "author".to_string());
        graph.add_edge(2, 3, 0.7, "series".to_string());

        assert_eq!(graph.node_count(), 3);

        let neighbors = graph.neighbors(1);
        assert_eq!(neighbors.len(), 2);
    }

    #[test]
    fn test_multi_hop_traversal() {
        let mut graph = BookGraph::new();
        graph.add_edge(1, 2, 0.9, "content".to_string());
        graph.add_edge(2, 3, 0.8, "content".to_string());
        graph.add_edge(3, 4, 0.7, "content".to_string());

        let config = TraversalConfig::default();
        let candidates = multi_hop_traversal(&graph, &[1], &config);

        // Should find books 2, 3, 4 via traversal
        assert!(candidates.iter().any(|c| c.book_id == 2));
        assert!(candidates.iter().any(|c| c.book_id == 3));
    }

    #[test]
    fn test_mmr_diversity() {
        let candidates = vec![
            TraversalCandidate { book_id: 1, score: 0.9, path: vec![], edge_types: vec![] },
            TraversalCandidate { book_id: 2, score: 0.85, path: vec![], edge_types: vec![] },
            TraversalCandidate { book_id: 3, score: 0.8, path: vec![], edge_types: vec![] },
        ];

        let result = maximal_marginal_relevance(&candidates, |_, _| 0.5, 0.7, 2);
        assert_eq!(result.len(), 2);
    }
}
