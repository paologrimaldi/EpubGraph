<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, replaceState } from '$app/navigation';
	import { page } from '$app/stores';
	import { invoke } from '@tauri-apps/api/core';
	import GraphView from '$lib/components/GraphView.svelte';
	import type { Book } from '$lib/api/commands';
	import { recentlyViewedIds, addRecentlyViewed } from '$lib/stores/recentlyViewed';

	let centerId: number | null = null;
	let depth = 2;
	let maxNodes = 50;
	let centerBook: Book | null = null;
	let recentBooks: Book[] = [];
	let searchQuery = '';
	let searchResults: Book[] = [];
	let searching = false;

	onMount(async () => {
		// Check URL params for initial book
		const idParam = $page.url.searchParams.get('id');
		if (idParam) {
			centerId = parseInt(idParam, 10);
			await loadCenterBook();
		}

		// Load recent books for quick selection
		await loadRecentBooks();
	});

	async function loadCenterBook() {
		if (centerId === null) return;

		try {
			centerBook = await invoke('get_book', { id: centerId });
		} catch (e) {
			console.error('Failed to load center book:', e);
		}
	}

	async function loadRecentBooks() {
		try {
			// Get recently viewed book IDs
			const recentIds = $recentlyViewedIds.slice(0, 10);

			if (recentIds.length > 0) {
				// Load books by their IDs
				const bookPromises = recentIds.map((id) =>
					invoke('get_book', { id }).catch(() => null)
				);
				const books = await Promise.all(bookPromises);
				recentBooks = books.filter((b): b is Book => b !== null);
			}

			// If no recent books, fall back to recently added
			if (recentBooks.length === 0) {
				const result = await invoke('query_books', {
					query: {
						limit: 10,
						sortBy: 'dateAdded',
						sortOrder: 'desc'
					}
				});
				recentBooks = (result as any).items;
			}
		} catch (e) {
			console.error('Failed to load recent books:', e);
		}
	}

	async function searchBooks() {
		if (!searchQuery.trim()) {
			searchResults = [];
			return;
		}

		searching = true;
		try {
			const result = await invoke('query_books', {
				query: {
					search: searchQuery,
					limit: 10
				}
			});
			searchResults = (result as any).items;
		} catch (e) {
			console.error('Search failed:', e);
		} finally {
			searching = false;
		}
	}

	function selectBook(book: Book) {
		centerId = book.id;
		centerBook = book;
		searchQuery = '';
		searchResults = [];

		// Track as recently viewed
		addRecentlyViewed(book.id);

		// Update URL using SvelteKit's navigation
		const url = new URL($page.url);
		url.searchParams.set('id', String(book.id));
		replaceState(url, {});
	}

	async function handleNodeClick(nodeId: number) {
		// Recenter the graph on the clicked book
		try {
			const book = await invoke('get_book', { id: nodeId }) as Book;
			selectBook(book);
		} catch (e) {
			console.error('Failed to load clicked book:', e);
		}
	}

	let searchTimeout: ReturnType<typeof setTimeout>;
	function handleSearchInput() {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(searchBooks, 300);
	}
</script>

<svelte:head>
	<title>Book Graph - EpubGraph</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header -->
	<div class="p-4 border-b border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800">
		<div class="flex items-center justify-between">
			<div>
				<h1 class="text-xl font-semibold text-surface-900 dark:text-surface-100">Book Relationships</h1>
				<p class="text-sm text-surface-500 mt-1">
					Explore connections between books based on content, authors, and series
				</p>
			</div>

			<a
				href="/"
				class="flex items-center gap-2 px-4 py-2 text-surface-600 hover:text-surface-900 dark:text-surface-400 dark:hover:text-surface-100"
			>
				<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
				</svg>
				Back to Library
			</a>
		</div>
	</div>

	<div class="flex-1 flex overflow-hidden">
		<!-- Sidebar -->
		<div class="w-80 border-r border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 flex flex-col">
			<!-- Search -->
			<div class="p-4 border-b border-surface-200 dark:border-surface-700">
				<label class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
					Select Center Book
				</label>
				<div class="relative">
					<input
						type="text"
						bind:value={searchQuery}
						on:input={handleSearchInput}
						placeholder="Search for a book..."
						class="w-full px-3 py-2 border border-surface-300 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-surface-900 dark:text-surface-100 placeholder-surface-400 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
					/>
					{#if searching}
						<div class="absolute right-3 top-1/2 -translate-y-1/2">
							<div class="animate-spin h-4 w-4 border-2 border-primary-500 border-t-transparent rounded-full"></div>
						</div>
					{/if}
				</div>

				<!-- Search Results -->
				{#if searchResults.length > 0}
					<div class="mt-2 border border-surface-200 dark:border-surface-600 rounded-lg max-h-48 overflow-y-auto">
						{#each searchResults as book}
							<button
								on:click={() => selectBook(book)}
								class="w-full px-3 py-2 text-left hover:bg-surface-50 dark:hover:bg-surface-700 border-b last:border-b-0 border-surface-200 dark:border-surface-600"
							>
								<p class="text-sm font-medium text-surface-900 dark:text-surface-100 truncate">
									{book.title}
								</p>
								<p class="text-xs text-surface-500 truncate">
									{book.author || 'Unknown Author'}
								</p>
							</button>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Current Selection -->
			{#if centerBook}
				<div class="p-4 border-b border-surface-200 dark:border-surface-700">
					<p class="text-xs font-medium text-surface-500 uppercase tracking-wide mb-2">Current Center</p>
					<div class="bg-surface-50 dark:bg-surface-700 rounded-lg p-3">
						<p class="font-medium text-surface-900 dark:text-surface-100 truncate">
							{centerBook.title}
						</p>
						<p class="text-sm text-surface-500 truncate">
							{centerBook.author || 'Unknown Author'}
						</p>
						{#if centerBook.series}
							<p class="text-xs text-surface-400 mt-1">
								{centerBook.series} #{centerBook.seriesIndex}
							</p>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Options -->
			<div class="p-4 border-b border-surface-200 dark:border-surface-700">
				<p class="text-xs font-medium text-surface-500 uppercase tracking-wide mb-3">Graph Options</p>

				<div class="space-y-4">
					<div>
						<label class="block text-sm text-surface-600 dark:text-surface-400 mb-1">
							Depth: {depth}
						</label>
						<input
							type="range"
							bind:value={depth}
							min="1"
							max="3"
							class="w-full"
						/>
					</div>

					<div>
						<label class="block text-sm text-surface-600 dark:text-surface-400 mb-1">
							Max Nodes: {maxNodes}
						</label>
						<input
							type="range"
							bind:value={maxNodes}
							min="10"
							max="100"
							step="10"
							class="w-full"
						/>
					</div>
				</div>
			</div>

			<!-- Recently Viewed Books -->
			<div class="flex-1 overflow-y-auto p-4">
				<p class="text-xs font-medium text-surface-500 uppercase tracking-wide mb-3">Recently Viewed</p>
				<div class="space-y-2">
					{#each recentBooks as book}
						<button
							on:click={() => selectBook(book)}
							class="w-full text-left p-2 rounded-lg hover:bg-surface-50 dark:hover:bg-surface-700 {centerId === book.id ? 'bg-primary-50 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-800' : ''}"
						>
							<p class="text-sm font-medium text-surface-900 dark:text-surface-100 truncate">
								{book.title}
							</p>
							<p class="text-xs text-surface-500 truncate">
								{book.author || 'Unknown'}
							</p>
						</button>
					{/each}
				</div>
			</div>
		</div>

		<!-- Graph -->
		<div class="flex-1 p-4">
			<GraphView
				{centerId}
				{depth}
				{maxNodes}
				onNodeClick={handleNodeClick}
			/>
		</div>
	</div>
</div>
