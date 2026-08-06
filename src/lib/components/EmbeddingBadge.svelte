<script lang="ts">
	import { Sparkles, AlertTriangle, Loader2 } from 'lucide-svelte';
	import type { EmbeddingStatus } from '$lib/api/commands';

	/** Raw `books.embedding_status`. Unrecognised values render nothing. */
	export let status: EmbeddingStatus | string | null | undefined = undefined;

	/**
	 * `overlay` pins the badge into a cover's bottom-right corner — the one
	 * corner BookCard leaves free (top-left is the hidden flag, top-right the
	 * read-status dot, bottom-left the rating).
	 * `inline` drops the positioning so it can sit in a normal flow layout.
	 */
	export let variant: 'overlay' | 'inline' = 'overlay';

	/**
	 * Whether "not yet indexed" earns its own badge.
	 *
	 * Off by default because in a grid it says nothing: 71% of the library is
	 * pending, so marking it would badge most thumbnails and leave the eye
	 * nowhere to rest. Absence carries that meaning for free. Turned on in the
	 * detail panel, where there is one book and therefore no noise to make.
	 */
	export let showPending = false;

	/** Show the text label beside the icon. Icon-only keeps cover overlays small. */
	export let showLabel = false;

	type Kind = 'complete' | 'processing' | 'failed' | 'pending';

	// 'skipped' is deliberately excluded from embedding, so it gets no badge —
	// it is not a state the user needs to act on.
	$: kind = ((): Kind | null => {
		if (status === 'complete') return 'complete';
		if (status === 'processing') return 'processing';
		if (status === 'failed') return 'failed';
		if (status === 'pending' && showPending) return 'pending';
		return null;
	})();

	const LABELS: Record<Kind, string> = {
		complete: 'Indexed',
		processing: 'Indexing…',
		failed: 'Failed',
		pending: 'Not indexed'
	};

	const DESCRIPTIONS: Record<Kind, string> = {
		complete: 'Indexed — this book appears in recommendations',
		processing: 'Generating this book’s embedding now',
		failed: 'Embedding failed after repeated attempts',
		pending: 'Not indexed yet — no recommendations for this book'
	};

	// Bright variants: these sit on a black/60 scrim in overlay mode, where the
	// light-theme tokens are too dark to read.
	const COLORS: Record<Kind, string> = {
		complete: '#0a84ff',
		processing: '#0a84ff',
		failed: '#ff453a',
		pending: 'rgba(255,255,255,0.55)'
	};

	// Explicit rgba tints rather than color-mix(): the codebase expresses every
	// translucent fill this way (see --gw-accent-subtle and the rgba(255,59,48,0.12)
	// error fill in app.css), and color-mix appears nowhere else here.
	// --gw-accent-text is the accent tuned for text contrast in both themes.
	const INLINE_STYLES: Record<Kind, string> = {
		complete: 'color: var(--gw-accent-text); background: var(--gw-accent-subtle)',
		processing: 'color: var(--gw-accent-text); background: var(--gw-accent-subtle)',
		failed: 'color: var(--gw-error); background: rgba(255, 59, 48, 0.12)',
		pending: 'color: var(--gw-fg-muted); background: var(--gw-surface-tint)'
	};
</script>

{#if kind}
	{#if variant === 'overlay'}
		<div
			class="absolute bottom-1.5 right-1.5 bg-black/60 backdrop-blur-sm rounded-md flex items-center gap-1 {showLabel ? 'px-1.5 py-0.5' : 'p-1'}"
			title={DESCRIPTIONS[kind]}
		>
			{#if kind === 'processing'}
				<Loader2 class="w-3 h-3 animate-spin" style={`color: ${COLORS[kind]}`} />
			{:else if kind === 'failed'}
				<AlertTriangle class="w-3 h-3" style={`color: ${COLORS[kind]}`} />
			{:else}
				<Sparkles class="w-3 h-3" style={`color: ${COLORS[kind]}`} />
			{/if}
			{#if showLabel}
				<span class="text-[10px] text-white font-medium">{LABELS[kind]}</span>
			{/if}
			<span class="sr-only">{DESCRIPTIONS[kind]}</span>
		</div>
	{:else}
		<span
			class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
			style={INLINE_STYLES[kind]}
			title={DESCRIPTIONS[kind]}
		>
			{#if kind === 'processing'}
				<Loader2 class="w-3 h-3 animate-spin" />
			{:else if kind === 'failed'}
				<AlertTriangle class="w-3 h-3" />
			{:else}
				<Sparkles class="w-3 h-3" />
			{/if}
			{LABELS[kind]}
			<span class="sr-only">— {DESCRIPTIONS[kind]}</span>
		</span>
	{/if}
{/if}
