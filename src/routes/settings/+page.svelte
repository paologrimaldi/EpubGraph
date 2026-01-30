<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { listen } from '@tauri-apps/api/event';
	import type { UnlistenFn } from '@tauri-apps/api/event';
	import {
		getSettings,
		updateSettings,
		getOllamaStatus,
		configureOllama,
		createBackup,
		restoreBackup,
		exportLibrary,
		importLibrary,
		getDatabasePath,
		getDatabaseStats,
		resetDatabase,
		clearEmbeddings,
		cleanupOrphanedBooks,
		getDatabasePathPreference,
		setDatabasePathPreference,
		rebuildGraphEdges
	} from '$lib/api/commands';
	import type { DatabaseStats } from '$lib/api/commands';
	import type { Settings, OllamaStatus } from '$lib/api/commands';
	import { open, save } from '@tauri-apps/plugin-dialog';
	import { toast } from 'svelte-sonner';
	import { theme, type Theme } from '$lib/stores/theme';
	import {
		Settings as SettingsIcon,
		Cpu,
		Database,
		Download,
		Upload,
		Save,
		FolderOpen,
		RefreshCw,
		Trash2,
		HardDrive,
		AlertTriangle,
		Sun,
		Moon,
		Monitor,
		X
	} from 'lucide-svelte';

	let settings: Settings | null = null;
	let ollamaStatus: OllamaStatus | null = null;
	let loading = true;
	let saving = false;

	// Form state
	let ollamaEndpoint = 'http://localhost:11434';
	let ollamaModel = 'nomic-embed-text';
	let autoScan = true;
	let currentTheme: Theme = 'system';

	// Database state
	let currentDbPath = '';
	let preferredDbPath: string | null = null;
	let dbStats: DatabaseStats | null = null;
	let showResetConfirm = false;
	let resetting = false;
	let showClearEmbeddingsConfirm = false;
	let clearingEmbeddings = false;
	let cleaningOrphans = false;
	let rebuildingGraph = false;
	let graphRebuildProgress: { current: number; total: number; edgesSoFar: number } | null = null;
	let unlistenGraphProgress: UnlistenFn | null = null;

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
	}

	// Subscribe to theme changes
	$: currentTheme = $theme;

	function setTheme(newTheme: Theme) {
		theme.set(newTheme);
	}

	onMount(async () => {
		if (!browser) return;

		try {
			const [settingsResult, ollamaResult, dbPath, dbPref, stats] = await Promise.all([
				getSettings(),
				getOllamaStatus(),
				getDatabasePath(),
				getDatabasePathPreference(),
				getDatabaseStats()
			]);

			settings = settingsResult;
			ollamaStatus = ollamaResult;
			currentDbPath = dbPath;
			preferredDbPath = dbPref;
			dbStats = stats;

			if (settings) {
				ollamaEndpoint = settings.ollamaEndpoint || 'http://localhost:11434';
				ollamaModel = settings.ollamaModel || 'nomic-embed-text';
				autoScan = settings.autoScanEnabled ?? true;
			}
		} catch (error) {
			console.error('Failed to load settings:', error);
			toast.error('Failed to load settings');
		} finally {
			loading = false;
		}
	});

	onDestroy(() => {
		if (unlistenGraphProgress) {
			unlistenGraphProgress();
		}
	});

	async function saveSettings() {
		if (!browser) return;

		saving = true;
		try {
			await updateSettings({
				ollamaEndpoint,
				ollamaModel,
				autoScanEnabled: autoScan
			});
			toast.success('Settings saved');
		} catch (error) {
			console.error('Failed to save settings:', error);
			toast.error('Failed to save settings');
		} finally {
			saving = false;
		}
	}

	async function testOllamaConnection() {
		if (!browser) return;

		try {
			await configureOllama(ollamaEndpoint, ollamaModel);
			ollamaStatus = await getOllamaStatus();
			if (ollamaStatus?.connected) {
				toast.success('Connected to Ollama');
			} else {
				toast.error('Failed to connect to Ollama');
			}
		} catch (error) {
			console.error('Failed to test Ollama:', error);
			toast.error('Failed to connect to Ollama');
		}
	}

	async function handleBackup() {
		if (!browser) return;

		try {
			const path = await save({
				title: 'Save Backup',
				defaultPath: `alexandria-backup-${new Date().toISOString().split('T')[0]}.db`,
				filters: [{ name: 'Database', extensions: ['db'] }]
			});

			if (path) {
				await createBackup(path);
				toast.success('Backup created successfully');
			}
		} catch (error) {
			console.error('Failed to create backup:', error);
			toast.error('Failed to create backup');
		}
	}

	async function handleRestore() {
		if (!browser) return;

		try {
			const path = await open({
				title: 'Select Backup File',
				filters: [{ name: 'Database', extensions: ['db'] }]
			});

			if (path) {
				await restoreBackup(path as string);
				toast.success('Backup restored successfully');
			}
		} catch (error) {
			console.error('Failed to restore backup:', error);
			toast.error('Failed to restore backup');
		}
	}

	async function handleExport() {
		if (!browser) return;

		try {
			const path = await save({
				title: 'Export Library',
				defaultPath: `alexandria-export-${new Date().toISOString().split('T')[0]}.json`,
				filters: [{ name: 'JSON', extensions: ['json'] }]
			});

			if (path) {
				await exportLibrary(path);
				toast.success('Library exported successfully');
			}
		} catch (error) {
			console.error('Failed to export:', error);
			toast.error('Failed to export library');
		}
	}

	async function handleImport() {
		if (!browser) return;

		try {
			const path = await open({
				title: 'Import Library',
				filters: [{ name: 'JSON', extensions: ['json'] }]
			});

			if (path) {
				await importLibrary(path as string);
				toast.success('Library imported successfully');
			}
		} catch (error) {
			console.error('Failed to import:', error);
			toast.error('Failed to import library');
		}
	}

	async function handleResetDatabase() {
		if (!browser) return;

		resetting = true;
		try {
			await resetDatabase();
			toast.success('Database reset successfully');
			showResetConfirm = false;
		} catch (error) {
			console.error('Failed to reset database:', error);
			toast.error('Failed to reset database');
		} finally {
			resetting = false;
		}
	}

	async function handleClearEmbeddings() {
		if (!browser) return;

		clearingEmbeddings = true;
		try {
			const result = await clearEmbeddings();
			dbStats = await getDatabaseStats();
			toast.success(`Cleared ${result.embeddingsCleared.toLocaleString()} embeddings`);
			showClearEmbeddingsConfirm = false;
		} catch (error) {
			console.error('Failed to clear embeddings:', error);
			toast.error('Failed to clear embeddings');
		} finally {
			clearingEmbeddings = false;
		}
	}

	async function handleCleanupOrphans() {
		if (!browser) return;

		cleaningOrphans = true;
		try {
			const result = await cleanupOrphanedBooks();
			dbStats = await getDatabaseStats();
			if (result.removed > 0) {
				toast.success(`Removed ${result.removed.toLocaleString()} orphaned entries`);
			} else {
				toast.success('No orphaned entries found');
			}
		} catch (error) {
			console.error('Failed to cleanup orphans:', error);
			toast.error('Failed to cleanup orphaned entries');
		} finally {
			cleaningOrphans = false;
		}
	}

	async function handleRebuildGraph() {
		if (!browser) return;

		rebuildingGraph = true;
		graphRebuildProgress = null;

		try {
			// Listen for progress events
			unlistenGraphProgress = await listen<{ current: number; total: number; edgesSoFar: number }>(
				'graph-rebuild-progress',
				(event) => {
					graphRebuildProgress = event.payload;
				}
			);

			const result = await rebuildGraphEdges();
			toast.success(
				`Rebuilt graph: ${result.booksProcessed.toLocaleString()} books, ${result.edgesCreated.toLocaleString()} connections`
			);
		} catch (error) {
			console.error('Failed to rebuild graph:', error);
			toast.error('Failed to rebuild graph edges');
		} finally {
			rebuildingGraph = false;
			graphRebuildProgress = null;
			if (unlistenGraphProgress) {
				unlistenGraphProgress();
				unlistenGraphProgress = null;
			}
		}
	}

	async function handleChangeDatabasePath() {
		if (!browser) return;

		try {
			const path = await open({
				title: 'Choose Database Location',
				directory: true
			});

			if (path) {
				await setDatabasePathPreference(path as string);
				preferredDbPath = path as string;
				toast.success('Database path updated. Restart the app for changes to take effect.');
			}
		} catch (error) {
			console.error('Failed to set database path:', error);
			toast.error('Failed to set database path');
		}
	}
</script>

<svelte:head>
	<title>Settings - EpubGraph</title>
</svelte:head>

<div class="flex-1 overflow-auto p-6">
	<div class="max-w-2xl mx-auto">
		<!-- Header -->
		<div class="flex items-center gap-4 mb-8">
			<div class="w-14 h-14 rounded-2xl gw-card flex items-center justify-center">
				<SettingsIcon class="w-7 h-7" style="color: var(--gw-accent)" />
			</div>
			<div>
				<h1 class="text-2xl font-semibold">Settings</h1>
				<p class="text-muted">Configure EpubGraph preferences</p>
			</div>
		</div>

		{#if loading}
			<div class="flex items-center justify-center py-16">
				<div class="w-10 h-10 rounded-full gw-glass flex items-center justify-center">
					<RefreshCw class="w-5 h-5 animate-spin" style="color: var(--gw-accent)" />
				</div>
			</div>
		{:else}
			<div class="space-y-6">
				<!-- Appearance -->
				<section class="glass-section">
					<div class="flex items-center gap-3 mb-5">
						<Sun class="w-5 h-5" style="color: var(--gw-accent)" />
						<h2 class="text-lg font-semibold">Appearance</h2>
					</div>

					<div class="space-y-4">
						<div>
							<label class="block text-sm font-medium mb-3">Theme</label>
							<div class="flex gap-2">
								<button
									class="gw-btn flex-1 {currentTheme === 'light' ? 'gw-glass-focus' : ''}"
									class:ring-2={currentTheme === 'light'}
									class:ring-[var(--gw-accent)]={currentTheme === 'light'}
									on:click={() => setTheme('light')}
								>
									<Sun class="w-4 h-4" />
									<span>Light</span>
								</button>
								<button
									class="gw-btn flex-1 {currentTheme === 'dark' ? 'gw-glass-focus' : ''}"
									class:ring-2={currentTheme === 'dark'}
									class:ring-[var(--gw-accent)]={currentTheme === 'dark'}
									on:click={() => setTheme('dark')}
								>
									<Moon class="w-4 h-4" />
									<span>Dark</span>
								</button>
								<button
									class="gw-btn flex-1 {currentTheme === 'system' ? 'gw-glass-focus' : ''}"
									class:ring-2={currentTheme === 'system'}
									class:ring-[var(--gw-accent)]={currentTheme === 'system'}
									on:click={() => setTheme('system')}
								>
									<Monitor class="w-4 h-4" />
									<span>System</span>
								</button>
							</div>
						</div>
					</div>
				</section>

				<!-- AI Settings -->
				<section class="glass-section">
					<div class="flex items-center gap-3 mb-5">
						<Cpu class="w-5 h-5" style="color: var(--gw-accent)" />
						<h2 class="text-lg font-semibold">AI Settings (Ollama)</h2>
					</div>

					<div class="space-y-4">
						<div>
							<label for="ollama-endpoint" class="block text-sm font-medium mb-2">
								Ollama Endpoint
							</label>
							<input
								id="ollama-endpoint"
								type="text"
								bind:value={ollamaEndpoint}
								class="glass-input"
								placeholder="http://localhost:11434"
							/>
						</div>

						<div>
							<label for="ollama-model" class="block text-sm font-medium mb-2">
								Embedding Model
							</label>
							<input
								id="ollama-model"
								type="text"
								bind:value={ollamaModel}
								class="glass-input"
								placeholder="nomic-embed-text"
							/>
						</div>

						<div class="flex items-center justify-between pt-2">
							<div class="flex items-center gap-3">
								<div
									class="w-3 h-3 rounded-full {ollamaStatus?.connected
										? 'bg-green-500'
										: 'bg-red-500'}"
								></div>
								<span class="text-sm text-muted">
									{ollamaStatus?.connected ? 'Connected' : 'Disconnected'}
								</span>
							</div>
							<button class="gw-btn" on:click={testOllamaConnection}>
								Test Connection
							</button>
						</div>
					</div>
				</section>

				<!-- General Settings -->
				<section class="glass-section">
					<div class="flex items-center gap-3 mb-5">
						<SettingsIcon class="w-5 h-5" style="color: var(--gw-accent)" />
						<h2 class="text-lg font-semibold">General</h2>
					</div>

					<div class="space-y-4">
						<div class="flex items-center justify-between">
							<div>
								<p class="font-medium">Auto-scan libraries</p>
								<p class="text-sm text-muted">Automatically scan for new books on startup</p>
							</div>
							<button
								class="relative w-11 h-6 rounded-full transition-colors {autoScan ? 'bg-[var(--gw-accent)]' : 'bg-glass border border-glass'}"
								on:click={() => autoScan = !autoScan}
								role="switch"
								aria-checked={autoScan}
							>
								<span
									class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-transform {autoScan ? 'translate-x-5' : 'translate-x-0'}"
								></span>
							</button>
						</div>
					</div>
				</section>

				<!-- Database -->
				<section class="glass-section">
					<div class="flex items-center gap-3 mb-5">
						<HardDrive class="w-5 h-5" style="color: var(--gw-accent)" />
						<h2 class="text-lg font-semibold">Database</h2>
					</div>

					<div class="space-y-4">
						<!-- Stats -->
						{#if dbStats}
							<div class="grid grid-cols-2 gap-3">
								<div class="p-3 rounded-xl bg-glass border border-glass">
									<p class="text-xs text-muted uppercase tracking-wider mb-1">Database Size</p>
									<p class="text-lg font-semibold">{formatBytes(dbStats.databaseSizeBytes)}</p>
								</div>
								<div class="p-3 rounded-xl bg-glass border border-glass">
									<p class="text-xs text-muted uppercase tracking-wider mb-1">Books</p>
									<p class="text-lg font-semibold">{dbStats.booksCount.toLocaleString()}</p>
								</div>
								<div class="p-3 rounded-xl bg-glass border border-glass">
									<p class="text-xs text-muted uppercase tracking-wider mb-1">Embeddings</p>
									<p class="text-lg font-semibold">{dbStats.embeddingsCount.toLocaleString()}</p>
								</div>
								<div class="p-3 rounded-xl bg-glass border border-glass">
									<p class="text-xs text-muted uppercase tracking-wider mb-1">Embeddings Size</p>
									<p class="text-lg font-semibold">{formatBytes(dbStats.embeddingsSizeBytes)}</p>
								</div>
							</div>
						{/if}

						<!-- Database Path -->
						<div>
							<label class="block text-sm font-medium mb-2">Database Location</label>
							<div class="flex items-center gap-2">
								<input
									type="text"
									value={currentDbPath}
									readonly
									class="glass-input flex-1 opacity-70"
								/>
								<button class="gw-btn gw-btn-icon" on:click={handleChangeDatabasePath}>
									<FolderOpen class="w-4 h-4" />
								</button>
							</div>
							{#if preferredDbPath && preferredDbPath !== currentDbPath}
								<p class="text-sm mt-2" style="color: var(--gw-warning)">
									Database will move to new location on restart.
								</p>
							{/if}
						</div>

						<!-- Clear Embeddings -->
						<div class="pt-4 border-t border-glass-subtle">
							<div class="flex items-center justify-between">
								<div>
									<p class="font-medium" style="color: var(--gw-warning)">Clear Embeddings</p>
									<p class="text-sm text-muted">Remove all embeddings to regenerate correctly</p>
								</div>
								{#if !showClearEmbeddingsConfirm}
									<button
										class="gw-btn"
										style="color: var(--gw-warning)"
										on:click={() => (showClearEmbeddingsConfirm = true)}
									>
										<Trash2 class="w-4 h-4" />
										<span>Clear</span>
									</button>
								{:else}
									<div class="flex items-center gap-2">
										<button
											class="gw-btn"
											on:click={() => (showClearEmbeddingsConfirm = false)}
											disabled={clearingEmbeddings}
										>
											<X class="w-4 h-4" />
											<span>Cancel</span>
										</button>
										<button
											class="gw-btn"
											style="background: var(--gw-warning); color: white"
											on:click={handleClearEmbeddings}
											disabled={clearingEmbeddings}
										>
											{#if clearingEmbeddings}
												<RefreshCw class="w-4 h-4 animate-spin" />
											{:else}
												<AlertTriangle class="w-4 h-4" />
											{/if}
											<span>Confirm</span>
										</button>
									</div>
								{/if}
							</div>
						</div>

						<!-- Cleanup Orphaned Books -->
						<div class="pt-4 border-t border-glass-subtle">
							<div class="flex items-center justify-between">
								<div>
									<p class="font-medium">Cleanup Missing Files</p>
									<p class="text-sm text-muted">Remove database entries for deleted book files</p>
								</div>
								<button
									class="gw-btn"
									on:click={handleCleanupOrphans}
									disabled={cleaningOrphans}
								>
									{#if cleaningOrphans}
										<RefreshCw class="w-4 h-4 animate-spin" />
									{:else}
										<Trash2 class="w-4 h-4" />
									{/if}
									<span>Cleanup</span>
								</button>
							</div>
						</div>

						<!-- Rebuild Graph Edges -->
						<div class="pt-4 border-t border-glass-subtle">
							<div class="flex items-center justify-between">
								<div class="flex-1">
									<p class="font-medium">Rebuild Book Graph</p>
									<p class="text-sm text-muted">Recompute similarity connections from embeddings</p>
									{#if graphRebuildProgress}
										<div class="mt-2">
											<div class="flex justify-between text-xs text-muted mb-1">
												<span>{graphRebuildProgress.current.toLocaleString()} / {graphRebuildProgress.total.toLocaleString()} books</span>
												<span>{graphRebuildProgress.edgesSoFar.toLocaleString()} connections</span>
											</div>
											<div class="h-1.5 bg-glass rounded-full overflow-hidden">
												<div
													class="h-full transition-all duration-300"
													style="width: {(graphRebuildProgress.current / graphRebuildProgress.total) * 100}%; background: var(--gw-accent)"
												></div>
											</div>
										</div>
									{/if}
								</div>
								<button
									class="gw-btn ml-4"
									on:click={handleRebuildGraph}
									disabled={rebuildingGraph}
								>
									{#if rebuildingGraph}
										<RefreshCw class="w-4 h-4 animate-spin" />
									{:else}
										<RefreshCw class="w-4 h-4" />
									{/if}
									<span>Rebuild</span>
								</button>
							</div>
						</div>

						<!-- Reset Database -->
						<div class="pt-4 border-t border-glass-subtle">
							<div class="flex items-center justify-between">
								<div>
									<p class="font-medium" style="color: var(--gw-error)">Reset Database</p>
									<p class="text-sm text-muted">Delete all books, libraries, and settings</p>
								</div>
								{#if !showResetConfirm}
									<button
										class="gw-btn"
										style="color: var(--gw-error)"
										on:click={() => (showResetConfirm = true)}
									>
										<Trash2 class="w-4 h-4" />
										<span>Reset</span>
									</button>
								{:else}
									<div class="flex items-center gap-2">
										<button
											class="gw-btn"
											on:click={() => (showResetConfirm = false)}
											disabled={resetting}
										>
											<X class="w-4 h-4" />
											<span>Cancel</span>
										</button>
										<button
											class="gw-btn"
											style="background: var(--gw-error); color: white"
											on:click={handleResetDatabase}
											disabled={resetting}
										>
											{#if resetting}
												<RefreshCw class="w-4 h-4 animate-spin" />
											{:else}
												<AlertTriangle class="w-4 h-4" />
											{/if}
											<span>Confirm</span>
										</button>
									</div>
								{/if}
							</div>
						</div>
					</div>
				</section>

				<!-- Backup & Export -->
				<section class="glass-section">
					<div class="flex items-center gap-3 mb-5">
						<Database class="w-5 h-5" style="color: var(--gw-accent)" />
						<h2 class="text-lg font-semibold">Backup & Export</h2>
					</div>

					<div class="grid grid-cols-2 gap-3">
						<button class="gw-btn justify-center" on:click={handleBackup}>
							<Download class="w-4 h-4" />
							<span>Create Backup</span>
						</button>

						<button class="gw-btn justify-center" on:click={handleRestore}>
							<Upload class="w-4 h-4" />
							<span>Restore Backup</span>
						</button>

						<button class="gw-btn justify-center" on:click={handleExport}>
							<FolderOpen class="w-4 h-4" />
							<span>Export JSON</span>
						</button>

						<button class="gw-btn justify-center" on:click={handleImport}>
							<FolderOpen class="w-4 h-4" />
							<span>Import JSON</span>
						</button>
					</div>
				</section>

				<!-- Save Button -->
				<div class="flex justify-end">
					<button
						class="gw-btn"
						style="background: var(--gw-accent); color: white"
						on:click={saveSettings}
						disabled={saving}
					>
						{#if saving}
							<RefreshCw class="w-4 h-4 animate-spin" />
						{:else}
							<Save class="w-4 h-4" />
						{/if}
						<span>Save Settings</span>
					</button>
				</div>
			</div>
		{/if}
	</div>
</div>
