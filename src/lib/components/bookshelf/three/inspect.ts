import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Pose } from '../types/experience';
import type { Experience } from './experience';
import { SHELF_CAMERA_POSITION, SHELF_CAMERA_TARGET, SHELF_TOP } from './experience';
import type { Carousel } from './carousel';
import type { RigHandle } from './bookRig';
import type { ModeMachine } from './state';
import { smootherstep, shelfPose, damp } from './carouselMath';
import { capturePose, lerpPose, inspectScale, type PoseTargets } from './inspectMath';
import { coverOpenAmount, coverAngle, HOVER_CRACK, type CoverDrag } from './pageFlex';

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
	// Instant, announcement-free return to 'shelf' — for when the caller is
	// about to invalidate the rig this controller is tracking out from under
	// it (Task 9 review Finding 4: `books` prop replaced mid-inspect). See
	// the implementation's doc comment for the full contract.
	forceReset(): void;
	readonly activeRig: RigHandle | null;
	// Task 12 (§4.4): front-cover open/close. `readingOpen` is the settled
	// state the HUD toggle mirrors; the three pointer handlers own the whole
	// click-vs-drag gesture (raycast ownership, px→progress mapping, commit/
	// spring-back, OrbitControls suppression for the duration of a claimed
	// drag) so that logic stays colocated with the frontPivot/pagePivot
	// transform it drives instead of leaking into Library3D.svelte.
	readonly readingOpen: boolean;
	setReadingOpen(open: boolean): void;
	handleCoverPointerDown(event: PointerEvent): boolean; // true if claimed (started a cover drag)
	handleCoverPointerMove(event: PointerEvent): void;
	handleCoverPointerUp(event: PointerEvent): void;
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

// Task 12 (§4.4): front-cover open/close easing + gesture tuning.
const COVER_OPEN_LAMBDA = 10; // brief-specified "damped, λ≈10"
const COVER_OPEN_EPS = 0.0006;
// How fully shut counts as "close enough to skip/finish the settle window" —
// looser than COVER_OPEN_EPS (a per-frame damp-convergence epsilon) since
// this only gates a one-time "is there anything worth animating" decision.
const COVER_SETTLE_EPS = 0.01;
const COVER_SETTLE_MAX_SECONDS = 0.35;
// Same click/drag distinction threshold as Library3D.svelte's own
// CLICK_DRAG_THRESHOLD_PX (kept local rather than imported — this module's
// pointer handlers are otherwise fully self-contained, see the interface
// doc above).
const COVER_CLICK_THRESHOLD_PX = 6;
// Placeholder per-leaf fan stagger (Task 12 brief) until Task 13 replaces it
// with real leaf spring physics — leaf i eases toward LEAF_FAN_STEP*(i+1)*openAmount.
const LEAF_FAN_STEP = -0.06;

const IDENTITY_POSE: Pose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 };

// Straight-line camera→book distance at the canonical inspect pose (the
// camera always targets the book exactly, so this doubles as "distance to
// the frustum plane the book sits on") — computed once since both endpoints
// are fixed constants.
const INSPECT_DISTANCE = new THREE.Vector3(...INSPECT_CAMERA_POSITION).distanceTo(
	new THREE.Vector3(...INSPECT_BOOK_POSITION)
);

// Task 9 review Finding 2: a literal minDistance of 2.8 left ~0 dolly-in
// headroom (INSPECT_DISTANCE ≈ 2.8009 — the canonical pose already sits at
// the clamp). Deriving the clamp from the pose instead of a hand-picked
// constant guarantees real headroom to zoom in, and stays correct if the
// inspect pose constants above are ever retuned again.
const ORBIT_MIN_DISTANCE = INSPECT_DISTANCE * 0.72;

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
	// 'settling-cover': close() detoured here (mode stays 'inspect') to let
	// an open cover ease shut before the shelf-return transition starts —
	// see close()/beginClosingTransition() below.
	let phase: 'idle' | 'opening' | 'closing' | 'settling-cover' = 'idle';
	let transitionTime = 0;
	let currentViewOffset = 0;

	// Cover hover-crack state for the detached rig (Finding 2, Task 9 review):
	// owned entirely here instead of routing through Carousel.setHovered.
	let hoverCrackTarget = 0;
	let hoverCrackAngle = 0;

	// Task 12 (§4.4): front-cover open/close state — `readingOpen` is the
	// settled toggle, `coverDrag` the in-flight pointer-drag override
	// `coverOpenAmount` (pageFlex.ts) blends between. `coverAngleCurrent` is
	// the eased frontPivot.rotation.y contribution from open/close (summed
	// with `hoverCrackAngle` each frame — see updateCoverPivot); `leafAngles`
	// mirrors it per page-leaf for the placeholder fan.
	let readingOpen = false;
	let coverDrag: CoverDrag = { active: false, kind: null, progress: 0 };
	let coverAngleCurrent = 0;
	let leafAngles: number[] = [0, 0, 0, 0, 0, 0];
	let settleTime = 0;

	// Cover-drag pointer tracking — a single claimed pointerId at a time
	// (a second finger/pointer during an active drag is simply ignored by
	// handleCoverPointerDown's raycast-ownership check never being asked,
	// since Library3D only forwards the container's own pointer events).
	let coverPointerId: number | null = null;
	let coverDragStartClientX = 0;
	let coverDragTraveled = false;
	let coverDragKindAtStart: 'cover-open' | 'cover-close' | null = null;
	const coverRaycaster = new THREE.Raycaster();
	const coverPointerNdc = new THREE.Vector2();
	const scratchBookWorldPos = new THREE.Vector3();

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

	/** Cover-drag pointer coordinates → NDC, against the actual canvas rect
	 * (not the outer container Library3D.svelte owns) — mirrors
	 * Library3D.svelte's own pointerToNdc, kept local so this module's cover
	 * pointer handlers are fully self-contained. */
	function pointerToNdc(event: PointerEvent): { x: number; y: number } {
		const rect = experience.renderer.domElement.getBoundingClientRect();
		return {
			x: rect.width === 0 ? 0 : ((event.clientX - rect.left) / rect.width) * 2 - 1,
			y: rect.height === 0 ? 0 : -((event.clientY - rect.top) / rect.height) * 2 + 1
		};
	}

	/** Whether `event` lands on the active rig's front cover (any mesh under
	 * `frontPivot` — cover board, art, foil, endpaper, groove) — the raycast
	 * that decides cover-drag ownership on pointerdown. Only ever true during
	 * idle inspect browsing: gated on `phase === 'idle'` so a click landing
	 * mid-open/close/settle transition (or a second cover-drag claimed while
	 * one is already easing shut, see close()) can't reopen the mid-flight
	 * transform this controller is already animating. */
	function raycastCoverHit(event: PointerEvent): boolean {
		if (!activeRig || machine.mode !== 'inspect' || phase !== 'idle') return false;
		const ndc = pointerToNdc(event);
		coverPointerNdc.set(ndc.x, ndc.y);
		// Inspect moves the camera every frame it's active — force a fresh
		// matrixWorld so a raycast firing between two rendered frames (e.g.
		// mid-orbit-drag) doesn't use a stale camera transform (mirrors
		// Library3D.svelte's raycastBook).
		camera.updateMatrixWorld();
		coverRaycaster.setFromCamera(coverPointerNdc, camera);
		return coverRaycaster.intersectObject(activeRig.frontPivot, true).length > 0;
	}

	/** Approximate on-screen width (px) of `rig` at its *current* camera
	 * distance — used to normalize cover-drag horizontal travel into a
	 * [0,1] progress (§4.4: "px → progress normalized by the book's
	 * on-screen width"). Uses the live camera↔book distance (not the fixed
	 * INSPECT_DISTANCE constant) so drag sensitivity stays correct even
	 * after the user has dollied in/out via OrbitControls. */
	function bookScreenWidthPx(rig: RigHandle): number {
		rig.root.getWorldPosition(scratchBookWorldPos);
		const distance = Math.max(camera.position.distanceTo(scratchBookWorldPos), 0.001);
		const vFov = THREE.MathUtils.degToRad(camera.fov);
		const frustumHeight = 2 * Math.tan(vFov / 2) * distance;
		const frustumWidthAtBook = frustumHeight * camera.aspect;
		const viewportWidthPx = Math.max(experience.renderer.domElement.clientWidth, 1);
		if (frustumWidthAtBook <= 0) return viewportWidthPx; // defensive: never divide by ~0
		const bookWorldWidth = rig.identity.size.width * rig.root.scale.x;
		return Math.max((bookWorldWidth / frustumWidthAtBook) * viewportWidthPx, 1);
	}

	/**
	 * Advances the frontPivot/pagePivot cover-open transform one frame:
	 * hover-crack (suppressed while reading open or a drag owns the pivot)
	 * plus the open/close angle itself (live 1:1 while a drag is active,
	 * damped toward `coverAngle(openAmount)` at COVER_OPEN_LAMBDA otherwise —
	 * "damped, λ≈10" per the brief), plus the placeholder per-leaf fan.
	 * Reduced motion snaps every channel straight to its target. Returns
	 * whether anything is still easing (mirrors carousel.ts's `ease()`
	 * settled-boolean convention).
	 */
	function updateCoverPivot(dt: number): boolean {
		if (!activeRig) return false;
		let unsettled = false;
		const reduced = reducedMotion();

		const crackTarget = readingOpen || coverDrag.active ? 0 : hoverCrackTarget;
		if (reduced || Math.abs(hoverCrackAngle - crackTarget) < HOVER_CRACK_EPS) {
			hoverCrackAngle = crackTarget;
		} else {
			hoverCrackAngle = damp(hoverCrackAngle, crackTarget, HOVER_CRACK_LAMBDA, dt);
			unsettled = true;
		}

		const openAmount = coverOpenAmount(readingOpen, coverDrag);
		const angleTarget = coverAngle(openAmount);
		if (coverDrag.active) {
			coverAngleCurrent = angleTarget;
		} else if (reduced || Math.abs(coverAngleCurrent - angleTarget) < COVER_OPEN_EPS) {
			coverAngleCurrent = angleTarget;
		} else {
			coverAngleCurrent = damp(coverAngleCurrent, angleTarget, COVER_OPEN_LAMBDA, dt);
			unsettled = true;
		}
		activeRig.frontPivot.rotation.y = coverAngleCurrent + hoverCrackAngle;

		for (let i = 0; i < activeRig.pagePivots.length; i++) {
			const leafTarget = LEAF_FAN_STEP * (i + 1) * openAmount;
			if (coverDrag.active) {
				leafAngles[i] = leafTarget;
			} else if (reduced || Math.abs(leafAngles[i] - leafTarget) < COVER_OPEN_EPS) {
				leafAngles[i] = leafTarget;
			} else {
				leafAngles[i] = damp(leafAngles[i], leafTarget, COVER_OPEN_LAMBDA, dt);
				unsettled = true;
			}
			activeRig.pagePivots[i].rotation.y = leafAngles[i];
		}

		return unsettled;
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

	/**
	 * Instant, announcement-free return to 'shelf' (Task 9 review Finding 4).
	 * Unlike close(), this doesn't animate and doesn't require being in
	 * 'inspect' — it works from any non-shelf phase (opening/inspect/
	 * closing), because the caller (Library3D.svelte's rebuildRigs) needs to
	 * sever this controller's ownership of its rig *before* deciding whether
	 * that rig survives the incoming `books` diff or gets disposed.
	 *
	 * Mirrors what finishClosing() does to the shared channels (camera,
	 * shelfStage, view offset, controls) but:
	 *  - reattaches the rig to shelfStage and clears `detachedRig` even
	 *    though no close() ever ran, so a surviving rig re-enters the
	 *    carousel's normal update()/snapAll() loop instead of being skipped
	 *    forever (carousel.ts special-cases `rig === detachedRig` by
	 *    reference — that reference has to be cleared here, not left for a
	 *    future close() that may never come);
	 *  - walks the mode machine's ring (shelf→opening→inspect→closing→shelf)
	 *    one legal `to()` step at a time until it reaches 'shelf', since
	 *    `to()` refuses to skip states;
	 *  - never calls announce() — this is a silent invalidation, not a
	 *    user-driven close.
	 *
	 * Must be called by the caller BEFORE it disposes any rig: leaving the
	 * (possibly about-to-be-disposed) rig's root parented under shelfStage
	 * here is what lets `Carousel.setRigs()`'s old-root cleanup (Finding 4b)
	 * find and remove it, instead of it staying orphaned directly on `scene`
	 * (where `shelfStage.remove(...)` is a no-op) — a disposed-material rig
	 * otherwise stuck rendering in the scene forever.
	 */
	function forceReset(): void {
		if (machine.mode === 'shelf') return; // nothing to unwind

		const rig = activeRig;
		if (rig) {
			experience.shelfStage.attach(rig.root);
			rig.contactShadow.visible = true;
			rig.setOpacity(1);
		}
		carousel.setDetachedRig(null);

		controls.enabled = false;
		clearOrbitMomentum();

		camera.position.set(...SHELF_CAMERA_POSITION);
		cameraTarget.set(...SHELF_CAMERA_TARGET);
		camera.lookAt(cameraTarget);

		experience.shelfStage.position.set(0, 0, 0);
		currentViewOffset = 0;
		experience.setViewOffsetX(0);

		hoverCrackTarget = 0;
		hoverCrackAngle = 0;

		// Task 12: instantly drop any in-flight/settled cover-open state too —
		// pagePivots have no other owner (unlike frontPivot, carousel.ts never
		// touches them), so without this explicit reset a rig that survives a
		// forceReset() mid-fan would carry visibly fanned pages back onto the
		// shelf forever.
		readingOpen = false;
		coverDrag = { active: false, kind: null, progress: 0 };
		coverAngleCurrent = 0;
		leafAngles.fill(0);
		coverPointerId = null;
		coverDragKindAtStart = null;
		settleTime = 0;
		if (rig) {
			rig.frontPivot.rotation.y = 0;
			for (const pivot of rig.pagePivots) pivot.rotation.y = 0;
		}

		activeRig = null;
		originEl = null;
		phase = 'idle';
		transitionTime = 0;

		// `to()` only ever advances one ring-step — cascade through however
		// many steps the current mode is from 'shelf'. Each `if` re-reads
		// `machine.mode` fresh, so this walks opening→inspect→closing→shelf,
		// inspect→closing→shelf, or closing→shelf as appropriate.
		if (machine.mode === 'opening') machine.to('inspect');
		if (machine.mode === 'inspect') machine.to('closing');
		if (machine.mode === 'closing') machine.to('shelf');
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

		// Task 12: a fresh open() always starts from a closed, un-dragged
		// book — reset every cover-open channel regardless of whatever the
		// *previously* inspected book was left at.
		readingOpen = false;
		coverDrag = { active: false, kind: null, progress: 0 };
		coverAngleCurrent = 0;
		leafAngles.fill(0);
		coverPointerId = null;
		coverDragKindAtStart = null;
		settleTime = 0;
		for (const pivot of rig.pagePivots) pivot.rotation.y = 0;

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

	/** The actual shelf-return transition (camera/book/shelfStage/view-offset
	 * choreography) — factored out of close() so a settling cover (Task 12,
	 * §4.4) can delay entering it without duplicating any of this. */
	function beginClosingTransition(): void {
		const rig = activeRig;
		if (!rig) return;

		// Belt-and-suspenders exact stamp (mirrors finishOpening()'s own
		// "hard-set exact endpoints" comment) — close()'s settle window aims
		// for this via damping but caps out at COVER_SETTLE_MAX_SECONDS, so
		// this guarantees the book is provably closed the instant the
		// shelf-return transition begins regardless of whether the ease
		// actually converged in time.
		rig.frontPivot.rotation.y = 0;
		for (const pivot of rig.pagePivots) pivot.rotation.y = 0;
		coverAngleCurrent = 0;
		hoverCrackAngle = 0;
		hoverCrackTarget = 0;
		leafAngles.fill(0);

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

	function close(): void {
		if (!activeRig || !machine.can('closing')) return;
		// Already mid-settle (or, per the can('closing') guard above, mid the
		// real closing transition — 'closing' fails can('closing') on its
		// own) — idempotent no-op rather than restarting the settle timer on
		// a repeat call (e.g. a double Escape/click-outside during the
		// ≤0.35s settle window).
		if (phase === 'settling-cover') return;

		// §4.4: settle the cover first if it's open or mid-drag — drag is
		// cleared without committing (spring-back semantics: an in-flight
		// drag never gets to finish its own gesture once close() preempts
		// it) before deciding whether there's actually anything to settle.
		if (coverDrag.active) {
			coverPointerId = null;
			coverDragKindAtStart = null;
			coverDrag = { active: false, kind: null, progress: 0 };
		}
		const needsSettle = (readingOpen || Math.abs(coverAngleCurrent) > COVER_SETTLE_EPS) && !reducedMotion();
		if (readingOpen) setReadingOpen(false);

		if (needsSettle) {
			phase = 'settling-cover';
			settleTime = 0;
			experience.requestFrame();
			return;
		}
		beginClosingTransition();
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
		if (phase === 'settling-cover') {
			settleTime += dt;
			const pivotUnsettled = activeRig ? updateCoverPivot(dt) : false;
			if (!pivotUnsettled || settleTime >= COVER_SETTLE_MAX_SECONDS || !activeRig) {
				beginClosingTransition();
			}
			return true;
		}
		if (machine.mode === 'inspect' && activeRig) {
			const pivotUnsettled = updateCoverPivot(dt);
			const controlsMoving = controls.enabled ? controls.update() : false;
			return pivotUnsettled || controlsMoving;
		}
		return false;
	}

	function setHovered(isHovered: boolean): void {
		if (!activeRig) return;
		hoverCrackTarget = isHovered ? HOVER_CRACK : 0;
		experience.requestFrame();
	}

	/**
	 * Settled front-cover open/close toggle (§4.4) — the HUD "Open book"
	 * button and every cover pointer gesture below funnel through this so
	 * announcements and the eased frontPivot/pagePivot target (updateCoverPivot,
	 * driven every frame from `update()`) always agree. No-ops if the value
	 * isn't actually changing, so callers (e.g. close()'s defensive
	 * `setReadingOpen(false)`) can call it unconditionally without risking a
	 * duplicate "Closed …" announcement.
	 */
	function setReadingOpen(open: boolean): void {
		if (!activeRig || readingOpen === open) return;
		readingOpen = open;
		announce(open ? `Opened ${activeRig.identity.title}` : `Closed ${activeRig.identity.title}`);
		experience.requestFrame();
	}

	/**
	 * Pointerdown on the container (Library3D.svelte forwards every pointer
	 * event here while `machine.mode === 'inspect'`) — raycasts the active
	 * rig's front cover and, if hit, claims the drag: disables OrbitControls
	 * for the duration (so orbit and cover-drag can't fight over the same
	 * pointer, mirroring close()'s own controls.enabled=false) and captures
	 * the pointer so a fast drag that leaves the canvas bounds still
	 * delivers move/up here. Returns whether the drag was claimed purely for
	 * caller convenience — nothing in this module depends on the caller
	 * checking it.
	 */
	function handleCoverPointerDown(event: PointerEvent): boolean {
		if (!raycastCoverHit(event)) return false;
		coverPointerId = event.pointerId;
		coverDragStartClientX = event.clientX;
		coverDragTraveled = false;
		coverDragKindAtStart = readingOpen ? 'cover-close' : 'cover-open';
		coverDrag = { active: true, kind: coverDragKindAtStart, progress: 0 };
		controls.enabled = false;
		try {
			experience.renderer.domElement.setPointerCapture(event.pointerId);
		} catch {
			// Programmatic/synthetic pointer events (e.g. automated
			// verification dispatching a pointerId the browser never
			// registered as "active") can throw here — capture only matters
			// for a drag that leaves the canvas bounds, it isn't load-bearing
			// for the drag logic itself, so this is silently ignored.
		}
		experience.requestFrame();
		return true;
	}

	/**
	 * Pointermove — a no-op unless `event.pointerId` matches whatever
	 * handleCoverPointerDown claimed. Maps horizontal travel to [0,1]
	 * progress via bookScreenWidthPx, direction-aware per §4.4: dragging
	 * left grows 'cover-open' progress (opening), dragging right grows
	 * 'cover-close' progress (closing) — both drags "pull" the cover's free
	 * edge the same screen direction the swing itself moves.
	 */
	function handleCoverPointerMove(event: PointerEvent): void {
		if (coverPointerId === null || event.pointerId !== coverPointerId || !activeRig || !coverDragKindAtStart) return;
		const deltaX = event.clientX - coverDragStartClientX;
		if (Math.abs(deltaX) > COVER_CLICK_THRESHOLD_PX) coverDragTraveled = true;
		const widthPx = bookScreenWidthPx(activeRig);
		const raw = coverDragKindAtStart === 'cover-open' ? -deltaX / widthPx : deltaX / widthPx;
		coverDrag = { active: true, kind: coverDragKindAtStart, progress: THREE.MathUtils.clamp(raw, 0, 1) };
		experience.requestFrame();
	}

	/**
	 * Pointerup — resolves whatever handleCoverPointerDown claimed (a no-op
	 * if nothing was). A release with no meaningful travel is treated as a
	 * click (toggles readingOpen, §4.4's "click on the cover toggles open");
	 * a real drag commits past the 0.5 progress threshold or springs back
	 * otherwise — both routed through setReadingOpen so the announcement and
	 * the eased settle behave identically to the HUD toggle.
	 */
	function handleCoverPointerUp(event: PointerEvent): void {
		if (coverPointerId === null || event.pointerId !== coverPointerId) return;
		const traveled = coverDragTraveled;
		const finalProgress = coverDrag.progress;
		const kind = coverDragKindAtStart;
		try {
			experience.renderer.domElement.releasePointerCapture(event.pointerId);
		} catch {
			// See handleCoverPointerDown's matching try/catch.
		}
		coverPointerId = null;
		coverDragKindAtStart = null;
		coverDrag = { active: false, kind: null, progress: 0 };
		controls.enabled = machine.mode === 'inspect';

		if (!traveled) {
			setReadingOpen(!readingOpen);
		} else if (kind === 'cover-open') {
			setReadingOpen(finalProgress > 0.5);
		} else if (kind === 'cover-close') {
			setReadingOpen(finalProgress <= 0.5);
		}
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
		forceReset,
		get activeRig() {
			return activeRig;
		},
		get readingOpen() {
			return readingOpen;
		},
		setReadingOpen,
		handleCoverPointerDown,
		handleCoverPointerMove,
		handleCoverPointerUp
	};
}
