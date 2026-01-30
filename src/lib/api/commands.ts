/**
 * Tauri API wrapper for type-safe command invocations
 */
import { browser } from '$app/environment';

// Dynamic import of invoke to avoid SSR issues
async function getInvoke() {
	if (!browser) {
		throw new Error('Tauri commands can only be called in the browser');
	}
	const { invoke } = await import('@tauri-apps/api/core');
	return invoke;
}

// ============================================
// Types
// ============================================

export interface Book {
	id: number;
	path: string;
	coverPath: string | null;
	title: string;
	sortTitle: string | null;
	author: string | null;
	authorSort: string | null;
	series: string | null;
	seriesIndex: number | null;
	description: string | null;
	language: string | null;
	publisher: string | null;
	publishDate: string | null;
	isbn: string | null;
	fileSize: number;
	fileHash: string | null;
	calibreId: number | null;
	source: string;
	dateAdded: number;
	dateModified: number;
	dateIndexed: number | null;
	embeddingStatus: EmbeddingStatus;
	embeddingModel: string | null;
	rating: number | null;
	readStatus: ReadStatus | null;
}

export type ReadStatus = 'unread' | 'want' | 'reading' | 'finished' | 'abandoned';
export type EmbeddingStatus = 'pending' | 'processing' | 'complete' | 'failed';

export interface Library {
	id: number;
	name: string;
	path: string;
	isCalibre: boolean;
	calibreDbPath: string | null;
	lastScan: number | null;
	watchEnabled: boolean;
	bookCount: number;
	/** Whether the library path is currently accessible (e.g., external drive connected) */
	accessible: boolean;
}

export interface BookQuery {
	search?: string;
	author?: string;
	series?: string;
	tags?: string[];
	readStatus?: ReadStatus;
	minRating?: number;
	embeddingStatus?: EmbeddingStatus;
	sortBy?: 'title' | 'author' | 'dateAdded' | 'rating' | 'series';
	sortOrder?: 'asc' | 'desc';
	limit?: number;
	offset?: number;
}

export interface PagedResult<T> {
	items: T[];
	total: number;
	hasMore: boolean;
}

export interface ScanResult {
	booksFound: number;
	booksAdded: number;
	booksUpdated: number;
	errors: string[];
	durationMs: number;
}

export interface Recommendation {
	book: Book;
	score: number;
	reasons: RecommendationReason[];
}

export type RecommendationReason =
	| { type: 'similarContent'; similarity: number }
	| { type: 'sameAuthor'; author: string }
	| { type: 'sameSeries'; series: string; position: string }
	| { type: 'tagOverlap'; tags: string[] }
	| { type: 'readersAlsoLiked'; basedOn: string }
	| { type: 'nextInSeries'; previous: string };

export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface GraphNode {
	id: number;
	title: string;
	author: string | null;
	coverPath: string | null;
	rating: number | null;
}

export interface GraphEdge {
	source: number;
	target: number;
	weight: number;
	edgeType: string;
}

export interface OllamaStatus {
	connected: boolean;
	endpoint: string;
	model: string;
	modelsAvailable: string[];
	error: string | null;
}

export interface ProcessingStatus {
	totalBooks: number;
	processed: number;
	pending: number;
	currentBook: string | null;
	isPaused: boolean;
	estimatedTimeRemaining: number | null;
	booksNeedingMetadata: number;
}

export interface MetadataParsingResult {
	processed: number;
	success: number;
	failed: number;
	remaining: number;
	durationMs: number;
}

export interface Settings {
	ollamaEndpoint: string;
	ollamaModel: string;
	embeddingBatchSize: number;
	maxRecommendations: number;
	autoScanEnabled: boolean;
	scanIntervalMinutes: number;
}

export interface BookUpdate {
	title?: string;
	author?: string;
	series?: string;
	seriesIndex?: number;
	description?: string;
}

// ============================================
// Library Commands
// ============================================

export async function getLibraries(): Promise<Library[]> {
	const invoke = await getInvoke();
	return invoke('get_libraries');
}

export async function addLibrary(path: string, name?: string): Promise<Library> {
	const invoke = await getInvoke();
	return invoke('add_library', { path, name });
}

export async function removeLibrary(id: number): Promise<void> {
	const invoke = await getInvoke();
	return invoke('remove_library', { id });
}

export async function scanLibrary(id: number): Promise<ScanResult> {
	const invoke = await getInvoke();
	return invoke('scan_library', { id });
}

export async function parseMetadataBatch(batchSize?: number): Promise<MetadataParsingResult> {
	const invoke = await getInvoke();
	return invoke('parse_metadata_batch', { batchSize });
}

// ============================================
// Book Commands
// ============================================

export async function queryBooks(query: BookQuery): Promise<PagedResult<Book>> {
	const invoke = await getInvoke();
	return invoke('query_books', { query });
}

export async function getBook(id: number): Promise<Book> {
	const invoke = await getInvoke();
	return invoke('get_book', { id });
}

export async function updateBook(id: number, updates: BookUpdate): Promise<void> {
	const invoke = await getInvoke();
	return invoke('update_book', { id, updates });
}

export async function deleteBook(id: number): Promise<void> {
	const invoke = await getInvoke();
	return invoke('delete_book', { id });
}

export async function setRating(bookId: number, rating: number): Promise<void> {
	const invoke = await getInvoke();
	return invoke('set_rating', { bookId, rating });
}

export async function setReadStatus(bookId: number, status: ReadStatus): Promise<void> {
	const invoke = await getInvoke();
	return invoke('set_read_status', { bookId, status });
}

export async function getCoverImage(bookId: number): Promise<string | null> {
	const invoke = await getInvoke();
	return invoke('get_cover_image', { bookId });
}

// ============================================
// Recommendation Commands
// ============================================

export async function getRecommendations(
	bookId?: number,
	limit?: number
): Promise<Recommendation[]> {
	const invoke = await getInvoke();
	return invoke('get_recommendations', { bookId, limit });
}

export async function getPersonalizedRecommendations(limit?: number): Promise<Recommendation[]> {
	const invoke = await getInvoke();
	return invoke('get_personalized_recommendations', { limit });
}

export async function getBookGraph(
	centerId: number,
	depth?: number,
	maxNodes?: number
): Promise<GraphData> {
	const invoke = await getInvoke();
	return invoke('get_book_graph', { centerId, depth, maxNodes });
}

// ============================================
// Ollama Commands
// ============================================

export async function getOllamaStatus(): Promise<OllamaStatus> {
	const invoke = await getInvoke();
	return invoke('get_ollama_status');
}

export async function configureOllama(endpoint: string, model: string): Promise<void> {
	const invoke = await getInvoke();
	return invoke('configure_ollama', { endpoint, model });
}

export async function getProcessingStatus(): Promise<ProcessingStatus> {
	const invoke = await getInvoke();
	return invoke('get_processing_status');
}

export async function pauseProcessing(): Promise<void> {
	const invoke = await getInvoke();
	return invoke('pause_processing');
}

export async function resumeProcessing(): Promise<void> {
	const invoke = await getInvoke();
	return invoke('resume_processing');
}

export async function prioritizeBook(bookId: number): Promise<void> {
	const invoke = await getInvoke();
	return invoke('prioritize_book', { bookId });
}

export interface ProcessingResult {
	processed: number;
	failed: number;
	remaining: number;
	durationMs: number;
}

export async function processEmbeddingsBatch(batchSize?: number): Promise<ProcessingResult> {
	const invoke = await getInvoke();
	return invoke('process_embeddings_batch', { batchSize });
}

// ============================================
// Settings Commands
// ============================================

export async function getSettings(): Promise<Settings> {
	const invoke = await getInvoke();
	return invoke('get_settings');
}

export async function updateSettings(settings: Partial<Settings>): Promise<void> {
	const invoke = await getInvoke();
	return invoke('update_settings', { settings });
}

export async function getDatabasePath(): Promise<string> {
	const invoke = await getInvoke();
	return invoke('get_database_path');
}

export interface DatabaseStats {
	databaseSizeBytes: number;
	booksCount: number;
	embeddingsCount: number;
	embeddingsSizeBytes: number;
}

export interface ClearEmbeddingsResult {
	embeddingsCleared: number;
	booksReset: number;
}

export async function getDatabaseStats(): Promise<DatabaseStats> {
	const invoke = await getInvoke();
	return invoke('get_database_stats');
}

export async function resetDatabase(): Promise<void> {
	const invoke = await getInvoke();
	return invoke('reset_database');
}

export async function clearEmbeddings(): Promise<ClearEmbeddingsResult> {
	const invoke = await getInvoke();
	return invoke('clear_embeddings');
}

export interface RebuildGraphResult {
	booksProcessed: number;
	edgesCreated: number;
	durationMs: number;
}

export async function rebuildGraphEdges(): Promise<RebuildGraphResult> {
	const invoke = await getInvoke();
	return invoke('rebuild_graph_edges');
}

export interface CleanupOrphanedResult {
	checked: number;
	removed: number;
	durationMs: number;
}

export async function cleanupOrphanedBooks(): Promise<CleanupOrphanedResult> {
	const invoke = await getInvoke();
	return invoke('cleanup_orphaned_books');
}

export async function getDatabasePathPreference(): Promise<string | null> {
	const invoke = await getInvoke();
	return invoke('get_database_path_preference');
}

export async function setDatabasePathPreference(path: string): Promise<void> {
	const invoke = await getInvoke();
	return invoke('set_database_path_preference', { path });
}

// ============================================
// Export/Backup Commands
// ============================================

export async function exportLibrary(path: string): Promise<void> {
	const invoke = await getInvoke();
	return invoke('export_library', { path });
}

export async function importLibrary(path: string): Promise<void> {
	const invoke = await getInvoke();
	return invoke('import_library', { path });
}

export async function createBackup(path: string): Promise<void> {
	const invoke = await getInvoke();
	return invoke('create_backup', { path });
}

export async function restoreBackup(path: string): Promise<void> {
	const invoke = await getInvoke();
	return invoke('restore_backup', { path });
}

// ============================================
// Utility Functions
// ============================================

export function formatFileSize(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB'];
	let size = bytes;
	let unitIndex = 0;

	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}

	return `${size.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDate(timestamp: number): string {
	return new Date(timestamp * 1000).toLocaleDateString();
}

export function getReasonText(reason: RecommendationReason): string {
	switch (reason.type) {
		case 'similarContent':
			return `${Math.round(reason.similarity * 100)}% similar content`;
		case 'sameAuthor':
			return `By ${reason.author}`;
		case 'sameSeries':
			return `${reason.position} in ${reason.series}`;
		case 'tagOverlap':
			return `Shares tags: ${reason.tags.join(', ')}`;
		case 'readersAlsoLiked':
			return `Readers of "${reason.basedOn}" also liked`;
		case 'nextInSeries':
			return `Next after "${reason.previous}"`;
	}
}
