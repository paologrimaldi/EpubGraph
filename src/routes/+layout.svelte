<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import { theme } from '$lib/stores/theme';

	let initialized = !browser;

	onMount(() => {
		// Initialize theme on mount
		theme.initialize();
		initialized = true;
	});
</script>

<div class="flex h-full">
	<Sidebar />

	<main class="flex-1 flex flex-col overflow-hidden">
		{#if initialized}
			<slot />
		{:else}
			<div class="flex-1 flex items-center justify-center">
				<div class="text-center">
					<div class="w-12 h-12 mx-auto mb-4 rounded-full gw-glass flex items-center justify-center">
						<svg class="w-6 h-6 animate-spin" viewBox="0 0 24 24" fill="none">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
					</div>
					<p class="text-muted">Loading Alexandria...</p>
				</div>
			</div>
		{/if}
	</main>
</div>

<Toast />
