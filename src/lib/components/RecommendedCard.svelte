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
	class="group text-left w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gw-accent)] focus-visible:ring-offset-1 rounded-xl"
	on:click={handleClick}
>
	<div class="card overflow-hidden">
		<!-- Cover -->
		<div class="relative book-cover" style="background: var(--gw-surface-tint)">
			{#if loading}
				<div class="absolute inset-0 flex items-center justify-center">
					<div class="animate-pulse">
						<BookOpen class="w-10 h-10 text-muted" />
					</div>
				</div>
			{:else if coverSrc}
				<img
					src={coverSrc}
					alt={recommendation.book.title}
					class="w-full h-full object-cover"
				/>
			{:else}
				<div class="absolute inset-0 flex items-center justify-center p-3">
					<div class="text-center">
						<BookOpen class="w-8 h-8 text-muted mx-auto mb-1.5" />
						<p class="text-[11px] text-muted line-clamp-2 leading-tight">{recommendation.book.title}</p>
					</div>
				</div>
			{/if}

			<!-- Match score -->
			<div class="absolute top-1.5 right-1.5 flex items-center gap-0.5 bg-black/60 backdrop-blur-sm rounded-md px-1.5 py-0.5">
				<Sparkles class="w-2.5 h-2.5" style="color: {getMatchColor(recommendation.score)}" />
				<span class="text-[10px] text-white font-medium tabular-nums">{getMatchPercentage(recommendation.score)}%</span>
			</div>
		</div>

		<!-- Info -->
		<div class="px-2.5 py-2">
			<h3 class="font-medium text-[12px] line-clamp-2 leading-snug tracking-tight mb-0.5">
				{recommendation.book.title}
			</h3>
			{#if recommendation.book.author}
				<p class="text-[11px] text-muted truncate mb-1.5">{recommendation.book.author}</p>
			{/if}

			<!-- Reason -->
			<div class="p-1.5 rounded-md" style="background: var(--gw-surface-tint)">
				<p class="text-[10px] leading-snug" style="color: var(--gw-accent-text)">
					{recommendation.reasonDetails}
				</p>
			</div>

			<!-- Source books -->
			{#if recommendation.sourceBooks.length > 0}
				<div class="mt-1.5 flex flex-wrap gap-1">
					{#each recommendation.sourceBooks.slice(0, 2) as source}
						<span
							class="text-[9px] px-1.5 py-[1px] rounded-full truncate max-w-[110px]"
							style="background: var(--gw-accent-subtle); color: var(--gw-accent-text)"
							title={source.inUpNext ? 'In your Up Next' : `Rated ${source.rating} stars`}
						>
							{source.title}
						</span>
					{/each}
					{#if recommendation.sourceBooks.length > 2}
						<span
							class="text-[9px] px-1.5 py-[1px] rounded-full"
							style="background: var(--gw-accent-subtle); color: var(--gw-accent-text)"
						>
							+{recommendation.sourceBooks.length - 2} more
						</span>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</button>
