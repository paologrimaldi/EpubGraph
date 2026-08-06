<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { browser } from '$app/environment';
	import type { Book, Recommendation, ReadStatus, SmartRecommendation } from '$lib/api/commands';
	import { getCoverImage, getRecommendations, formatFileSize, formatDate, getReasonText, generateRecommendationReason } from '$lib/api/commands';
	import { rateBook, setBookReadStatus } from '$lib/stores/library';
	import { isInUpNextSync, toggleUpNext, loadUpNextBooks, upNextBooks, removeFromUpNext } from '$lib/stores/upnext';
	import {
		X,
		Star,
		BookOpen,
		Calendar,
		HardDrive,
		User,
		BookMarked,
		Sparkles,
		ExternalLink,
		Send,
		ListPlus,
		ListMinus,
		Loader2
	} from 'lucide-svelte';
	import { showTooltip, hideTooltip } from './Tooltip.svelte';
	import EmbeddingBadge from './EmbeddingBadge.svelte';

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

	export let book: Book;
	export let context: 'library' | 'upnext' | 'discover' = 'library';
	export let recommendation: SmartRecommendation | null = null;
	export let getCachedReason: ((bookId: number) => { reason: string; timestamp: number } | null) | null = null;
	export let setCachedReason: ((bookId: number, reason: string) => void) | null = null;

	const dispatch = createEventDispatcher<{ close: void; bookRemoved: number }>();

	let coverSrc: string | null = null;
	let recommendations: Recommendation[] = [];
	let loadingRecs = false;
	let loadingCover = false;

	let llmReason: string | null = null;
	let loadingLlm = false;
	let llmError: string | null = null;

	const readStatuses: { value: ReadStatus; label: string }[] = [
		{ value: 'unread', label: 'Unread' },
		{ value: 'want', label: 'Want to Read' },
		{ value: 'reading', label: 'Reading' },
		{ value: 'finished', label: 'Finished' },
		{ value: 'abandoned', label: 'Abandoned' }
	];

	$: if (browser && book?.id) {
		loadBookData(book.id);
		llmReason = null;
		llmError = null;
		loadingLlm = false;
		if (recommendation && getCachedReason) {
			const cached = getCachedReason(book.id);
			if (cached) {
				llmReason = cached.reason;
			}
		}
	}

	async function loadBookData(bookId: number) {
		coverSrc = null;
		recommendations = [];

		loadingCover = true;
		const coverTimeout = new Promise<string | null>((_, reject) =>
			setTimeout(() => reject(new Error('Cover timeout')), 3000)
		);

		Promise.race([getCoverImage(bookId), coverTimeout])
			.then((src) => {
				if (book?.id === bookId) coverSrc = src;
			})
			.catch((err) => {
				console.warn('Failed to load cover:', err);
				if (book?.id === bookId) coverSrc = null;
			})
			.finally(() => {
				if (book?.id === bookId) loadingCover = false;
			});

		loadingRecs = true;
		const recsTimeout = new Promise<Recommendation[]>((_, reject) =>
			setTimeout(() => reject(new Error('Recommendations timeout')), 5000)
		);

		Promise.race([getRecommendations(bookId, 5), recsTimeout])
			.then((recs) => {
				if (book?.id === bookId) recommendations = recs;
			})
			.catch((err) => {
				console.warn('Failed to load recommendations:', err);
				if (book?.id === bookId) recommendations = [];
			})
			.finally(() => {
				if (book?.id === bookId) loadingRecs = false;
			});
	}

	async function handleRating(rating: number) {
		await rateBook(book.id, rating);
	}

	async function handleStatusChange(event: Event) {
		const select = event.target as HTMLSelectElement;
		const newStatus = select.value as ReadStatus;
		await setBookReadStatus(book.id, newStatus);

		if (context === 'upnext') {
			await removeFromUpNext(book.id);
			await loadUpNextBooks();
			dispatch('bookRemoved', book.id);
			dispatch('close');
		}
	}

	// Shared by both action buttons. Follows the existing `llmError` precedent
	// rather than toast, because these messages are instructions the user needs
	// to act on ("Set your Kindle address in Settings", "is the external drive
	// connected?") and must persist while they act, not fade after a few seconds.
	let actionError: string | null = null;
	let isSendingToKindle = false;

	async function openFile() {
		actionError = null;
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			await invoke('open_file_with_default_app', { path: book.path });
		} catch (error) {
			// Previously the only handler here without a catch, so a failed open
			// rejected silently and the button looked dead — which is exactly what
			// happens whenever the external volume is unmounted.
			console.error('Failed to open file:', error);
			actionError =
				typeof error === 'string'
					? error
					: 'Could not open this file. Is the external drive connected?';
		}
	}

	async function sendToKindle() {
		if (isSendingToKindle) return;
		isSendingToKindle = true;
		actionError = null;
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			await invoke('send_book_to_kindle', { bookId: book.id });
		} catch (error) {
			console.error('Failed to send to Kindle:', error);
			actionError = typeof error === 'string' ? error : 'Could not create the email draft.';
		} finally {
			isSendingToKindle = false;
		}
	}

	let isTogglingUpNext = false;

	async function handleToggleUpNext() {
		if (isTogglingUpNext) return;
		isTogglingUpNext = true;
		try {
			await toggleUpNext(book.id);
			await loadUpNextBooks();
		} finally {
			isTogglingUpNext = false;
		}
	}

	async function handleRemoveFromUpNext() {
		if (isTogglingUpNext) return;
		isTogglingUpNext = true;
		try {
			await removeFromUpNext(book.id);
			await loadUpNextBooks();
			dispatch('bookRemoved', book.id);
			dispatch('close');
		} finally {
			isTogglingUpNext = false;
		}
	}

	async function fetchLLMExplanation() {
		if (!recommendation || loadingLlm || llmReason) return;

		loadingLlm = true;
		llmError = null;

		try {
			const reason = await generateRecommendationReason(
				recommendation.book.id,
				recommendation.sourceBooks.map((s) => s.id),
				recommendation.score,
				recommendation.edgeType
			);
			llmReason = reason;
			if (setCachedReason) {
				setCachedReason(book.id, reason);
			}
		} catch (error) {
			console.error('Failed to generate LLM reason:', error);
			llmError = 'Could not generate explanation. Make sure Ollama is running with the configured model.';
		} finally {
			loadingLlm = false;
		}
	}

	$: isBookInUpNext = isInUpNextSync(book.id);
	$: $upNextBooks, isBookInUpNext = isInUpNextSync(book.id);
</script>

<div class="flex flex-col h-full" style="background: var(--gw-bg)">
	<!-- Header -->
	<div class="flex items-center justify-between px-5 py-3.5 border-b border-[var(--gw-separator)]">
		<h2 class="text-[13px] font-semibold text-secondary">Book Details</h2>
		<button
			class="w-6 h-6 rounded-md flex items-center justify-center hover:bg-[var(--gw-surface-tint)] transition-colors"
			on:click={() => dispatch('close')}
		>
			<X class="w-4 h-4 text-muted" />
		</button>
	</div>

	<!-- Content -->
	<div class="flex-1 overflow-auto px-5 py-5 space-y-5">
		<!-- Cover and Title -->
		<div class="flex gap-4">
			<div class="w-[88px] flex-none">
				{#if coverSrc}
					<img
						src={coverSrc}
						alt={book.title}
						class="w-full rounded-lg"
						style="box-shadow: 0 2px 12px rgba(0,0,0,0.12)"
					/>
				{:else}
					<div class="w-full book-cover rounded-lg flex items-center justify-center" style="background: var(--gw-surface-tint)">
						<BookOpen class="w-8 h-8 text-muted" />
					</div>
				{/if}
			</div>
			<div class="flex-1 min-w-0">
				<h3 class="text-[15px] font-semibold leading-snug tracking-tight mb-1">{book.title}</h3>
				{#if book.author}
					<p class="text-[13px] text-secondary flex items-center gap-1.5">
						<User class="w-3.5 h-3.5 text-muted" />
						{book.author}
					</p>
				{/if}
				{#if book.series}
					<p class="text-[12px] flex items-center gap-1.5 mt-1" style="color: var(--gw-accent-text)">
						<BookMarked class="w-3.5 h-3.5" />
						{book.series} #{book.seriesIndex ?? '?'}
					</p>
				{/if}
				<!-- showPending is on here: one book, so "Not indexed" is information
				     rather than the grid-wide noise it would be on a thumbnail. -->
				<div class="mt-2">
					<EmbeddingBadge status={book.embeddingStatus} variant="inline" showPending />
				</div>
			</div>
		</div>

		<!-- Rating -->
		<div>
			<label class="text-[11px] font-semibold text-muted uppercase tracking-widest mb-2 block">
				Your Rating
			</label>
			<div class="flex gap-0.5">
				{#each [1, 2, 3, 4, 5] as rating}
					<button
						class="p-0.5 transition-colors rounded"
						on:click={() => handleRating(rating)}
					>
						<Star
							class="w-5 h-5 {book.rating && book.rating >= rating
								? 'text-yellow-400 fill-yellow-400'
								: 'text-[var(--gw-fg-muted)]'}"
						/>
					</button>
				{/each}
			</div>
		</div>

		<!-- Read Status -->
		<div>
			<label class="text-[11px] font-semibold text-muted uppercase tracking-widest mb-2 block">
				Read Status
			</label>
			<select
				class="input"
				value={book.readStatus ?? 'unread'}
				on:change={handleStatusChange}
			>
				{#each readStatuses as status}
					<option value={status.value}>{status.label}</option>
				{/each}
			</select>
		</div>

		<!-- Description -->
		{#if book.description}
			<div>
				<h4 class="text-[11px] font-semibold text-muted uppercase tracking-widest mb-2">
					Description
				</h4>
				<p class="text-[13px] leading-relaxed text-secondary line-clamp-6" use:truncatable={book.description}>{book.description}</p>
			</div>
		{/if}

		<!-- Why This Recommendation (Discover context only) -->
		{#if context === 'discover' && recommendation}
			<div>
				<div class="flex items-center gap-1.5 mb-2.5">
					<Sparkles class="w-3.5 h-3.5" style="color: var(--gw-accent)" />
					<h4 class="text-[12px] font-semibold" style="color: var(--gw-accent-text)">
						Why This Recommendation
					</h4>
				</div>

				<p class="text-[13px] leading-relaxed mb-2.5 text-secondary">{recommendation.reasonDetails}</p>

				{#if recommendation.sourceBooks.length > 0}
					<div class="flex flex-wrap gap-1 mb-2.5">
						{#each recommendation.sourceBooks as source}
							<span
								class="text-[11px] px-2 py-0.5 rounded-full"
								style="background: var(--gw-accent-subtle); color: var(--gw-accent-text)"
								title={source.inUpNext ? 'In your Up Next' : source.rating ? `Rated ${source.rating} stars` : ''}
							>
								Based on "{source.title}"
							</span>
						{/each}
					</div>
				{/if}

				{#if llmReason}
					<div class="p-3 rounded-lg" style="background: var(--gw-surface-tint)">
						<p class="text-[13px] leading-relaxed text-secondary">{llmReason}</p>
					</div>
				{:else if llmError}
					<div class="p-3 rounded-lg" style="background: rgba(255, 59, 48, 0.06); border: 0.5px solid rgba(255, 59, 48, 0.12)">
						<p class="text-[12px]" style="color: var(--gw-error)">{llmError}</p>
					</div>
				{:else}
					<button
						class="btn-secondary w-full flex items-center justify-center gap-2"
						on:click={fetchLLMExplanation}
						disabled={loadingLlm}
					>
						{#if loadingLlm}
							<Loader2 class="w-3.5 h-3.5 animate-spin" />
							<span>Generating explanation...</span>
						{:else}
							<Sparkles class="w-3.5 h-3.5" />
							<span>Get AI Explanation</span>
						{/if}
					</button>
				{/if}
			</div>
		{/if}

		<!-- Metadata -->
		<div class="grid grid-cols-2 gap-2.5">
			<div class="flex items-center gap-1.5 text-[12px] text-secondary">
				<Calendar class="w-3.5 h-3.5 text-muted" />
				<span>Added {formatDate(book.dateAdded)}</span>
			</div>
			<div class="flex items-center gap-1.5 text-[12px] text-secondary">
				<HardDrive class="w-3.5 h-3.5 text-muted" />
				<span>{formatFileSize(book.fileSize)}</span>
			</div>
			{#if book.language}
				<div class="text-[12px] text-secondary">
					Language: {book.language}
				</div>
			{/if}
			{#if book.publishDate}
				<div class="text-[12px] text-secondary">
					Published: {new Date(book.publishDate).toLocaleDateString()}
				</div>
			{/if}
			{#if book.publisher}
				<div class="text-[12px] text-secondary">
					Publisher: {book.publisher}
				</div>
			{/if}
		</div>

		<!-- Recommendations -->
		<div>
			<div class="flex items-center gap-1.5 mb-2.5">
				<Sparkles class="w-3.5 h-3.5" style="color: var(--gw-accent)" />
				<h4 class="text-[11px] font-semibold uppercase tracking-widest" style="color: var(--gw-accent-text)">Similar Books</h4>
			</div>

			{#if loadingRecs}
				<div class="flex justify-center py-4">
					<div class="animate-spin rounded-full h-5 w-5 border-2 border-t-transparent" style="border-color: var(--gw-accent); border-top-color: transparent"></div>
				</div>
			{:else if recommendations.length > 0}
				<div class="space-y-1">
					{#each recommendations as rec}
						<div class="flex items-center gap-2.5 p-2 rounded-lg hover:bg-[var(--gw-surface-tint)] transition-colors">
							<div class="flex-1 min-w-0">
								<p class="text-[13px] font-medium truncate">{rec.book.title}</p>
								{#if rec.reasons.length > 0}
									<p class="text-[11px] text-muted truncate">
										{getReasonText(rec.reasons[0])}
									</p>
								{/if}
							</div>
							<span class="text-[11px] font-medium text-muted tabular-nums">
								{Math.round(rec.score * 100)}%
							</span>
						</div>
					{/each}
				</div>
			{:else}
				<p class="text-[12px] text-muted text-center py-3">
					No recommendations available yet
				</p>
			{/if}
		</div>
	</div>

	<!-- Actions — pinned to bottom -->
	<div class="flex-none px-5 py-4 border-t border-[var(--gw-separator)] space-y-2">
		{#if actionError}
			<div class="p-3 rounded-lg" style="background: rgba(255, 59, 48, 0.06); border: 0.5px solid rgba(255, 59, 48, 0.12)">
				<p class="text-[12px]" style="color: var(--gw-error)">{actionError}</p>
			</div>
		{/if}
		<button
			class="btn-primary w-full"
			on:click={openFile}
		>
			<ExternalLink class="w-3.5 h-3.5" />
			Open Book
		</button>
		<button
			class="btn-secondary w-full flex items-center justify-center gap-2"
			on:click={sendToKindle}
			disabled={isSendingToKindle}
		>
			{#if isSendingToKindle}
				<Loader2 class="w-3.5 h-3.5 animate-spin" />
				Opening Mail…
			{:else}
				<Send class="w-3.5 h-3.5" />
				Send to Kindle
			{/if}
		</button>
		{#if context === 'library'}
			<button
				class="btn-secondary w-full flex items-center justify-center gap-2"
				on:click={handleToggleUpNext}
				disabled={isTogglingUpNext}
			>
				{#if isBookInUpNext}
					<ListMinus class="w-3.5 h-3.5" />
					Remove from Up Next
				{:else}
					<ListPlus class="w-3.5 h-3.5" />
					Add to Up Next
				{/if}
			</button>
		{:else if context === 'upnext' && isBookInUpNext}
			<button
				class="btn-secondary w-full flex items-center justify-center gap-2"
				on:click={handleRemoveFromUpNext}
				disabled={isTogglingUpNext}
			>
				<ListMinus class="w-3.5 h-3.5" />
				Remove from Up Next
			</button>
		{/if}
	</div>
</div>
