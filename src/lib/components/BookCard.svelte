<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { Book } from '$lib/api/commands';
	import { getCoverImage } from '$lib/api/commands';
	import { onMount } from 'svelte';
	import { Star, BookOpen, EyeOff } from 'lucide-svelte';
	import { showTooltip, hideTooltip } from './Tooltip.svelte';
	import EmbeddingBadge from './EmbeddingBadge.svelte';

	export let book: Book;
	export let selected = false;
	export let coverHeight: number;
	export let cardHeight: number;

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
			case 'reading': return 'bg-blue-500';
			case 'finished': return 'bg-green-500';
			case 'want': return 'bg-yellow-500';
			case 'abandoned': return 'bg-red-500';
			default: return '';
		}
	}

	function truncatable(node: HTMLElement, text: string) {
		let currentText = text;

		function handleMouseEnter() {
			const isTruncated = node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight;
			if (isTruncated) {
				const rect = node.getBoundingClientRect();
				showTooltip(currentText, rect);
			}
		}

		function handleMouseLeave() {
			hideTooltip();
		}

		node.addEventListener('mouseenter', handleMouseEnter);
		node.addEventListener('mouseleave', handleMouseLeave);

		return {
			update(text: string) {
				currentText = text;
			},
			destroy() {
				node.removeEventListener('mouseenter', handleMouseEnter);
				node.removeEventListener('mouseleave', handleMouseLeave);
				hideTooltip();
			}
		};
	}
</script>

<button
	class="group block text-left w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gw-accent)] focus-visible:ring-offset-1 rounded-xl"
	on:click
	on:contextmenu={handleContextMenu}
>
	<div
		class="card overflow-hidden"
		class:selected
		style={`height: ${cardHeight}px;${selected ? 'border-color: var(--gw-accent); box-shadow: 0 0 0 2px var(--gw-accent-subtle), var(--gw-shadow-md)' : ''}${book.hidden ? '; opacity: 0.45' : ''}`}
	>
		<!-- Cover -->
		<div class="relative" style={`background: var(--gw-surface-tint); height: ${coverHeight}px;`}>
			{#if loading}
				<div class="absolute inset-0 flex items-center justify-center">
					<div class="animate-pulse">
						<BookOpen class="w-10 h-10 text-muted" />
					</div>
				</div>
			{:else if coverSrc}
				<img
					src={coverSrc}
					alt={book.title}
					class="w-full h-full object-cover"
				/>
			{:else}
				<div class="absolute inset-0 flex items-center justify-center p-3">
					<div class="text-center">
						<BookOpen class="w-8 h-8 text-muted mx-auto mb-1.5" />
						<p class="text-[11px] text-muted line-clamp-2 leading-tight">{book.title}</p>
					</div>
				</div>
			{/if}

			<!-- Hidden indicator -->
			{#if book.hidden}
				<div class="absolute top-1.5 left-1.5 bg-black/60 backdrop-blur-sm rounded-md p-1">
					<EyeOff class="w-3 h-3 text-white/80" />
				</div>
			{/if}

			<!-- Read status indicator -->
			{#if book.readStatus && book.readStatus !== 'unread'}
				<div class="absolute top-1.5 right-1.5">
					<div class="w-2.5 h-2.5 rounded-full {getStatusColor(book.readStatus)}" style="box-shadow: 0 0 0 1.5px var(--gw-bg)"></div>
				</div>
			{/if}

			<!-- Rating overlay -->
			{#if book.rating}
				<div class="absolute bottom-1.5 left-1.5 flex items-center gap-0.5 bg-black/60 backdrop-blur-sm rounded-md px-1.5 py-0.5">
					<Star class="w-2.5 h-2.5 text-yellow-400 fill-yellow-400" />
					<span class="text-[10px] text-white font-medium">{book.rating}</span>
				</div>
			{/if}

			<!-- Embedding status — bottom-right, the one corner left free -->
			<EmbeddingBadge status={book.embeddingStatus} />
		</div>

		<!-- Info -->
		<div class="px-2.5 py-2 h-[3.75rem] flex flex-col overflow-hidden">
			<h3
				class="font-medium text-[12px] line-clamp-2 leading-snug tracking-tight flex-shrink-0"
				class:text-accent={selected}
				use:truncatable={book.title}
			>
				{book.title}
			</h3>
			<div class="mt-auto min-w-0">
				{#if book.author}
					<p class="text-[11px] text-muted truncate leading-tight" use:truncatable={book.author}>{book.author}</p>
				{/if}
				{#if book.series}
					<p class="text-[10px] truncate leading-tight" style="color: var(--gw-accent-text)" use:truncatable={`${book.series} #${book.seriesIndex ?? '?'}`}>
						{book.series} #{book.seriesIndex ?? '?'}
					</p>
				{/if}
			</div>
		</div>
	</div>
</button>
