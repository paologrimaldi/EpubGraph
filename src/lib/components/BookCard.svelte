<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { Book } from '$lib/api/commands';
	import { getCoverImage } from '$lib/api/commands';
	import { onMount } from 'svelte';
	import { Star, BookOpen } from 'lucide-svelte';

	export let book: Book;
	export let selected = false;

	const dispatch = createEventDispatcher<{
		contextmenu: { book: Book; x: number; y: number };
	}>();

	function handleContextMenu(event: MouseEvent) {
		event.preventDefault();
		dispatch('contextmenu', {
			book,
			x: event.clientX,
			y: event.clientY
		});
	}

	let coverSrc: string | null = null;
	let loading = true;

	onMount(async () => {
		try {
			coverSrc = await getCoverImage(book.id);
		} catch (error) {
			console.error('Failed to load cover:', error);
		} finally {
			loading = false;
		}
	});

	function getStatusColor(status: string | null): string {
		switch (status) {
			case 'reading':
				return 'bg-blue-500';
			case 'finished':
				return 'bg-green-500';
			case 'want':
				return 'bg-yellow-500';
			case 'abandoned':
				return 'bg-red-500';
			default:
				return 'bg-glass';
		}
	}
</script>

<button
	class="group text-left w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gw-accent)] focus-visible:ring-offset-2 rounded-2xl"
	on:click
	on:contextmenu={handleContextMenu}
>
	<div
		class="card overflow-hidden transition-all duration-200 group-hover:shadow-lg"
		class:selected
		style={selected ? 'border-color: var(--gw-accent); box-shadow: 0 0 0 2px var(--gw-accent-subtle), var(--gw-shadow-md)' : ''}
	>
		<!-- Cover -->
		<div class="relative book-cover bg-glass">
			{#if loading}
				<div class="absolute inset-0 flex items-center justify-center">
					<div class="animate-pulse">
						<BookOpen class="w-12 h-12 text-muted" />
					</div>
				</div>
			{:else if coverSrc}
				<img
					src={coverSrc}
					alt={book.title}
					class="w-full h-full object-cover"
				/>
			{:else}
				<div class="absolute inset-0 flex items-center justify-center p-4">
					<div class="text-center">
						<BookOpen class="w-10 h-10 text-muted mx-auto mb-2" />
						<p class="text-xs text-muted line-clamp-2">{book.title}</p>
					</div>
				</div>
			{/if}

			<!-- Read status indicator -->
			{#if book.readStatus && book.readStatus !== 'unread'}
				<div class="absolute top-2 right-2">
					<div class="w-3 h-3 rounded-full {getStatusColor(book.readStatus)}"></div>
				</div>
			{/if}

			<!-- Rating overlay -->
			{#if book.rating}
				<div class="absolute bottom-2 left-2 flex items-center gap-1 bg-black/60 backdrop-blur-sm rounded px-1.5 py-0.5">
					<Star class="w-3 h-3 text-yellow-400 fill-yellow-400" />
					<span class="text-xs text-white font-medium">{book.rating}</span>
				</div>
			{/if}
		</div>

		<!-- Info - fixed height to ensure uniform cards -->
		<div class="p-3 h-[4.5rem] flex flex-col">
			<h3 class="font-medium text-sm line-clamp-2 leading-tight transition-colors flex-shrink-0" class:text-accent={selected}>
				{book.title}
			</h3>
			<div class="mt-auto">
				{#if book.author}
					<p class="text-xs text-muted truncate">{book.author}</p>
				{/if}
				{#if book.series}
					<p class="text-xs truncate" style="color: var(--gw-accent)">
						{book.series} #{book.seriesIndex ?? '?'}
					</p>
				{/if}
			</div>
		</div>
	</div>
</button>
