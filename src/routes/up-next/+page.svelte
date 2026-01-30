<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { Library3D } from '$lib/components/bookshelf';
	import BookDetail from '$lib/components/BookDetail.svelte';
	import {
		upNextBooksWithWant,
		upNextLoading,
		loadUpNextBooks,
		upNextTotalCount
	} from '$lib/stores/upnext';
	import type { Book } from '$lib/api/commands';
	import { ListTodo, BookOpen } from 'lucide-svelte';

	let selectedBook: Book | null = null;
	let selectedBookId: number | null = null;

	function handleBookSelected(event: CustomEvent<Book>) {
		selectedBook = event.detail;
		selectedBookId = event.detail.id;
	}

	function handleCloseDetail() {
		selectedBook = null;
		selectedBookId = null;
	}

	onMount(() => {
		if (browser) {
			loadUpNextBooks();
		}
	});
</script>

<svelte:head>
	<title>Up Next - EpubGraph</title>
</svelte:head>

<div class="flex h-full">
	<!-- Main Content -->
	<div class="flex-1 flex flex-col min-w-0">
		<!-- Header -->
		<header class="flex-none p-6 border-b border-glass-subtle">
			<div class="flex items-center gap-3">
				<div class="w-10 h-10 rounded-xl gw-card flex items-center justify-center">
					<ListTodo class="w-5 h-5" style="color: var(--gw-accent)" />
				</div>
				<div>
					<h1 class="text-xl font-semibold">Up Next</h1>
					<p class="text-sm text-muted">
						{#if $upNextLoading}
							Loading...
						{:else if $upNextTotalCount === 0}
							No books in your reading queue
						{:else}
							{$upNextTotalCount} book{$upNextTotalCount === 1 ? '' : 's'} to read
						{/if}
					</p>
				</div>
			</div>
		</header>

		<!-- 3D Bookshelf View -->
		<div class="flex-1 min-h-0 relative">
			{#if $upNextLoading}
				<div class="absolute inset-0 flex items-center justify-center">
					<div class="flex flex-col items-center gap-4">
						<div class="animate-spin rounded-full h-10 w-10 border-2 border-t-transparent" style="border-color: var(--gw-accent); border-top-color: transparent"></div>
						<p class="text-muted">Loading your reading queue...</p>
					</div>
				</div>
			{:else if $upNextBooksWithWant.length === 0}
				<div class="absolute inset-0 flex items-center justify-center">
					<div class="text-center max-w-md px-6">
						<div class="w-16 h-16 rounded-2xl gw-card flex items-center justify-center mx-auto mb-4">
							<BookOpen class="w-8 h-8 text-muted" />
						</div>
						<h2 class="text-lg font-medium mb-2">Your reading queue is empty</h2>
						<p class="text-muted text-sm mb-4">
							Add books to "Up Next" from your library to see them displayed on a 3D bookshelf.
							Books marked as "Want to Read" will also appear here automatically.
						</p>
						<a
							href="/"
							class="gw-btn"
						>
							Browse Library
						</a>
					</div>
				</div>
			{:else}
				<Library3D
					books={$upNextBooksWithWant}
					bind:selectedBookId
					on:bookSelected={handleBookSelected}
					maxBooksPerShelf={8}
				/>
			{/if}
		</div>
	</div>

	<!-- Book Detail Sidebar -->
	{#if selectedBook}
		<aside class="w-96 flex-none border-l border-glass-subtle overflow-hidden">
			<BookDetail book={selectedBook} context="upnext" on:close={handleCloseDetail} />
		</aside>
	{/if}
</div>

<style>
	/* Ensure the 3D view takes full height */
	:global(.library-wrapper) {
		height: 100% !important;
	}
</style>
