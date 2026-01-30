<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import type { Book } from '$lib/api/commands';
	import BookCard from './BookCard.svelte';

	export let books: Book[] = [];
	export let loading = false;
	export let hasMore = false;
	export let selectedBookId: number | null = null;

	const dispatch = createEventDispatcher<{
		loadMore: void;
		select: Book;
	}>();

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
			<BookCard {book} selected={selectedBookId === book.id} on:click={() => dispatch('select', book)} />
		{/each}
	</div>

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
