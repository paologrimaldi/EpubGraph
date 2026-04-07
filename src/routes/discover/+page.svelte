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

	const CACHE_KEY = 'recommendation_reasons';
	const CACHE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

	function getCachedReason(bookId: number): { reason: string; timestamp: number } | null {
		if (!browser) return null;
		try {
			const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
			const entry = cache[bookId];
			if (entry && Date.now() - entry.timestamp < CACHE_EXPIRY_MS) {
				return entry;
			}
		} catch { /* ignore */ }
		return null;
	}

	function setCachedReason(bookId: number, reason: string): void {
		if (!browser) return;
		try {
			const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
			cache[bookId] = { reason, timestamp: Date.now() };
			localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
		} catch { /* ignore */ }
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
		<header class="flex-none px-5 py-3.5 border-b border-[var(--gw-separator)]">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2.5">
					<div class="w-8 h-8 rounded-lg flex items-center justify-center" style="background: var(--gw-accent-subtle)">
						<Sparkles class="w-4 h-4" style="color: var(--gw-accent)" />
					</div>
					<div>
						<h1 class="text-[17px] font-semibold tracking-tight">Discover</h1>
						<p class="text-[12px] text-muted">
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
					<button class="btn-secondary" on:click={handleRefresh} title="Refresh recommendations">
						<RefreshCw class="w-3.5 h-3.5" />
						<span>Refresh</span>
					</button>
				{/if}
			</div>
		</header>

		<!-- Content -->
		<div class="flex-1 overflow-auto p-5">
			{#if loading}
				<div class="flex items-center justify-center h-full">
					<div class="flex flex-col items-center gap-3">
						<div class="animate-spin rounded-full h-8 w-8 border-2 border-t-transparent" style="border-color: var(--gw-accent); border-top-color: transparent"></div>
						<p class="text-[13px] text-muted">Finding books you might enjoy...</p>
					</div>
				</div>
			{:else if error}
				<div class="flex items-center justify-center h-full">
					<div class="text-center max-w-sm px-6">
						<div class="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4" style="background: var(--gw-surface-tint)">
							<Sparkles class="w-7 h-7 text-muted" />
						</div>
						<h2 class="text-[17px] font-semibold tracking-tight mb-1.5">Something went wrong</h2>
						<p class="text-[13px] text-muted mb-5">{error}</p>
						<button class="btn-primary" on:click={handleRefresh}>
							<RefreshCw class="w-3.5 h-3.5" />
							<span>Try Again</span>
						</button>
					</div>
				</div>
			{:else if recommendations.length === 0}
				<div class="flex items-center justify-center h-full">
					<div class="text-center max-w-sm px-6">
						<div class="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4" style="background: var(--gw-surface-tint)">
							<BookOpen class="w-7 h-7 text-muted" />
						</div>
						<h2 class="text-[17px] font-semibold tracking-tight mb-1.5">No recommendations yet</h2>
						<p class="text-[13px] text-muted mb-5 leading-relaxed">
							Add books to your "Up Next" queue or rate some books to get personalized recommendations.
						</p>
						<div class="flex gap-2 justify-center">
							<a href="/" class="btn-primary">
								<BookOpen class="w-3.5 h-3.5" />
								<span>Browse Library</span>
							</a>
							<a href="/up-next" class="btn-secondary">
								View Up Next
							</a>
						</div>
					</div>
				</div>
			{:else}
				<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3.5">
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
		<aside class="w-[22rem] flex-none border-l border-[var(--gw-separator)] overflow-hidden">
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
