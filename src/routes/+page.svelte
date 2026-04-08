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
		selectBook,
		showHidden,
		toggleShowHidden,
		hideBook,
		unhideBook,
		deleteBookFull
	} from '$lib/stores/library';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import SortSelect from '$lib/components/SortSelect.svelte';
	import BookGrid from '$lib/components/BookGrid.svelte';
	import BookDetail from '$lib/components/BookDetail.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { Library, BookOpen, Eye } from 'lucide-svelte';

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

	async function handleKeyDown(event: KeyboardEvent) {
		// Don't trigger when typing in inputs
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;

		const book = $selectedBook;
		if (!book) return;

		if (event.key === 'h' || event.key === 'H') {
			event.preventDefault();
			try {
				if (book.hidden) {
					await unhideBook(book.id);
				} else {
					await hideBook(book.id);
				}
			} catch (e) {
				console.error('Failed to hide/unhide book:', e);
			}
		}

		if (event.key === 'Delete' || event.key === 'Backspace') {
			event.preventDefault();
			try {
				const { ask } = await import('@tauri-apps/plugin-dialog');
				const { getBookDeleteInfo } = await import('$lib/api/commands');

				const confirmed = await ask(
					`Delete "${book.title}"? The file will be sent to Trash.`,
					{ title: 'Delete Book', kind: 'warning' }
				);
				if (!confirmed) return;

				let trashFolder = false;
				const deleteInfo = await getBookDeleteInfo(book.id);
				if (deleteInfo.hasBookFolder) {
					trashFolder = await ask(
						`"${book.title}" is inside folder "${deleteInfo.folderName}" which also contains cover and metadata files. Delete the entire folder?`,
						{ title: 'Delete Folder', kind: 'warning', okLabel: 'Delete Folder', cancelLabel: 'File Only' }
					);
				}

				await deleteBookFull(book.id, trashFolder);
			} catch (e) {
				console.error('Failed to delete book:', e);
			}
		}
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

<svelte:window on:keydown={handleKeyDown} />

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

			<div class="flex items-center gap-2.5">
				<button
					class="flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-md transition-colors"
					class:text-muted={!$showHidden}
					class:text-[var(--gw-accent)]={$showHidden}
					class:bg-[var(--gw-accent-subtle)]={$showHidden}
					on:click={toggleShowHidden}
					title={$showHidden ? 'Hide hidden books' : 'Show hidden books'}
				>
					<Eye class="w-3.5 h-3.5" />
					{#if $showHidden}Hidden{/if}
				</button>
			</div>

			<div class="flex items-center gap-2.5">
				<SortSelect />
				<SearchBar value={$searchQuery} on:search={(e) => search(e.detail)} />
			</div>
		</div>
	</header>

	<!-- Content -->
	<div class="flex-1 flex overflow-hidden">
		<!-- Book Grid -->
		<div class="flex-1 overflow-hidden">
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
