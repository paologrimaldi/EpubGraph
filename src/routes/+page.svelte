<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import {
		books,
		totalBooks,
		selectedBook,
		isLoading,
		searchQuery,
		search,
		loadMoreBooks,
		loadBooks,
		hasMore,
		selectBook
	} from '$lib/stores/library';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import BookGrid from '$lib/components/BookGrid.svelte';
	import BookDetail from '$lib/components/BookDetail.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { Library, BookOpen } from 'lucide-svelte';

	let showDetail = false;

	$: if ($selectedBook) {
		showDetail = true;
	}

	function closeDetail() {
		showDetail = false;
		selectBook(null);
	}

	function handleSelectBook(book: any) {
		if ($selectedBook?.id === book.id) return;
		selectBook(book);
	}

	onMount(async () => {
		if (!browser) return;
		try {
			await loadBooks();
		} catch (err) {
			console.error('Failed to load books:', err);
		}
	});
</script>

<svelte:head>
	<title>Library - EpubGraph</title>
</svelte:head>

<div class="flex flex-col h-full">
	<!-- Header -->
	<header class="flex-none px-5 py-3.5 border-b border-[var(--gw-separator)]">
		<div class="flex items-center justify-between gap-4">
			<div class="flex items-center gap-2.5">
				<BookOpen class="w-5 h-5" style="color: var(--gw-accent)" />
				<h1 class="text-[17px] font-semibold tracking-tight">Library</h1>
				<span class="text-[12px] text-muted tabular-nums">
					{$totalBooks.toLocaleString()} books
				</span>
			</div>

			<SearchBar value={$searchQuery} on:search={(e) => search(e.detail)} />
		</div>
	</header>

	<!-- Content -->
	<div class="flex-1 flex overflow-hidden">
		<!-- Book Grid -->
		<div class="flex-1 overflow-auto p-5">
			{#if $books.length === 0 && !$isLoading}
				<EmptyState
					icon={Library}
					title="No books found"
					description={$searchQuery
						? "Try a different search term"
						: "Add a library folder to get started"}
				/>
			{:else}
				<BookGrid
					books={$books}
					loading={$isLoading}
					hasMore={$hasMore}
					selectedBookId={$selectedBook?.id ?? null}
					on:loadMore={loadMoreBooks}
					on:select={(e) => handleSelectBook(e.detail)}
				/>
			{/if}
		</div>

		<!-- Book Detail Sidebar -->
		{#if showDetail && $selectedBook}
			<aside class="w-[22rem] flex-none border-l border-[var(--gw-separator)] overflow-auto">
				{#key $selectedBook.id}
					<BookDetail book={$selectedBook} on:close={closeDetail} />
				{/key}
			</aside>
		{/if}
	</div>
</div>
