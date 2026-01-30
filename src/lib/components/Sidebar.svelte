<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
	import {
		libraries,
		selectedLibrary,
		isScanning,
		scanLibrary,
		addLibrary,
		loadLibraries,
		scanProgress,
		setupScanEventListeners
	} from '$lib/stores/library';
	import { getOllamaStatus, getProcessingStatus, processEmbeddingsBatch, parseMetadataBatch } from '$lib/api/commands';
	import type { OllamaStatus, ProcessingStatus } from '$lib/api/commands';
	import {
		Library,
		FolderPlus,
		RefreshCw,
		Settings,
		Cpu,
		BookOpen,
		Sparkles,
		Network,
		AlertTriangle,
		Unplug,
		ListTodo
	} from 'lucide-svelte';
	import { upNextTotalCount, loadUpNextBooks } from '$lib/stores/upnext';

	let ollamaStatus: OllamaStatus | null = null;
	let processingStatus: ProcessingStatus | null = null;
	let statusTimeout: ReturnType<typeof setTimeout> | null = null;
	let cleanupEventListeners: (() => void) | null = null;
	let isProcessingEmbeddings = false;
	let processingTimeout: ReturnType<typeof setTimeout> | null = null;
	let isParsingMetadata = false;
	let metadataParsingTimeout: ReturnType<typeof setTimeout> | null = null;

	// Smart polling intervals (in ms)
	const POLL_INTERVAL_DISCONNECTED = 5000;  // 5 seconds when disconnected
	const POLL_INTERVAL_CONNECTED = 30000;    // 30 seconds when connected
	const POLL_INTERVAL_ACTIVE = 3000;        // 3 seconds when processing

	// Load status with smart polling
	async function loadStatus() {
		if (!browser) return;
		try {
			ollamaStatus = await getOllamaStatus();
			processingStatus = await getProcessingStatus();
		} catch (error) {
			console.error('Failed to load status:', error);
		}

		// Schedule next poll based on current state
		scheduleNextPoll();
	}

	function scheduleNextPoll() {
		// Clear any existing timeout
		if (statusTimeout) {
			clearTimeout(statusTimeout);
			statusTimeout = null;
		}

		// Determine interval based on state
		let interval: number;
		if (isProcessingEmbeddings || isParsingMetadata) {
			// Active processing - poll frequently
			interval = POLL_INTERVAL_ACTIVE;
		} else if (ollamaStatus?.connected) {
			// Connected but idle - poll infrequently
			interval = POLL_INTERVAL_CONNECTED;
		} else {
			// Disconnected - poll more frequently to catch reconnection
			interval = POLL_INTERVAL_DISCONNECTED;
		}

		statusTimeout = setTimeout(loadStatus, interval);
	}

	onMount(async () => {
		if (!browser) return;

		// Load initial data (non-blocking)
		loadLibraries().catch((err) => console.error('Failed to load libraries:', err));
		loadStatus().catch((err) => console.error('Failed to load status:', err));
		loadUpNextBooks().catch((err) => console.error('Failed to load up next books:', err));

		// Set up scan event listeners
		cleanupEventListeners = await setupScanEventListeners();

		// Note: loadStatus() will schedule the next poll via scheduleNextPoll()
	});

	onDestroy(() => {
		if (statusTimeout) {
			clearTimeout(statusTimeout);
		}
		if (cleanupEventListeners) {
			cleanupEventListeners();
		}
		if (processingTimeout) {
			clearTimeout(processingTimeout);
		}
		if (metadataParsingTimeout) {
			clearTimeout(metadataParsingTimeout);
		}
	});

	async function startEmbeddingProcessing() {
		if (isProcessingEmbeddings || !ollamaStatus?.connected) return;

		isProcessingEmbeddings = true;

		// Process in a loop
		const processLoop = async () => {
			if (!isProcessingEmbeddings) return;

			try {
				const result = await processEmbeddingsBatch(10);
				await loadStatus(); // Refresh status

				// Stop if no more pending, otherwise schedule next batch
				if (result.remaining === 0) {
					stopEmbeddingProcessing();
				} else if (isProcessingEmbeddings) {
					// Schedule next batch only after current one completes (prevents concurrent calls)
					processingTimeout = setTimeout(processLoop, 500);
				}
			} catch (error) {
				console.error('Processing error:', error);
				stopEmbeddingProcessing();
			}
		};

		// Start immediately
		processLoop();
	}

	function stopEmbeddingProcessing() {
		isProcessingEmbeddings = false;
		if (processingTimeout) {
			clearTimeout(processingTimeout);
			processingTimeout = null;
		}
		// Reschedule polling with idle interval
		scheduleNextPoll();
	}

	async function startMetadataParsing() {
		if (isParsingMetadata) return;

		isParsingMetadata = true;

		const parseLoop = async () => {
			if (!isParsingMetadata) return;

			try {
				const result = await parseMetadataBatch(20);
				await loadStatus();

				// Stop if no more pending, otherwise schedule next batch
				if (result.remaining === 0) {
					stopMetadataParsing();
					// Auto-start embedding processing if Ollama is connected
					if (ollamaStatus?.connected && processingStatus && processingStatus.pending > 0) {
						startEmbeddingProcessing();
					}
				} else if (isParsingMetadata) {
					// Schedule next batch only after current one completes (prevents concurrent calls)
					metadataParsingTimeout = setTimeout(parseLoop, 100);
				}
			} catch (error) {
				console.error('Metadata parsing error:', error);
				stopMetadataParsing();
			}
		};

		// Start immediately
		parseLoop();
	}

	function stopMetadataParsing() {
		isParsingMetadata = false;
		if (metadataParsingTimeout) {
			clearTimeout(metadataParsingTimeout);
			metadataParsingTimeout = null;
		}
		// Reschedule polling with idle interval
		scheduleNextPoll();
	}

	async function handleAddLibrary() {
		if (!browser) return;

		try {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const selected = await open({
				directory: true,
				multiple: false,
				title: 'Select Library Folder'
			});

			if (selected) {
				await addLibrary(selected as string);
			}
		} catch (error) {
			console.error('Failed to open dialog:', error);
		}
	}

	async function handleScan(id: number) {
		await scanLibrary(id);
	}

	function selectLibrary(lib: typeof $libraries[0]) {
		$selectedLibrary = lib;
	}

	// Reactive current path
	$: currentPath = $page.url.pathname;

	// Check if any libraries are inaccessible (e.g., external drive disconnected)
	$: inaccessibleLibraries = $libraries.filter(lib => !lib.accessible);
	$: hasInaccessibleLibraries = inaccessibleLibraries.length > 0;
</script>

<aside class="w-64 flex-none glass-sidebar flex flex-col">
	<!-- Logo -->
	<div class="flex items-center gap-3 px-4 py-5 border-b border-glass-subtle">
		<div class="w-11 h-11 rounded-2xl gw-card flex items-center justify-center">
			<BookOpen class="w-6 h-6" style="color: var(--gw-accent)" />
		</div>
		<div>
			<h1 class="font-semibold text-lg">EpubGraph</h1>
			<p class="text-xs text-muted">AI-Powered Library</p>
		</div>
	</div>

	<!-- Libraries -->
	<div class="flex-1 overflow-auto py-4">
		<!-- Warning for inaccessible libraries -->
		{#if hasInaccessibleLibraries}
			<div class="mx-2 mb-3 p-3 rounded-xl border" style="background: oklch(0.45 0.12 25 / 0.15); border-color: oklch(0.55 0.15 25 / 0.3)">
				<div class="flex items-start gap-2">
					<Unplug class="w-4 h-4 mt-0.5 flex-shrink-0" style="color: var(--gw-error)" />
					<div>
						<p class="text-sm font-medium" style="color: var(--gw-error)">
							{inaccessibleLibraries.length === 1 ? 'Library' : 'Libraries'} Unavailable
						</p>
						<p class="text-xs text-muted mt-0.5">
							{#if inaccessibleLibraries.length === 1}
								"{inaccessibleLibraries[0].name}" is not accessible. Check if the drive is connected.
							{:else}
								{inaccessibleLibraries.length} libraries are not accessible. Check if drives are connected.
							{/if}
						</p>
					</div>
				</div>
			</div>
		{/if}

		<div class="px-4 mb-3 flex items-center justify-between">
			<h2 class="text-xs font-semibold text-muted uppercase tracking-wider">
				Libraries
			</h2>
			<button
				class="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-glass transition-colors"
				on:click={handleAddLibrary}
				title="Add Library"
			>
				<FolderPlus class="w-4 h-4" />
			</button>
		</div>

		<nav class="space-y-1 px-2">
			{#each $libraries as library (library.id)}
				<button
					class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all
						{$selectedLibrary?.id === library.id
							? 'bg-glass shadow-glass'
							: 'hover:bg-glass/50'}
						{!library.accessible ? 'opacity-60' : ''}"
					on:click={() => selectLibrary(library)}
				>
					<div class="w-8 h-8 rounded-lg flex items-center justify-center relative"
						 style="background: {library.accessible ? 'var(--gw-accent-subtle)' : 'oklch(0.45 0.12 25 / 0.2)'}">
						{#if library.accessible}
							<Library class="w-4 h-4" style="color: var(--gw-accent)" />
						{:else}
							<Unplug class="w-4 h-4" style="color: var(--gw-error)" />
						{/if}
					</div>
					<div class="flex-1 min-w-0">
						<p class="font-medium truncate text-sm">{library.name}</p>
						<p class="text-xs text-muted">
							{#if library.accessible}
								{library.bookCount.toLocaleString()} books
							{:else}
								Drive disconnected
							{/if}
						</p>
					</div>
					{#if library.accessible}
						<button
							class="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-glass transition-colors"
							class:animate-spin={$isScanning}
							on:click|stopPropagation={() => handleScan(library.id)}
							disabled={$isScanning}
							title="Scan Library"
						>
							<RefreshCw class="w-4 h-4" />
						</button>
					{:else}
						<div class="w-7 h-7 rounded-lg flex items-center justify-center" title="Library unavailable">
							<AlertTriangle class="w-4 h-4" style="color: var(--gw-error)" />
						</div>
					{/if}
				</button>
			{:else}
				<div class="px-3 py-6 text-center">
					<p class="text-sm text-muted mb-2">No libraries added</p>
					<button
						class="gw-btn gw-btn-sm"
						on:click={handleAddLibrary}
					>
						<FolderPlus class="w-4 h-4" />
						<span>Add Library</span>
					</button>
				</div>
			{/each}
		</nav>

		<!-- Scan Progress -->
		{#if $isScanning || $scanProgress}
			<div class="mx-2 mt-4 p-3 rounded-xl glass-section">
				<div class="flex items-center justify-between mb-2">
					<div class="flex items-center gap-2">
						<RefreshCw class="w-4 h-4 animate-spin" style="color: var(--gw-accent)" />
						<span class="text-sm font-medium">
							{#if $scanProgress?.phase === 'scanning'}
								Discovering...
							{:else if $scanProgress?.phase === 'inserting'}
								Importing...
							{:else}
								Scanning...
							{/if}
						</span>
					</div>
					{#if $scanProgress?.total && $scanProgress.total > 0}
						{@const pct = Math.round(($scanProgress.processed / $scanProgress.total) * 100)}
						<span class="text-xs font-mono" style="color: var(--gw-accent)">
							{pct}%
						</span>
					{/if}
				</div>
				{#if $scanProgress?.total && $scanProgress.total > 0}
					{@const processed = $scanProgress.processed}
					{@const total = $scanProgress.total}
					{@const eta = $scanProgress.etaSeconds ?? 0}
					<div class="glass-progress mb-2">
						<div
							class="glass-progress-bar"
							style="width: {Math.round((processed / total) * 100)}%"
						></div>
					</div>
					<div class="flex justify-between text-xs text-muted">
						<span>{processed.toLocaleString()} / {total.toLocaleString()}</span>
						{#if eta > 0}
							<span>
								ETA: {eta < 60
									? `${eta}s`
									: `${Math.floor(eta / 60)}m ${eta % 60}s`}
							</span>
						{/if}
					</div>
				{:else if $scanProgress?.current}
					<p class="text-xs text-muted">
						{$scanProgress.current}
					</p>
				{:else}
					<p class="text-xs text-muted">
						Starting scan...
					</p>
				{/if}
			</div>
		{/if}
	</div>

	<!-- AI Status -->
	<div class="flex-none border-t border-glass-subtle p-3 space-y-2">
		<!-- Ollama Status -->
		<div class="glass-status {ollamaStatus?.connected ? 'glass-status-success' : 'glass-status-error'}">
			<div class="glass-status-icon">
				<Cpu class="w-4 h-4" />
			</div>
			<div class="flex-1 min-w-0">
				<p class="text-sm font-medium">
					{ollamaStatus?.connected ? 'Ollama Connected' : 'Ollama Offline'}
				</p>
				{#if ollamaStatus?.connected}
					<p class="text-xs text-muted truncate">{ollamaStatus.model}</p>
				{/if}
			</div>
		</div>

		<!-- Metadata Parsing Status -->
		{#if processingStatus && processingStatus.booksNeedingMetadata > 0}
			<div class="glass-status glass-status-warning">
				<div class="glass-status-icon">
					<BookOpen class="w-4 h-4 {isParsingMetadata ? 'animate-pulse-glow' : ''}" />
				</div>
				<div class="flex-1 min-w-0">
					<p class="text-sm font-medium">
						{isParsingMetadata ? 'Parsing...' : 'Metadata'}
					</p>
					<p class="text-xs text-muted">
						{processingStatus.booksNeedingMetadata.toLocaleString()} need parsing
					</p>
				</div>
				<button
					class="p-1.5 rounded-lg transition-colors hover:bg-glass"
					style={isParsingMetadata ? 'color: oklch(0.5 0.18 25)' : 'color: oklch(0.55 0.15 85)'}
					on:click={() => isParsingMetadata ? stopMetadataParsing() : startMetadataParsing()}
					title={isParsingMetadata ? 'Stop parsing' : 'Start parsing metadata'}
				>
					{#if isParsingMetadata}
						<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
							<rect x="6" y="6" width="12" height="12" rx="2" />
						</svg>
					{:else}
						<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
							<path d="M8 5v14l11-7z" />
						</svg>
					{/if}
				</button>
			</div>
		{/if}

		<!-- Embeddings Processing Status -->
		{#if processingStatus}
			{@const needsMetadataFirst = processingStatus.booksNeedingMetadata > 0}
			{@const canStartEmbeddings = processingStatus.pending > 0 && ollamaStatus?.connected && !needsMetadataFirst}
			{@const isComplete = processingStatus.pending === 0 && !needsMetadataFirst && !isProcessingEmbeddings}
			{@const skippedCount = processingStatus.totalBooks - processingStatus.processed - processingStatus.pending}
			<div class="glass-status {isComplete ? 'glass-status-success' : 'glass-status-accent'}">
				<div class="glass-status-icon">
					<Sparkles class="w-4 h-4 {isProcessingEmbeddings ? 'animate-pulse-glow' : ''}" />
				</div>
				<div class="flex-1 min-w-0">
					<p class="text-sm font-medium">
						{#if isComplete}
							Embeddings Complete
						{:else if isProcessingEmbeddings}
							Processing...
						{:else}
							Embeddings
						{/if}
					</p>
					<p class="text-xs text-muted">
						{#if needsMetadataFirst && !isProcessingEmbeddings}
							Parse metadata first
						{:else if isComplete && skippedCount > 0}
							{processingStatus.processed.toLocaleString()} done, {skippedCount.toLocaleString()} skipped
						{:else if isComplete}
							{processingStatus.processed.toLocaleString()} books indexed
						{:else}
							{processingStatus.pending.toLocaleString()} pending
						{/if}
					</p>
				</div>
				{#if canStartEmbeddings || isProcessingEmbeddings}
					<button
						class="p-1.5 rounded-lg transition-colors hover:bg-glass"
						style={isProcessingEmbeddings ? 'color: oklch(0.5 0.18 25)' : 'color: var(--gw-accent)'}
						on:click={() => isProcessingEmbeddings ? stopEmbeddingProcessing() : startEmbeddingProcessing()}
						title={isProcessingEmbeddings ? 'Stop processing' : 'Start processing embeddings'}
					>
						{#if isProcessingEmbeddings}
							<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
								<rect x="6" y="6" width="12" height="12" rx="2" />
							</svg>
						{:else}
							<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
								<path d="M8 5v14l11-7z" />
							</svg>
						{/if}
					</button>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Navigation -->
	<div class="flex-none border-t border-glass-subtle p-2 space-y-1">
		<a
			href="/"
			class="glass-nav-item {currentPath === '/' ? 'active' : ''}"
		>
			<BookOpen class="w-5 h-5" />
			<span>Library</span>
		</a>
		<a
			href="/up-next"
			class="glass-nav-item {currentPath === '/up-next' ? 'active' : ''}"
		>
			<ListTodo class="w-5 h-5" />
			<span>Up Next</span>
			{#if $upNextTotalCount > 0}
				<span class="ml-auto text-xs font-medium px-2 py-0.5 rounded-full" style="background: var(--gw-accent-subtle); color: var(--gw-accent)">
					{$upNextTotalCount}
				</span>
			{/if}
		</a>
		<a
			href="/graph"
			class="glass-nav-item {currentPath === '/graph' ? 'active' : ''}"
		>
			<Network class="w-5 h-5" />
			<span>Book Graph</span>
		</a>
		<a
			href="/settings"
			class="glass-nav-item {currentPath === '/settings' ? 'active' : ''}"
		>
			<Settings class="w-5 h-5" />
			<span>Settings</span>
		</a>
	</div>
</aside>
