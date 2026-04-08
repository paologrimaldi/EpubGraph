<script lang="ts">
	import { sortBy, setSort, randomSeed, generateSeed } from '$lib/stores/library';
	import { ArrowUpDown, Shuffle } from 'lucide-svelte';

	const sortOptions = [
		{ label: 'Random', value: 'random', order: 'asc' as const },
		{ label: 'Title A\u2013Z', value: 'title', order: 'asc' as const },
		{ label: 'Author A\u2013Z', value: 'author', order: 'asc' as const },
		{ label: 'Date Added', value: 'dateAdded', order: 'desc' as const },
		{ label: 'Date Published', value: 'publishDate', order: 'desc' as const },
	];

	function handleChange(event: Event) {
		const target = event.target as HTMLSelectElement;
		const option = sortOptions.find(o => o.value === target.value);
		if (option) {
			setSort(option.value as typeof $sortBy, option.order);
		}
	}

	function reshuffle() {
		randomSeed.set(generateSeed());
		setSort('random', 'asc');
	}
</script>

<div class="flex items-center gap-1.5">
	<div class="relative">
		<ArrowUpDown class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none" style="color: var(--gw-fg-muted)" />
		<select
			value={$sortBy}
			on:change={handleChange}
			class="input pl-8 pr-3 w-auto cursor-pointer appearance-none"
			style="min-width: 9rem; background-image: url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23888%22 stroke-width=%222.5%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22m6 9 6 6 6-6%22/></svg>'); background-repeat: no-repeat; background-position: right 0.5rem center; padding-right: 1.75rem;"
		>
			{#each sortOptions as option}
				<option value={option.value}>{option.label}</option>
			{/each}
		</select>
	</div>
	{#if $sortBy === 'random'}
		<button
			class="p-1.5 rounded-md hover:bg-[var(--gw-surface-tint)] transition-colors"
			title="Shuffle"
			on:click={reshuffle}
		>
			<Shuffle class="w-3.5 h-3.5" style="color: var(--gw-fg-muted)" />
		</button>
	{/if}
</div>
