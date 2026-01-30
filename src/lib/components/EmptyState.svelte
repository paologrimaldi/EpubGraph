<script lang="ts">
	import type { ComponentType } from 'svelte';

	export let icon: ComponentType;
	export let title: string;
	export let description: string = '';
</script>

<div class="flex flex-col items-center justify-center py-16 px-4 text-center">
	<div class="w-16 h-16 rounded-full bg-surface-100 dark:bg-surface-800 flex items-center justify-center mb-4">
		<svelte:component this={icon} class="w-8 h-8 text-surface-400" />
	</div>
	<h3 class="text-lg font-medium mb-2">{title}</h3>
	{#if description}
		<p class="text-surface-500 max-w-sm">{description}</p>
	{/if}
	<slot />
</div>
