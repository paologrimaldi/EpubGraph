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
	const POLL_INTERVAL_DISCONNECTED = 5000;
	const POLL_INTERVAL_CONNECTED = 30000;
	const POLL_INTERVAL_ACTIVE = 3000;

	async function loadStatus() {
		if (!browser) return;
		try {
			ollamaStatus = await getOllamaStatus();
			processingStatus = await getProcessingStatus();
		} catch (error) {
			console.error('Failed to load status:', error);
		}
		scheduleNextPoll();
	}

	function scheduleNextPoll() {
		if (statusTimeout) {
			clearTimeout(statusTimeout);
			statusTimeout = null;
		}

		let interval: number;
		if (isProcessingEmbeddings || isParsingMetadata) {
			interval = POLL_INTERVAL_ACTIVE;
		} else if (ollamaStatus?.connected) {
			interval = POLL_INTERVAL_CONNECTED;
		} else {
			interval = POLL_INTERVAL_DISCONNECTED;
		}

		statusTimeout = setTimeout(loadStatus, interval);
	}

	onMount(async () => {
		if (!browser) return;
		loadLibraries().catch((err) => console.error('Failed to load libraries:', err));
		loadStatus().catch((err) => console.error('Failed to load status:', err));
		loadUpNextBooks().catch((err) => console.error('Failed to load up next books:', err));
		cleanupEventListeners = await setupScanEventListeners();
	});

	onDestroy(() => {
		if (statusTimeout) clearTimeout(statusTimeout);
		if (cleanupEventListeners) cleanupEventListeners();
		if (processingTimeout) clearTimeout(processingTimeout);
		if (metadataParsingTimeout) clearTimeout(metadataParsingTimeout);
	});

	async function startEmbeddingProcessing() {
		if (isProcessingEmbeddings || !ollamaStatus?.connected) return;
		isProcessingEmbeddings = true;

		const processLoop = async () => {
			if (!isProcessingEmbeddings) return;
			try {
				const result = await processEmbeddingsBatch(10);
				await loadStatus();
				if (result.remaining === 0) {
					stopEmbeddingProcessing();
				} else if (isProcessingEmbeddings) {
					processingTimeout = setTimeout(processLoop, 500);
				}
			} catch (error) {
				console.error('Processing error:', error);
				stopEmbeddingProcessing();
			}
		};
		processLoop();
	}

	function stopEmbeddingProcessing() {
		isProcessingEmbeddings = false;
		if (processingTimeout) {
			clearTimeout(processingTimeout);
			processingTimeout = null;
		}
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
				if (result.remaining === 0) {
					stopMetadataParsing();
					if (ollamaStatus?.connected && processingStatus && processingStatus.pending > 0) {
						startEmbeddingProcessing();
					}
				} else if (isParsingMetadata) {
					metadataParsingTimeout = setTimeout(parseLoop, 100);
				}
			} catch (error) {
				console.error('Metadata parsing error:', error);
				stopMetadataParsing();
			}
		};
		parseLoop();
	}

	function stopMetadataParsing() {
		isParsingMetadata = false;
		if (metadataParsingTimeout) {
			clearTimeout(metadataParsingTimeout);
			metadataParsingTimeout = null;
		}
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

	$: currentPath = $page.url.pathname;
	$: inaccessibleLibraries = $libraries.filter(lib => !lib.accessible);
	$: hasInaccessibleLibraries = inaccessibleLibraries.length > 0;
</script>

<aside class="w-60 flex-none glass-sidebar flex flex-col select-none">
	<!-- Logo -->
	<div class="flex items-center gap-2.5 px-4 pt-5 pb-4 drag-region">
		<div class="w-9 h-9 rounded-xl flex items-center justify-center" style="background: var(--gw-accent-subtle)">
			<BookOpen class="w-[18px] h-[18px]" style="color: var(--gw-accent)" />
		</div>
		<div>
			<h1 class="text-[15px] font-semibold tracking-tight leading-none">EpubGraph</h1>
			<p class="text-[11px] text-muted mt-0.5">AI-Powered Library</p>
		</div>
	</div>

	<!-- Libraries -->
	<div class="flex-1 overflow-auto">
		<!-- Warning for inaccessible libraries -->
		{#if hasInaccessibleLibraries}
			<div class="mx-3 mb-2 p-2.5 rounded-lg" style="background: rgba(255, 59, 48, 0.08); border: 0.5px solid rgba(255, 59, 48, 0.15);">
				<div class="flex items-start gap-2">
					<Unplug class="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style="color: var(--gw-error)" />
					<div>
						<p class="text-[12px] font-medium" style="color: var(--gw-error)">
							{inaccessibleLibraries.length === 1 ? 'Library' : 'Libraries'} Unavailable
						</p>
						<p class="text-[11px] text-muted mt-0.5">
							{#if inaccessibleLibraries.length === 1}
								"{inaccessibleLibraries[0].name}" — check if drive is connected.
							{:else}
								{inaccessibleLibraries.length} libraries are not accessible.
							{/if}
						</p>
					</div>
				</div>
			</div>
		{/if}

		<div class="px-4 mb-1.5 flex items-center justify-between">
			<h2 class="text-[11px] font-semibold text-muted uppercase tracking-widest">
				Libraries
			</h2>
			<button
				class="w-6 h-6 rounded-md flex items-center justify-center hover:bg-[var(--gw-surface-tint)] transition-colors"
				on:click={handleAddLibrary}
				title="Add Library"
			>
				<FolderPlus class="w-3.5 h-3.5 text-muted" />
			</button>
		</div>

		<nav class="space-y-0.5 px-2">
			{#each $libraries as library (library.id)}
				<button
					class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-all
						{$selectedLibrary?.id === library.id
							? 'bg-[var(--gw-surface-tint)]'
							: 'hover:bg-[var(--gw-surface-tint)]'}
						{!library.accessible ? 'opacity-50' : ''}"
					on:click={() => selectLibrary(library)}
				>
					<div class="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
						 style="background: {library.accessible ? 'var(--gw-accent-subtle)' : 'rgba(255, 59, 48, 0.1)'}">
						{#if library.accessible}
							<Library class="w-3.5 h-3.5" style="color: var(--gw-accent)" />
						{:else}
							<Unplug class="w-3.5 h-3.5" style="color: var(--gw-error)" />
						{/if}
					</div>
					<div class="flex-1 min-w-0">
						<p class="font-medium truncate text-[13px] leading-tight">{library.name}</p>
						<p class="text-[11px] text-muted leading-tight mt-0.5">
							{#if library.accessible}
								{library.bookCount.toLocaleString()} books
							{:else}
								Drive disconnected
							{/if}
						</p>
					</div>
					{#if library.accessible}
						<button
							class="w-6 h-6 rounded-md flex items-center justify-center hover:bg-[var(--gw-surface-elevated)] transition-colors flex-shrink-0"
							class:animate-spin={$isScanning}
							on:click|stopPropagation={() => handleScan(library.id)}
							disabled={$isScanning}
							title="Scan Library"
						>
							<RefreshCw class="w-3.5 h-3.5 text-muted" />
						</button>
					{:else}
						<div class="w-6 h-6 flex items-center justify-center flex-shrink-0" title="Library unavailable">
							<AlertTriangle class="w-3.5 h-3.5" style="color: var(--gw-error)" />
						</div>
					{/if}
				</button>
			{:else}
				<div class="px-2.5 py-5 text-center">
					<p class="text-[12px] text-muted mb-2">No libraries added</p>
					<button
						class="gw-btn gw-btn-sm"
						on:click={handleAddLibrary}
					>
						<FolderPlus class="w-3.5 h-3.5" />
						<span>Add Library</span>
					</button>
				</div>
			{/each}
		</nav>

		<!-- Scan Progress -->
		{#if $isScanning || $scanProgress}
			<div class="mx-2 mt-3 p-2.5 rounded-lg glass-section">
				<div class="flex items-center justify-between mb-1.5">
					<div class="flex items-center gap-1.5">
						<RefreshCw class="w-3.5 h-3.5 animate-spin" style="color: var(--gw-accent)" />
						<span class="text-[12px] font-medium">
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
						<span class="text-[11px] font-mono" style="color: var(--gw-accent)">
							{pct}%
						</span>
					{/if}
				</div>
				{#if $scanProgress?.total && $scanProgress.total > 0}
					{@const processed = $scanProgress.processed}
					{@const total = $scanProgress.total}
					{@const eta = $scanProgress.etaSeconds ?? 0}
					<div class="glass-progress mb-1.5">
						<div
							class="glass-progress-bar"
							style="width: {Math.round((processed / total) * 100)}%"
						></div>
					</div>
					<div class="flex justify-between text-[10px] text-muted">
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
					<p class="text-[11px] text-muted truncate">{$scanProgress.current}</p>
				{:else}
					<p class="text-[11px] text-muted">Starting scan...</p>
				{/if}
			</div>
		{/if}
	</div>

	<!-- AI Status -->
	<div class="flex-none border-t border-[var(--gw-separator)] p-2.5 space-y-1.5">
		<!-- Ollama Status -->
		<div class="glass-status {ollamaStatus?.connected ? 'glass-status-success' : 'glass-status-error'}">
			<div class="glass-status-icon">
				<Cpu class="w-3.5 h-3.5" />
			</div>
			<div class="flex-1 min-w-0">
				<p class="text-[12px] font-medium leading-tight">
					{ollamaStatus?.connected ? 'Ollama Connected' : 'Ollama Offline'}
				</p>
				{#if ollamaStatus?.connected}
					<p class="text-[11px] text-muted truncate leading-tight">{ollamaStatus.model}</p>
				{/if}
			</div>
		</div>

		<!-- Metadata Parsing Status -->
		{#if processingStatus && processingStatus.booksNeedingMetadata > 0}
			<div class="glass-status glass-status-warning">
				<div class="glass-status-icon">
					<BookOpen class="w-3.5 h-3.5 {isParsingMetadata ? 'animate-pulse-glow' : ''}" />
				</div>
				<div class="flex-1 min-w-0">
					<p class="text-[12px] font-medium leading-tight">
						{isParsingMetadata ? 'Parsing...' : 'Metadata'}
					</p>
					<p class="text-[11px] text-muted leading-tight">
						{processingStatus.booksNeedingMetadata.toLocaleString()} need parsing
					</p>
				</div>
				<button
					class="p-1 rounded-md transition-colors hover:bg-[var(--gw-surface-tint)]"
					style={isParsingMetadata ? 'color: var(--gw-error)' : 'color: var(--gw-warning)'}
					on:click={() => isParsingMetadata ? stopMetadataParsing() : startMetadataParsing()}
					title={isParsingMetadata ? 'Stop parsing' : 'Start parsing metadata'}
				>
					{#if isParsingMetadata}
						<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
							<rect x="6" y="6" width="12" height="12" rx="2" />
						</svg>
					{:else}
						<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
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
					<Sparkles class="w-3.5 h-3.5 {isProcessingEmbeddings ? 'animate-pulse-glow' : ''}" />
				</div>
				<div class="flex-1 min-w-0">
					<p class="text-[12px] font-medium leading-tight">
						{#if isComplete}
							Embeddings Complete
						{:else if isProcessingEmbeddings}
							Processing...
						{:else}
							Embeddings
						{/if}
					</p>
					<p class="text-[11px] text-muted leading-tight">
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
						class="p-1 rounded-md transition-colors hover:bg-[var(--gw-surface-tint)]"
						style={isProcessingEmbeddings ? 'color: var(--gw-error)' : 'color: var(--gw-accent)'}
						on:click={() => isProcessingEmbeddings ? stopEmbeddingProcessing() : startEmbeddingProcessing()}
						title={isProcessingEmbeddings ? 'Stop processing' : 'Start processing embeddings'}
					>
						{#if isProcessingEmbeddings}
							<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
								<rect x="6" y="6" width="12" height="12" rx="2" />
							</svg>
						{:else}
							<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
								<path d="M8 5v14l11-7z" />
							</svg>
						{/if}
					</button>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Navigation -->
	<div class="flex-none border-t border-[var(--gw-separator)] p-2 space-y-0.5">
		<a href="/" class="glass-nav-item {currentPath === '/' ? 'active' : ''}">
			<BookOpen class="w-[18px] h-[18px]" />
			<span>Library</span>
		</a>
		<a href="/up-next" class="glass-nav-item {currentPath === '/up-next' ? 'active' : ''}">
			<ListTodo class="w-[18px] h-[18px]" />
			<span>Up Next</span>
			{#if $upNextTotalCount > 0}
				<span class="ml-auto text-[11px] font-semibold min-w-[1.25rem] text-center px-1.5 py-[1px] rounded-full" style="background: var(--gw-accent-subtle); color: var(--gw-accent)">
					{$upNextTotalCount}
				</span>
			{/if}
		</a>
		<a href="/discover" class="glass-nav-item {currentPath === '/discover' ? 'active' : ''}">
			<Sparkles class="w-[18px] h-[18px]" />
			<span>Discover</span>
		</a>
		<a href="/graph" class="glass-nav-item {currentPath === '/graph' ? 'active' : ''}">
			<Network class="w-[18px] h-[18px]" />
			<span>Book Graph</span>
		</a>
		<a href="/settings" class="glass-nav-item {currentPath === '/settings' ? 'active' : ''}">
			<Settings class="w-[18px] h-[18px]" />
			<span>Settings</span>
		</a>
	</div>
</aside>
