<script lang="ts" context="module">
	import { writable } from 'svelte/store';

	const tooltipState = writable<{
		text: string;
		x: number;
		y: number;
		wide: boolean;
		visible: boolean;
	}>({ text: '', x: 0, y: 0, wide: false, visible: false });

	let showTimer: ReturnType<typeof setTimeout> | null = null;
	let hideTimer: ReturnType<typeof setTimeout> | null = null;

	export function showTooltip(text: string, rect: DOMRect) {
		if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
		const x = rect.left + rect.width / 2;
		const y = rect.top;
		const wide = text.length > 120;
		showTimer = setTimeout(() => {
			tooltipState.set({ text, x, y, wide, visible: true });
		}, 400);
	}

	export function hideTooltip() {
		if (showTimer) { clearTimeout(showTimer); showTimer = null; }
		hideTimer = setTimeout(() => {
			tooltipState.update(s => ({ ...s, visible: false }));
		}, 100);
	}
</script>

<script lang="ts">
	$: ({ text, x, y, wide, visible } = $tooltipState);

	let tooltipEl: HTMLElement;
	let adjustedX = 0;
	let adjustedY = 0;

	$: if (visible && tooltipEl) {
		const tw = tooltipEl.offsetWidth;
		const th = tooltipEl.offsetHeight;
		adjustedX = Math.max(8, Math.min(x - tw / 2, window.innerWidth - tw - 8));
		adjustedY = y - th - 6;
		if (adjustedY < 8) {
			adjustedY = y + 20;
		}
	}
</script>

{#if visible}
	<div
		bind:this={tooltipEl}
		class="tooltip-popover"
		class:wide
		style="left: {adjustedX}px; top: {adjustedY}px;"
	>
		{text}
	</div>
{/if}

<style>
	.tooltip-popover {
		position: fixed;
		z-index: 9999;
		max-width: 280px;
		max-height: 200px;
		overflow-y: auto;
		padding: 6px 10px;
		font-size: 12px;
		line-height: 1.4;
		color: var(--gw-fg);
		background: var(--gw-surface);
		border: 0.5px solid var(--gw-border);
		border-radius: 8px;
		box-shadow: var(--gw-shadow-md);
		backdrop-filter: blur(16px);
		-webkit-backdrop-filter: blur(16px);
		pointer-events: none;
		white-space: normal;
		word-break: break-word;
		animation: tooltip-in 0.12s ease-out;
	}

	.tooltip-popover.wide {
		max-width: 380px;
		max-height: 300px;
		padding: 10px 14px;
		font-size: 13px;
		pointer-events: auto;
	}

	@keyframes tooltip-in {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
