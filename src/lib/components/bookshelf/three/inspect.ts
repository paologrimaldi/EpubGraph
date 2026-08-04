import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Pose } from '../types/experience';
import type { Experience } from './experience';
import { SHELF_CAMERA_POSITION, SHELF_CAMERA_TARGET, SHELF_TOP } from './experience';
import type { Carousel } from './carousel';
import { HOVER_CRACK } from './carousel';
import type { RigHandle } from './bookRig';
import type { ModeMachine } from './state';
import { smootherstep, shelfPose, damp } from './carouselMath';
import { capturePose, lerpPose, inspectScale, type PoseTargets } from './inspectMath';

export interface InspectController {
	open(rig: RigHandle, origin: HTMLElement | null): void; // shelf→opening
	close(): void; // inspect→closing
	update(dt: number): boolean; // advances transitions, true while active
	resetView(): void;
	// Cover hover-crack ownership while a rig is detached for inspect (shelf
	// mode's hover keeps going through Carousel.setHovered instead — see
	// Library3D.svelte's mode-branched setHover). `isHovered` is just "is the
	// pointer over the (single) inspected book" — no bookId matching needed,
	// there's only ever one candidate.
	setHovered(isHovered: boolean): void;
	readonly activeRig: RigHandle | null;
}

// Inspect pose constants — the design brief's original numbers ([0,1.5,3.1]
// camera / [0,1.45,0] book) were tuned for an older, higher shelf camera.
// With the current near-level SHELF_CAMERA_POSITION/SHELF_CAMERA_TARGET
// framing these values read better. Named + colocated so a controller retune
// during self-verification is one line each.
export const INSPECT_BOOK_POSITION: [number, number, number] = [0, 1.35, 0.6];
export const INSPECT_CAMERA_POSITION: [number, number, number] = [0, 1.42, 3.4];
export const INSPECT_CAMERA_TARGET: [number, number, number] = [0, 1.35, 0.6];
const SHELF_RETREAT_POSITION: [number, number, number] = [0, -4.2, -3];

const OPEN_DURATION = 0.9; // seconds
const CLOSE_DURATION = 0.9;
const SHELF_CLEAR_T_DIVISOR = 0.68; // opening: shelf retreat eased on t/0.68
const SHELF_RETURN_T_OFFSET = 0.24; // closing: shelf return eased on (t-0.24)/0.76
const SHELF_RETURN_T_DIVISOR = 0.76;

// 22rem BookDetail sidebar — colocated with the view-offset math that
// consumes it so the two can't silently drift apart.
export const SIDEBAR_WIDTH_PX = 352;

const ORBIT_MIN_DISTANCE = 2.8;
const ORBIT_MAX_DISTANCE = 7.2;
const ORBIT_MIN_POLAR = 0.24 * Math.PI;
const ORBIT_MAX_POLAR = 0.76 * Math.PI;
const ORBIT_DAMPING_FACTOR = 0.08;

// Cover hover-crack easing while a rig is detached for inspect — same feel
// as carousel.ts's RIG_LAMBDA/EPS_ANGLE (kept local rather than imported so
// inspect.ts's own tuning can drift from shelf-mode's independently; only
// the crack angle itself (HOVER_CRACK) is shared).
const HOVER_CRACK_LAMBDA = 12;
const HOVER_CRACK_EPS = 0.0004;

const IDENTITY_POSE: Pose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 };

// Straight-line camera→book distance at the canonical inspect pose (the
// camera always targets the book exactly, so this doubles as "distance to
// the frustum plane the book sits on") — computed once since both endpoints
// are fixed constants.
const INSPECT_DISTANCE = new THREE.Vector3(...INSPECT_CAMERA_POSITION).distanceTo(
	new THREE.Vector3(...INSPECT_BOOK_POSITION)
);

/**
 * Deterministic shelf⇄inspect choreography (§4.3). Owns the camera and
 * `shelfStage` group outside of shelf mode (carousel.ts never touches
 * either), plus the single detached rig's root/motion transform while it's
 * reparented onto the scene directly. All transition endpoints are captured
 * once at `open()`/`close()` time and eased with `smootherstep` over a fixed
 * duration — never an open-ended lerp — so first/last frames land exactly on
 * the captured/target pose (see inspectMath.test.ts).
 */
export function createInspect(deps: {
	experience: Experience;
	carousel: Carousel;
	machine: ModeMachine;
	controls: OrbitControls;
	sidebarWidthPx: () => number;
	reducedMotion: () => boolean;
	announce: (msg: string) => void;
}): InspectController {
	const { experience, carousel, machine, controls, sidebarWidthPx, reducedMotion, announce } = deps;
	const camera = experience.camera;

	controls.minDistance = ORBIT_MIN_DISTANCE;
	controls.maxDistance = ORBIT_MAX_DISTANCE;
	controls.minPolarAngle = ORBIT_MIN_POLAR;
	controls.maxPolarAngle = ORBIT_MAX_POLAR;
	controls.dampingFactor = ORBIT_DAMPING_FACTOR;
	controls.enabled = false;
	controls.addEventListener('change', () => experience.requestFrame());

	let activeRig: RigHandle | null = null;
	let originEl: HTMLElement | null = null;
	let phase: 'idle' | 'opening' | 'closing' = 'idle';
	let transitionTime = 0;
	let currentViewOffset = 0;

	// Cover hover-crack state for the detached rig (Finding 2, Task 9 review):
	// owned entirely here instead of routing through Carousel.setHovered.
	let hoverCrackTarget = 0;
	let hoverCrackAngle = 0;

	// inspect.ts is the sole owner of camera orientation outside shelf mode
	// (shelf browsing never moves the camera) — this tracks "wherever the
	// camera is currently looking" across both transitions.
	const cameraTarget = new THREE.Vector3(...SHELF_CAMERA_TARGET);

	let startBookPose: Pose = IDENTITY_POSE;
	let endBookPose: Pose = IDENTITY_POSE;
	const startCameraPos = new THREE.Vector3();
	const endCameraPos = new THREE.Vector3();
	const startCameraTarget = new THREE.Vector3();
	const endCameraTarget = new THREE.Vector3();
	const startShelfPos = new THREE.Vector3();
	const endShelfPos = new THREE.Vector3();
	let startViewOffset = 0;
	let endViewOffset = 0;

	const poseTargets: PoseTargets = {
		position: new THREE.Vector3(),
		quaternion: new THREE.Quaternion(),
		scale: new THREE.Vector3()
	};

	/** Captures the book's full root+motion world pose, then collapses
	 * `motion`'s own offset (bob/hover-lift/pointer-tilt) back to identity —
	 * from this point until it's reattached, `root` alone carries the whole
	 * pose, so whatever bob/tilt was live at click time eases away smoothly
	 * as part of the transition instead of popping. */
	function captureRigPose(rig: RigHandle): Pose {
		const pose = capturePose(rig.motion);
		rig.motion.position.set(0, 0, 0);
		rig.motion.rotation.set(0, 0, 0);
		rig.motion.scale.set(1, 1, 1);
		return pose;
	}

	// The book's front-cover surface sits slightly closer to the camera than
	// `root`'s own origin (board thickness + cover-art offset within the rig,
	// see bookRig.ts's buildBoardPivot) — a few % of INSPECT_DISTANCE, which
	// this frustum-fit intentionally does not chase exactly (see inspect.ts's
	// module doc). Verified against a running build: the book comes out
	// noticeably (~15%) larger than the literal 72% figure but still fits
	// the safe width with margin on both sides — a controller-tunable nuance
	// via SAFE_WIDTH_FRACTION in inspectMath.ts, not a functional bug.
	function computeInspectScale(rig: RigHandle): number {
		const vFov = THREE.MathUtils.degToRad(camera.fov);
		const frustumHeight = 2 * Math.tan(vFov / 2) * INSPECT_DISTANCE;
		const frustumWidthAtBook = frustumHeight * camera.aspect;
		const viewportWidthPx = Math.max(experience.renderer.domElement.clientWidth, 1);
		const safeWidthPx = Math.max(viewportWidthPx - sidebarWidthPx(), 1);
		return inspectScale(rig.identity.size.width, safeWidthPx, viewportWidthPx, frustumWidthAtBook);
	}

	/** The rig's resting shelf-slot pose at offset 0 (the *focused* slot) —
	 * shelfStage-local coordinates, which equal world coordinates once
	 * shelfStage is back at its rest transform (identity) at t=1. */
	function focusedSlotPose(rig: RigHandle): Pose {
		const pose = shelfPose(0, rig.identity.size.height, SHELF_TOP);
		return { position: [pose.x, pose.y, pose.z], quaternion: [0, 0, 0, 1], scale: pose.scale };
	}

	function applyBookPose(t: number): void {
		if (!activeRig) return;
		lerpPose(startBookPose, endBookPose, t, poseTargets);
		activeRig.root.position.copy(poseTargets.position);
		activeRig.root.quaternion.copy(poseTargets.quaternion);
		activeRig.root.scale.copy(poseTargets.scale);
	}

	function applyCamera(t: number): void {
		camera.position.lerpVectors(startCameraPos, endCameraPos, t);
		cameraTarget.lerpVectors(startCameraTarget, endCameraTarget, t);
		camera.lookAt(cameraTarget);
	}

	function applyShelfStage(subT: number): void {
		experience.shelfStage.position.lerpVectors(startShelfPos, endShelfPos, subT);
	}

	function applyViewOffset(t: number): void {
		currentViewOffset = startViewOffset + (endViewOffset - startViewOffset) * t;
		experience.setViewOffsetX(currentViewOffset);
	}

	function easedSub(rawT: number, offset: number, divisor: number): number {
		return smootherstep(THREE.MathUtils.clamp((rawT - offset) / divisor, 0, 1));
	}

	function applyOpeningFrame(rawT: number): void {
		const t = smootherstep(rawT);
		applyBookPose(t);
		applyCamera(t);
		applyShelfStage(easedSub(rawT, 0, SHELF_CLEAR_T_DIVISOR));
		applyViewOffset(t);
	}

	function applyClosingFrame(rawT: number): void {
		const t = smootherstep(rawT);
		applyBookPose(t);
		applyCamera(t);
		applyShelfStage(easedSub(rawT, SHELF_RETURN_T_OFFSET, SHELF_RETURN_T_DIVISOR));
		applyViewOffset(t);
	}

	// OrbitControls has no public API to cancel in-flight damped orbit
	// momentum: `update()` (called by both plain frame-ticks and internally by
	// `reset()`) unconditionally re-applies `_sphericalDelta`/`_panOffset` on
	// top of whatever position/target were just set, decayed but not zeroed.
	// Verified against a running build: without this, syncing controls to a
	// fresh canonical pose (or resetting to one) right after — or during — a
	// drag left the camera visibly off the intended pose, because the still-
	// decaying delta from that drag got folded back in. These fields aren't
	// declared in OrbitControls' TS types (underscore-prefixed = private by
	// convention only), so this reaches past the public API deliberately.
	function clearOrbitMomentum(): void {
		const internals = controls as unknown as {
			_sphericalDelta: { theta: number; phi: number };
			_panOffset: THREE.Vector3;
			_scale: number;
		};
		internals._sphericalDelta.theta = 0;
		internals._sphericalDelta.phi = 0;
		internals._panOffset.set(0, 0, 0);
		internals._scale = 1;
	}

	function finishOpening(): void {
		const rig = activeRig;
		if (!rig) return;

		// Hard-set exact endpoints — belt-and-suspenders beyond the t=1 lerp,
		// which is already exact per inspectMath.test.ts.
		rig.root.position.set(...endBookPose.position);
		rig.root.quaternion.set(...endBookPose.quaternion);
		rig.root.scale.setScalar(endBookPose.scale);
		rig.setOpacity(1);

		camera.position.copy(endCameraPos);
		cameraTarget.copy(endCameraTarget);
		camera.lookAt(cameraTarget);

		experience.shelfStage.position.copy(endShelfPos);
		currentViewOffset = endViewOffset;
		experience.setViewOffsetX(endViewOffset);

		machine.to('inspect');

		controls.target.copy(cameraTarget);
		controls.enableDamping = !reducedMotion();
		controls.enabled = true;
		clearOrbitMomentum();
		// Syncs OrbitControls' internal spherical/last-* bookkeeping to this
		// exact pose before any user interaction — otherwise the first drag
		// would apply its delta on top of stale state from a previous session.
		controls.update();
		controls.saveState();

		phase = 'idle';
	}

	function finishClosing(): void {
		const rig = activeRig;
		if (!rig) return;

		rig.root.position.set(...endBookPose.position);
		rig.root.quaternion.set(...endBookPose.quaternion);
		rig.root.scale.setScalar(endBookPose.scale);

		camera.position.copy(endCameraPos);
		cameraTarget.copy(endCameraTarget);
		camera.lookAt(cameraTarget);

		experience.shelfStage.position.copy(endShelfPos);
		currentViewOffset = endViewOffset;
		experience.setViewOffsetX(endViewOffset);

		// Reparent preserving the just-set world pose, then hand the rig back
		// to the carousel — shelfStage is at rest (identity) here, so the pose
		// we hard-set above already equals the correct shelfStage-local value.
		experience.shelfStage.attach(rig.root);
		carousel.setDetachedRig(null);
		carousel.snapAll();

		rig.contactShadow.visible = true;
		rig.setOpacity(1);
		hoverCrackTarget = 0;
		hoverCrackAngle = 0;

		machine.to('shelf');
		announce(`${rig.identity.title} returned to the shelf`);

		const focusTarget = originEl;
		activeRig = null;
		originEl = null;
		phase = 'idle';

		// Deferred: `machine.to('shelf')` above only updates the mode-machine's
		// own closure state — the caller's `mode` mirror (which drives the
		// browse HUD's `inert` attribute) is only synced, and Svelte's DOM
		// patch only flushed, once this call stack unwinds back through
		// `handleFrame`. Focusing `focusTarget` *now* would target a still-
		// `inert` (therefore unfocusable) element and silently no-op; a
		// macrotask guarantees both have happened first.
		if (focusTarget && typeof focusTarget.focus === 'function') {
			setTimeout(() => focusTarget.focus(), 0);
		}
	}

	function open(rig: RigHandle, origin: HTMLElement | null): void {
		if (!machine.can('opening')) return;

		startBookPose = captureRigPose(rig);
		endBookPose = {
			position: INSPECT_BOOK_POSITION,
			quaternion: [0, 0, 0, 1],
			scale: computeInspectScale(rig)
		};

		startCameraPos.copy(camera.position);
		startCameraTarget.copy(cameraTarget);
		endCameraPos.set(...INSPECT_CAMERA_POSITION);
		endCameraTarget.set(...INSPECT_CAMERA_TARGET);

		startShelfPos.copy(experience.shelfStage.position);
		endShelfPos.set(...SHELF_RETREAT_POSITION);

		startViewOffset = currentViewOffset;
		// PerspectiveCamera.updateProjectionMatrix() shifts the frustum's
		// [left,right] bounds by `+offsetX·(frustumWidth/fullWidth)`, which
		// moves a fixed on-axis point (our book, since the camera always
		// targets it) to NDC x = −2·offsetX/fullWidth — i.e. a *positive*
		// pixel offset is what pushes the book toward *negative* NDC x (left
		// on screen), clearing room for the sidebar on the right. Verified
		// against a running build: `-sidebarWidth/2` pushed the book *into*
		// the sidebar instead of away from it.
		endViewOffset = sidebarWidthPx() / 2;

		activeRig = rig;
		originEl = origin;
		carousel.setDetachedRig(rig);
		experience.scene.attach(rig.root);
		rig.contactShadow.visible = false;

		// A book can arrive here still cover-cracked from shelf-mode hover
		// (the pointer that clicked it was, by definition, hovering it) — reset
		// to flat rather than carrying that angle into a transition this
		// controller doesn't otherwise drive frame-by-frame while opening.
		hoverCrackTarget = 0;
		hoverCrackAngle = 0;
		rig.frontPivot.rotation.y = 0;

		machine.to('opening');
		phase = 'opening';
		transitionTime = 0;
		announce(`Inspecting ${rig.identity.title}`);
		experience.requestFrame();

		if (reducedMotion()) {
			transitionTime = 1;
			applyOpeningFrame(1);
			finishOpening();
		}
	}

	function close(): void {
		if (!activeRig || !machine.can('closing')) return;
		const rig = activeRig;

		controls.enabled = false;

		startBookPose = capturePose(rig.root);
		startCameraPos.copy(camera.position);
		startCameraTarget.copy(controls.target);
		startShelfPos.copy(experience.shelfStage.position);
		startViewOffset = currentViewOffset;

		// Settle every other (non-active) rig instantly so the background
		// shelf isn't still visibly damping when it swings back into frame.
		carousel.snapAll();

		endBookPose = focusedSlotPose(rig);
		endCameraPos.set(...SHELF_CAMERA_POSITION);
		endCameraTarget.set(...SHELF_CAMERA_TARGET);
		endShelfPos.set(0, 0, 0);
		endViewOffset = 0;

		machine.to('closing');
		phase = 'closing';
		transitionTime = 0;
		experience.requestFrame();

		if (reducedMotion()) {
			transitionTime = 1;
			applyClosingFrame(1);
			finishClosing();
		}
	}

	function update(dt: number): boolean {
		if (phase === 'opening' || phase === 'closing') {
			const duration = phase === 'opening' ? OPEN_DURATION : CLOSE_DURATION;
			transitionTime = Math.min(transitionTime + dt / duration, 1);
			if (phase === 'opening') {
				applyOpeningFrame(transitionTime);
				if (transitionTime >= 1) finishOpening();
			} else {
				applyClosingFrame(transitionTime);
				if (transitionTime >= 1) finishClosing();
			}
			return true;
		}
		if (machine.mode === 'inspect' && activeRig) {
			let unsettled = false;
			if (Math.abs(hoverCrackAngle - hoverCrackTarget) < HOVER_CRACK_EPS) {
				hoverCrackAngle = hoverCrackTarget;
			} else {
				hoverCrackAngle = damp(hoverCrackAngle, hoverCrackTarget, HOVER_CRACK_LAMBDA, dt);
				unsettled = true;
			}
			activeRig.frontPivot.rotation.y = hoverCrackAngle;
			const controlsMoving = controls.enabled ? controls.update() : false;
			return unsettled || controlsMoving;
		}
		return false;
	}

	function setHovered(isHovered: boolean): void {
		if (!activeRig) return;
		hoverCrackTarget = isHovered ? HOVER_CRACK : 0;
		experience.requestFrame();
	}

	function resetView(): void {
		if (machine.mode !== 'inspect') return;
		clearOrbitMomentum();
		controls.reset();
		experience.requestFrame();
	}

	return {
		open,
		close,
		update,
		resetView,
		setHovered,
		get activeRig() {
			return activeRig;
		}
	};
}
