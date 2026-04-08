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

	let ollamaEndpoint = 'http://localhost:11434';
	let ollamaModel = 'nomic-embed-text';
	let ollamaChatModel = 'mistral:7b';
	let autoScan = true;
	let currentTheme: Theme = 'system';

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

	$: currentTheme = $theme;

	const themeOptions: { value: Theme; label: string; icon: typeof Sun }[] = [
		{ value: 'light', label: 'Light', icon: Sun },
		{ value: 'dark', label: 'Dark', icon: Moon },
		{ value: 'system', label: 'System', icon: Monitor }
	];

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
				ollamaChatModel = settings.ollamaChatModel || 'mistral:7b';
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
				ollamaChatModel,
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
			unlistenGraphProgress = await listen<{ current: number; total: number; edgesSoFar: number }>(
				'graph-rebuild-progress',
				(event) => { graphRebuildProgress = event.payload; }
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
			const path = await open({ title: 'Choose Database Location', directory: true });
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

<div class="flex-1 overflow-auto p-8">
	<div class="max-w-[600px] mx-auto">
		<!-- Header -->
		<div class="flex items-center gap-3 mb-8">
			<div class="w-10 h-10 rounded-xl flex items-center justify-center" style="background: var(--gw-accent-subtle)">
				<SettingsIcon class="w-5 h-5" style="color: var(--gw-accent)" />
			</div>
			<div>
				<h1 class="text-[22px] font-bold tracking-tight">Settings</h1>
				<p class="text-[13px] text-muted">Configure EpubGraph preferences</p>
			</div>
		</div>

		{#if loading}
			<div class="flex items-center justify-center py-16">
				<RefreshCw class="w-5 h-5 animate-spin" style="color: var(--gw-accent)" />
			</div>
		{:else}
			<div class="space-y-5">
				<!-- Appearance -->
				<section class="glass-section">
					<div class="flex items-center gap-2.5 mb-4">
						<Sun class="w-4 h-4" style="color: var(--gw-accent)" />
						<h2 class="text-[15px] font-semibold tracking-tight">Appearance</h2>
					</div>

					<div>
						<label class="block text-[12px] font-medium text-secondary mb-2.5">Theme</label>
						<div class="flex gap-2">
							{#each themeOptions as opt}
								<button
									class="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-all"
									style={currentTheme === opt.value
										? 'background: var(--gw-accent); color: #fff;'
										: 'background: var(--gw-surface-tint); color: var(--gw-fg-secondary); border: 0.5px solid var(--gw-border);'}
									on:click={() => setTheme(opt.value)}
								>
									<svelte:component this={opt.icon} class="w-3.5 h-3.5" />
									<span>{opt.label}</span>
								</button>
							{/each}
						</div>
					</div>
				</section>

				<!-- AI Settings -->
				<section class="glass-section">
					<div class="flex items-center gap-2.5 mb-4">
						<Cpu class="w-4 h-4" style="color: var(--gw-accent)" />
						<h2 class="text-[15px] font-semibold tracking-tight">AI Settings (Ollama)</h2>
					</div>

					<div class="space-y-3.5">
						<div>
							<label for="ollama-endpoint" class="block text-[12px] font-medium text-secondary mb-1.5">
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
							<label for="ollama-model" class="block text-[12px] font-medium text-secondary mb-1.5">
								Embedding Model
							</label>
							<input
								id="ollama-model"
								type="text"
								bind:value={ollamaModel}
								class="glass-input"
								placeholder="nomic-embed-text"
							/>
							<p class="text-[11px] text-muted mt-1">Used for generating book embeddings</p>
						</div>

						<div>
							<label for="ollama-chat-model" class="block text-[12px] font-medium text-secondary mb-1.5">
								Chat Model
							</label>
							<input
								id="ollama-chat-model"
								type="text"
								bind:value={ollamaChatModel}
								class="glass-input"
								placeholder="mistral:7b"
							/>
							<p class="text-[11px] text-muted mt-1">Used for AI explanations</p>
						</div>

						<div class="flex items-center justify-between pt-1">
							<div class="flex items-center gap-2">
								<div
									class="w-2 h-2 rounded-full"
									style="background: {ollamaStatus?.connected ? 'var(--gw-success)' : 'var(--gw-error)'}"
								></div>
								<span class="text-[12px] text-muted">
									{ollamaStatus?.connected ? 'Connected' : 'Disconnected'}
								</span>
							</div>
							<button class="btn-secondary" on:click={testOllamaConnection}>
								Test Connection
							</button>
						</div>
					</div>
				</section>

				<!-- General Settings -->
				<section class="glass-section">
					<div class="flex items-center gap-2.5 mb-4">
						<SettingsIcon class="w-4 h-4" style="color: var(--gw-accent)" />
						<h2 class="text-[15px] font-semibold tracking-tight">General</h2>
					</div>

					<div class="flex items-center justify-between">
						<div>
							<p class="text-[13px] font-medium">Auto-scan libraries</p>
							<p class="text-[12px] text-muted mt-0.5">Automatically scan for new books on startup</p>
						</div>
						<button
							class="toggle-switch"
							on:click={() => autoScan = !autoScan}
							role="switch"
							aria-checked={autoScan}
						>
							<span class="toggle-knob"></span>
						</button>
					</div>
				</section>

				<!-- Database -->
				<section class="glass-section">
					<div class="flex items-center gap-2.5 mb-4">
						<HardDrive class="w-4 h-4" style="color: var(--gw-accent)" />
						<h2 class="text-[15px] font-semibold tracking-tight">Database</h2>
					</div>

					<div class="space-y-4">
						<!-- Stats -->
						{#if dbStats}
							<div class="grid grid-cols-2 gap-2">
								{#each [
									{ label: 'Database Size', value: formatBytes(dbStats.databaseSizeBytes) },
									{ label: 'Books', value: dbStats.booksCount.toLocaleString() },
									{ label: 'Embeddings', value: dbStats.embeddingsCount.toLocaleString() },
									{ label: 'Embeddings Size', value: formatBytes(dbStats.embeddingsSizeBytes) }
								] as stat}
									<div class="p-2.5 rounded-lg" style="background: var(--gw-surface-tint)">
										<p class="text-[10px] text-muted uppercase tracking-widest mb-0.5">{stat.label}</p>
										<p class="text-[15px] font-semibold tabular-nums">{stat.value}</p>
									</div>
								{/each}
							</div>
						{/if}

						<!-- Database Path -->
						<div>
							<label class="block text-[12px] font-medium text-secondary mb-1.5">Database Location</label>
							<div class="flex items-center gap-2">
								<input
									type="text"
									value={currentDbPath}
									readonly
									class="glass-input flex-1 opacity-60"
								/>
								<button class="btn-secondary px-2.5" on:click={handleChangeDatabasePath}>
									<FolderOpen class="w-3.5 h-3.5" />
								</button>
							</div>
							{#if preferredDbPath && preferredDbPath !== currentDbPath}
								<p class="text-[12px] mt-1.5" style="color: var(--gw-warning)">
									Database will move to new location on restart.
								</p>
							{/if}
						</div>

						<!-- Maintenance actions -->
						{#each [
							{ title: 'Clear Embeddings', desc: 'Remove all embeddings to regenerate', color: 'var(--gw-warning)', confirm: showClearEmbeddingsConfirm, loading: clearingEmbeddings, onToggle: () => showClearEmbeddingsConfirm = !showClearEmbeddingsConfirm, onConfirm: handleClearEmbeddings },
							{ title: 'Cleanup Missing Files', desc: 'Remove entries for deleted book files', color: 'var(--gw-fg)', confirm: false, loading: cleaningOrphans, onToggle: handleCleanupOrphans, onConfirm: null }
						] as action}
							<div class="pt-3.5 border-t border-[var(--gw-separator)]">
								<div class="flex items-center justify-between">
									<div>
										<p class="text-[13px] font-medium" style="color: {action.color}">{action.title}</p>
										<p class="text-[12px] text-muted mt-0.5">{action.desc}</p>
									</div>
									{#if action.onConfirm && action.confirm}
										<div class="flex items-center gap-1.5">
											<button class="btn-secondary" on:click={action.onToggle} disabled={action.loading}>
												Cancel
											</button>
											<button
												class="btn-primary"
												style="background: {action.color}"
												on:click={action.onConfirm}
												disabled={action.loading}
											>
												{#if action.loading}<RefreshCw class="w-3.5 h-3.5 animate-spin" />{/if}
												Confirm
											</button>
										</div>
									{:else}
										<button class="btn-secondary" on:click={action.onToggle} disabled={action.loading}>
											{#if action.loading}<RefreshCw class="w-3.5 h-3.5 animate-spin" />{:else}<Trash2 class="w-3.5 h-3.5" />{/if}
											<span>{action.title.split(' ')[0]}</span>
										</button>
									{/if}
								</div>
							</div>
						{/each}

						<!-- Rebuild Graph -->
						<div class="pt-3.5 border-t border-[var(--gw-separator)]">
							<div class="flex items-center justify-between">
								<div class="flex-1">
									<p class="text-[13px] font-medium">Rebuild Book Graph</p>
									<p class="text-[12px] text-muted mt-0.5">Recompute similarity connections</p>
									{#if graphRebuildProgress}
										<div class="mt-2">
											<div class="flex justify-between text-[10px] text-muted mb-1">
												<span>{graphRebuildProgress.current.toLocaleString()} / {graphRebuildProgress.total.toLocaleString()}</span>
												<span>{graphRebuildProgress.edgesSoFar.toLocaleString()} connections</span>
											</div>
											<div class="glass-progress">
												<div
													class="glass-progress-bar"
													style="width: {(graphRebuildProgress.current / graphRebuildProgress.total) * 100}%"
												></div>
											</div>
										</div>
									{/if}
								</div>
								<button class="btn-secondary ml-3" on:click={handleRebuildGraph} disabled={rebuildingGraph}>
									{#if rebuildingGraph}<RefreshCw class="w-3.5 h-3.5 animate-spin" />{:else}<RefreshCw class="w-3.5 h-3.5" />{/if}
									<span>Rebuild</span>
								</button>
							</div>
						</div>

						<!-- Reset Database -->
						<div class="pt-3.5 border-t border-[var(--gw-separator)]">
							<div class="flex items-center justify-between">
								<div>
									<p class="text-[13px] font-medium" style="color: var(--gw-error)">Reset Database</p>
									<p class="text-[12px] text-muted mt-0.5">Delete all books, libraries, and settings</p>
								</div>
								{#if !showResetConfirm}
									<button
										class="btn-secondary"
										style="color: var(--gw-error)"
										on:click={() => showResetConfirm = true}
									>
										<Trash2 class="w-3.5 h-3.5" />
										<span>Reset</span>
									</button>
								{:else}
									<div class="flex items-center gap-1.5">
										<button class="btn-secondary" on:click={() => showResetConfirm = false} disabled={resetting}>
											Cancel
										</button>
										<button
											class="btn-primary"
											style="background: var(--gw-error)"
											on:click={handleResetDatabase}
											disabled={resetting}
										>
											{#if resetting}<RefreshCw class="w-3.5 h-3.5 animate-spin" />{:else}<AlertTriangle class="w-3.5 h-3.5" />{/if}
											Confirm
										</button>
									</div>
								{/if}
							</div>
						</div>
					</div>
				</section>

				<!-- Backup & Export -->
				<section class="glass-section">
					<div class="flex items-center gap-2.5 mb-4">
						<Database class="w-4 h-4" style="color: var(--gw-accent)" />
						<h2 class="text-[15px] font-semibold tracking-tight">Backup & Export</h2>
					</div>

					<div class="grid grid-cols-2 gap-2">
						<button class="btn-secondary justify-center" on:click={handleBackup}>
							<Download class="w-3.5 h-3.5" />
							<span>Create Backup</span>
						</button>
						<button class="btn-secondary justify-center" on:click={handleRestore}>
							<Upload class="w-3.5 h-3.5" />
							<span>Restore Backup</span>
						</button>
						<button class="btn-secondary justify-center" on:click={handleExport}>
							<FolderOpen class="w-3.5 h-3.5" />
							<span>Export JSON</span>
						</button>
						<button class="btn-secondary justify-center" on:click={handleImport}>
							<FolderOpen class="w-3.5 h-3.5" />
							<span>Import JSON</span>
						</button>
					</div>
				</section>

				<!-- Save Button -->
				<div class="flex justify-end pb-4">
					<button
						class="btn-primary"
						on:click={saveSettings}
						disabled={saving}
					>
						{#if saving}
							<RefreshCw class="w-3.5 h-3.5 animate-spin" />
						{:else}
							<Save class="w-3.5 h-3.5" />
						{/if}
						<span>Save Settings</span>
					</button>
				</div>
			</div>
		{/if}
	</div>
</div>
