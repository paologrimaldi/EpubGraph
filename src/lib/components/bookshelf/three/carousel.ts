import type * as THREE from 'three';
import type { RigHandle } from './bookRig';
import { shouldWrap, wrapOffset, shortestDelta, clampTarget, damp, shelfPose } from './carouselMath';

export interface Carousel {
	readonly selectedIndex: number;
	readonly position: number;
	setRigs(rigs: RigHandle[]): void;
	navigate(delta: number): void; // buttons/keys — snaps target to integer
	navigateTo(index: number): void; // markers — shortestDelta route
	nudge(wheelDelta: number): void; // clamped ±0.72 impulse, 0.14s idle snap
	setHovered(bookId: number | null, pointerNdc: { x: number; y: number }): void;
	update(dt: number, elapsed: number): boolean; // damps everything; true if still moving
	snapAll(): void; // reduced-motion / post-transition sync
	onSelectionChange(cb: (index: number) => void): void;
}

// §4.2 recipe constants.
const POSITION_LAMBDA = 9.5;
const POSITION_SNAP_EPS = 0.0005;
const RIG_LAMBDA = 12;
const HOVER_CRACK = -0.085;
const BOB_FREQUENCY = 0.72;
const BOB_AMPLITUDE = 0.012;
const HOVER_LIFT = 0.035;
const POINTER_TILT_MAX = 0.035;
const WHEEL_IDLE_SECONDS = 0.14;
const WHEEL_IMPULSE_CLAMP = 0.72;
// Tuned so a fast trackpad flick (~150-250px/event) approaches but rarely pins
// the impulse clamp, while a single mouse-wheel notch (~100px) still reads as
// a deliberate nudge rather than a rounding error.
const WHEEL_SENSITIVITY = 0.0026;

const EPS_LINEAR = 0.0004;
const EPS_ANGLE = 0.0004;
const EPS_SCALE = 0.0004;
const EPS_OPACITY = 0.0015;

function mod(n: number, m: number): number {
	return m <= 0 ? 0 : ((n % m) + m) % m;
}

function clampMagnitude(value: number, max: number): number {
	return Math.max(-max, Math.min(max, value));
}

/** Damps `current` toward `target`; snaps + reports "settled" once within `eps`. */
function ease(current: number, target: number, dt: number, eps: number): [value: number, settled: boolean] {
	if (Math.abs(current - target) < eps) return [target, true];
	return [damp(current, target, RIG_LAMBDA, dt), false];
}

interface RigRuntime {
	rig: RigHandle;
	x: number;
	y: number;
	z: number;
	rotY: number;
	rotZ: number;
	scale: number;
	opacity: number;
	frontRotY: number; // cover-crack hinge, damped toward HOVER_CRACK on hover
	liftY: number; // hover lift, lives on `motion` (idle/hover offsets)
	tiltX: number; // pointer tilt, lives on `motion`
	tiltZ: number;
	lastOffset: number; // previous wrapOffset — seam-crossing detector
}

export function createCarousel(
	shelfStage: THREE.Group,
	opts: { shelfTop: number; reducedMotion: () => boolean }
): Carousel {
	let runtimes: RigRuntime[] = [];
	let position = 0;
	let targetPosition = 0;
	let selectedIndex = 0;
	let wheelIdleRemaining = 0;
	let hoveredBookId: number | null = null;
	let hoveredPointerNdc = { x: 0, y: 0 };
	let selectionChangeCb: ((index: number) => void) | null = null;

	function count(): number {
		return runtimes.length;
	}

	function computePose(rig: RigHandle, index: number, atPosition: number, n: number, wrap: boolean) {
		const offset = wrapOffset(index, atPosition, n, wrap);
		const pose = shelfPose(offset, rig.identity.size.height, opts.shelfTop);
		return { offset, pose };
	}

	/** Writes a runtime's damped channels onto its rig's root/frontPivot/motion. */
	function writeTransforms(runtime: RigRuntime, bobY: number): void {
		const rig = runtime.rig;
		rig.root.position.set(runtime.x, runtime.y, runtime.z);
		rig.root.rotation.set(0, runtime.rotY, runtime.rotZ);
		rig.root.scale.setScalar(runtime.scale);
		rig.setOpacity(runtime.opacity);
		rig.frontPivot.rotation.y = runtime.frontRotY;
		rig.motion.position.set(0, bobY + runtime.liftY, 0);
		rig.motion.rotation.set(runtime.tiltX, 0, runtime.tiltZ);
	}

	/** Snaps a runtime straight to its resting pose for the given index/position — no animation. */
	function snapRuntime(runtime: RigRuntime, index: number, atPosition: number, n: number, wrap: boolean): void {
		const { offset, pose } = computePose(runtime.rig, index, atPosition, n, wrap);
		runtime.x = pose.x;
		runtime.y = pose.y;
		runtime.z = pose.z;
		runtime.rotY = pose.rotY;
		runtime.rotZ = pose.rotZ;
		runtime.scale = pose.scale;
		runtime.opacity = pose.opacity;
		runtime.frontRotY = 0;
		runtime.liftY = 0;
		runtime.tiltX = 0;
		runtime.tiltZ = 0;
		runtime.lastOffset = offset;
		writeTransforms(runtime, 0);
	}

	function recomputeSelectedIndex(): void {
		const n = count();
		if (n === 0) return;
		const wrap = shouldWrap(n);
		const rounded = Math.round(position);
		const next = wrap ? mod(rounded, n) : Math.min(Math.max(rounded, 0), n - 1);
		if (next !== selectedIndex) {
			selectedIndex = next;
			selectionChangeCb?.(selectedIndex);
		}
	}

	function setRigs(rigs: RigHandle[]): void {
		for (const runtime of runtimes) shelfStage.remove(runtime.rig.root);

		runtimes = rigs.map((rig) => ({
			rig,
			x: 0,
			y: 0,
			z: 0,
			rotY: 0,
			rotZ: 0,
			scale: 1,
			opacity: 1,
			frontRotY: 0,
			liftY: 0,
			tiltX: 0,
			tiltZ: 0,
			lastOffset: 0
		}));
		for (const runtime of runtimes) shelfStage.add(runtime.rig.root);

		const n = count();
		const wrap = shouldWrap(n);
		targetPosition = clampTarget(targetPosition, n, wrap);
		position = clampTarget(position, n, wrap);

		for (let i = 0; i < n; i++) snapRuntime(runtimes[i], i, position, n, wrap);

		// A fresh rig list can select a different book at the same numeric
		// position (e.g. queue mutated) — re-derive without assuming a change.
		const rounded = Math.round(position);
		selectedIndex = n === 0 ? 0 : wrap ? mod(rounded, n) : Math.min(Math.max(rounded, 0), n - 1);
	}

	function navigate(delta: number): void {
		const n = count();
		if (n === 0) return;
		const wrap = shouldWrap(n);
		wheelIdleRemaining = 0;
		targetPosition = clampTarget(Math.round(targetPosition) + delta, n, wrap);
	}

	function navigateTo(index: number): void {
		const n = count();
		if (n === 0) return;
		const wrap = shouldWrap(n);
		wheelIdleRemaining = 0;
		const clampedIndex = Math.min(Math.max(index, 0), n - 1);
		targetPosition = clampTarget(position + shortestDelta(position, clampedIndex, n, wrap), n, wrap);
	}

	function nudge(wheelDelta: number): void {
		const n = count();
		if (n === 0) return;
		const wrap = shouldWrap(n);
		const impulse = clampMagnitude(wheelDelta * WHEEL_SENSITIVITY, WHEEL_IMPULSE_CLAMP);
		targetPosition = clampTarget(targetPosition + impulse, n, wrap);
		wheelIdleRemaining = WHEEL_IDLE_SECONDS;
	}

	function setHovered(bookId: number | null, pointerNdc: { x: number; y: number }): void {
		hoveredBookId = bookId;
		hoveredPointerNdc = pointerNdc;
	}

	function update(dt: number, elapsed: number): boolean {
		const n = count();
		if (n === 0) return false;
		const reduced = opts.reducedMotion();
		const wrap = shouldWrap(n);

		let unsettled = false;

		// Wheel-idle countdown: once scrubbing stops, snap the target to the
		// nearest integer index so the carousel always comes to rest centered.
		if (wheelIdleRemaining > 0) {
			wheelIdleRemaining = Math.max(0, wheelIdleRemaining - dt);
			if (wheelIdleRemaining === 0) {
				targetPosition = clampTarget(Math.round(targetPosition), n, wrap);
			} else {
				unsettled = true;
			}
		}

		if (reduced) {
			position = targetPosition;
		} else if (Math.abs(position - targetPosition) < POSITION_SNAP_EPS) {
			position = targetPosition;
		} else {
			position = damp(position, targetPosition, POSITION_LAMBDA, dt);
			unsettled = true;
		}

		recomputeSelectedIndex();

		for (let i = 0; i < n; i++) {
			const runtime = runtimes[i];
			const rig = runtime.rig;
			const { offset, pose } = computePose(rig, i, position, n, wrap);

			// Seam crossing: the wrapped offset jumped by roughly half the queue in
			// one frame (a book swept from one end of the visible arc to the
			// other through the back of the shelf) — snap position and hide it
			// for this frame instead of animating a highly visible teleport.
			if (wrap && Math.abs(offset - runtime.lastOffset) > n / 2) {
				runtime.x = pose.x;
				runtime.opacity = 0;
			}
			runtime.lastOffset = offset;

			const hovered = !reduced && hoveredBookId !== null && rig.identity.id === hoveredBookId;

			if (reduced) {
				runtime.x = pose.x;
				runtime.y = pose.y;
				runtime.z = pose.z;
				runtime.rotY = pose.rotY;
				runtime.rotZ = pose.rotZ;
				runtime.scale = pose.scale;
				runtime.opacity = pose.opacity;
				runtime.frontRotY = 0;
				runtime.liftY = 0;
				runtime.tiltX = 0;
				runtime.tiltZ = 0;
			} else {
				let rigSettled = true;
				let v: number;
				let s: boolean;

				[v, s] = ease(runtime.x, pose.x, dt, EPS_LINEAR);
				runtime.x = v;
				rigSettled = rigSettled && s;
				[v, s] = ease(runtime.y, pose.y, dt, EPS_LINEAR);
				runtime.y = v;
				rigSettled = rigSettled && s;
				[v, s] = ease(runtime.z, pose.z, dt, EPS_LINEAR);
				runtime.z = v;
				rigSettled = rigSettled && s;
				[v, s] = ease(runtime.rotY, pose.rotY, dt, EPS_ANGLE);
				runtime.rotY = v;
				rigSettled = rigSettled && s;
				[v, s] = ease(runtime.rotZ, pose.rotZ, dt, EPS_ANGLE);
				runtime.rotZ = v;
				rigSettled = rigSettled && s;
				[v, s] = ease(runtime.scale, pose.scale, dt, EPS_SCALE);
				runtime.scale = v;
				rigSettled = rigSettled && s;
				[v, s] = ease(runtime.opacity, pose.opacity, dt, EPS_OPACITY);
				runtime.opacity = v;
				rigSettled = rigSettled && s;

				const frontTarget = hovered ? HOVER_CRACK : 0;
				[v, s] = ease(runtime.frontRotY, frontTarget, dt, EPS_ANGLE);
				runtime.frontRotY = v;
				rigSettled = rigSettled && s;

				const liftTarget = hovered ? HOVER_LIFT : 0;
				[v, s] = ease(runtime.liftY, liftTarget, dt, EPS_LINEAR);
				runtime.liftY = v;
				rigSettled = rigSettled && s;

				const tiltXTarget = hovered ? -hoveredPointerNdc.y * POINTER_TILT_MAX : 0;
				[v, s] = ease(runtime.tiltX, tiltXTarget, dt, EPS_ANGLE);
				runtime.tiltX = v;
				rigSettled = rigSettled && s;

				const tiltZTarget = hovered ? hoveredPointerNdc.x * POINTER_TILT_MAX : 0;
				[v, s] = ease(runtime.tiltZ, tiltZTarget, dt, EPS_ANGLE);
				runtime.tiltZ = v;
				rigSettled = rigSettled && s;

				if (!rigSettled) unsettled = true;
			}

			// Bob is a passenger on frames already in flight (interaction/settling) —
			// it never independently re-requests a frame, so a fully-settled,
			// unhovered shelf still reaches true idle (0 fps), per §4.5.
			const bobY = reduced ? 0 : Math.sin(elapsed * BOB_FREQUENCY + i * 0.8) * BOB_AMPLITUDE * pose.focus;
			writeTransforms(runtime, bobY);
		}

		return unsettled;
	}

	function snapAll(): void {
		position = targetPosition;
		wheelIdleRemaining = 0;
		const n = count();
		const wrap = shouldWrap(n);
		for (let i = 0; i < n; i++) snapRuntime(runtimes[i], i, position, n, wrap);
		recomputeSelectedIndex();
	}

	return {
		get selectedIndex() {
			return selectedIndex;
		},
		get position() {
			return position;
		},
		setRigs,
		navigate,
		navigateTo,
		nudge,
		setHovered,
		update,
		snapAll,
		onSelectionChange(cb: (index: number) => void) {
			selectionChangeCb = cb;
		}
	};
}
