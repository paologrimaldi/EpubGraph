import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type FrameCallback = (dt: number, elapsed: number) => boolean;
export type ReducedMotionCallback = (reduced: boolean) => void;

export interface Experience {
	scene: THREE.Scene;
	camera: THREE.PerspectiveCamera;
	renderer: THREE.WebGLRenderer;
	shelfStage: THREE.Group; // carousel parent; retreats during inspect
	requestFrame(): void; // schedules exactly one rAF if none pending
	onFrame(cb: FrameCallback): void;
	// cb returns true → another frame is needed (on-demand loop, §4.5)
	setViewOffsetX(px: number): void; // camera.setViewOffset horizontal shift
	resize(): void;
	dispose(): void;
	/** prefers-reduced-motion, read at init and kept live for later tasks. */
	reducedMotion(): boolean;
	/** Single-slot subscription (mirrors onFrame) fired whenever the OS setting flips. */
	onReducedMotionChange(cb: ReducedMotionCallback | null): void;
}

export const SHELF_CAMERA_POSITION: [number, number, number] = [0, 1.45, 6.1];
export const SHELF_CAMERA_TARGET: [number, number, number] = [0, 1.15, 0];
export const SHELF_TOP = 0.47; // walnut board top Y — carousel ground truth

const DPR_NARROW_BREAKPOINT = 820;

export function createExperience(container: HTMLElement): Experience {
	const scene = new THREE.Scene();

	const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 60);
	camera.position.set(...SHELF_CAMERA_POSITION);
	camera.lookAt(...SHELF_CAMERA_TARGET);

	const renderer = new THREE.WebGLRenderer({
		antialias: true,
		alpha: true,
		powerPreference: 'high-performance'
	});
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 0.9;
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	container.appendChild(renderer.domElement);

	const pmremGenerator = new THREE.PMREMGenerator(renderer);
	const environmentScene = new RoomEnvironment();
	const environmentTarget = pmremGenerator.fromScene(environmentScene, 0.04);
	scene.environment = environmentTarget.texture;
	scene.environmentIntensity = 0.5;
	environmentScene.dispose();

	scene.fog = new THREE.FogExp2(new THREE.Color('#efe7d8'), 0.027);

	const shelfStage = new THREE.Group();
	shelfStage.name = 'shelfStage';
	scene.add(shelfStage);

	let disposed = false;
	let currentOffsetX = 0;

	function applySize(): void {
		const width = Math.max(container.clientWidth, 1);
		const height = Math.max(container.clientHeight, 1);
		const dprCap = width < DPR_NARROW_BREAKPOINT ? 1.5 : 2;
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap));
		renderer.setSize(width, height);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
	}

	applySize();

	let rafId = 0;
	let last = performance.now();
	let cb: FrameCallback | null = null;

	function requestFrame(): void {
		if (disposed) return;
		if (!rafId) rafId = requestAnimationFrame(frame);
	}

	function frame(time: number): void {
		rafId = 0;
		const dt = Math.min((time - last) / 1000, 0.05);
		last = time;
		const again = cb?.(dt, time / 1000) ?? false;
		renderer.render(scene, camera);
		if (again) requestFrame();
	}

	function onFrame(next: FrameCallback): void {
		cb = next;
	}

	function setViewOffsetX(px: number): void {
		if (disposed) return;
		currentOffsetX = px;
		if (px === 0) {
			camera.clearViewOffset();
			return;
		}
		const width = Math.max(container.clientWidth, 1);
		const height = Math.max(container.clientHeight, 1);
		camera.setViewOffset(width, height, px, 0, width, height);
	}

	function resize(): void {
		if (disposed) return;
		applySize();
		if (currentOffsetX !== 0) setViewOffsetX(currentOffsetX);
	}

	// prefers-reduced-motion — read now, kept live for later tasks (carousel/inspect).
	const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
	let reducedMotionValue = motionQuery.matches;
	let reducedMotionListener: ReducedMotionCallback | null = null;
	const handleMotionChange = (event: MediaQueryListEvent): void => {
		reducedMotionValue = event.matches;
		reducedMotionListener?.(reducedMotionValue);
		// A callback branching on reducedMotion() inside onFrame needs a frame to
		// actually observe the flip — an idle on-demand loop wouldn't otherwise repaint.
		requestFrame();
	};
	motionQuery.addEventListener('change', handleMotionChange);

	// Browsers throttle/suspend rAF callbacks for a hidden (backgrounded) document —
	// a rAF already scheduled via requestFrame() can sit unfired for as long as the
	// tab stays hidden, which reads from the outside as "the on-demand loop died"
	// even though a target moved and requestFrame() was called correctly. Force a
	// fresh request the moment the document is visible again so any state mutated
	// while hidden gets painted promptly instead of waiting on a possibly-starved
	// pending frame.
	const handleVisibilityChange = (): void => {
		if (document.visibilityState === 'visible') requestFrame();
	};
	document.addEventListener('visibilitychange', handleVisibilityChange);

	function reducedMotion(): boolean {
		return reducedMotionValue;
	}

	function onReducedMotionChange(next: ReducedMotionCallback | null): void {
		reducedMotionListener = next;
	}

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		if (rafId) cancelAnimationFrame(rafId);
		rafId = 0;
		cb = null;
		reducedMotionListener = null;
		motionQuery.removeEventListener('change', handleMotionChange);
		document.removeEventListener('visibilitychange', handleVisibilityChange);
		environmentTarget.dispose();
		pmremGenerator.dispose();
		renderer.dispose();
		if (renderer.domElement.parentElement === container) {
			container.removeChild(renderer.domElement);
		}
	}

	return {
		scene,
		camera,
		renderer,
		shelfStage,
		requestFrame,
		onFrame,
		setViewOffsetX,
		resize,
		dispose,
		reducedMotion,
		onReducedMotionChange
	};
}
