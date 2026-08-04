<script lang="ts">
	import { onMount, createEventDispatcher } from 'svelte';
	import { browser } from '$app/environment';
	import { ChevronLeft, ChevronRight, Star } from 'lucide-svelte';
	import type { Book } from '$lib/api/commands';
	import type { Experience } from './three/experience';
	import type { Room } from './three/room';
	import type { LightRig } from './three/lights';
	import type { RigHandle } from './three/bookRig';
	import type { Carousel } from './three/carousel';
	import type { InspectController } from './three/inspect';
	import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
	import type { ScenePalette, Mode } from './types/experience';
	// Pure/near-pure modules — no three.js/DOM touched at module scope — safe to
	// import statically even though this component otherwise keeps every three.js-
	// touching module behind a dynamic import (see initScene below). carousel.ts
	// and theme.ts's createThemeDriver both only ever operate on already-
	// constructed three.js objects handed to them by the caller (they never call
	// `new THREE.X()` themselves), so neither carries a runtime three.js import.
	import { buildIdentity } from './three/bookIdentity';
	import { createCarousel } from './three/carousel';
	import { createThemeDriver } from './three/theme';
	import { createModeMachine } from './three/state';

	// Dark editorial-room theme painted instantly before any book is selected —
	// there is no carousel selection yet for the theme driver to ease toward.
	// The reference design is a dark intimate room (near-black backdrop, dark
	// floor, warm light pooling), not a light warm-paper wash.
	const PLACEHOLDER_PALETTE: ScenePalette = {
		backdrop: '#232630',
		fog: '#232630',
		floor: '#1d1713',
		key: '#f4d7b9',
		fill: '#9fb3c9',
		accent: '#c87046',
		shelf: '#3a2118'
	};

	// Props (Svelte 4 syntax).
	export let books: Book[] = [];
	export let textureQuality: 'low' | 'medium' | 'high' = 'medium';
	// Which book is shown in the external BookDetail sidebar / inspect view.
	// Two-way: openInspect()/closeInspect() reassign it directly (drives
	// `bind:selectedBookId` on the caller); a caller nulling it externally
	// (e.g. the sidebar's own close button) is reactively observed below and
	// closes inspect if it's currently open.
	export let selectedBookId: number | null = null;

	const dispatch = createEventDispatcher<{
		bookSelected: Book;
		bookHover: Book | null;
		selectedBookIdChange: number | null;
	}>();

	const DUST_SETTLE_SECONDS = 2.5;
	const ANNOUNCE_DEBOUNCE_MS = 200;
	// Matches SERIF_STACK in three/textures/artwork.ts, so the HUD title reads
	// as the same editorial voice as the cover/spine type painted on the books.
	const HUD_SERIF_STACK = `'Iowan Old Style', 'Baskerville', 'Georgia', serif`;

	$: identities = books.map(buildIdentity);
	$: idKey = identities.map((identity) => identity.id).join(',');

	let container: HTMLDivElement;
	let experience: Experience | null = null;
	let room: Room | null = null;
	let lights: LightRig | null = null;
	let carousel: Carousel | null = null;
	let themeDriver: ReturnType<typeof createThemeDriver> | null = null;
	let raycaster: import('three').Raycaster | null = null;
	let pointerVec: import('three').Vector2 | null = null;
	const modeMachine = createModeMachine();
	let controls: OrbitControls | null = null;
	let inspect: InspectController | null = null;
	// Mirrors modeMachine.mode for Svelte template reactivity — the machine's
	// `.mode` getter has hidden closure state Svelte's compiler can't track,
	// so template-facing reads go through this plain `let` instead, kept in
	// sync via syncMode() after anything that can move the machine.
	let mode: Mode = 'shelf';
	let resizeObserver: ResizeObserver | null = null;
	let darkModeObserver: MutationObserver | null = null;
	let currentDarkMode = false;
	let dustSettleStart: number | null = null;
	let shelfTop = 0.47; // fallback until initScene loads the real SHELF_TOP constant
	let rigs: RigHandle[] = [];
	let lastIdKey: string | null = null;
	let bookRigModule: typeof import('./three/bookRig') | null = null;
	// Guards the dynamic-import window in initScene(): the component can be
	// destroyed (e.g. a store flip swapping this component out) before the
	// imports resolve — without this flag, initScene() would still go on to
	// build a renderer/canvas/matchMedia listener/rAF loop with no disposal
	// handle, orphaning a WebGL context.
	let destroyed = false;

	let selectedIndex = 0;
	let hoveredBook: Book | null = null;
	let liveMessage = '';
	let announceTimer: ReturnType<typeof setTimeout> | null = null;

	$: selectedBook = books[selectedIndex] ?? null;

	// Detect current dark mode state
	function isDarkMode(): boolean {
		if (!browser) return false;
		return document.documentElement.classList.contains('dark');
	}

	// Instant (non-eased) scene paint — used only for the pre-selection default,
	// before any book has been chosen and the theme driver has something to ease
	// toward. Every subsequent re-theme goes through themeDriver.setPalette.
	function applyScenePalette(palette: ScenePalette): void {
		if (!experience || !room || !lights) return;
		room.themeTargets.backdrop.color.set(palette.backdrop);
		room.themeTargets.floor.color.set(palette.floor);
		experience.scene.fog?.color.set(palette.fog);
		lights.key.color.set(palette.key);
		lights.fill.color.set(palette.fill);
	}

	// Single on-demand frame callback (Experience.onFrame is single-slot) —
	// multiplexes dust settle, carousel motion, theme easing, and inspect
	// open/close/orbit through one handler and requests another frame while
	// any one of them is still moving.
	function handleFrame(dt: number, elapsed: number): boolean {
		if (dustSettleStart === null) dustSettleStart = elapsed;
		let dustSettling = false;
		if (room?.dust) {
			room.dust.rotation.y += dt * 0.015;
			room.dust.position.y = Math.sin(elapsed * 0.15) * 0.02;
			dustSettling = elapsed - dustSettleStart < DUST_SETTLE_SECONDS;
		}
		const carouselMoving = carousel?.update(dt, elapsed) ?? false;
		const themeMoving = themeDriver?.update(dt) ?? false;
		const inspectMoving = inspect?.update(dt) ?? false;
		syncMode();
		return dustSettling || carouselMoving || themeMoving || inspectMoving;
	}

	// Keeps the template-facing `mode` mirror in sync with modeMachine.mode —
	// cheap no-op check on frames where nothing transitioned.
	function syncMode(): void {
		if (mode !== modeMachine.mode) mode = modeMachine.mode;
	}

	function announceSelection(index: number): void {
		if (announceTimer) clearTimeout(announceTimer);
		announceTimer = setTimeout(() => {
			const book = books[index];
			if (book) liveMessage = `${book.title}, ${index + 1} of ${books.length}`;
		}, ANNOUNCE_DEBOUNCE_MS);
	}

	// Fired by carousel.onSelectionChange whenever the centered book changes,
	// and called once directly after each rig rebuild to seed the initial state.
	function handleSelectionChange(index: number): void {
		selectedIndex = index;
		const identity = identities[index];
		if (identity) themeDriver?.setPalette(identity.palette, isDarkMode());
		announceSelection(index);
		experience?.requestFrame();
	}

	async function initScene(): Promise<void> {
		if (!browser || !container) return;

		// Dynamic imports for Three.js (client-only). `three` itself is included
		// here (rather than statically imported) purely to construct the
		// Raycaster/Vector2 used by pointer hit-testing below — carousel.ts and
		// theme.ts need no runtime three.js import of their own.
		const [three, experienceModule, roomModule, lightsModule, orbitModule, inspectModule] = await Promise.all([
			import('three'),
			import('./three/experience'),
			import('./three/room'),
			import('./three/lights'),
			import('three/examples/jsm/controls/OrbitControls.js'),
			import('./three/inspect')
		]);

		// The component may have been torn down while the imports above were
		// in flight — bail before creating anything so no renderer/canvas/
		// listener/rAF loop is ever orphaned without a disposal handle.
		if (destroyed) return;

		currentDarkMode = isDarkMode();
		raycaster = new three.Raycaster();
		pointerVec = new three.Vector2();

		experience = experienceModule.createExperience(container);
		shelfTop = experienceModule.SHELF_TOP;
		room = roomModule.addRoom(experience.scene, experience.shelfStage, experience.reducedMotion());
		lights = lightsModule.addLights(experience.scene);

		applyScenePalette(PLACEHOLDER_PALETTE);

		themeDriver = createThemeDriver({ room, lights, scene: experience.scene });
		carousel = createCarousel(experience.shelfStage, {
			shelfTop,
			reducedMotion: experience.reducedMotion
		});
		carousel.onSelectionChange(handleSelectionChange);

		// Bare OrbitControls instance — createInspect() owns all of its tuning
		// (distance/polar clamps, damping) and its enabled/target lifecycle.
		controls = new orbitModule.OrbitControls(experience.camera, experience.renderer.domElement);
		inspect = inspectModule.createInspect({
			experience,
			carousel,
			machine: modeMachine,
			controls,
			sidebarWidthPx: () => inspectModule.SIDEBAR_WIDTH_PX,
			reducedMotion: experience.reducedMotion,
			announce: (msg: string) => {
				liveMessage = msg;
			}
		});

		experience.onFrame(handleFrame);
		experience.requestFrame();
	}

	// Rebuilds every rig from the current identity list and hands them to the
	// carousel, which owns their shelfStage membership + carousel-driven pose
	// from that point on (Task 7's fixed static placement is gone).
	async function rebuildRigs(): Promise<void> {
		if (!browser || destroyed || !experience || !carousel) return;
		const requestedIdKey = idKey;

		if (!bookRigModule) {
			bookRigModule = await import('./three/bookRig');
		}
		// The component/identity list may have moved on while the import above
		// was in flight — bail rather than build rigs for a stale book list.
		if (destroyed || !experience || !carousel || idKey !== requestedIdKey) return;

		for (const rig of rigs) rig.dispose();

		const currentIdentities = identities;
		rigs = currentIdentities.map((identity) => bookRigModule!.createBookRig(identity, textureQuality));
		carousel.setRigs(rigs);
		lastIdKey = requestedIdKey;

		// setRigs() doesn't itself fire onSelectionChange (it may not represent an
		// actual change) — seed the HUD/theme for whatever it landed on now.
		handleSelectionChange(carousel.selectedIndex);
		experience.requestFrame();
	}

	// Fires once `experience`/`carousel` exist (post-initScene) and again
	// whenever the book id-list actually changes — not on every re-render.
	$: if (browser && experience && carousel && idKey !== lastIdKey) {
		rebuildRigs().catch((error) => {
			console.error('Library3D: failed to build book rigs', error);
		});
	}

	function handleResize(): void {
		if (!experience) return;
		experience.resize();
		experience.requestFrame();
	}

	function handleDarkModeChange(): void {
		if (!browser || !experience) return;
		const newDarkMode = isDarkMode();
		if (newDarkMode === currentDarkMode) return;
		currentDarkMode = newDarkMode;
		const identity = identities[selectedIndex];
		if (identity && themeDriver) {
			themeDriver.setPalette(identity.palette, currentDarkMode);
		} else {
			applyScenePalette(PLACEHOLDER_PALETTE);
		}
		experience.requestFrame();
	}

	// ---- carousel inputs — all guarded on mode: opening/inspect/closing move
	// the machine out of 'shelf', and the shelf must stop responding to
	// navigation while it's retreated/occluded behind the inspect view. ----

	function navigate(delta: number): void {
		if (!carousel || modeMachine.mode !== 'shelf') return;
		carousel.navigate(delta);
		experience?.requestFrame();
	}

	function navigateTo(index: number): void {
		if (!carousel || modeMachine.mode !== 'shelf') return;
		carousel.navigateTo(index);
		experience?.requestFrame();
	}

	function nudge(wheelDelta: number): void {
		if (!carousel || modeMachine.mode !== 'shelf') return;
		carousel.nudge(wheelDelta);
		experience?.requestFrame();
	}

	function pointerToNdc(event: PointerEvent | MouseEvent): { x: number; y: number } {
		const rect = container.getBoundingClientRect();
		return {
			x: rect.width === 0 ? 0 : ((event.clientX - rect.left) / rect.width) * 2 - 1,
			y: rect.height === 0 ? 0 : -((event.clientY - rect.top) / rect.height) * 2 + 1
		};
	}

	function raycastBook(event: PointerEvent | MouseEvent): { book: Book; index: number } | null {
		if (!experience || !raycaster || !pointerVec || rigs.length === 0) return null;
		const ndc = pointerToNdc(event);
		pointerVec.set(ndc.x, ndc.y);
		// Inspect moves the camera every frame it's active (shelf browsing never
		// does) — force a fresh matrixWorld so a raycast firing between two
		// rendered frames (e.g. mid-transition or mid-orbit-drag) doesn't use a
		// stale camera transform.
		experience.camera.updateMatrixWorld();
		raycaster.setFromCamera(pointerVec, experience.camera);
		const hitMeshes = rigs.map((rig) => rig.hit).filter((mesh) => mesh.visible);
		const intersections = raycaster.intersectObjects(hitMeshes, false);
		if (intersections.length === 0) return null;
		const bookId = intersections[0].object.userData.bookId as number;
		const index = identities.findIndex((identity) => identity.id === bookId);
		if (index < 0) return null;
		const book = books[index];
		return book ? { book, index } : null;
	}

	function setHover(book: Book | null, ndc: { x: number; y: number }): void {
		carousel?.setHovered(book?.id ?? null, ndc);
		if (hoveredBook?.id !== book?.id) {
			hoveredBook = book;
			dispatch('bookHover', book);
		}
	}

	function handlePointerMove(event: PointerEvent): void {
		if (!carousel) return;
		const hit = raycastBook(event);
		setHover(hit?.book ?? null, pointerToNdc(event));
		experience?.requestFrame();
	}

	function handlePointerLeave(): void {
		if (!carousel) return;
		setHover(null, { x: 0, y: 0 });
		experience?.requestFrame();
	}

	function handleClick(event: MouseEvent): void {
		if (!carousel) return;
		if (modeMachine.mode === 'inspect') {
			// Click on the book itself: no-op (still inspecting). Click on empty
			// canvas: close.
			if (!raycastBook(event)) closeInspect();
			return;
		}
		if (modeMachine.mode !== 'shelf') return; // opening/closing: inert
		const hit = raycastBook(event);
		if (!hit) return;
		if (hit.index === carousel.selectedIndex) {
			openInspect();
			return;
		}
		navigateTo(hit.index);
	}

	function handleWheel(event: WheelEvent): void {
		if (!carousel || modeMachine.mode !== 'shelf') return;
		event.preventDefault();
		const dominant = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
		nudge(dominant);
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (!carousel) return;
		if (modeMachine.mode === 'inspect' && event.key === 'Escape') {
			event.preventDefault();
			closeInspect();
			return;
		}
		if (modeMachine.mode !== 'shelf') return;
		switch (event.key) {
			case 'ArrowLeft':
				event.preventDefault();
				navigate(-1);
				break;
			case 'ArrowRight':
				event.preventDefault();
				navigate(1);
				break;
			case 'Home':
				event.preventDefault();
				navigateTo(0);
				break;
			case 'End':
				event.preventDefault();
				navigateTo(Math.max(books.length - 1, 0));
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				openInspect();
				break;
			default:
				break;
		}
	}

	// ---- inspect open/close (Task 9) ----

	function openInspect(): void {
		if (!carousel || !inspect || modeMachine.mode !== 'shelf') return;
		const rig = rigs[carousel.selectedIndex];
		const book = books[carousel.selectedIndex];
		if (!rig || !book) return;
		const origin = (browser ? (document.activeElement as HTMLElement | null) : null) ?? container;
		inspect.open(rig, origin);
		syncMode();
		selectedBookId = book.id;
		dispatch('bookSelected', book);
		dispatch('selectedBookIdChange', book.id);
		experience?.requestFrame();
		// The browse HUD (and whatever control was just focused, e.g. this
		// button) goes `inert` once Svelte flushes the mode change, which
		// browser-natively blurs it back to <body> — deferred past that so
		// Escape (handled by this container's own on:keydown) and Tab-to-
		// "Reset view" work without depending on where focus happened to be
		// when open() was invoked.
		if (browser) setTimeout(() => container?.focus(), 0);
	}

	function closeInspect(): void {
		if (!inspect || modeMachine.mode !== 'inspect') return;
		inspect.close();
		syncMode();
		if (selectedBookId !== null) selectedBookId = null;
		dispatch('selectedBookIdChange', null);
		experience?.requestFrame();
	}

	// External close (e.g. the BookDetail sidebar's own close button, wired
	// via bind:selectedBookId) — only acts while genuinely inspecting so a
	// parent that simply hasn't set selectedBookId yet doesn't do anything.
	$: if (browser && modeMachine.mode === 'inspect' && selectedBookId === null) {
		closeInspect();
	}

	interface Disposable {
		dispose(): void;
	}
	function isDisposable(value: unknown): value is Disposable {
		return !!value && typeof (value as Disposable).dispose === 'function';
	}

	function disposeSceneResources(target: Experience): void {
		target.scene.traverse((obj) => {
			const anyObj = obj as unknown as { geometry?: unknown; material?: unknown | unknown[] };
			if (isDisposable(anyObj.geometry)) anyObj.geometry.dispose();
			const material = anyObj.material;
			if (Array.isArray(material)) {
				for (const m of material) if (isDisposable(m)) m.dispose();
			} else if (isDisposable(material)) {
				material.dispose();
			}
		});
	}

	onMount(() => {
		initScene().catch((error) => {
			console.error('Library3D: failed to initialize the 3D experience', error);
		});

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
			destroyed = true;
			if (announceTimer) clearTimeout(announceTimer);
			resizeObserver?.disconnect();
			darkModeObserver?.disconnect();

			// Rig textures (per-book CoverArtSet + emboss maps) aren't reachable via
			// the generic scene traversal below — dispose them explicitly first.
			for (const rig of rigs) rig.dispose();
			rigs = [];
			lastIdKey = null;

			if (experience) {
				disposeSceneResources(experience);
				experience.dispose();
			}
			controls?.dispose();
			experience = null;
			room = null;
			lights = null;
			carousel = null;
			themeDriver = null;
			inspect = null;
			controls = null;
			raycaster = null;
			pointerVec = null;
		};
	});
</script>

<div class="library-wrapper">
	<div
		bind:this={container}
		class="library-container"
		class:hovering={!!hoveredBook}
		role="application"
		aria-label="Up Next 3D shelf"
		tabindex="0"
		on:wheel={handleWheel}
		on:pointermove={handlePointerMove}
		on:pointerleave={handlePointerLeave}
		on:click={handleClick}
		on:keydown={handleKeydown}
	></div>

	{#if identities.length > 0}
		<div class="hud-overlay" class:hud-faded={mode !== 'shelf'} inert={mode !== 'shelf'}>
			<div class="hud-panel">
				<div class="text-center max-w-full">
					<h2
						class="text-[20px] font-semibold tracking-tight leading-snug truncate max-w-full"
						style={`font-family: ${HUD_SERIF_STACK}; color: var(--gw-fg)`}
					>
						{selectedBook?.title ?? ''}
					</h2>
					{#if selectedBook?.author}
						<p class="text-[13px] text-muted truncate">{selectedBook.author}</p>
					{/if}
					<p class="mt-1 flex items-center justify-center gap-2 text-[11.5px] text-secondary">
						<span>{selectedIndex + 1} of {books.length}</span>
						{#if selectedBook?.rating}
							<span class="inline-flex items-center gap-1">
								<Star class="w-3 h-3 text-amber-400 fill-amber-400" />
								{selectedBook.rating}
							</span>
						{/if}
					</p>
				</div>

				<div class="hud-controls">
					<button
						type="button"
						class="hud-round-btn"
						aria-label="Previous book"
						disabled={books.length < 2}
						on:click={() => navigate(-1)}
					>
						<ChevronLeft class="w-4 h-4" />
					</button>
					<button
						type="button"
						class="hud-inspect-btn"
						disabled={mode !== 'shelf'}
						aria-label="Inspect selected book"
						on:click={openInspect}
					>
						Inspect
					</button>
					<button
						type="button"
						class="hud-round-btn"
						aria-label="Next book"
						disabled={books.length < 2}
						on:click={() => navigate(1)}
					>
						<ChevronRight class="w-4 h-4" />
					</button>
				</div>

				<div class="hud-markers" role="tablist" aria-label="Book selector">
					{#each books as book, i (book.id)}
						<button
							type="button"
							role="tab"
							class="hud-marker"
							class:selected={i === selectedIndex}
							aria-selected={i === selectedIndex}
							aria-label={`Select book ${i + 1}: ${book.title}`}
							on:click={() => navigateTo(i)}
						></button>
					{/each}
				</div>
			</div>
		</div>
	{/if}

	{#if mode === 'inspect'}
		<div class="inspect-hud">
			<button type="button" class="inspect-reset-btn" on:click={() => inspect?.resetView()}>
				Reset view
			</button>
		</div>
	{/if}

	<div class="sr-only" aria-live="polite">{liveMessage}</div>
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

	.library-container.hovering {
		cursor: pointer;
	}

	.library-container:focus-visible {
		outline: 2px solid var(--gw-accent);
		outline-offset: -2px;
	}

	.hud-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		padding-bottom: 28px;
		pointer-events: none;
		opacity: 1;
		transition: opacity 0.3s ease;
	}

	/* Browse HUD fades (and is made `inert`) during opening/inspect/closing —
	   the shelf it controls is retreated/occluded in those modes. */
	.hud-overlay.hud-faded {
		opacity: 0;
	}

	.inspect-hud {
		position: absolute;
		left: 24px;
		bottom: 28px;
		pointer-events: none;
	}

	.inspect-reset-btn {
		pointer-events: auto;
		padding: 0.4rem 1rem;
		font-size: 12.5px;
		font-weight: 500;
		letter-spacing: -0.005em;
		border-radius: 999px;
		background: var(--gw-surface);
		backdrop-filter: blur(var(--gw-blur)) saturate(180%);
		-webkit-backdrop-filter: blur(var(--gw-blur)) saturate(180%);
		color: var(--gw-fg);
		border: 0.5px solid var(--gw-border);
		box-shadow: var(--gw-shadow-lg);
		transition: background 0.15s ease, transform 0.1s ease;
	}

	.inspect-reset-btn:hover {
		background: var(--gw-surface-elevated);
	}

	.inspect-reset-btn:active {
		transform: scale(0.96);
	}

	.inspect-reset-btn:focus-visible {
		outline: 2px solid var(--gw-accent);
		outline-offset: 2px;
	}

	.hud-panel {
		pointer-events: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 16px 22px;
		max-width: min(560px, 92vw);
		background: var(--gw-surface);
		backdrop-filter: blur(var(--gw-blur)) saturate(180%);
		-webkit-backdrop-filter: blur(var(--gw-blur)) saturate(180%);
		border: 0.5px solid var(--gw-border);
		border-radius: 18px;
		box-shadow: var(--gw-shadow-lg);
	}

	.hud-controls {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.hud-round-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		flex: 0 0 auto;
		border-radius: 999px;
		background: var(--gw-surface-tint);
		border: 1px solid var(--gw-border);
		color: var(--gw-fg);
		transition: background 0.15s ease, transform 0.1s ease;
	}

	.hud-round-btn:hover:not(:disabled) {
		background: var(--gw-surface-elevated);
	}

	.hud-round-btn:active:not(:disabled) {
		transform: scale(0.94);
	}

	.hud-round-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.hud-round-btn:focus-visible {
		outline: 2px solid var(--gw-accent);
		outline-offset: 2px;
	}

	.hud-inspect-btn {
		padding: 0.4rem 1rem;
		font-size: 12.5px;
		font-weight: 500;
		letter-spacing: -0.005em;
		border-radius: 999px;
		background: var(--gw-surface-tint);
		color: var(--gw-fg);
		border: 1px solid var(--gw-border);
		cursor: pointer;
		transition: background 0.15s ease, transform 0.1s ease;
	}

	.hud-inspect-btn:hover:not(:disabled) {
		background: var(--gw-surface-elevated);
	}

	.hud-inspect-btn:active:not(:disabled) {
		transform: scale(0.96);
	}

	.hud-inspect-btn:disabled {
		color: var(--gw-fg-muted);
		cursor: not-allowed;
	}

	.hud-inspect-btn:focus-visible {
		outline: 2px solid var(--gw-accent);
		outline-offset: 2px;
	}

	.hud-markers {
		display: flex;
		align-items: center;
		gap: 6px;
		max-width: min(320px, 80vw);
		overflow-x: auto;
		padding: 2px 2px 4px;
		scrollbar-width: thin;
	}

	.hud-marker {
		flex: 0 0 auto;
		width: 6px;
		height: 6px;
		border-radius: 999px;
		background: var(--gw-fg-muted);
		opacity: 0.45;
		transition: opacity 0.15s ease, transform 0.15s ease, background 0.15s ease;
	}

	.hud-marker:hover {
		opacity: 0.75;
	}

	.hud-marker.selected {
		background: var(--gw-accent);
		opacity: 1;
		transform: scale(1.35);
	}

	.hud-marker:focus-visible {
		outline: 2px solid var(--gw-accent);
		outline-offset: 2px;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
