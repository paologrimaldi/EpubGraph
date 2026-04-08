<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
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

	async function handleOpenBook() {
		if (!contextMenuBook) return;
		const { invoke } = await import('@tauri-apps/api/core');
		await invoke('open_file_with_default_app', { path: contextMenuBook.path });
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

	// Virtualization — we measure the grid container once, compute
	// exact pixel widths for cards, and hand explicit sizes to both
	// flexbox rows and the virtualizer so nothing can drift.
	let scrollElement: HTMLElement;
	let gridEl: HTMLElement;
	let containerWidth = 0;

	const GAP = 14;
	const MIN_COLUMNS = 2;
	const MIN_CARD_WIDTH = 140;
	const MAX_CARD_WIDTH = 176;
	const INFO_HEIGHT = 60;
	const CARD_BORDER = 1;

	function getItemsPerRow(width: number): number {
		if (width <= 0) return 0;

		// Column ladder: keep at least 2 columns and promote to the next
		// column count before cards get visually oversized.
		return Math.max(MIN_COLUMNS, Math.ceil((width + GAP) / (MAX_CARD_WIDTH + GAP)));
	}

	$: itemsPerRow = getItemsPerRow(containerWidth);
	$: cardWidth = itemsPerRow > 0
		? Math.floor((containerWidth - GAP * (itemsPerRow - 1)) / itemsPerRow)
		: MIN_CARD_WIDTH;
	$: coverHeight = Math.round(cardWidth * 1.5);
	$: cardHeight = coverHeight + INFO_HEIGHT + CARD_BORDER;
	$: rowHeight = cardHeight + GAP;
	$: totalRows = itemsPerRow > 0 ? Math.ceil(books.length / itemsPerRow) : 0;

	const virtualizer = createVirtualizer({
		count: 0,
		getScrollElement: () => scrollElement,
		estimateSize: () => 320,
		overscan: 3,
	});

	$: if (itemsPerRow > 0) {
		$virtualizer.setOptions({
			count: totalRows,
			getScrollElement: () => scrollElement,
			estimateSize: () => rowHeight,
		});
	}

	// Trigger loadMore when near the end
	$: virtualItems = $virtualizer.getVirtualItems();
	$: {
		if (virtualItems.length > 0) {
			const lastItem = virtualItems[virtualItems.length - 1];
			if (lastItem && lastItem.index >= totalRows - 3 && hasMore && !loading) {
				dispatch('loadMore');
			}
		}
	}

	function getRowBooks(rowIndex: number): Book[] {
		const start = rowIndex * itemsPerRow;
		return books.slice(start, start + itemsPerRow);
	}

	onMount(() => {
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				containerWidth = entry.contentRect.width;
			}
		});
		if (gridEl) {
			observer.observe(gridEl);
		}
		return () => observer.disconnect();
	});
</script>

<div bind:this={scrollElement} class="h-full overflow-auto p-5">
	<div bind:this={gridEl}>
		{#if books.length > 0 && itemsPerRow > 0}
			<div style="height: {$virtualizer.getTotalSize()}px; width: 100%; position: relative;">
				{#each $virtualizer.getVirtualItems() as virtualRow (virtualRow.index)}
					<div
						style="position: absolute; left: 0; width: 100%;
							height: {cardHeight}px; display: flex; align-items: stretch; gap: {GAP}px;
							transform: translateY({virtualRow.start}px);"
					>
						{#each getRowBooks(virtualRow.index) as book (book.id)}
							<div style="width: {cardWidth}px; height: {cardHeight}px; flex: 0 0 {cardWidth}px;">
								<BookCard
									{book}
									{coverHeight}
									{cardHeight}
									selected={selectedBookId === book.id}
									on:click={() => dispatch('select', book)}
									on:contextmenu={handleBookContextMenu}
								/>
							</div>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
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
