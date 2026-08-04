<script lang="ts">
	import { onMount, createEventDispatcher, tick } from 'svelte';
	import { browser } from '$app/environment';
	import { ChevronLeft, ChevronRight, Star } from 'lucide-svelte';
	import type { Book } from '$lib/api/commands';
	import { getCoverImage } from '$lib/api/commands';
	import type { Experience } from './three/experience';
	import type { Room } from './three/room';
	import type { LightRig } from './three/lights';
	import type { RigHandle } from './three/bookRig';
	import type { Carousel } from './three/carousel';
	import type { InspectController } from './three/inspect';
	import type { CoverPipeline } from './three/coverPipeline';
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
	let coverPipeline: CoverPipeline | null = null;
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

	// WebGL fallback (§4.5, §7): flips true when `createExperience` throws
	// (no WebGL) or the canvas fires `webglcontextlost` mid-session. While
	// true, the markup below swaps the canvas host + HUD for a plain HTML
	// list of the queue; "Retry 3D" flips it back and re-runs initScene().
	let webglFailed = false;
	// bookId -> data URL, populated by loadFallbackCovers() while the
	// fallback list is showing. A plain `let` Map, reassigned to itself after
	// each mutation to ping Svelte 4's dirty-check (see loadFallbackCovers).
	let fallbackCovers = new Map<number, string>();

	let selectedIndex = 0;
	let hoveredBook: Book | null = null;
	// Mirrors InspectController.readingOpen for the "Open book" HUD toggle's
	// aria-pressed (see syncReadingOpen) — same pattern as the `mode` mirror.
	let readingOpen = false;
	let liveMessage = '';
	let announceTimer: ReturnType<typeof setTimeout> | null = null;

	// Task 9 review Finding 1: a DOM `click` fires after any mousedown/mouseup
	// pair regardless of how far the pointer traveled between them, and
	// OrbitControls (active during inspect) suppresses nothing — so releasing
	// an orbit drag over empty canvas used to both rotate the camera *and*
	// close inspect. Recording pointerdown position and checking travel in
	// handleClick lets orbit-dragging and click-empty-to-close coexist.
	let pointerDownClient: { x: number; y: number } | null = null;
	const CLICK_DRAG_THRESHOLD_PX = 6;

	// Task 9 review Finding 3: the sidebar's own Close button nulls
	// `selectedBookId` externally. If that happens while a book is still
	// mid-'opening' (not yet 'inspect'), the reactive guard below used to
	// no-op (it only checked `mode === 'inspect'`), hiding the sidebar while
	// leaving the book fully inspected once opening finished — a desync
	// between the sidebar and the mode machine. Latching this flag and
	// draining it the moment `mode` reaches 'inspect' (see handleFrame)
	// closes immediately instead.
	let pendingClose = false;

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
		syncReadingOpen();
		// Drain a close that arrived while still 'opening' (Finding 3) the
		// instant 'inspect' is reached — at most one frame after
		// inspect.update() above drove finishOpening(), never waiting on a
		// further external event.
		if (pendingClose && mode === 'inspect') {
			pendingClose = false;
			closeInspect();
			syncMode(); // reflect the closeInspect()-driven 'closing' transition now, not next frame
		}
		return dustSettling || carouselMoving || themeMoving || inspectMoving;
	}

	// Keeps the template-facing `mode` mirror in sync with modeMachine.mode —
	// cheap no-op check on frames where nothing transitioned.
	function syncMode(): void {
		if (mode !== modeMachine.mode) mode = modeMachine.mode;
	}

	// Task 12: mirrors InspectController.readingOpen for the "Open book" HUD
	// toggle's aria-pressed — same rationale as syncMode() (the controller's
	// own state lives in a closure Svelte's compiler can't observe).
	function syncReadingOpen(): void {
		const value = inspect?.readingOpen ?? false;
		if (readingOpen !== value) readingOpen = value;
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
	// Doubles as the cover pipeline's "selection changed" hook (Task 10, §5.3):
	// re-calling hydrate() here re-scores the eager/queue window against
	// wherever the shelf just landed, so a book that scrolls into the ±30
	// window (or the ±4 eager window) gets picked up without waiting on the
	// next rig rebuild — this is also what satisfies the brief's "after rig
	// build, pipeline.hydrate" wiring, since rebuildRigs() calls this same
	// function once at the end with the freshly-built `rigs`.
	function handleSelectionChange(index: number): void {
		selectedIndex = index;
		const identity = identities[index];
		if (identity) themeDriver?.setPalette(identity.palette, isDarkMode());
		announceSelection(index);
		coverPipeline?.hydrate(rigs, () => carousel?.selectedIndex ?? 0);
		experience?.requestFrame();
	}

	async function initScene(): Promise<void> {
		if (!browser || !container) return;

		try {
			// Dynamic imports for Three.js (client-only). `three` itself is included
			// here (rather than statically imported) purely to construct the
			// Raycaster/Vector2 used by pointer hit-testing below — carousel.ts and
			// theme.ts need no runtime three.js import of their own.
			const [three, experienceModule, roomModule, lightsModule, orbitModule, inspectModule, coverPipelineModule] =
				await Promise.all([
					import('three'),
					import('./three/experience'),
					import('./three/room'),
					import('./three/lights'),
					import('three/examples/jsm/controls/OrbitControls.js'),
					import('./three/inspect'),
					import('./three/coverPipeline')
				]);

			// The component may have been torn down while the imports above were
			// in flight — bail before creating anything so no renderer/canvas/
			// listener/rAF loop is ever orphaned without a disposal handle.
			if (destroyed) return;

			currentDarkMode = isDarkMode();
			raycaster = new three.Raycaster();
			pointerVec = new three.Vector2();

			// createExperience is where WebGL context creation actually happens
			// (`new THREE.WebGLRenderer(...)` throws synchronously if the browser
			// can't hand back a context) — everything below this line assumes a
			// live renderer exists, so a throw here (or anywhere below) is caught
			// by the try/catch wrapping this whole function and routed to the
			// same HTML-fallback path as a later `webglcontextlost` (§4.5, §7).
			experience = experienceModule.createExperience(container);
			experience.onContextLost(handleContextLost);
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

			coverPipeline = coverPipelineModule.createCoverPipeline(textureQuality);
			coverPipeline.onPalette((bookId, palette) => {
				// Re-theme live only when the extracted palette belongs to whatever
				// book is currently centered (§5.2) — a background hydration
				// finishing for an off-screen neighbor must not steal the scene's
				// theme out from under the book the user is actually looking at.
				if (rigs[selectedIndex]?.identity.id === bookId) {
					themeDriver?.setPalette(palette, isDarkMode());
					experience?.requestFrame();
				}
			});

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
		} catch (error) {
			if (destroyed) return;
			console.error('Library3D: WebGL unavailable — falling back to HTML list', error);
			teardownExperience();
			webglFailed = true;
		}
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

		const currentIdentities = identities;
		const previousSelectedId = rigs[carousel.selectedIndex]?.identity.id ?? null;

		// Diff by id (Task 10, §6) instead of disposing/rebuilding every rig on
		// any queue edit — a survivor keeps its RigHandle instance untouched,
		// which means it also keeps whatever real-cover texture the cover
		// pipeline already hydrated onto it (a full rebuild would silently
		// flash every book back to its procedural look for a frame while the
		// pipeline redundantly re-applied from cache). Only ids genuinely new
		// to this book list get a fresh rig; only ids genuinely gone get
		// disposed.
		const existingById = new Map(rigs.map((rig) => [rig.identity.id, rig]));
		const newRigs = currentIdentities.map((identity) => {
			const survivor = existingById.get(identity.id);
			if (survivor) {
				existingById.delete(identity.id);
				return survivor;
			}
			return bookRigModule!.createBookRig(identity, textureQuality);
		});

		// Task 9 review Finding 4: `books` replacing mid-inspect (e.g. the queue
		// mutating while a book is being inspected) must not leave a disposed
		// rig scene-parented and the mode machine stuck outside 'shelf'. Sever
		// InspectController's ownership of its rig instantly — BEFORE any
		// dispose() call below — so the diff/dispose/setRigs flow that follows
		// treats it like any other rig (see inspect.ts's forceReset() doc).
		if (inspect && modeMachine.mode !== 'shelf') {
			inspect.forceReset();
			syncMode();
		}

		for (const removed of existingById.values()) removed.dispose();

		rigs = newRigs;
		carousel.setRigs(rigs);
		lastIdKey = requestedIdKey;

		// Anchor back onto whichever book was selected before the diff, if it
		// survived. setRigs() alone re-derives selectedIndex purely from the
		// carousel's raw numeric `position`, which — once an id shifts ahead of
		// the selection (e.g. a book removed earlier in the list) — can now
		// land on a *different* book occupying the same slot index.
		const anchorIndex =
			previousSelectedId !== null ? rigs.findIndex((rig) => rig.identity.id === previousSelectedId) : -1;
		if (anchorIndex >= 0 && anchorIndex !== carousel.selectedIndex) {
			carousel.navigateTo(anchorIndex);
		}

		// setRigs() doesn't itself fire onSelectionChange (it may not represent
		// an actual change) — seed the HUD/theme/cover-hydration for whatever it
		// landed on now (the survivor's anchor if it survived, else setRigs's
		// own "nearest index" fallback). This is also the "after rig build,
		// pipeline.hydrate" call (see handleSelectionChange's doc comment).
		handleSelectionChange(anchorIndex >= 0 ? anchorIndex : carousel.selectedIndex);
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

	// Mode-branched, not a plain `!== 'shelf'` guard like every other input
	// (click/keydown/wheel): hover has a legitimate job in *both* shelf mode
	// (drives Carousel.setHovered — the lift/tilt/crack-on-hover shelf feel)
	// and inspect mode (drives InspectController.setHovered — cover
	// hover-crack on the single inspected book, per the Task 9 brief's step 5
	// manual-verification criteria). It's inert only during opening/closing,
	// same as click/keydown are during those transitional modes.
	function setHover(book: Book | null, ndc: { x: number; y: number }): void {
		if (modeMachine.mode === 'shelf') {
			carousel?.setHovered(book?.id ?? null, ndc);
		} else if (modeMachine.mode === 'inspect') {
			const activeId = inspect?.activeRig?.identity.id ?? null;
			inspect?.setHovered(!!book && book.id === activeId);
		}
		if (hoveredBook?.id !== book?.id) {
			hoveredBook = book;
			dispatch('bookHover', book);
		}
	}

	function handlePointerMove(event: PointerEvent): void {
		if (!carousel) return;
		// Forwarded unconditionally in inspect mode — a no-op inside
		// InspectController unless this pointerId is the one
		// handlePointerDown's cover raycast already claimed (Task 12, §4.4).
		if (modeMachine.mode === 'inspect') inspect?.handleCoverPointerMove(event);
		if (modeMachine.mode !== 'shelf' && modeMachine.mode !== 'inspect') return;
		const hit = raycastBook(event);
		setHover(hit?.book ?? null, pointerToNdc(event));
		experience?.requestFrame();
	}

	function handlePointerLeave(): void {
		if (!carousel) return;
		if (modeMachine.mode !== 'shelf' && modeMachine.mode !== 'inspect') return;
		setHover(null, { x: 0, y: 0 });
		experience?.requestFrame();
	}

	// Records where a click gesture started (Task 9 review Finding 1) so
	// handleClick can tell a genuine click apart from the mouseup that ends an
	// OrbitControls drag — a DOM `click` fires after any mousedown/mouseup
	// pair regardless of travel distance, and OrbitControls doesn't suppress
	// it, so without this an orbit-drag release over empty canvas would both
	// rotate the camera *and* close inspect.
	function handlePointerDown(event: PointerEvent): void {
		pointerDownClient = { x: event.clientX, y: event.clientY };
		// Task 12 (§4.4): let InspectController's own raycast decide whether
		// this pointerdown lands on the front cover and claim the drag if so
		// (it owns controls.enabled/pointer-capture for the duration itself).
		// Cover click/drag and the whole-canvas click-to-close above coexist
		// the same way orbit-drag and click-to-close already do (Finding 1):
		// a cover drag traveling past the threshold makes
		// clickTraveledPastThreshold() true, so the subsequent native `click`
		// no-ops instead of also closing inspect.
		if (modeMachine.mode === 'inspect') inspect?.handleCoverPointerDown(event);
	}

	// Resolves whatever handleCoverPointerDown claimed (Task 12) — commit/
	// spring-back or click-toggle, all decided inside InspectController. A
	// no-op if no cover drag is in flight for this pointerId.
	function handlePointerUp(event: PointerEvent): void {
		if (modeMachine.mode !== 'inspect') return;
		inspect?.handleCoverPointerUp(event);
		experience?.requestFrame();
	}

	// Code-review fix (Task 12 findings, Important 1): `pointercancel` (OS
	// gesture cancel, palm rejection, touch takeover) and `lostpointercapture`
	// (capture lost/revoked mid-drag) both need the same recovery as a
	// released cover drag — without routing these, an interrupted drag left
	// InspectController's coverDrag/coverPointerId permanently set, which
	// left OrbitControls permanently disabled for the rest of the inspect
	// session (nothing else ever clears that state). Forwarded the same way
	// handlePointerUp forwards to handleCoverPointerUp; a no-op inside
	// InspectController unless this pointerId is the one a drag claimed.
	function handlePointerCancel(event: PointerEvent): void {
		if (modeMachine.mode !== 'inspect') return;
		inspect?.handleCoverPointerCancel(event);
		experience?.requestFrame();
	}

	function clickTraveledPastThreshold(event: MouseEvent): boolean {
		if (!pointerDownClient) return false;
		const dx = event.clientX - pointerDownClient.x;
		const dy = event.clientY - pointerDownClient.y;
		return Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX;
	}

	function handleClick(event: MouseEvent): void {
		if (!carousel) return;
		const dragged = clickTraveledPastThreshold(event);
		pointerDownClient = null;
		if (modeMachine.mode === 'inspect') {
			// Click on the book itself: no-op (still inspecting). Click on empty
			// canvas: close — but only for a genuine click, not an orbit-drag
			// release (see handlePointerDown's doc above); orbit and
			// click-empty-to-close must coexist.
			if (dragged) return;
			if (!raycastBook(event)) closeInspect();
			return;
		}
		if (modeMachine.mode !== 'shelf') return; // opening/closing: inert
		if (dragged) return;
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
		pendingClose = false; // fresh open — don't inherit a stale latch from a prior cycle
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
	// Task 9 review Finding 3: a close arriving mid-'opening' (the sidebar's
	// button clicked before the 0.9s open transition finishes) used to no-op
	// here — this reactive block only re-runs when `selectedBookId` itself
	// changes, and at that instant `modeMachine.mode` was still 'opening', not
	// 'inspect', so the check silently missed it. That hid the sidebar while
	// leaving the book fully inspected once opening finished: a lasting
	// desync between the sidebar and the mode machine. Latching a pendingClose
	// flag here and draining it the moment `mode` reaches 'inspect' (see
	// handleFrame) closes immediately instead of leaving it stuck open.
	$: if (browser && selectedBookId === null) {
		if (modeMachine.mode === 'inspect') {
			closeInspect();
		} else if (modeMachine.mode === 'opening') {
			pendingClose = true;
		}
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

	// Tears down every three.js-owned resource (rigs, cover pipeline,
	// room/lights/carousel/inspect/controls, the renderer + its scene graph)
	// and resets every local handle back to its pre-init state. Shared by the
	// real route-unmount path (onMount's returned cleanup) and the WebGL-loss
	// / init-failure fallback path (handleContextLost/initScene's catch) —
	// the latter needs the exact same disposal but must NOT set `destroyed`,
	// since "Retry 3D" re-runs initScene() afterward.
	function teardownExperience(): void {
		// Unwind the mode machine through inspect.ts's own forceReset() — the
		// single implementation of the shelf⇄inspect ring-walk (no more
		// hand-duplicated copy here). Per forceReset()'s documented contract
		// this must run BEFORE `inspect` is nulled below and BEFORE the rig
		// disposal loop that follows. `modeMachine` (and `pendingClose`) are
		// component-lifetime state that outlives a single `experience` — a
		// WebGL-loss/init-failure fallback tears down and later rebuilds the
		// *experience*, but without this the next successful initScene()
		// would hand a fresh InspectController to a machine still stuck on
		// whatever non-'shelf' mode it was in when the failure hit, which
		// `InspectController.open()`'s `machine.can('opening')` guard would
		// then refuse forever.
		if (inspect && modeMachine.mode !== 'shelf') {
			inspect.forceReset();
		}
		pendingClose = false;
		syncMode();

		// Stop the pipeline (cancels pending idle work) and free every
		// pipeline-owned real-cover texture before the rigs that reference
		// them go away — see coverPipeline.ts's module doc for why rig
		// disposal below never double-frees these.
		coverPipeline?.dispose();
		coverPipeline = null;

		// Rig textures (per-book CoverArtSet + emboss maps) aren't reachable via
		// the generic scene traversal below — dispose them explicitly first.
		for (const rig of rigs) rig.dispose();
		rigs = [];
		lastIdKey = null;

		if (experience) {
			disposeSceneResources(experience);
			// Dev-only: watch this in the real Tauri app across a mount →
			// navigate-away → remount cycle (§8 item 8) — geometries/textures
			// should return to whatever baseline they were at before this
			// route's first mount, confirming nothing here leaks.
			if (import.meta.env.DEV) {
				console.debug('Library3D: renderer.info.memory before dispose', experience.renderer.info.memory);
			}
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

		dustSettleStart = null;
		hoveredBook = null;

		// Context-loss/fallback teardown must not leave the BookDetail
		// sidebar dangling over the HTML fallback list — the caller derives
		// sidebar visibility from `selectedBookId` (bind:selectedBookId), so
		// without this a context loss caught mid-inspect would leave the
		// sidebar open above the fallback list. Mirrors closeInspect()'s own
		// clear + dispatch, and is safe to run unconditionally here since
		// this path also covers the plain route-unmount teardown.
		if (selectedBookId !== null) selectedBookId = null;
		dispatch('selectedBookIdChange', null);
	}

	// Loads cover thumbnails for the HTML fallback list, one settle per book,
	// never throwing — a rejected/absent cover just leaves that row without
	// an <img> (§7: never let a cover failure break anything). Re-entrant:
	// already-cached ids are skipped, so this is safe to re-run whenever
	// `books` changes while the fallback is showing (see the reactive call
	// below) without re-fetching covers it already has.
	async function loadFallbackCovers(currentBooks: Book[]): Promise<void> {
		await Promise.all(
			currentBooks.map(async (book) => {
				if (fallbackCovers.has(book.id)) return;
				let src: string | null;
				try {
					src = await getCoverImage(book.id);
				} catch (err) {
					console.debug(`Library3D fallback: getCoverImage(${book.id}) rejected`, err);
					return;
				}
				// Superseded by a retry or unmount while the request was in flight.
				if (destroyed || !webglFailed || !src) return;
				fallbackCovers.set(book.id, src);
				fallbackCovers = fallbackCovers; // Svelte 4 Map-mutation dirty-check ping
			})
		);
	}

	// Re-fetches whenever the fallback is showing and `books` changes
	// (already-cached ids are cheap no-ops, see loadFallbackCovers above).
	$: if (webglFailed) {
		loadFallbackCovers(books);
	}

	// `webglcontextlost` (§4.5/§7): the renderer is unusable the instant this
	// fires. Dispose everything and drop into the HTML fallback — there's no
	// attempt at in-place context restoration.
	function handleContextLost(): void {
		if (destroyed || webglFailed) return;
		console.warn('Library3D: WebGL context lost — falling back to HTML list');
		teardownExperience();
		webglFailed = true;
	}

	// "Retry 3D" — flips back to the canvas markup, waits for Svelte to put
	// `container` back in the DOM (bind:this only resolves after that patch),
	// then re-runs the normal init path.
	async function retryInit(): Promise<void> {
		if (destroyed) return;
		webglFailed = false;
		await tick();
		if (destroyed) return;
		// `container` lives inside `{#if !webglFailed}` — the `tick()` above
		// just flushed a FRESH DOM node into `container` (Svelte tore down
		// the old one when the fallback showed). The ResizeObserver created
		// in onMount is still observing that now-detached old node, so
		// without re-observing here, resize handling would be silently dead
		// for the rest of the session after any fallback → retry cycle
		// (stretched canvas on the next window resize). `disconnect()` first
		// clears the observer's whole target set (not just one node), so
		// this stays exactly-one-observation even across repeated retries.
		if (resizeObserver && container) {
			resizeObserver.disconnect();
			resizeObserver.observe(container);
		}
		initScene().catch((error) => {
			console.error('Library3D: retry failed to initialize the 3D experience', error);
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
			teardownExperience();
		};
	});
</script>

<div class="library-wrapper">
	{#if !webglFailed}
		<div
			bind:this={container}
			class="library-container"
			class:hovering={!!hoveredBook}
			role="application"
			aria-label="Up Next 3D shelf"
			tabindex="0"
			on:wheel={handleWheel}
			on:pointerdown={handlePointerDown}
			on:pointermove={handlePointerMove}
			on:pointerup={handlePointerUp}
			on:pointercancel={handlePointerCancel}
			on:lostpointercapture={handlePointerCancel}
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
				<button
					type="button"
					class="inspect-reset-btn"
					aria-pressed={readingOpen}
					on:click={() => inspect?.setReadingOpen(!readingOpen)}
				>
					Open book
				</button>
			</div>
		{/if}
	{:else}
		<!-- WebGL fallback (§4.5, §7): shown when createExperience() threw (no
		     WebGL) or the canvas fired webglcontextlost. Plain HTML list of the
		     queue — no three.js involved — plus a retry. -->
		<div class="webgl-fallback">
			<div class="webgl-fallback-panel">
				<p class="webgl-fallback-message">
					3D view isn't available right now — here's your reading queue as a list.
				</p>
				{#if books.length > 0}
					<ul class="webgl-fallback-list">
						{#each books as book (book.id)}
							<li class="webgl-fallback-item">
								{#if fallbackCovers.get(book.id)}
									<img class="webgl-fallback-cover" src={fallbackCovers.get(book.id)} alt={book.title} />
								{:else}
									<div class="webgl-fallback-cover webgl-fallback-cover-placeholder" aria-hidden="true"></div>
								{/if}
								<div class="webgl-fallback-meta">
									<p class="webgl-fallback-title">{book.title}</p>
									{#if book.author}
										<p class="webgl-fallback-author">{book.author}</p>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
				{/if}
				<button type="button" class="btn-primary webgl-fallback-retry" on:click={retryInit}>
					Retry 3D
				</button>
			</div>
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
		display: flex;
		align-items: center;
		gap: 8px;
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

	.inspect-reset-btn[aria-pressed='true'] {
		background: var(--gw-accent);
		color: var(--gw-bg);
		border-color: var(--gw-accent);
	}

	.inspect-reset-btn:hover {
		background: var(--gw-surface-elevated);
	}

	.inspect-reset-btn[aria-pressed='true']:hover {
		background: var(--gw-accent);
		opacity: 0.9;
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

	.webgl-fallback {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow-y: auto;
		padding: 24px;
		background: var(--gw-bg);
	}

	.webgl-fallback-panel {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		width: 100%;
		max-width: 420px;
	}

	.webgl-fallback-message {
		font-size: 13px;
		color: var(--gw-fg-muted);
		text-align: center;
	}

	.webgl-fallback-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 100%;
		max-height: 55vh;
		overflow-y: auto;
		border: 0.5px solid var(--gw-border);
		border-radius: 12px;
		background: var(--gw-surface);
	}

	.webgl-fallback-item {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 12px;
		border-bottom: 0.5px solid var(--gw-border);
	}

	.webgl-fallback-item:last-child {
		border-bottom: none;
	}

	.webgl-fallback-cover {
		flex: 0 0 auto;
		width: 32px;
		height: 46px;
		border-radius: 3px;
		object-fit: cover;
		background: var(--gw-surface-tint);
	}

	.webgl-fallback-cover-placeholder {
		border: 1px solid var(--gw-border);
	}

	.webgl-fallback-meta {
		min-width: 0;
	}

	.webgl-fallback-title {
		font-size: 13px;
		font-weight: 500;
		color: var(--gw-fg);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.webgl-fallback-author {
		font-size: 11.5px;
		color: var(--gw-fg-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.webgl-fallback-retry {
		flex: 0 0 auto;
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
