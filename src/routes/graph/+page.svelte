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
		const idParam = $page.url.searchParams.get('id');
		if (idParam) {
			centerId = parseInt(idParam, 10);
			await loadCenterBook();
		}
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
			const recentIds = $recentlyViewedIds.slice(0, 10);
			if (recentIds.length > 0) {
				const bookPromises = recentIds.map((id) =>
					invoke('get_book', { id }).catch(() => null)
				);
				const books = await Promise.all(bookPromises);
				recentBooks = books.filter((b): b is Book => b !== null);
			}
			if (recentBooks.length === 0) {
				const result = await invoke('query_books', {
					query: { limit: 10, sortBy: 'dateAdded', sortOrder: 'desc' }
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
				query: { search: searchQuery, limit: 10 }
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
		addRecentlyViewed(book.id);
		const url = new URL($page.url);
		url.searchParams.set('id', String(book.id));
		replaceState(url, {});
	}

	async function handleNodeClick(nodeId: number) {
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
	<header class="flex-none px-5 py-3.5 border-b border-[var(--gw-separator)]">
		<div class="flex items-center justify-between">
			<div>
				<h1 class="text-[17px] font-semibold tracking-tight">Book Relationships</h1>
				<p class="text-[12px] text-muted mt-0.5">
					Explore connections between books based on content, authors, and series
				</p>
			</div>
			<a
				href="/"
				class="flex items-center gap-1.5 text-[13px] text-secondary hover:text-[var(--gw-fg)] transition-colors"
			>
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
				</svg>
				Back to Library
			</a>
		</div>
	</header>

	<div class="flex-1 flex overflow-hidden">
		<!-- Sidebar -->
		<div class="w-72 border-r border-[var(--gw-separator)] flex flex-col" style="background: var(--gw-bg)">
			<!-- Search -->
			<div class="p-4 border-b border-[var(--gw-separator)]">
				<label class="block text-[11px] font-semibold text-muted uppercase tracking-widest mb-2">
					Select Center Book
				</label>
				<div class="relative">
					<input
						type="text"
						bind:value={searchQuery}
						on:input={handleSearchInput}
						placeholder="Search for a book..."
						class="glass-input"
					/>
					{#if searching}
						<div class="absolute right-2.5 top-1/2 -translate-y-1/2">
							<div class="animate-spin h-3.5 w-3.5 border-[1.5px] border-t-transparent rounded-full" style="border-color: var(--gw-accent); border-top-color: transparent"></div>
						</div>
					{/if}
				</div>

				{#if searchResults.length > 0}
					<div class="mt-2 border border-[var(--gw-border)] rounded-lg max-h-48 overflow-y-auto" style="background: var(--gw-bg-secondary)">
						{#each searchResults as book}
							<button
								on:click={() => selectBook(book)}
								class="w-full px-3 py-2 text-left hover:bg-[var(--gw-surface-tint)] border-b last:border-b-0 border-[var(--gw-separator)] transition-colors"
							>
								<p class="text-[13px] font-medium truncate">{book.title}</p>
								<p class="text-[11px] text-muted truncate">{book.author || 'Unknown Author'}</p>
							</button>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Current Selection -->
			{#if centerBook}
				<div class="p-4 border-b border-[var(--gw-separator)]">
					<p class="text-[11px] font-semibold text-muted uppercase tracking-widest mb-2">Current Center</p>
					<div class="p-2.5 rounded-lg" style="background: var(--gw-surface-tint)">
						<p class="text-[13px] font-medium truncate">{centerBook.title}</p>
						<p class="text-[12px] text-muted truncate">{centerBook.author || 'Unknown Author'}</p>
						{#if centerBook.series}
							<p class="text-[11px] mt-0.5" style="color: var(--gw-accent-text)">
								{centerBook.series} #{centerBook.seriesIndex}
							</p>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Options -->
			<div class="p-4 border-b border-[var(--gw-separator)]">
				<p class="text-[11px] font-semibold text-muted uppercase tracking-widest mb-3">Graph Options</p>

				<div class="space-y-3.5">
					<div>
						<label class="block text-[12px] text-secondary mb-1.5">
							Depth: {depth}
						</label>
						<input type="range" bind:value={depth} min="1" max="3" class="w-full" />
					</div>

					<div>
						<label class="block text-[12px] text-secondary mb-1.5">
							Max Nodes: {maxNodes}
						</label>
						<input type="range" bind:value={maxNodes} min="10" max="100" step="10" class="w-full" />
					</div>
				</div>
			</div>

			<!-- Recently Viewed Books -->
			<div class="flex-1 overflow-y-auto p-4">
				<p class="text-[11px] font-semibold text-muted uppercase tracking-widest mb-2.5">Recently Viewed</p>
				<div class="space-y-0.5">
					{#each recentBooks as book}
						<button
							on:click={() => selectBook(book)}
							class="w-full text-left p-2 rounded-lg transition-colors
								{centerId === book.id
									? ''
									: 'hover:bg-[var(--gw-surface-tint)]'}"
							style={centerId === book.id ? 'background: var(--gw-accent-subtle); border: 0.5px solid var(--gw-accent-subtle)' : ''}
						>
							<p class="text-[13px] font-medium truncate"
							   style={centerId === book.id ? 'color: var(--gw-accent-text)' : ''}
							>{book.title}</p>
							<p class="text-[11px] text-muted truncate">{book.author || 'Unknown'}</p>
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
