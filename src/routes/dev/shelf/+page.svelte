<script lang="ts">
	// Client-only browser dev harness for the 3D shelf studio — no Tauri
	// involved, so the scene can be checked with a plain `npm run dev` /
	// `vite dev` browser tab instead of the full Tauri shell.
	import { onMount } from 'svelte';
	import { Library3D } from '$lib/components/bookshelf';
	import type { Book } from '$lib/api/commands';

	let mounted = false;
	let selectedBookId: number | null = null;
	onMount(() => {
		mounted = true;
	});

	const FAKE_BOOKS: Book[] = [
		{
			id: 1,
			path: '/dev/fake/the-winds-of-habit.epub',
			coverPath: null,
			title: 'The Winds of Habit',
			sortTitle: null,
			author: 'Eleanor Voss',
			authorSort: null,
			series: null,
			seriesIndex: null,
			description:
				'A quiet meditation on the small rituals that hold a life together, traced across three generations of a coastal family.',
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
			id: 2,
			path: '/dev/fake/a-field-guide-to-silence.epub',
			coverPath: null,
			title: 'A Field Guide to Silence',
			sortTitle: null,
			author: 'Thomas Ridley',
			authorSort: null,
			series: null,
			seriesIndex: null,
			description:
				"Part memoir, part naturalist's field notes, written during a year spent listening to the spaces between sounds.",
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
		},
		{
			id: 3,
			path: '/dev/fake/copper-and-bone.epub',
			coverPath: null,
			title: 'Copper & Bone',
			sortTitle: null,
			author: 'Naomi Ashcroft',
			authorSort: null,
			series: null,
			seriesIndex: null,
			description: "A blacksmith's apprentice uncovers a conspiracy buried beneath her city's oldest foundry.",
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
			id: 4,
			path: '/dev/fake/the-cartographers-daughter.epub',
			coverPath: null,
			title: "The Cartographer's Daughter",
			sortTitle: null,
			author: 'Julian Marsh',
			authorSort: null,
			series: null,
			seriesIndex: null,
			description: "Orphaned young, a mapmaker's daughter inherits an unfinished atlas and the debts that came with it.",
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
			id: 5,
			path: '/dev/fake/notes-on-a-small-library.epub',
			coverPath: null,
			title: 'Notes on a Small Library',
			sortTitle: null,
			author: 'Priya Chandrasekhar',
			authorSort: null,
			series: null,
			seriesIndex: null,
			description:
				'An essay collection on the private libraries people build without meaning to, and what they reveal about their owners.',
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
			id: 6,
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
			rating: 5,
			readStatus: 'want'
		},
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
		}
	];
</script>

<svelte:head>
	<title>Shelf Dev Harness</title>
</svelte:head>

{#if mounted}
	<div style="width:100%;height:100vh;position:relative">
		<Library3D books={FAKE_BOOKS} textureQuality="medium" bind:selectedBookId />

		<!-- Minimal fake sidebar — verifies the inspect view-offset/composition
		     (book beside a 22rem panel, canvas never resizing) without Tauri or
		     the real BookDetail component. Wired the same way the real sidebar
		     is: closing it nulls selectedBookId, which Library3D reactively
		     observes and closes inspect for. -->
		{#if selectedBookId !== null}
			<aside
				style="position:absolute;right:0;top:0;bottom:0;width:22rem;z-index:10;background:#161616;color:#eee;border-left:1px solid #333;padding:16px;box-sizing:border-box"
			>
				<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
					<strong>Book detail (fake)</strong>
					<button type="button" on:click={() => (selectedBookId = null)} style="color:#eee">Close</button>
				</div>
				<p>Selected book id: {selectedBookId}</p>
			</aside>
		{/if}
	</div>
{/if}
