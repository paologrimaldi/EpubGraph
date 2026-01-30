/**
 * Up Next Store
 *
 * Manages the "Up Next" reading queue - books the user wants to read soon.
 * Books can be added explicitly or automatically when their read status is "want".
 */
import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import type { Book } from '$lib/api/commands';
import {
	getUpNextBooks,
	addToUpNext as apiAddToUpNext,
	removeFromUpNext as apiRemoveFromUpNext,
	isInUpNext as apiIsInUpNext,
	getUpNextCount,
	getWantToReadBooks
} from '$lib/api/commands';

// Store for explicitly added Up Next books
export const upNextBooks = writable<Book[]>([]);

// Store for want-to-read books (automatically included)
export const wantToReadBooks = writable<Book[]>([]);

// Loading state
export const upNextLoading = writable(false);

// Combined list: explicit Up Next + want-to-read books (deduped)
export const upNextBooksWithWant = derived(
	[upNextBooks, wantToReadBooks],
	([$upNextBooks, $wantToReadBooks]) => {
		// Combine and deduplicate by book ID
		const bookMap = new Map<number, Book>();

		// Add explicit Up Next books first (they take priority)
		for (const book of $upNextBooks) {
			bookMap.set(book.id, book);
		}

		// Add want-to-read books that aren't already in the list
		for (const book of $wantToReadBooks) {
			if (!bookMap.has(book.id)) {
				bookMap.set(book.id, book);
			}
		}

		return Array.from(bookMap.values());
	}
);

// Count of books in Up Next (explicit only, not including auto-added want books)
export const upNextCount = derived(upNextBooks, ($upNextBooks) => $upNextBooks.length);

// Total count including want-to-read
export const upNextTotalCount = derived(
	upNextBooksWithWant,
	($upNextBooksWithWant) => $upNextBooksWithWant.length
);

/**
 * Load Up Next books from the backend
 */
export async function loadUpNextBooks(): Promise<void> {
	if (!browser) return;

	upNextLoading.set(true);
	try {
		const [upNext, wantBooks] = await Promise.all([
			getUpNextBooks(),
			getWantToReadBooks()
		]);
		upNextBooks.set(upNext);
		wantToReadBooks.set(wantBooks);
	} catch (error) {
		console.error('Failed to load Up Next books:', error);
	} finally {
		upNextLoading.set(false);
	}
}

/**
 * Add a book to the Up Next queue
 */
export async function addToUpNext(bookId: number): Promise<void> {
	if (!browser) return;

	try {
		await apiAddToUpNext(bookId);
		// Reload to get the updated list
		await loadUpNextBooks();
	} catch (error) {
		console.error('Failed to add to Up Next:', error);
		throw error;
	}
}

/**
 * Remove a book from the Up Next queue
 */
export async function removeFromUpNext(bookId: number): Promise<void> {
	if (!browser) return;

	try {
		await apiRemoveFromUpNext(bookId);
		// Update the local store immediately for responsiveness
		upNextBooks.update((books) => books.filter((b) => b.id !== bookId));
	} catch (error) {
		console.error('Failed to remove from Up Next:', error);
		throw error;
	}
}

/**
 * Check if a book is explicitly in the Up Next queue (not auto-added via want status)
 */
export async function checkIsInUpNext(bookId: number): Promise<boolean> {
	if (!browser) return false;

	try {
		return await apiIsInUpNext(bookId);
	} catch (error) {
		console.error('Failed to check Up Next status:', error);
		return false;
	}
}

/**
 * Check if a book is in Up Next (checks local store for performance)
 */
export function isInUpNextSync(bookId: number): boolean {
	const books = get(upNextBooks);
	return books.some((b) => b.id === bookId);
}

/**
 * Toggle a book's Up Next status
 */
export async function toggleUpNext(bookId: number): Promise<boolean> {
	const isCurrentlyInUpNext = isInUpNextSync(bookId);

	if (isCurrentlyInUpNext) {
		await removeFromUpNext(bookId);
		return false;
	} else {
		await addToUpNext(bookId);
		return true;
	}
}

/**
 * Refresh the want-to-read books list
 * Call this when a book's read status changes
 */
export async function refreshWantToReadBooks(): Promise<void> {
	if (!browser) return;

	try {
		const wantBooks = await getWantToReadBooks();
		wantToReadBooks.set(wantBooks);
	} catch (error) {
		console.error('Failed to refresh want-to-read books:', error);
	}
}
