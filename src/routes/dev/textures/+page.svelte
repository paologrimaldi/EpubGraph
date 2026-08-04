<script lang="ts">
	// Client-only browser dev harness for reviewing the shared cloth/paper/edge
	// maps and per-book artwork painters (Task 6) against the dark editorial
	// room tone — no Tauri runtime involved, checkable with a plain
	// `npm run dev` / `vite dev` browser tab. Temporary: deleted in Task 11.
	import { onMount, tick } from 'svelte';
	import type { Book } from '$lib/api/commands';
	import type { BookIdentity } from '$lib/components/bookshelf/types/experience';

	let mounted = false;
	let identities: BookIdentity[] = [];
	let bookContainers: HTMLDivElement[] = [];
	let sharedContainer: HTMLDivElement;

	const FAKE_BOOKS: Book[] = [
		{
			id: 7,
			path: '/dev/fake/midnight-compile.epub',
			coverPath: null,
			title: 'Midnight Compile',
			sortTitle: null,
			author: 'Rosalind Fetch',
			authorSort: null,
			series: 'The Orchard Cycle',
			seriesIndex: 2,
			description: "A programmer chasing a phantom bug in her company's oldest codebase finds it isn't a bug at all.",
			language: null,
			publisher: null,
			publishDate: null,
			isbn: null,
			fileSize: 1000000,
			fileHash: null,
			calibreId: null,
			source: 'dev-harness',
			dateAdded: 0,
			dateModified: 0,
			dateIndexed: null,
			embeddingStatus: 'complete',
			embeddingModel: null,
			hidden: false,
			rating: null,
			readStatus: 'want'
		},
		{
			id: 8,
			path: '/dev/fake/paper-rivers.epub',
			coverPath: null,
			title: 'Paper Rivers',
			sortTitle: null,
			author: 'Desmond Okafor',
			authorSort: null,
			series: null,
			seriesIndex: null,
			description:
				'A cartography of the mail routes that once connected a fractured country, told through the letters that survived.',
			language: null,
			publisher: null,
			publishDate: null,
			isbn: null,
			fileSize: 1000000,
			fileHash: null,
			calibreId: null,
			source: 'dev-harness',
			dateAdded: 0,
			dateModified: 0,
			dateIndexed: null,
			embeddingStatus: 'complete',
			embeddingModel: null,
			hidden: false,
			rating: null,
			readStatus: 'want'
		},
		{
			id: 9,
			path: '/dev/fake/the-glass-orchard.epub',
			coverPath: null,
			title: 'The Glass Orchard',
			sortTitle: null,
			author: 'Simon Wilder',
			authorSort: null,
			series: 'The Orchard Cycle',
			seriesIndex: 1,
			description:
				"A horticulturist discovers her family's greenhouse holds more than plants, and the first harvest changes everything she believed about home.",
			language: null,
			publisher: null,
			publishDate: null,
			isbn: null,
			fileSize: 1000000,
			fileHash: null,
			calibreId: null,
			source: 'dev-harness',
			dateAdded: 0,
			dateModified: 0,
			dateIndexed: null,
			embeddingStatus: 'complete',
			embeddingModel: null,
			hidden: false,
			rating: 4,
			readStatus: 'want'
		}
	];

	function appendLabeled(container: HTMLElement, label: string, canvas: HTMLCanvasElement): void {
		const tile = document.createElement('div');
		tile.className = 'texture-tile';
		canvas.style.maxWidth = '220px';
		canvas.style.maxHeight = '220px';
		canvas.style.width = 'auto';
		canvas.style.height = 'auto';
		canvas.style.border = '1px solid #33384a';
		canvas.style.background = '#000';
		const caption = document.createElement('span');
		caption.className = 'texture-label';
		caption.textContent = label;
		tile.appendChild(canvas);
		tile.appendChild(caption);
		container.appendChild(tile);
	}

	onMount(async () => {
		const [{ buildIdentity }, { makeArtwork }, shared] = await Promise.all([
			import('$lib/components/bookshelf/three/bookIdentity'),
			import('$lib/components/bookshelf/three/textures/artwork'),
			import('$lib/components/bookshelf/three/textures/shared')
		]);

		identities = FAKE_BOOKS.map(buildIdentity);
		mounted = true;
		await tick();

		identities.forEach((identity, i) => {
			const container = bookContainers[i];
			if (!container) return;
			const art = makeArtwork(identity, 'medium');
			appendLabeled(container, 'cover', art.cover.image);
			if (art.foil) appendLabeled(container, 'foil', art.foil.image);
			appendLabeled(container, 'spine', art.spine.image);
			appendLabeled(container, 'spineFoil', art.spineFoil.image);
			appendLabeled(container, 'back', art.back.image);
			appendLabeled(container, 'endpaper', art.endpaper.image);
		});

		if (sharedContainer) {
			const cloth = shared.sharedClothMaps();
			const paper = shared.sharedPaperFaceTexture();
			const edges = shared.sharedPageEdgeTextures();
			appendLabeled(sharedContainer, 'cloth normal', cloth.normal.image);
			appendLabeled(sharedContainer, 'cloth roughness', cloth.roughness.image);
			appendLabeled(sharedContainer, 'cloth bump', cloth.bump.image);
			appendLabeled(sharedContainer, 'paper', paper.image);
			appendLabeled(sharedContainer, 'page edge fore', edges.fore.image);
			appendLabeled(sharedContainer, 'page edge headTail', edges.headTail.image);
		}
	});
</script>

<svelte:head>
	<title>Textures Dev Harness</title>
</svelte:head>

<div class="texture-harness">
	{#if mounted}
		{#each identities as identity, i (identity.id)}
			<section>
				<h2>#{identity.id} — {identity.title} (seed {identity.seed}, motif {identity.motifIndex})</h2>
				<div class="row" bind:this={bookContainers[i]}></div>
			</section>
		{/each}
		<section>
			<h2>Shared maps</h2>
			<div class="row" bind:this={sharedContainer}></div>
		</section>
	{/if}
</div>

<style>
	.texture-harness {
		/* The app shell wraps routes in a fixed-height, overflow-hidden <main> —
		   without its own scroll container, content taller than one viewport
		   (several book sections + the shared-maps row) would be unreachable. */
		height: 100%;
		min-height: 100vh;
		overflow-y: auto;
		background: #1c1e26;
		padding: 24px;
		font-family: system-ui, sans-serif;
	}
	section {
		margin-bottom: 32px;
	}
	h2 {
		color: #e8e6df;
		font-size: 14px;
		font-weight: 600;
		margin: 0 0 10px;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
	}
	:global(.texture-tile) {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
	}
	:global(.texture-label) {
		font-size: 12px;
		color: #c9cede;
	}
</style>
