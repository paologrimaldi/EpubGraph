/**
 * Library store - manages library state and book queries
 */
import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import * as api from '$lib/api/commands';
import type { Book, Library, BookQuery, PagedResult } from '$lib/api/commands';

// ============================================
// State
// ============================================

export const libraries = writable<Library[]>([]);
export const selectedLibrary = writable<Library | null>(null);
export const books = writable<Book[]>([]);
export const totalBooks = writable<number>(0);
export const selectedBook = writable<Book | null>(null);
export const isLoading = writable<boolean>(false);
export const isScanning = writable<boolean>(false);
export const scanProgress = writable<{
	phase: string;
	found: number;
	processed: number;
	total: number;
	current: string | null;
	etaSeconds: number | null;
} | null>(null);
export const searchQuery = writable<string>('');
export const filters = writable<Omit<BookQuery, 'search' | 'limit' | 'offset'>>({});
export const sortBy = writable<BookQuery['sortBy']>('dateAdded');
export const sortOrder = writable<BookQuery['sortOrder']>('desc');

// Pagination
const PAGE_SIZE = 50;
export const currentPage = writable<number>(0);
export const hasMore = writable<boolean>(false);

// ============================================
// Derived Stores
// ============================================

export const currentQuery = derived(
	[searchQuery, filters, sortBy, sortOrder, currentPage],
	([$search, $filters, $sortBy, $sortOrder, $page]) => ({
		search: $search || undefined,
		...$filters,
		sortBy: $sortBy,
		sortOrder: $sortOrder,
		limit: PAGE_SIZE,
		offset: $page * PAGE_SIZE
	})
);

export const uniqueAuthors = derived(books, ($books) => {
	const authors = new Set<string>();
	$books.forEach((b) => {
		if (b.author) authors.add(b.author);
	});
	return Array.from(authors).sort();
});

export const uniqueSeries = derived(books, ($books) => {
	const series = new Set<string>();
	$books.forEach((b) => {
		if (b.series) series.add(b.series);
	});
	return Array.from(series).sort();
});

// ============================================
// Actions
// ============================================

export async function loadLibraries(): Promise<void> {
	if (!browser) return;

	try {
		isLoading.set(true);
		const result = await api.getLibraries();
		libraries.set(result);

		// Auto-select first library if none selected
		if (result.length > 0 && !get(selectedLibrary)) {
			selectedLibrary.set(result[0]);
		}
	} catch (error) {
		console.error('Failed to load libraries:', error);
		throw error;
	} finally {
		isLoading.set(false);
	}
}

export async function addLibrary(path: string, name?: string): Promise<Library> {
	const library = await api.addLibrary(path, name);
	libraries.update((libs) => [...libs, library]);
	return library;
}

export async function removeLibrary(id: number): Promise<void> {
	await api.removeLibrary(id);
	libraries.update((libs) => libs.filter((l) => l.id !== id));

	// Clear selection if removed
	if (get(selectedLibrary)?.id === id) {
		selectedLibrary.set(null);
	}
}

export async function scanLibrary(id: number): Promise<api.ScanResult> {
	try {
		isScanning.set(true);
		scanProgress.set(null);
		const result = await api.scanLibrary(id);

		// Reload libraries to get updated counts
		await loadLibraries();

		// Reload books
		await loadBooks();

		return result;
	} finally {
		isScanning.set(false);
		scanProgress.set(null);
	}
}

// Set up event listeners for scan progress
export async function setupScanEventListeners(): Promise<() => void> {
	if (!browser) return () => {};

	const { listen } = await import('@tauri-apps/api/event');

	const unlisteners: Array<() => void> = [];

	const unlistenProgress = await listen<{
		phase: string;
		found: number;
		processed: number;
		total: number;
		current: string | null;
		etaSeconds: number | null;
	}>('scan:progress', (event) => {
		scanProgress.set(event.payload);
	});
	unlisteners.push(unlistenProgress);

	const unlistenComplete = await listen('scan:complete', () => {
		scanProgress.set(null);
	});
	unlisteners.push(unlistenComplete);

	return () => {
		unlisteners.forEach((unlisten) => unlisten());
	};
}

export async function loadBooks(): Promise<void> {
	if (!browser) return;

	console.log('[loadBooks] Starting...');
	try {
		isLoading.set(true);
		const query = get(currentQuery);
		console.log('[loadBooks] Query:', query);
		const result = await api.queryBooks(query);
		console.log('[loadBooks] Result:', result.total, 'total,', result.items.length, 'items, hasMore:', result.hasMore);

		if (query.offset === 0) {
			books.set(result.items);
		} else {
			// Append for infinite scroll
			books.update((current) => [...current, ...result.items]);
		}

		totalBooks.set(result.total);
		hasMore.set(result.hasMore);
	} catch (error) {
		console.error('[loadBooks] Failed:', error);
		throw error;
	} finally {
		isLoading.set(false);
	}
}

export async function loadMoreBooks(): Promise<void> {
	if (get(isLoading) || !get(hasMore)) return;

	currentPage.update((p) => p + 1);
	await loadBooks();
}

export function resetPagination(): void {
	currentPage.set(0);
	books.set([]);
}

export async function search(query: string): Promise<void> {
	searchQuery.set(query);
	resetPagination();
	await loadBooks();
}

export async function setFilters(newFilters: Omit<BookQuery, 'search' | 'limit' | 'offset'>): Promise<void> {
	filters.set(newFilters);
	resetPagination();
	await loadBooks();
}

export async function setSort(by: BookQuery['sortBy'], order: BookQuery['sortOrder']): Promise<void> {
	sortBy.set(by);
	sortOrder.set(order);
	resetPagination();
	await loadBooks();
}

export async function selectBook(book: Book | null): Promise<void> {
	selectedBook.set(book);
}

export async function rateBook(bookId: number, rating: number): Promise<void> {
	await api.setRating(bookId, rating);

	// Update local state
	books.update((list) =>
		list.map((b) => (b.id === bookId ? { ...b, rating } : b))
	);

	if (get(selectedBook)?.id === bookId) {
		selectedBook.update((b) => (b ? { ...b, rating } : null));
	}
}

export async function setBookReadStatus(bookId: number, status: api.ReadStatus): Promise<void> {
	await api.setReadStatus(bookId, status);

	// Update local state
	books.update((list) =>
		list.map((b) => (b.id === bookId ? { ...b, readStatus: status } : b))
	);

	if (get(selectedBook)?.id === bookId) {
		selectedBook.update((b) => (b ? { ...b, readStatus: status } : null));
	}
}

// ============================================
// Initialize
// ============================================

// Note: Books are loaded explicitly via loadBooks() calls from components
// to avoid double-loading and race conditions. The onMount in +page.svelte
// handles the initial load.
