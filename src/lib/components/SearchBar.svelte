<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	export let value = '';
	export let placeholder = 'Search books...';

	const dispatch = createEventDispatcher<{ search: string }>();

	let inputElement: HTMLInputElement;
	let debounceTimer: ReturnType<typeof setTimeout>;

	function handleInput(event: Event) {
		const target = event.target as HTMLInputElement;
		value = target.value;
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			dispatch('search', value);
		}, 300);
	}

	function clear() {
		value = '';
		dispatch('search', '');
		inputElement?.focus();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			clear();
		}
	}
</script>

<div class="relative w-72">
	<svg
		class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 z-10 pointer-events-none"
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		fill="none"
		stroke-width="2.5"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<circle cx="11" cy="11" r="8" stroke="var(--gw-fg-muted)" />
		<path d="m21 21-4.3-4.3" stroke="var(--gw-fg-muted)" />
	</svg>

	<input
		bind:this={inputElement}
		type="text"
		{value}
		{placeholder}
		class="input pl-8 pr-8"
		on:input={handleInput}
		on:keydown={handleKeydown}
	/>

	{#if value}
		<button
			class="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded-md hover:bg-[var(--gw-surface-tint)] transition-colors"
			on:click={clear}
		>
			<svg
				class="w-3.5 h-3.5"
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="none"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="M18 6 6 18" stroke="var(--gw-fg-muted)" />
				<path d="m6 6 12 12" stroke="var(--gw-fg-muted)" />
			</svg>
		</button>
	{/if}
</div>
