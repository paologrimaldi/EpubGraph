/**
 * Recently Viewed Books Store
 *
 * Tracks books that the user has recently selected/viewed.
 * Persists to localStorage for cross-session persistence.
 */
import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';

const STORAGE_KEY = 'epubgraph_recently_viewed';
const MAX_RECENT = 20;

// Initialize from localStorage
function loadFromStorage(): number[] {
	if (!browser) return [];
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			return JSON.parse(stored);
		}
	} catch (e) {
		console.warn('Failed to load recently viewed from storage:', e);
	}
	return [];
}

// Save to localStorage
function saveToStorage(bookIds: number[]): void {
	if (!browser) return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(bookIds));
	} catch (e) {
		console.warn('Failed to save recently viewed to storage:', e);
	}
}

// Create the store
export const recentlyViewedIds = writable<number[]>(loadFromStorage());

// Subscribe to changes and persist
recentlyViewedIds.subscribe((ids) => {
	saveToStorage(ids);
});

/**
 * Add a book to the recently viewed list
 * Moves to front if already in list, maintains max size
 */
export function addRecentlyViewed(bookId: number): void {
	recentlyViewedIds.update((ids) => {
		// Remove if already exists (will be added to front)
		const filtered = ids.filter((id) => id !== bookId);
		// Add to front and limit size
		return [bookId, ...filtered].slice(0, MAX_RECENT);
	});
}

/**
 * Get recently viewed book IDs
 */
export function getRecentlyViewedIds(): number[] {
	return get(recentlyViewedIds);
}

/**
 * Clear recently viewed history
 */
export function clearRecentlyViewed(): void {
	recentlyViewedIds.set([]);
}
