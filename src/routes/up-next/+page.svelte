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
	import { ListTodo, BookOpen } from 'lucide-svelte';

	let selectedBookId: number | null = null;
	// Derived (not separately tracked) so there's a single source of truth for
	// "which book is inspected" — Library3D's inspect view reassigns
	// selectedBookId directly (two-way bind), and a close initiated from
	// *inside* the 3D view (Escape, empty-canvas click) nulls it the same way
	// a close from this sidebar's own button does, so both paths converge here.
	$: selectedBook = $upNextBooksWithWant.find((b) => b.id === selectedBookId) ?? null;

	function handleCloseDetail() {
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
		<header class="flex-none px-5 py-3.5 border-b border-[var(--gw-separator)]">
			<div class="flex items-center gap-2.5">
				<div class="w-8 h-8 rounded-lg flex items-center justify-center" style="background: var(--gw-accent-subtle)">
					<ListTodo class="w-4 h-4" style="color: var(--gw-accent)" />
				</div>
				<div>
					<h1 class="text-[17px] font-semibold tracking-tight">Up Next</h1>
					<p class="text-[12px] text-muted">
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
					<div class="flex flex-col items-center gap-3">
						<div class="animate-spin rounded-full h-8 w-8 border-2 border-t-transparent" style="border-color: var(--gw-accent); border-top-color: transparent"></div>
						<p class="text-[13px] text-muted">Loading your reading queue...</p>
					</div>
				</div>
			{:else if $upNextBooksWithWant.length === 0}
				<div class="absolute inset-0 flex items-center justify-center">
					<div class="text-center max-w-sm px-6">
						<div class="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4" style="background: var(--gw-surface-tint)">
							<BookOpen class="w-7 h-7 text-muted" />
						</div>
						<h2 class="text-[17px] font-semibold tracking-tight mb-1.5">Your reading queue is empty</h2>
						<p class="text-[13px] text-muted mb-5 leading-relaxed">
							Add books to "Up Next" from your library. Books marked as "Want to Read" will also appear here.
						</p>
						<a href="/" class="btn-primary inline-flex">
							Browse Library
						</a>
					</div>
				</div>
			{:else}
				<Library3D books={$upNextBooksWithWant} bind:selectedBookId />
			{/if}

			<!-- Book Detail Sidebar — an absolute overlay (not a flex sibling) so the
			     canvas never resizes when it opens/closes; Library3D's inspect view
			     shifts its own camera view-offset to keep the book clear of it. -->
			{#if selectedBook}
				<aside class="absolute right-0 top-0 bottom-0 w-[22rem] z-10 border-l border-[var(--gw-separator)] overflow-hidden">
					<BookDetail book={selectedBook} context="upnext" on:close={handleCloseDetail} />
				</aside>
			{/if}
		</div>
	</div>
</div>

<style>
	:global(.library-wrapper) {
		height: 100% !important;
	}
</style>
