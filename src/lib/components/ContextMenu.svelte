<script context="module" lang="ts">
	import type { ComponentType } from 'svelte';

	export interface ContextMenuItem {
		label: string;
		action: () => void;
		icon?: ComponentType;
		disabled?: boolean;
		separator?: boolean;
	}
</script>

<script lang="ts">
	import { onMount, onDestroy, createEventDispatcher } from 'svelte';

	export let items: ContextMenuItem[] = [];
	export let x: number = 0;
	export let y: number = 0;

	const dispatch = createEventDispatcher<{ close: void }>();

	let menuElement: HTMLDivElement;

	function handleClickOutside(event: MouseEvent) {
		if (menuElement && !menuElement.contains(event.target as Node)) {
			dispatch('close');
		}
	}

	function handleKeyDown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			dispatch('close');
		}
	}

	function handleItemClick(item: ContextMenuItem) {
		if (item.disabled) return;
		item.action();
		dispatch('close');
	}

	// Adjust position if menu goes off-screen
	function adjustPosition() {
		if (!menuElement) return;

		const rect = menuElement.getBoundingClientRect();
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;

		// Adjust X if menu goes off right edge
		if (rect.right > viewportWidth) {
			x = viewportWidth - rect.width - 10;
		}

		// Adjust Y if menu goes off bottom edge
		if (rect.bottom > viewportHeight) {
			y = viewportHeight - rect.height - 10;
		}

		// Ensure minimum position
		x = Math.max(10, x);
		y = Math.max(10, y);
	}

	onMount(() => {
		document.addEventListener('click', handleClickOutside, true);
		document.addEventListener('keydown', handleKeyDown);

		// Small delay to ensure menu is rendered before adjusting
		requestAnimationFrame(adjustPosition);
	});

	onDestroy(() => {
		document.removeEventListener('click', handleClickOutside, true);
		document.removeEventListener('keydown', handleKeyDown);
	});
</script>

<div
	bind:this={menuElement}
	class="context-menu"
	style="left: {x}px; top: {y}px;"
	role="menu"
	tabindex="-1"
>
	{#each items as item, index (index)}
		{#if item.separator}
			<div class="context-menu-separator"></div>
		{:else}
			<button
				class="context-menu-item"
				class:disabled={item.disabled}
				role="menuitem"
				disabled={item.disabled}
				on:click={() => handleItemClick(item)}
			>
				{#if item.icon}
					<span class="context-menu-icon">
						<svelte:component this={item.icon} class="w-4 h-4" />
					</span>
				{/if}
				<span class="context-menu-label">{item.label}</span>
			</button>
		{/if}
	{/each}
</div>

<style>
	.context-menu {
		position: fixed;
		z-index: 1000;
		min-width: 180px;
		padding: 6px;
		border-radius: 12px;
		background: rgba(30, 30, 40, 0.95);
		backdrop-filter: blur(20px);
		border: 1px solid rgba(255, 255, 255, 0.1);
		box-shadow:
			0 4px 24px rgba(0, 0, 0, 0.4),
			0 0 0 1px rgba(255, 255, 255, 0.05) inset;
	}

	.context-menu-item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 10px 12px;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: rgba(255, 255, 255, 0.9);
		font-size: 13px;
		text-align: left;
		cursor: pointer;
		transition: background-color 0.15s;
	}

	.context-menu-item:hover:not(.disabled) {
		background: rgba(255, 255, 255, 0.1);
	}

	.context-menu-item.disabled {
		color: rgba(255, 255, 255, 0.4);
		cursor: not-allowed;
	}

	.context-menu-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		color: rgba(255, 255, 255, 0.7);
	}

	.context-menu-item:hover:not(.disabled) .context-menu-icon {
		color: rgba(255, 255, 255, 0.9);
	}

	.context-menu-label {
		flex: 1;
	}

	.context-menu-separator {
		height: 1px;
		margin: 6px 8px;
		background: rgba(255, 255, 255, 0.1);
	}
</style>
