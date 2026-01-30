<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { browser } from '$app/environment';
	import type { Book, Recommendation, ReadStatus } from '$lib/api/commands';
	import { getCoverImage, getRecommendations, formatFileSize, formatDate, getReasonText } from '$lib/api/commands';
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
		ListPlus,
		ListMinus
	} from 'lucide-svelte';

	export let book: Book;
	// Context: 'library' shows Up Next button, 'upnext' hides it and auto-removes on status change
	export let context: 'library' | 'upnext' = 'library';

	const dispatch = createEventDispatcher<{ close: void; bookRemoved: number }>();

	let coverSrc: string | null = null;
	let recommendations: Recommendation[] = [];
	let loadingRecs = false;
	let loadingCover = false;

	const readStatuses: { value: ReadStatus; label: string }[] = [
		{ value: 'unread', label: 'Unread' },
		{ value: 'want', label: 'Want to Read' },
		{ value: 'reading', label: 'Reading' },
		{ value: 'finished', label: 'Finished' },
		{ value: 'abandoned', label: 'Abandoned' }
	];

	// Reactive: reload data when book changes
	$: if (browser && book?.id) {
		loadBookData(book.id);
	}

	async function loadBookData(bookId: number) {
		// Reset state
		coverSrc = null;
		recommendations = [];

		// Load cover with timeout (non-blocking)
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

		// Load recommendations with timeout (non-blocking)
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

		// If we're on the Up Next page and status changed, remove the book from Up Next
		// (since explicit Up Next entries should be removed when status changes)
		if (context === 'upnext') {
			await removeFromUpNext(book.id);
			await loadUpNextBooks();
			dispatch('bookRemoved', book.id);
			dispatch('close');
		}
	}

	function openFile() {
		// This would use Tauri's shell API to open the file
		window.__TAURI__?.shell?.open(book.path);
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

	// Reactive: check if book is in Up Next
	$: isBookInUpNext = isInUpNextSync(book.id);

	// Re-check when upNextBooks changes
	$: $upNextBooks, isBookInUpNext = isInUpNextSync(book.id);
</script>

<div class="flex flex-col h-full bg-glass">
	<!-- Header -->
	<div class="flex items-center justify-between p-4 border-b border-glass-subtle">
		<h2 class="font-semibold">Book Details</h2>
		<button
			class="p-1.5 rounded-lg hover:bg-glass transition-colors"
			on:click={() => dispatch('close')}
		>
			<X class="w-5 h-5" />
		</button>
	</div>

	<!-- Content -->
	<div class="flex-1 overflow-auto p-4 space-y-6">
		<!-- Cover and Title -->
		<div class="flex gap-4">
			<div class="w-24 flex-none">
				{#if coverSrc}
					<img
						src={coverSrc}
						alt={book.title}
						class="w-full rounded-lg shadow-md"
					/>
				{:else}
					<div class="w-full book-cover bg-surface-200 dark:bg-surface-800 rounded-lg flex items-center justify-center">
						<BookOpen class="w-10 h-10 text-surface-400" />
					</div>
				{/if}
			</div>
			<div class="flex-1 min-w-0">
				<h3 class="font-semibold text-lg leading-tight mb-1">{book.title}</h3>
				{#if book.author}
					<p class="text-surface-600 dark:text-surface-400 flex items-center gap-1">
						<User class="w-4 h-4" />
						{book.author}
					</p>
				{/if}
				{#if book.series}
					<p class="text-primary-600 dark:text-primary-400 flex items-center gap-1 mt-1">
						<BookMarked class="w-4 h-4" />
						{book.series} #{book.seriesIndex ?? '?'}
					</p>
				{/if}
			</div>
		</div>

		<!-- Rating -->
		<div>
			<label class="text-sm font-medium text-surface-600 dark:text-surface-400 mb-2 block">
				Your Rating
			</label>
			<div class="flex gap-1">
				{#each [1, 2, 3, 4, 5] as rating}
					<button
						class="p-1 transition-colors"
						on:click={() => handleRating(rating)}
					>
						<Star
							class="w-6 h-6 {book.rating && book.rating >= rating
								? 'text-yellow-400 fill-yellow-400'
								: 'text-surface-300 dark:text-surface-600'}"
						/>
					</button>
				{/each}
			</div>
		</div>

		<!-- Read Status -->
		<div>
			<label class="text-sm font-medium text-surface-600 dark:text-surface-400 mb-2 block">
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
				<h4 class="text-sm font-medium text-surface-600 dark:text-surface-400 mb-2">
					Description
				</h4>
				<p class="text-sm leading-relaxed line-clamp-6">{book.description}</p>
			</div>
		{/if}

		<!-- Metadata -->
		<div class="grid grid-cols-2 gap-3 text-sm">
			<div class="flex items-center gap-2 text-surface-600 dark:text-surface-400">
				<Calendar class="w-4 h-4" />
				<span>Added {formatDate(book.dateAdded)}</span>
			</div>
			<div class="flex items-center gap-2 text-surface-600 dark:text-surface-400">
				<HardDrive class="w-4 h-4" />
				<span>{formatFileSize(book.fileSize)}</span>
			</div>
			{#if book.language}
				<div class="flex items-center gap-2 text-surface-600 dark:text-surface-400">
					<span>Language: {book.language}</span>
				</div>
			{/if}
			{#if book.publisher}
				<div class="flex items-center gap-2 text-surface-600 dark:text-surface-400">
					<span>Publisher: {book.publisher}</span>
				</div>
			{/if}
		</div>

		<!-- Recommendations -->
		<div>
			<div class="flex items-center gap-2 mb-3">
				<Sparkles class="w-4 h-4" style="color: var(--gw-accent)" />
				<h4 class="text-sm font-medium" style="color: var(--gw-accent)">Similar Books</h4>
			</div>

			{#if loadingRecs}
				<div class="flex justify-center py-4">
					<div class="animate-spin rounded-full h-6 w-6 border-2 border-t-transparent" style="border-color: var(--gw-accent); border-top-color: transparent"></div>
				</div>
			{:else if recommendations.length > 0}
				<div class="space-y-2">
					{#each recommendations as rec}
						<div class="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800">
							<div class="flex-1 min-w-0">
								<p class="text-sm font-medium truncate">{rec.book.title}</p>
								{#if rec.reasons.length > 0}
									<p class="text-xs text-surface-500 truncate">
										{getReasonText(rec.reasons[0])}
									</p>
								{/if}
							</div>
							<span class="text-xs text-surface-500">
								{Math.round(rec.score * 100)}%
							</span>
						</div>
					{/each}
				</div>
			{:else}
				<p class="text-sm text-surface-500 text-center py-4">
					No recommendations available yet
				</p>
			{/if}
		</div>

		<!-- Actions -->
		<div class="pt-4 border-t border-glass-subtle space-y-2">
			<button
				class="btn-primary w-full"
				on:click={openFile}
			>
				<ExternalLink class="w-4 h-4" />
				Open Book
			</button>
			{#if context === 'library'}
				<!-- Library: Show add/remove toggle -->
				<button
					class="btn-secondary w-full flex items-center justify-center gap-2"
					on:click={handleToggleUpNext}
					disabled={isTogglingUpNext}
				>
					{#if isBookInUpNext}
						<ListMinus class="w-4 h-4" />
						Remove from Up Next
					{:else}
						<ListPlus class="w-4 h-4" />
						Add to Up Next
					{/if}
				</button>
			{:else if context === 'upnext' && isBookInUpNext}
				<!-- Up Next page: Only show remove button if book was explicitly added (not via "want" status) -->
				<button
					class="btn-secondary w-full flex items-center justify-center gap-2"
					on:click={handleRemoveFromUpNext}
					disabled={isTogglingUpNext}
				>
					<ListMinus class="w-4 h-4" />
					Remove from Up Next
				</button>
			{/if}
		</div>
	</div>
</div>
