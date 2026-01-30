<script lang="ts">
	import { onMount, createEventDispatcher } from 'svelte';
	import { browser } from '$app/environment';
	import type { Book } from '$lib/api/commands';
	import { type LibraryConfig, DEFAULT_CONFIG } from './types/config';

	// Props (Svelte 4 syntax)
	export let books: Book[] = [];
	export let maxBooksPerShelf: number = DEFAULT_CONFIG.maxBooksPerShelf;
	export let minShelfWidth: number = DEFAULT_CONFIG.minShelfWidth;
	export let shelfSpacing: number = DEFAULT_CONFIG.shelfSpacing;
	export let animationSpeed: number = DEFAULT_CONFIG.animationSpeed;
	export let textureQuality: 'low' | 'medium' | 'high' = DEFAULT_CONFIG.textureQuality;
	export let enableKeyboardNav: boolean = DEFAULT_CONFIG.enableKeyboardNav;
	export let enableTooltips: boolean = DEFAULT_CONFIG.enableTooltips;
	export let selectedBookId: number | null = null;

	const dispatch = createEventDispatcher<{
		bookSelected: Book;
		bookHover: Book | null;
		shelfScroll: number;
		bookFocus: Book;
		selectedBookIdChange: number | null;
	}>();

	let container: HTMLDivElement;
	let renderer: any;
	let scene: any;
	let camera: any;
	let clock: any;
	let wallMesh: any = null;
	let animationFrameId: number;
	let bookshelfData: any = null;
	let interactionManager: any = null;
	let scrollManager: any = null;
	let isInitialized = false;
	let isMounted = false;
	let isBuilding = false;
	let lastBooksLength = 0;
	let resizeObserver: ResizeObserver | null = null;
	let darkModeObserver: MutationObserver | null = null;
	let currentDarkMode = false;

	// Detect current dark mode state
	function isDarkMode(): boolean {
		if (!browser) return false;
		return document.documentElement.classList.contains('dark');
	}

	// Tooltip state
	let tooltipVisible = false;
	let tooltipX = 0;
	let tooltipY = 0;
	let tooltipBook: Book | null = null;
	let scrollEnabled = false;

	// Build config from props (Svelte 4 reactive)
	$: config = {
		...DEFAULT_CONFIG,
		maxBooksPerShelf,
		minShelfWidth,
		shelfSpacing,
		animationSpeed,
		textureQuality,
		enableKeyboardNav,
		enableTooltips
	} as LibraryConfig;

	async function initScene() {
		if (!browser || !container) return;

		// Dynamic imports for Three.js (client-only)
		const THREE = await import('three');
		const { createScene, createLighting } = await import('./three/scene');
		const { InteractionManager } = await import('./three/interaction');
		const { ScrollManager } = await import('./three/scroll');

		// Detect dark mode
		currentDarkMode = isDarkMode();

		const setup = createScene(container, currentDarkMode);
		scene = setup.scene;
		camera = setup.camera;
		renderer = setup.renderer;
		wallMesh = setup.wallMesh;
		clock = new THREE.Clock();

		createLighting(scene);

		// Initialize managers
		interactionManager = new InteractionManager(container, camera, config, {
			onBookSelected: handleBookSelected,
			onBookHover: handleBookHover,
			onBookFocus: handleBookFocus
		});

		scrollManager = new ScrollManager(container, {
			onShelfScroll: handleShelfScroll
		});

		// Build initial bookshelf
		if (books.length > 0) {
			await buildBookshelf();
		}

		isInitialized = true;
		animate();
	}

	async function buildBookshelf() {
		if (!browser || !scene || !interactionManager || !scrollManager) return;

		// Prevent concurrent builds
		if (isBuilding) return;

		// Skip if books haven't actually changed
		if (books.length === lastBooksLength && bookshelfData) return;

		isBuilding = true;
		lastBooksLength = books.length;

		try {
			const { createBookshelf, disposeBookshelf } = await import('./three/bookshelf');

			// Dispose existing
			if (bookshelfData) {
				disposeBookshelf(bookshelfData);
				scene.remove(bookshelfData.group);
			}

			// Create new bookshelf
			bookshelfData = createBookshelf(books, config);
			scene.add(bookshelfData.group);

			// Update managers
			interactionManager.setBookshelfData(bookshelfData);
			scrollManager.setBookshelf(bookshelfData, minShelfWidth);
			scrollEnabled = scrollManager.isEnabled();

			// Center camera on bookshelf
			adjustCameraToFit();

			// Select book if selectedBookId is set (with a small delay to ensure meshes are ready)
			if (selectedBookId !== null) {
				await new Promise(resolve => setTimeout(resolve, 50));
				interactionManager.selectBookById(selectedBookId);
			}
		} finally {
			isBuilding = false;
		}
	}

	function adjustCameraToFit() {
		if (!bookshelfData || !camera || !container) return;

		const contentHeight = bookshelfData.totalHeight;
		const contentWidth = bookshelfData.totalWidth;

		// Calculate camera distance to fit content
		const fov = camera.fov * (Math.PI / 180);
		const aspect = container.clientWidth / container.clientHeight;

		// Distance needed to fit height
		const distanceForHeight = (contentHeight / 2 + 2) / Math.tan(fov / 2);
		// Distance needed to fit width
		const distanceForWidth = (contentWidth / 2 + 2) / (Math.tan(fov / 2) * aspect);

		const distance = Math.max(distanceForHeight, distanceForWidth, 12);

		// Position camera
		camera.position.set(0, 1.5, distance);
		camera.lookAt(0, 0, 0);
		camera.updateProjectionMatrix();
	}

	function handleBookSelected(book: Book) {
		selectedBookId = book.id;
		dispatch('selectedBookIdChange', book.id);
		dispatch('bookSelected', book);
	}

	function handleBookHover(book: Book | null) {
		if (enableTooltips && book) {
			tooltipBook = book;
			tooltipVisible = true;
		} else {
			tooltipVisible = false;
			tooltipBook = null;
		}
		dispatch('bookHover', book);
	}

	function handleBookFocus(book: Book) {
		dispatch('bookFocus', book);
	}

	function handleShelfScroll(position: number) {
		dispatch('shelfScroll', position);
	}

	function handleMouseMove(event: MouseEvent) {
		if (tooltipVisible) {
			tooltipX = event.clientX + 15;
			tooltipY = event.clientY + 15;
		}
	}

	function animate() {
		if (!browser) return;

		animationFrameId = requestAnimationFrame(animate);

		const deltaTime = clock.getDelta();

		// Update managers
		interactionManager?.update(deltaTime);
		scrollManager?.update();

		// Render
		renderer?.render(scene, camera);
	}

	async function handleResize() {
		if (!browser || !container || !camera || !renderer) return;

		const { updateCameraSize } = await import('./three/scene');
		updateCameraSize(camera, renderer, container);
		scrollManager?.updateContainerSize(container.clientWidth);
		adjustCameraToFit();
	}

	async function handleDarkModeChange() {
		if (!browser || !scene || !wallMesh) return;

		const newDarkMode = isDarkMode();
		if (newDarkMode === currentDarkMode) return;

		currentDarkMode = newDarkMode;
		const { updateSceneColors } = await import('./three/scene');
		updateSceneColors(scene, wallMesh, currentDarkMode);
	}

	// Watch for books changes (Svelte 4 reactive)
	// Only rebuild when books array reference changes and we're not already building
	$: if (isInitialized && books && browser && !isBuilding && books.length !== lastBooksLength) {
		buildBookshelf();
	}

	// Watch for selectedBookId changes from outside (Svelte 4 reactive)
	// Wait until building is complete before trying to select
	$: if (isInitialized && interactionManager && selectedBookId !== null && !isBuilding && bookshelfData) {
		const currentSelected = interactionManager.getSelectedBook();
		if (!currentSelected || currentSelected.id !== selectedBookId) {
			interactionManager.selectBookById(selectedBookId);
		}
	}

	onMount(() => {
		isMounted = true;
		initScene();
		window.addEventListener('resize', handleResize);

		// Use ResizeObserver to detect container size changes (e.g., when sidebar opens/closes)
		resizeObserver = new ResizeObserver(() => {
			handleResize();
		});
		if (container) {
			resizeObserver.observe(container);
		}

		// Use MutationObserver to detect dark mode changes (class changes on <html>)
		darkModeObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				if (mutation.attributeName === 'class') {
					handleDarkModeChange();
					break;
				}
			}
		});
		darkModeObserver.observe(document.documentElement, { attributes: true });

		return () => {
			window.removeEventListener('resize', handleResize);
			resizeObserver?.disconnect();
			darkModeObserver?.disconnect();

			if (animationFrameId) {
				cancelAnimationFrame(animationFrameId);
			}

			interactionManager?.dispose();
			scrollManager?.dispose();

			if (bookshelfData) {
				import('./three/bookshelf').then(({ disposeBookshelf }) => {
					disposeBookshelf(bookshelfData);
				});
			}

			if (renderer) {
				renderer.dispose();
				container?.removeChild(renderer.domElement);
			}

			import('./three/materials').then(({ disposeTextures }) => {
				disposeTextures();
			});
		};
	});
</script>

<div class="library-wrapper">
	<div
		bind:this={container}
		class="library-container"
		on:mousemove={handleMouseMove}
		role="application"
		aria-label="3D Book Library"
	></div>

	{#if tooltipVisible && tooltipBook && enableTooltips}
		<div
			class="tooltip"
			style="left: {tooltipX}px; top: {tooltipY}px;"
		>
			<div class="tooltip-title">{tooltipBook.title}</div>
			{#if tooltipBook.author}
				<div class="tooltip-author">by {tooltipBook.author}</div>
			{/if}
			{#if tooltipBook.series}
				<div class="tooltip-series">
					{tooltipBook.series}
					{#if tooltipBook.seriesIndex}
						#{tooltipBook.seriesIndex}
					{/if}
				</div>
			{/if}
			{#if tooltipBook.rating}
				<div class="tooltip-rating">
					{'★'.repeat(Math.round(tooltipBook.rating))}{'☆'.repeat(5 - Math.round(tooltipBook.rating))}
				</div>
			{/if}
		</div>
	{/if}

	{#if scrollEnabled}
		<div class="scroll-indicator">
			<span>Scroll to explore</span>
		</div>
	{/if}
</div>

<style>
	.library-wrapper {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 400px;
		overflow: hidden;
	}

	.library-container {
		width: 100%;
		height: 100%;
		outline: none;
	}

	.tooltip {
		position: fixed;
		z-index: 1000;
		background: rgba(26, 26, 46, 0.95);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 8px;
		padding: 12px 16px;
		pointer-events: none;
		max-width: 280px;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
		backdrop-filter: blur(8px);
	}

	.tooltip-title {
		font-weight: 600;
		font-size: 14px;
		color: #ffffff;
		margin-bottom: 4px;
		line-height: 1.3;
	}

	.tooltip-author {
		font-size: 12px;
		color: rgba(255, 255, 255, 0.7);
		margin-bottom: 2px;
	}

	.tooltip-series {
		font-size: 11px;
		color: rgba(255, 255, 255, 0.5);
		font-style: italic;
	}

	.tooltip-rating {
		font-size: 12px;
		color: #ffd700;
		margin-top: 6px;
		letter-spacing: 2px;
	}

	.scroll-indicator {
		position: absolute;
		bottom: 16px;
		left: 50%;
		transform: translateX(-50%);
		background: rgba(26, 26, 46, 0.8);
		padding: 8px 16px;
		border-radius: 20px;
		font-size: 12px;
		color: rgba(255, 255, 255, 0.6);
		pointer-events: none;
		animation: pulse 2s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% {
			opacity: 0.6;
		}
		50% {
			opacity: 1;
		}
	}
</style>
