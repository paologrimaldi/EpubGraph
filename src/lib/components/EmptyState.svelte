<script lang="ts">
	import type { ComponentType } from 'svelte';

	export let icon: ComponentType;
	export let title: string;
	export let description: string = '';
</script>

<div class="flex flex-col items-center justify-center py-16 px-4 text-center">
	<div class="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style="background: var(--gw-surface-tint)">
		<svelte:component this={icon} class="w-7 h-7 text-muted" />
	</div>
	<h3 class="text-[17px] font-semibold tracking-tight mb-1.5">{title}</h3>
	{#if description}
		<p class="text-[13px] text-muted max-w-sm leading-relaxed">{description}</p>
	{/if}
	<slot />
</div>
