<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { SmartRecommendation } from '$lib/api/commands';
	import { getCoverImage } from '$lib/api/commands';
	import { onMount } from 'svelte';
	import { BookOpen, Sparkles } from 'lucide-svelte';

	export let recommendation: SmartRecommendation;

	const dispatch = createEventDispatcher<{
		select: { recommendation: SmartRecommendation };
	}>();

	let coverSrc: string | null = null;
	let loading = true;

	onMount(async () => {
		try {
			coverSrc = await getCoverImage(recommendation.book.id);
		} catch (error) {
			console.error('Failed to load cover:', error);
		} finally {
			loading = false;
		}
	});

	function handleClick() {
		dispatch('select', { recommendation });
	}

	function getMatchPercentage(score: number): number {
		return Math.round(score * 100);
	}

	function getMatchColor(score: number): string {
		if (score >= 0.8) return 'var(--gw-success)';
		if (score >= 0.6) return 'var(--gw-accent)';
		return 'var(--gw-warning)';
	}
</script>

<button
	class="group text-left w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gw-accent)] focus-visible:ring-offset-2 rounded-2xl"
	on:click={handleClick}
>
	<div class="card overflow-hidden transition-all duration-200 group-hover:shadow-lg">
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
					alt={recommendation.book.title}
					class="w-full h-full object-cover"
				/>
			{:else}
				<div class="absolute inset-0 flex items-center justify-center p-4">
					<div class="text-center">
						<BookOpen class="w-10 h-10 text-muted mx-auto mb-2" />
						<p class="text-xs text-muted line-clamp-2">{recommendation.book.title}</p>
					</div>
				</div>
			{/if}

			<!-- Match score indicator -->
			<div
				class="absolute top-2 right-2 flex items-center gap-1 bg-black/60 backdrop-blur-sm rounded px-1.5 py-0.5"
			>
				<Sparkles class="w-3 h-3" style="color: {getMatchColor(recommendation.score)}" />
				<span class="text-xs text-white font-medium">{getMatchPercentage(recommendation.score)}%</span>
			</div>
		</div>

		<!-- Info -->
		<div class="p-3">
			<h3 class="font-medium text-sm line-clamp-2 leading-tight mb-1">
				{recommendation.book.title}
			</h3>
			{#if recommendation.book.author}
				<p class="text-xs text-muted truncate mb-2">{recommendation.book.author}</p>
			{/if}

			<!-- Structured reason -->
			<div class="mt-2 p-2 rounded-lg bg-glass/50">
				<p class="text-xs" style="color: var(--gw-accent)">
					{recommendation.reasonDetails}
				</p>
			</div>

			<!-- Source books -->
			{#if recommendation.sourceBooks.length > 0}
				<div class="mt-2 flex flex-wrap gap-1">
					{#each recommendation.sourceBooks.slice(0, 2) as source}
						<span
							class="text-[10px] px-1.5 py-0.5 rounded-full truncate max-w-[120px]"
							style="background: var(--gw-accent-subtle); color: var(--gw-accent)"
							title={source.inUpNext ? 'In your Up Next' : `Rated ${source.rating} stars`}
						>
							{source.title}
						</span>
					{/each}
					{#if recommendation.sourceBooks.length > 2}
						<span
							class="text-[10px] px-1.5 py-0.5 rounded-full"
							style="background: var(--gw-accent-subtle); color: var(--gw-accent)"
						>
							+{recommendation.sourceBooks.length - 2} more
						</span>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</button>
