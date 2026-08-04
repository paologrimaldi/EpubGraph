<script lang="ts">
	import { onMount, createEventDispatcher } from 'svelte';
	import { browser } from '$app/environment';
	import type { Book } from '$lib/api/commands';
	import type { Experience } from './three/experience';
	import type { Room } from './three/room';
	import type { LightRig } from './three/lights';
	import type { ScenePalette } from './types/experience';

	// Dark editorial-room placeholder theme — real book-driven theming
	// (blendPaletteWithMode + paletteFromSeed) arrives once the carousel task
	// wires an actual selection. The reference design is a dark intimate room
	// (near-black backdrop, dark floor, warm light pooling), not a light
	// warm-paper wash, so this approximates the reference's default stage
	// minus books.
	const PLACEHOLDER_PALETTE: ScenePalette = {
		backdrop: '#232630',
		fog: '#232630',
		floor: '#2a2620',
		key: '#f4d7b9',
		fill: '#9fb3c9',
		accent: '#c87046',
		shelf: '#3a2118'
	};

	// Props (Svelte 4 syntax). books/selectedBookId feed the carousel + theming
	// wired up in later tasks; textureQuality gates texture generation quality
	// once artwork textures exist (Task 6+) — none are consumed by this task's
	// empty-studio scene yet, so they're surfaced as data-* attributes below
	// (debug/e2e hooks) to keep them live props rather than dead exports.
	export let books: Book[] = [];
	export let textureQuality: 'low' | 'medium' | 'high' = 'medium';
	export let selectedBookId: number | null = null;

	const dispatch = createEventDispatcher<{
		bookSelected: Book;
		bookHover: Book | null;
		selectedBookIdChange: number | null;
	}>();

	const DUST_SETTLE_SECONDS = 2.5;

	let container: HTMLDivElement;
	let experience: Experience | null = null;
	let room: Room | null = null;
	let lights: LightRig | null = null;
	let resizeObserver: ResizeObserver | null = null;
	let darkModeObserver: MutationObserver | null = null;
	let currentDarkMode = false;
	let dustSettleStart: number | null = null;
	// Guards the dynamic-import window in initScene(): the component can be
	// destroyed (e.g. a store flip swapping this component out) before the
	// five imports resolve — without this flag, initScene() would still go on
	// to build a renderer/canvas/matchMedia listener/rAF loop with no
	// disposal handle, orphaning a WebGL context.
	let destroyed = false;

	// Detect current dark mode state
	function isDarkMode(): boolean {
		if (!browser) return false;
		return document.documentElement.classList.contains('dark');
	}

	// Single funnel for theming the room + lighting rig — Task 8 replaces the body
	// with an eased update, callers here stay the same.
	function applyScenePalette(palette: ScenePalette): void {
		if (!experience || !room || !lights) return;
		room.themeTargets.backdrop.color.set(palette.backdrop);
		room.themeTargets.floor.color.set(palette.floor);
		experience.scene.fog?.color.set(palette.fog);
		lights.key.color.set(palette.key);
		lights.fill.color.set(palette.fill);
	}

	// On-demand frame callback: settles the dust drift for a bounded window after
	// (re)init, then stops requesting frames — an idle studio renders 0 fps.
	function handleFrame(dt: number, elapsed: number): boolean {
		if (dustSettleStart === null) dustSettleStart = elapsed;
		if (room?.dust) {
			room.dust.rotation.y += dt * 0.015;
			room.dust.position.y = Math.sin(elapsed * 0.15) * 0.02;
		}
		return elapsed - dustSettleStart < DUST_SETTLE_SECONDS;
	}

	async function initScene(): Promise<void> {
		if (!browser || !container) return;

		// Dynamic imports for Three.js (client-only)
		const [experienceModule, roomModule, lightsModule] = await Promise.all([
			import('./three/experience'),
			import('./three/room'),
			import('./three/lights')
		]);

		// The component may have been torn down while the imports above were
		// in flight — bail before creating anything so no renderer/canvas/
		// listener/rAF loop is ever orphaned without a disposal handle.
		if (destroyed) return;

		currentDarkMode = isDarkMode();

		experience = experienceModule.createExperience(container);
		room = roomModule.addRoom(experience.scene, experience.shelfStage, experience.reducedMotion());
		lights = lightsModule.addLights(experience.scene);

		applyScenePalette(PLACEHOLDER_PALETTE);

		experience.onFrame(handleFrame);
		experience.requestFrame();
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
		// The placeholder palette is a fixed warm neutral (not mode-dependent) until
		// real book theming lands, so this re-applies the same values — kept wired
		// so the observer/requestFrame plumbing is already correct for that task.
		applyScenePalette(PLACEHOLDER_PALETTE);
		experience.requestFrame();
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
			resizeObserver?.disconnect();
			darkModeObserver?.disconnect();

			if (experience) {
				disposeSceneResources(experience);
				experience.dispose();
			}
			experience = null;
			room = null;
			lights = null;
		};
	});
</script>

<div class="library-wrapper">
	<div
		bind:this={container}
		class="library-container"
		role="application"
		aria-label="Up Next 3D shelf"
		data-book-count={books.length}
		data-selected-book-id={selectedBookId ?? ''}
		data-texture-quality={textureQuality}
	></div>
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
</style>
