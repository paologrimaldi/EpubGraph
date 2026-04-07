<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { getSmartRecommendations } from '$lib/api/commands';
	import type { SmartRecommendation } from '$lib/api/commands';
	import RecommendedCard from '$lib/components/RecommendedCard.svelte';
	import BookDetail from '$lib/components/BookDetail.svelte';
	import { Sparkles, BookOpen, RefreshCw } from 'lucide-svelte';

	let recommendations: SmartRecommendation[] = [];
	let loading = true;
	let error: string | null = null;
	let selectedRecommendation: SmartRecommendation | null = null;

	// localStorage cache key for LLM-enhanced reasons
	const CACHE_KEY = 'recommendation_reasons';
	const CACHE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

	function getCachedReason(bookId: number): { reason: string; timestamp: number } | null {
		if (!browser) return null;
		try {
			const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
			const entry = cache[bookId];
			if (entry && Date.now() - entry.timestamp < CACHE_EXPIRY_MS) {
				return entry;
			}
		} catch {
			// Ignore parse errors
		}
		return null;
	}

	function setCachedReason(bookId: number, reason: string): void {
		if (!browser) return;
		try {
			const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
			cache[bookId] = { reason, timestamp: Date.now() };
			localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
		} catch {
			// Ignore storage errors
		}
	}

	async function loadRecommendations() {
		if (!browser) return;

		loading = true;
		error = null;

		try {
			recommendations = await getSmartRecommendations(24);
		} catch (e) {
			console.error('Failed to load recommendations:', e);
			error = 'Failed to load recommendations. Please try again.';
		} finally {
			loading = false;
		}
	}

	function handleRecommendationSelected(event: CustomEvent<{ recommendation: SmartRecommendation }>) {
		selectedRecommendation = event.detail.recommendation;
	}

	function handleCloseDetail() {
		selectedRecommendation = null;
	}

	async function handleRefresh() {
		await loadRecommendations();
	}

	onMount(() => {
		loadRecommendations();
	});
</script>

<svelte:head>
	<title>Discover - EpubGraph</title>
</svelte:head>

<div class="flex h-full">
	<!-- Main Content -->
	<div class="flex-1 flex flex-col min-w-0">
		<!-- Header -->
		<header class="flex-none p-6 border-b border-glass-subtle">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3">
					<div class="w-10 h-10 rounded-xl gw-card flex items-center justify-center">
						<Sparkles class="w-5 h-5" style="color: var(--gw-accent)" />
					</div>
					<div>
						<h1 class="text-xl font-semibold">Discover</h1>
						<p class="text-sm text-muted">
							{#if loading}
								Loading recommendations...
							{:else if recommendations.length === 0}
								No recommendations yet
							{:else}
								{recommendations.length} book{recommendations.length === 1 ? '' : 's'} recommended for you
							{/if}
						</p>
					</div>
				</div>

				{#if !loading && recommendations.length > 0}
					<button
						class="gw-btn gw-btn-sm"
						on:click={handleRefresh}
						title="Refresh recommendations"
					>
						<RefreshCw class="w-4 h-4" />
						<span>Refresh</span>
					</button>
				{/if}
			</div>
		</header>

		<!-- Content -->
		<div class="flex-1 overflow-auto p-6">
			{#if loading}
				<div class="flex items-center justify-center h-full">
					<div class="flex flex-col items-center gap-4">
						<div
							class="animate-spin rounded-full h-10 w-10 border-2 border-t-transparent"
							style="border-color: var(--gw-accent); border-top-color: transparent"
						></div>
						<p class="text-muted">Finding books you might enjoy...</p>
					</div>
				</div>
			{:else if error}
				<div class="flex items-center justify-center h-full">
					<div class="text-center max-w-md px-6">
						<div class="w-16 h-16 rounded-2xl gw-card flex items-center justify-center mx-auto mb-4">
							<Sparkles class="w-8 h-8 text-muted" />
						</div>
						<h2 class="text-lg font-medium mb-2">Something went wrong</h2>
						<p class="text-muted text-sm mb-4">{error}</p>
						<button class="gw-btn" on:click={handleRefresh}>
							<RefreshCw class="w-4 h-4" />
							<span>Try Again</span>
						</button>
					</div>
				</div>
			{:else if recommendations.length === 0}
				<div class="flex items-center justify-center h-full">
					<div class="text-center max-w-md px-6">
						<div class="w-16 h-16 rounded-2xl gw-card flex items-center justify-center mx-auto mb-4">
							<BookOpen class="w-8 h-8 text-muted" />
						</div>
						<h2 class="text-lg font-medium mb-2">No recommendations yet</h2>
						<p class="text-muted text-sm mb-4">
							Add books to your "Up Next" queue or rate some books to get personalized recommendations.
						</p>
						<div class="flex gap-3 justify-center">
							<a href="/" class="gw-btn">
								<BookOpen class="w-4 h-4" />
								<span>Browse Library</span>
							</a>
							<a href="/up-next" class="gw-btn gw-btn-secondary">
								<span>View Up Next</span>
							</a>
						</div>
					</div>
				</div>
			{:else}
				<!-- Recommendations Grid -->
				<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
					{#each recommendations as rec (rec.book.id)}
						<RecommendedCard
							recommendation={rec}
							on:select={handleRecommendationSelected}
						/>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<!-- Book Detail Sidebar -->
	{#if selectedRecommendation}
		<aside class="w-96 flex-none border-l border-glass-subtle overflow-hidden">
			<BookDetail
				book={selectedRecommendation.book}
				recommendation={selectedRecommendation}
				context="discover"
				{getCachedReason}
				{setCachedReason}
				on:close={handleCloseDetail}
			/>
		</aside>
	{/if}
</div>
