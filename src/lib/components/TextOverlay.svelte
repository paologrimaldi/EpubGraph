<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { X } from 'lucide-svelte';

	export let open = false;
	export let title = '';
	export let text = '';

	const dispatch = createEventDispatcher<{ close: void }>();

	let panelEl: HTMLElement | null = null;

	function close() {
		dispatch('close');
	}

	function onKeydown(event: KeyboardEvent) {
		if (open && event.key === 'Escape') {
			event.preventDefault();
			close();
		}
	}

	// Move focus into the panel when it opens so Escape and the scroll wheel
	// both land here rather than on whatever was focused behind the overlay.
	$: if (open && panelEl) panelEl.focus();
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
	<div class="overlay-root">
		<!-- A real <button> rather than a div with on:click, so dismissing by
		     clicking outside is keyboard-reachable and adds no a11y warnings.
		     It is a sibling of the panel, not a parent: interactive content
		     nested inside a button is invalid HTML. -->
		<button class="overlay-backdrop" tabindex="-1" aria-label="Close" on:click={close}></button>
		<div
			bind:this={panelEl}
			class="overlay-panel"
			role="dialog"
			aria-modal="true"
			aria-label={title || 'Details'}
			tabindex="-1"
		>
			<div class="overlay-header">
				<h2 class="text-[13px] font-semibold text-secondary">{title}</h2>
				<button class="overlay-close" on:click={close} aria-label="Close">
					<X class="w-4 h-4 text-muted" />
				</button>
			</div>

			<!-- The scroll container. Unlike the hover tooltip this replaced, it has
			     real pointer events and no hide-on-mouseleave timer, so the scrollbar
			     is actually reachable. Descriptions run to ~14k characters at the
			     extreme; the panel is sized so the median (~786 chars) and even the
			     99th percentile (~2.3k) need no scrolling at all. -->
			<div class="overlay-body">
				<p class="text-[13px] leading-relaxed whitespace-pre-wrap">{text}</p>
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay-root {
		position: fixed;
		inset: 0;
		z-index: 10000;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 32px;
	}

	.overlay-backdrop {
		position: absolute;
		inset: 0;
		cursor: default;
		/* Very light alpha over a strong blur — the library stays legible behind. */
		background: rgba(0, 0, 0, 0.18);
		backdrop-filter: blur(20px) saturate(140%);
		-webkit-backdrop-filter: blur(20px) saturate(140%);
		animation: overlay-fade 0.14s ease-out;
	}

	.overlay-panel {
		position: relative;
		display: flex;
		flex-direction: column;
		width: 100%;
		max-width: 640px;
		max-height: 82vh;
		background: var(--gw-surface);
		border: 0.5px solid var(--gw-border);
		border-radius: 14px;
		box-shadow: var(--gw-shadow-md);
		outline: none;
		animation: overlay-rise 0.16s ease-out;
	}

	.overlay-header {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 18px;
		border-bottom: 0.5px solid var(--gw-separator);
	}

	.overlay-close {
		width: 24px;
		height: 24px;
		border-radius: 6px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: background-color 0.15s ease;
	}

	.overlay-close:hover {
		background: var(--gw-surface-tint);
	}

	.overlay-body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: 18px;
		color: var(--gw-fg);
		word-break: break-word;
	}

	@keyframes overlay-fade {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	@keyframes overlay-rise {
		from { opacity: 0; transform: translateY(6px) scale(0.99); }
		to { opacity: 1; transform: translateY(0) scale(1); }
	}
</style>
