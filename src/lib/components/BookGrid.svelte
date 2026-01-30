<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import type { Book } from '$lib/api/commands';
	import BookCard from './BookCard.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import type { ContextMenuItem } from './ContextMenu.svelte';
	import { isInUpNextSync, toggleUpNext, loadUpNextBooks } from '$lib/stores/upnext';
	import { ListPlus, ListMinus, ExternalLink, Info } from 'lucide-svelte';

	export let books: Book[] = [];
	export let loading = false;
	export let hasMore = false;
	export let selectedBookId: number | null = null;

	const dispatch = createEventDispatcher<{
		loadMore: void;
		select: Book;
	}>();

	// Context menu state
	let contextMenuVisible = false;
	let contextMenuX = 0;
	let contextMenuY = 0;
	let contextMenuBook: Book | null = null;

	function handleBookContextMenu(event: CustomEvent<{ book: Book; x: number; y: number }>) {
		const { book, x, y } = event.detail;
		contextMenuBook = book;
		contextMenuX = x;
		contextMenuY = y;
		contextMenuVisible = true;
	}

	function closeContextMenu() {
		contextMenuVisible = false;
		contextMenuBook = null;
	}

	async function handleToggleUpNext() {
		if (!contextMenuBook) return;
		await toggleUpNext(contextMenuBook.id);
		await loadUpNextBooks();
	}

	function handleOpenBook() {
		if (!contextMenuBook) return;
		window.__TAURI__?.shell?.open(contextMenuBook.path);
	}

	function handleViewDetails() {
		if (!contextMenuBook) return;
		dispatch('select', contextMenuBook);
	}

	$: contextMenuItems = contextMenuBook ? [
		{
			label: isInUpNextSync(contextMenuBook.id) ? 'Remove from Up Next' : 'Add to Up Next',
			action: handleToggleUpNext,
			icon: isInUpNextSync(contextMenuBook.id) ? ListMinus : ListPlus
		},
		{ separator: true, label: '', action: () => {} },
		{
			label: 'Open Book',
			action: handleOpenBook,
			icon: ExternalLink
		},
		{
			label: 'View Details',
			action: handleViewDetails,
			icon: Info
		}
	] as ContextMenuItem[] : [];

	let containerEl: HTMLElement;
	let scrollParent: HTMLElement | null = null;

	function handleScroll() {
		if (!scrollParent || loading || !hasMore) return;

		const { scrollTop, scrollHeight, clientHeight } = scrollParent;
		// Load more when within 500px of the bottom
		if (scrollHeight - scrollTop - clientHeight < 500) {
			dispatch('loadMore');
		}
	}

	onMount(() => {
		// Find the scrollable parent
		scrollParent = containerEl?.closest('.overflow-auto') as HTMLElement | null;

		if (scrollParent) {
			scrollParent.addEventListener('scroll', handleScroll, { passive: true });
		}

		return () => {
			if (scrollParent) {
				scrollParent.removeEventListener('scroll', handleScroll);
			}
		};
	});
</script>

<div bind:this={containerEl} class="space-y-6">
	<!-- Book Grid - auto-fit ensures minimum width per book -->
	<div class="book-grid">
		{#each books as book (book.id)}
			<BookCard
				{book}
				selected={selectedBookId === book.id}
				on:click={() => dispatch('select', book)}
				on:contextmenu={handleBookContextMenu}
			/>
		{/each}
	</div>

	<!-- Context Menu -->
	{#if contextMenuVisible && contextMenuBook}
		<ContextMenu
			items={contextMenuItems}
			x={contextMenuX}
			y={contextMenuY}
			on:close={closeContextMenu}
		/>
	{/if}

	<!-- Loading indicator -->
	{#if loading}
		<div class="flex justify-center py-8">
			<div class="animate-spin rounded-full h-8 w-8 border-2 border-t-transparent" style="border-color: var(--gw-accent); border-top-color: transparent"></div>
		</div>
	{/if}

	<!-- Load more indicator -->
	{#if hasMore && !loading}
		<div class="flex justify-center py-4 text-muted text-sm">
			Scroll down for more...
		</div>
	{/if}

	<!-- End of list -->
	{#if !hasMore && books.length > 0}
		<div class="flex justify-center py-4 text-muted text-sm">
			End of library
		</div>
	{/if}
</div>
