import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Pose } from '../types/experience';
import type { Experience } from './experience';
import { SHELF_CAMERA_POSITION, SHELF_CAMERA_TARGET, SHELF_TOP } from './experience';
import type { Carousel } from './carousel';
import type { RigHandle } from './bookRig';
import type { ModeMachine } from './state';
import type { CoverPipeline } from './coverPipeline';
import { applySpreads, type SpreadSet } from './textures/pages';
import { smootherstep, smoothstep, inverseSmoothstep, shelfPose, damp } from './carouselMath';
import { capturePose, lerpPose, inspectScale, type PoseTargets } from './inspectMath';
import {
	coverOpenAmount,
	coverAngle,
	HOVER_CRACK,
	stepFlex,
	deformSheet,
	leafTargets,
	shouldCommitTurn,
	nextSpread,
	canClaimPageDrag,
	canClaimAnyGesture,
	shouldResetSpreadOnClose,
	openAmountFromAngle,
	LEAF_TURNED_ANGLE,
	type CoverDrag,
	type FlexState
} from './pageFlex';

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
	// Final review fix (Critical 1): returns whether THIS pointerId's release
	// resolved a claimed cover drag (toggle or commit/spring-back) — false if
	// nothing was claimed. Library3D.svelte uses this to suppress the native
	// `click` that immediately follows: without it, releasing a click-to-
	// toggle on the open cover's free edge (which can sit well outside the
	// rig's `hit` box — see raycastBook's doc in Library3D.svelte) reads as a
	// miss on the click-empty-to-close raycast and closes the whole inspect
	// view a frame after the cover/page gesture already resolved it.
	handleCoverPointerUp(event: PointerEvent): boolean;
	// Code-review fix (Task 12 findings, Important 1): the browser can abort
	// an in-flight cover drag out from under us (touch takeover, palm
	// rejection, OS-level gesture cancel) — pointerup, the only other place
	// that clears coverDrag/coverPointerId, never fires for a cancelled
	// pointer, so without this OrbitControls would stay disabled for the
	// rest of the inspect session. Library3D.svelte routes both the
	// `pointercancel` and `lostpointercapture` DOM events here.
	handleCoverPointerCancel(event: PointerEvent): void;
	// Task 14 (§4.4): page-turn gestures + commit rules. `currentSpread` is
	// how many leaves (from the spine) are already turned — mirrors
	// `readingOpen` for the HUD (prev/next disabled states, live-region
	// spread label) via the same per-frame sync pattern Library3D.svelte
	// already uses for `readingOpen`. The four pointer handlers mirror the
	// cover-drag ones exactly (raycast ownership against `pageSurfaces`
	// instead of `frontPivot`, px→progress, OrbitControls suppression,
	// pointercancel recovery) — only claimed while the book is open and idle
	// (`readingOpen && phase === 'idle'`).
	readonly currentSpread: number;
	// Task 15 (§4.4): the ACTIVE book's real spread count — `SPREAD_COUNT`
	// (the module-level export below) is only the fallback used before any
	// SpreadSet has been generated for the active rig (i.e. before its cover
	// has been opened this session). Library3D.svelte syncs this every frame
	// the same way it mirrors `currentSpread`, since a per-book value can't
	// be captured once like the old placeholder was.
	readonly spreadCount: number;
	turnPage(direction: 1 | -1): void; // programmatic HUD prev/next — eases like a drag, then commits
	handlePagePointerDown(event: PointerEvent): boolean; // true if claimed (started a page drag)
	handlePagePointerMove(event: PointerEvent): void;
	// Final review fix (Critical 1): mirrors handleCoverPointerUp's return —
	// true iff THIS pointerId's release resolved a claimed page drag
	// (commit or spring-back). Same click-suppression purpose as the cover
	// one, for a click landing on a turned leaf's free edge.
	handlePagePointerUp(event: PointerEvent): boolean;
	handlePagePointerCancel(event: PointerEvent): void;
	// Final review fix (Important 3): recomputes and reapplies the inspect
	// scale (and, mid-transition, the eased endpoint it's lerping toward) —
	// call from Library3D.svelte's handleResize, AFTER experience.resize()
	// has already refreshed camera.aspect, whenever the container resizes
	// while a book is open/opening/closing/inspecting. No-op with no
	// activeRig (i.e. in 'shelf' mode, nothing to resize).
	onResize(): void;
}

// Task 14 placeholder spread count/labels — Task 15 wires real per-book
// content (title/about/colophon, via textures/pages.ts's SpreadSet), but
// these stay as the FALLBACK used whenever no SpreadSet has been generated
// for the active rig yet (i.e. before its cover has been opened this
// session, or with no activeRig at all). `SPREAD_COUNT` stays exported so
// Library3D.svelte has a static initial default before `inspect` even
// exists; once it does, the per-book truth is `InspectController.spreadCount`
// (synced every frame, like `currentSpread`) — see activeSpreadCount() below.
export const SPREAD_COUNT = 4;
const PLACEHOLDER_SPREAD_LABELS = ['Cover', 'Title page', 'About', 'Details'];

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
// Task 13 (§4.5): per-leaf rest/turned damping + flex-spring tuning —
// replaces the Task 12 placeholder fan (previously
// LEAF_FAN_STEP*(i+1)*openAmount) with leafTargets/stepFlex/deformSheet.
const LEAF_LAMBDA = 13; // brief-specified — shared by rotation.y and position.z damping
const LEAF_ANGLE_EPS = 0.0006; // same order as COVER_OPEN_EPS
// Leaf z targets are book-scale meters (~1e-3 range, see bookRig.ts's
// restZ/turnedZ) — needs a proportionally tighter epsilon than the radian
// angle/hover-crack epsilons above or a real gap would read as "converged".
const LEAF_Z_EPS = 0.00002;
// Brief-specified perf guard: once a leaf's |curve|+|twist| and both
// velocities drop below this, treat it as flat and stop touching its
// geometry — the tiny (<0.001) residual bend left baked in is imperceptible
// ("settling flat-ish", per the brief's self-verification wording).
const FLEX_SETTLE_EPS = 0.001;
// Task 14 replaces this with real drag-derived curve/twist targets; until
// then the only thing that ever moves a leaf's flex spring off (0, 0) is a
// small transient curve on the leaves nearest the front cover while it's
// visibly opening/closing — a cheap stand-in for "the top pages riffle a
// little" that the real per-leaf drag will fully take over in Task 14.
const FLEX_GENTLE_CURVE = 0.15;
const FLEX_TOP_LEAF_COUNT = 2;
// Per-frame |Δ coverAngleCurrent| below this reads as "settled", not "still
// opening/closing" — driven off the already-eased angle (not the raw,
// instantly-toggled openAmount) so this stays true for the whole ~1s
// COVER_OPEN_LAMBDA settle window instead of firing for one frame only.
const FLEX_ANGLE_RATE_EPS = 0.00005;

// Task 14 (§4.4): page-drag gesture tuning. Brief-specified: "curve ∝
// clamp(velocity·0.4, −0.5, 0.5), twist small ∝ vertical drag component" —
// the curve scale/clamp are the brief's literal numbers; the twist scale/
// clamp aren't pinned down beyond "small", so they're tuned to read as a
// visible-but-subtle cloth-twist alongside the ±0.5 curve range (same
// "design decision not fully pinned down by the brief" category Task 13's
// report flagged for its own twist-centering choice).
const PAGE_DRAG_CURVE_VELOCITY_SCALE = 0.4;
const PAGE_DRAG_CURVE_CLAMP = 0.5;
const PAGE_DRAG_TWIST_SCALE = 0.3;
const PAGE_DRAG_TWIST_CLAMP = 0.15;
// Programmatic HUD prev/next turn duration — brief-specified "~0.45s".
const PAGE_TURN_DURATION = 0.45;

const IDENTITY_POSE: Pose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 };

/** Fresh idle FlexState per leaf (6 — matches bookRig.ts's LEAF_COUNT, not
 * itself exported) — a plain array literal won't do since `leafFlex.fill(0)`
 * (the pattern `leafAngles` uses) can't reset an array of distinct objects. */
function makeIdleLeafFlex(): FlexState[] {
	return [0, 1, 2, 3, 4, 5].map(() => ({ curve: 0, curveVelocity: 0, twist: 0, twistVelocity: 0 }));
}

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
 * Re-aims `camera` at SHELF_CAMERA_POSITION → SHELF_CAMERA_TARGET (position
 * AND orientation) and syncs `controls.target` to match. Top-level and
 * side-effect-free beyond its two arguments (no closure over createInspect()
 * locals) so an invariant test can call this exact production function
 * directly — see inspect.test.ts.
 *
 * Post-completion regression fix (Task 9): `new OrbitControls(...)`
 * (constructed by Library3D.svelte just before createInspect() runs)
 * unconditionally calls its own internal `update()` once, synchronously, as
 * the last line of its constructor — and since `controls.target` still
 * holds its just-constructed default of `(0,0,0)` at that point (nothing
 * has set it to SHELF_CAMERA_TARGET yet), that stray call re-aims
 * `camera`'s *orientation* at the origin instead of SHELF_CAMERA_TARGET.
 * Verified by reading OrbitControls.js directly: `update()` decomposes
 * `camera.position − controls.target` into spherical coordinates and
 * reconstructs `camera.position = controls.target + offset` from them, so
 * position is unaffected when target is unchanged (still `(0,0,0)` on this
 * first call) — but it then unconditionally calls `camera.lookAt(target)`,
 * which points the already-correctly-positioned camera at the origin
 * instead of `(0, 1.15, 0)`. At SHELF_CAMERA_POSITION `[0, 1.45, 6.1]` that
 * is `atan(1.45/6.1) − atan(0.3/6.1) ≈ 10.6°` of extra downtilt — measured
 * directly off a real `OrbitControls` instance at 10.56°, matching the
 * live-browser symptom (books cropped at the frame top, shelf board top at
 * ~39% frame height instead of ~72%) almost exactly. Nothing else corrects
 * this for shelf mode: the only other `controls.update()` call site (this
 * file's own `update()` closure) is gated to `machine.mode === 'inspect'`,
 * so a page load that never enters inspect keeps the wrong aim forever.
 * createInspect() calls this once, immediately after tuning `controls` and
 * before the first frame ever renders, to undo it; finishClosing() and
 * forceReset() also call it as belt-and-suspenders so a stale
 * `controls.target` left over from wherever the user last orbited/panned
 * during inspect can never leak into a later shelf-mode frame.
 */
export function pinShelfCameraAim(camera: THREE.PerspectiveCamera, controls: OrbitControls): void {
	camera.position.set(...SHELF_CAMERA_POSITION);
	camera.lookAt(...SHELF_CAMERA_TARGET);
	controls.target.set(...SHELF_CAMERA_TARGET);
}

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
	// Task 15: lazy SpreadSet generation/cache lives in coverPipeline.ts (see
	// its module doc) — inspect.ts calls ensureSpreadSet() the first time a
	// book's cover opens, then applies the result to the rig itself via
	// textures/pages.ts's applySpreads (this module already owns every other
	// leaf-pivot/material touch, so application stays here rather than
	// crossing back into coverPipeline.ts, which never touches rig geometry).
	coverPipeline: CoverPipeline;
}): InspectController {
	const { experience, carousel, machine, controls, sidebarWidthPx, reducedMotion, announce, coverPipeline } = deps;
	const camera = experience.camera;

	controls.minDistance = ORBIT_MIN_DISTANCE;
	controls.maxDistance = ORBIT_MAX_DISTANCE;
	controls.minPolarAngle = ORBIT_MIN_POLAR;
	controls.maxPolarAngle = ORBIT_MAX_POLAR;
	controls.dampingFactor = ORBIT_DAMPING_FACTOR;
	controls.enabled = false;
	controls.addEventListener('change', () => experience.requestFrame());
	// Undo OrbitControls' own constructor-time re-aim before anything ever
	// renders — see pinShelfCameraAim's doc comment above for the full
	// mechanism (Task 9 post-completion regression fix).
	pinShelfCameraAim(camera, controls);

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
	// is the same per-leaf damped rotation.y (Task 13's leafTargets.angle
	// target, replacing the old placeholder fan).
	let readingOpen = false;
	let coverDrag: CoverDrag = { active: false, kind: null, progress: 0 };
	let coverAngleCurrent = 0;
	let leafAngles: number[] = [0, 0, 0, 0, 0, 0];
	let settleTime = 0;

	// Task 13 (§4.5): per-leaf flex spring state + settle-guard bookkeeping.
	// `leafFlex` is stepFlex's per-leaf FlexState — idle {0,0,0,0} outside the
	// transient "cover is opening/closing" wire below (Task 14 drives it from
	// real page-turn drags instead). `leafDeformed` tracks whether a leaf's
	// sheet geometry currently carries a live (above-FLEX_SETTLE_EPS) baked-in
	// deform, purely so a reduced-motion transition mid-flex can flatten it
	// back to exactly flat once instead of leaving a stale bend baked in
	// forever (normal settling is allowed to leave an imperceptible
	// sub-epsilon residual — see updateCoverPivot). `currentSpread` is how
	// many leaves (from the spine) are already turned — introduced this task,
	// always 0 (every leaf rests, per leafTargets) until Task 14 wires real
	// page-turn gestures that advance it.
	let currentSpread = 0;
	let leafFlex: FlexState[] = makeIdleLeafFlex();
	let leafDeformed: boolean[] = [false, false, false, false, false, false];
	let previousCoverAngleForFlex = 0;

	// Task 15 (§4.4): the active rig's generated interior-page content, once
	// materialized (see setReadingOpen below) — null until the cover has been
	// opened at least once this inspect session, at which point it's applied
	// to the rig's leaf sheets and never changes again for this rig (a rig's
	// identity/description don't change mid-session). activeSpreadLabels()/
	// activeSpreadCount() are this file's only readers — every other page-
	// turn code path below reads through those two functions instead of the
	// PLACEHOLDER_SPREAD_LABELS/SPREAD_COUNT constants directly, so the whole
	// file transparently starts using real per-book content the moment it's
	// generated, with no other call site needing to know which is active.
	let activeSpreadSet: SpreadSet | null = null;

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

	// Task 14 (§4.4): page-turn drag pointer tracking — mirrors the cover-drag
	// bookkeeping above exactly (single claimed pointerId, start client
	// coords, a traveled flag for the click-vs-drag threshold), plus the
	// per-move velocity bookkeeping a cover drag doesn't need (page-drag flex
	// curve is driven by instantaneous drag speed, §4.4). `pageDragDirection`/
	// `pageDragLeafIndex` start unresolved (`null`/`-1`) at pointerdown —
	// §4.4's "direction from initial drag direction" means the gesture only
	// decides which leaf it owns (and which way) once the drag has traveled
	// past the click threshold, not at raycast time (raycasting any
	// `pageSurfaces` mesh just claims pointer ownership).
	let pagePointerId: number | null = null;
	let pageDragStartClientX = 0;
	let pageDragStartClientY = 0;
	let pageDragTraveled = false;
	let pageDragDirection: 1 | -1 | null = null;
	let pageDragLeafIndex = -1;
	let pageDragProgress = 0;
	let pageDragVelocity = 0; // progress/second, signed (matches direction of travel)
	let pageDragVerticalComponent = 0; // (clientY delta / book width), feeds the flex twist target
	let pageDragLastProgress = 0;
	let pageDragLastTimeMs = 0;
	// Programmatic HUD prev/next turn (turnPage()) — mirrors a live page-drag's
	// "active leaf follows a [0,1] progress" shape so both paths can share one
	// per-frame leaf-override block in updateCoverPivot, just fed by an eased
	// timer instead of the pointer. `null` when no programmatic turn is
	// in-flight.
	let programmaticTurn: { direction: 1 | -1; leafIndex: number; time: number } | null = null;

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
	// noticeably larger than the literal width-fit figure alone but still
	// fits both the safe width and the frame height with margin — a
	// controller-tunable nuance via SAFE_WIDTH_FRACTION/SAFE_HEIGHT_FRACTION
	// in inspectMath.ts, not a functional bug.
	//
	// QA round 1, Finding 2: fits BOTH width AND height (inspectScale takes
	// the book's height and the frustum height at the book's depth too, and
	// returns min(widthFit, heightFit)) — previously width-only, which left
	// the book overflowing the frame vertically at wide/short aspects. Used
	// by both open() (the initial pose) and resetView() (via onResize/the
	// canonical endBookPose captured at open time — see resetView's own doc)
	// so the two land on the identical framing the brief requires.
	function computeInspectScale(rig: RigHandle): number {
		const vFov = THREE.MathUtils.degToRad(camera.fov);
		const frustumHeight = 2 * Math.tan(vFov / 2) * INSPECT_DISTANCE;
		const frustumWidthAtBook = frustumHeight * camera.aspect;
		const viewportWidthPx = Math.max(experience.renderer.domElement.clientWidth, 1);
		const safeWidthPx = Math.max(viewportWidthPx - sidebarWidthPx(), 1);
		return inspectScale(
			rig.identity.size.width,
			rig.identity.size.height,
			safeWidthPx,
			viewportWidthPx,
			frustumWidthAtBook,
			frustumHeight
		);
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

	/** Whether `event` lands on any of the active rig's 12 page-leaf sheets —
	 * the raycast that decides page-drag ownership on pointerdown (Task 14,
	 * §4.4). Only claimed while the book is open and idle
	 * (`readingOpen && phase === 'idle'`, checked by the caller); which
	 * specific leaf/side was hit doesn't matter here — §4.4's "direction from
	 * initial drag direction" means the actual leaf + forward/backward
	 * decision happens later, in handlePagePointerMove, once the drag has
	 * traveled past the click threshold. Reuses `coverRaycaster`/
	 * `coverPointerNdc` (sequential per-call scratch objects, same as
	 * raycastCoverHit — never concurrent within a single handler). */
	function raycastPageHit(event: PointerEvent): boolean {
		if (!activeRig) return false;
		const ndc = pointerToNdc(event);
		coverPointerNdc.set(ndc.x, ndc.y);
		camera.updateMatrixWorld();
		coverRaycaster.setFromCamera(coverPointerNdc, camera);
		return coverRaycaster.intersectObjects(activeRig.pageSurfaces, false).length > 0;
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

	/** Writes `curve`/`twist` into leaf `i`'s sheet geometry and marks it
	 * dirty — front/back sheets of a leaf share one geometry (bookRig.ts's
	 * Task 13 per-pivot clone), so a single write updates both. No-ops
	 * defensively when the rig has no leaf geometry to deform, which is true
	 * of every mocked RigHandle in the test suite (carousel.test.ts,
	 * coverPipeline.test.ts both use empty pagePivots/pageSurfaces arrays) —
	 * this function is otherwise only exercised via a real bookRig.ts rig in
	 * the browser. `direction` defaults to `1` (Task 13's only-ever-called
	 * value, kept for every non-page-drag caller below); Task 14's page-drag
	 * leaf override passes the drag's real forward/backward direction, which
	 * `deformSheet` needs to curl the sheet toward the side it's actually
	 * being pulled. */
	function applyLeafDeform(rig: RigHandle, i: number, curve: number, twist: number, direction: 1 | -1 = 1): void {
		const base = rig.pagePivots[i]?.userData.basePositions as Float32Array | undefined;
		const sheet = rig.pageSurfaces[i * 2];
		if (!base || !sheet) return;
		const out = sheet.geometry.getAttribute('position') as THREE.BufferAttribute;
		deformSheet(base, out, curve, twist, direction);
		out.needsUpdate = true;
		sheet.geometry.computeVertexNormals();
	}

	/** Resets the per-leaf *state* (not any rig's pivots/geometry) back to
	 * idle — angle/flex arrays, currentSpread. Callable even with no
	 * activeRig (forceReset() may run with nothing to unwind on the rig
	 * side, but the arrays still need to start clean for whatever book is
	 * opened next). */
	/** Task 15: the active rig's real spread labels, falling back to the
	 * Task 14 placeholder whenever there's no activeRig or its SpreadSet
	 * hasn't been generated yet (cover never opened this session) — see
	 * activeSpreadSet's own doc comment above. Guarding on `activeRig` too
	 * (not just `activeSpreadSet`) means a lingering reference from a just-
	 * closed book can never leak into a reading of "no book is active". */
	function activeSpreadLabels(): string[] {
		return activeRig && activeSpreadSet ? activeSpreadSet.labels : PLACEHOLDER_SPREAD_LABELS;
	}

	function activeSpreadCount(): number {
		return activeSpreadLabels().length;
	}

	function resetLeafFlexState(): void {
		currentSpread = 0;
		leafAngles.fill(0);
		leafFlex = makeIdleLeafFlex();
		leafDeformed.fill(false);
		previousCoverAngleForFlex = 0;
	}

	/** Task 14: drops any in-flight page-drag/programmatic-turn *gesture*
	 * bookkeeping — deliberately separate from resetLeafFlexState() (which
	 * resets the *settled* currentSpread/leafAngles/leafFlex state) exactly
	 * the way coverPointerId/coverDragKindAtStart are reset separately from
	 * coverAngleCurrent/hoverCrackAngle elsewhere in this file: pointer/
	 * gesture-in-flight state and settled/eased state are cleared at
	 * different moments (close() cancels an in-flight drag immediately, but
	 * only beginClosingTransition() — via resetLeafPivots — snaps the
	 * settled leaf pose/currentSpread back to flat). Called from open(),
	 * forceReset(), and close()'s own in-flight-drag cancellation. */
	function resetPageDragState(): void {
		pagePointerId = null;
		pageDragStartClientX = 0;
		pageDragStartClientY = 0;
		pageDragTraveled = false;
		pageDragDirection = null;
		pageDragLeafIndex = -1;
		pageDragProgress = 0;
		pageDragVelocity = 0;
		pageDragVerticalComponent = 0;
		pageDragLastProgress = 0;
		pageDragLastTimeMs = 0;
		programmaticTurn = null;
	}

	/** Snaps every leaf pivot on `rig` to flat/rest (rotation.y 0,
	 * position.z restZ) and flattens any live curve/twist baked into its
	 * sheet geometry back to base — shared by open() (a fresh book always
	 * starts flat), forceReset() (Task 9 review Finding 4: a surviving rig
	 * can't carry a mid-flex bend back onto the shelf), and
	 * beginClosingTransition() (the cover snaps shut instantly here, the
	 * same "abrupt, not eased" contract reduced motion gets everywhere
	 * else). Unconditionally re-flattens every leaf's geometry rather than
	 * checking `leafDeformed` first — cheap (six ~160-vertex writes, only at
	 * these reset boundaries, never per-frame) and simpler than reasoning
	 * about which leaves might have a live bend. Also calls
	 * resetLeafFlexState(). */
	function resetLeafPivots(rig: RigHandle): void {
		for (let i = 0; i < rig.pagePivots.length; i++) {
			const pivot = rig.pagePivots[i];
			pivot.rotation.y = 0;
			pivot.position.z = pivot.userData.restZ;
			applyLeafDeform(rig, i, 0, 0);
		}
		resetLeafFlexState();
	}

	/**
	 * Advances the frontPivot/pagePivot cover-open transform one frame:
	 * hover-crack (suppressed while reading open or a drag owns the pivot)
	 * plus the open/close angle itself (live 1:1 while a drag is active,
	 * damped toward `coverAngle(openAmount)` at COVER_OPEN_LAMBDA otherwise —
	 * "damped, λ≈10" per the brief), plus each leaf's rest/turned transform
	 * (Task 13: `leafTargets` + damping, replacing the Task 12 placeholder
	 * fan) and its curve/twist flex spring (`stepFlex` + `deformSheet`, only
	 * while live — see FLEX_SETTLE_EPS). Reduced motion snaps every angle/z
	 * channel straight to its target and forces flex to exactly (0, 0) with
	 * no deform work at all. Returns whether anything is still
	 * easing/springing (mirrors carousel.ts's `ease()` settled-boolean
	 * convention) — true while any leaf spring is live, per the brief.
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

		// QA round 1, Finding 3/6: the cover just settled fully closed (this
		// frame's raw openAmount reached 0, not overridden by an in-flight
		// drag) while a stale currentSpread from before the close survived —
		// reset it now, the edge-triggered instant shouldResetSpreadOnClose
		// becomes true (see its own doc comment for the exact "stuck to the
		// cover on reopen" bug this prevents). Deliberately NOT a call to
		// resetLeafPivots()'s hard geometry snap: every leaf's *target* this
		// frame (leafTargets, in the per-leaf loop below) already reads
		// {angle:0,z:0} purely from openAmount===0, regardless of
		// currentSpread's value — so the already-correct eased return to flat
		// (each leaf damping toward that target at LEAF_LAMBDA, same as any
		// other close) is completely unaffected by exactly which frame this
		// bookkeeping-only reset lands on. Hard-snapping here would instead
		// fight that ease and pop any leaf still mid-return-to-flat.
		if (shouldResetSpreadOnClose(readingOpen, coverDrag.active, openAmount, currentSpread)) {
			currentSpread = 0;
		}

		const angleTarget = coverAngle(openAmount);
		let coverAngleUnsettled = false;
		if (coverDrag.active) {
			coverAngleCurrent = angleTarget;
		} else if (reduced || Math.abs(coverAngleCurrent - angleTarget) < COVER_OPEN_EPS) {
			coverAngleCurrent = angleTarget;
		} else {
			coverAngleCurrent = damp(coverAngleCurrent, angleTarget, COVER_OPEN_LAMBDA, dt);
			coverAngleUnsettled = true;
		}
		activeRig.frontPivot.rotation.y = coverAngleCurrent + hoverCrackAngle;
		unsettled = unsettled || coverAngleUnsettled;

		// "Is the cover visibly opening/closing right now" — driven off
		// coverAngleCurrent's own per-frame delta (not the raw openAmount,
		// which jumps straight to 0/1 on a click-toggle) so this stays true
		// across the whole damped-settle window AND during a live drag
		// (coverAngleCurrent tracks angleTarget 1:1 there, so it still moves
		// frame-to-frame whenever the user's drag progress does).
		const coverAngleDelta = coverAngleCurrent - previousCoverAngleForFlex;
		previousCoverAngleForFlex = coverAngleCurrent;
		const coverIsAnimating = !reduced && Math.abs(coverAngleDelta) > FLEX_ANGLE_RATE_EPS;

		// Task 14 (§4.4): resolve this frame's "active page turn" — either a
		// live user drag (pointer down, direction already decided by
		// handlePagePointerMove) or a programmatic turnPage() ease. At most
		// one can be active at a time (turnPage() refuses to start while
		// pagePointerId is set, see turnPage() below), and neither exists
		// under reduced motion (a live drag's follow is skipped entirely —
		// see handlePagePointerMove's own `reduced` guard — and turnPage()
		// commits reduced-motion turns instantly without ever setting
		// programmaticTurn). `t` is the leaf's rest(0)→turned(1) blend
		// factor for *this* frame — forward maps drag/ease progress 0→1 onto
		// t 0→1 (rest→turned); backward mirrors it (progress 0→1 onto t 1→0,
		// turned→rest), exactly matching leafTargets' own z/angle blend
		// convention so the leaf hands off to the normal damp path
		// seamlessly the instant this override clears (see below).
		let turn: { leafIndex: number; direction: 1 | -1; t: number } | null = null;
		if (!reduced && pagePointerId !== null && pageDragLeafIndex >= 0 && pageDragDirection) {
			const t =
				pageDragDirection === 1 ? smoothstep(pageDragProgress) : 1 - smoothstep(pageDragProgress);
			turn = { leafIndex: pageDragLeafIndex, direction: pageDragDirection, t };
		} else if (programmaticTurn) {
			programmaticTurn.time += dt;
			const p = Math.min(programmaticTurn.time / PAGE_TURN_DURATION, 1);
			const t = programmaticTurn.direction === 1 ? smoothstep(p) : 1 - smoothstep(p);
			turn = { leafIndex: programmaticTurn.leafIndex, direction: programmaticTurn.direction, t };
			if (p >= 1) {
				const direction = programmaticTurn.direction;
				programmaticTurn = null;
				currentSpread = nextSpread(currentSpread, direction, activeSpreadCount());
				announce(activeSpreadLabels()[currentSpread] ?? '');
			}
			unsettled = true;
		}

		for (let i = 0; i < activeRig.pagePivots.length; i++) {
			const pivot = activeRig.pagePivots[i];
			const isActiveTurnLeaf = turn !== null && turn.leafIndex === i;

			if (isActiveTurnLeaf && turn) {
				// Live 1:1 follow — no damping, exactly mirroring how
				// coverAngleCurrent tracks a live cover drag above. Never
				// reverses direction mid-gesture: forward always eases 0→1,
				// backward always 1→0, so a committed page (currentSpread
				// already advanced by the time this override clears) can
				// only ever keep moving the way it was already moving —
				// §8 item 9's "a committed page never springs back".
				const angle = LEAF_TURNED_ANGLE * turn.t;
				leafAngles[i] = angle;
				pivot.rotation.y = angle;
				const targetZ = THREE.MathUtils.lerp(pivot.userData.restZ, pivot.userData.turnedZ, turn.t);
				pivot.position.z = targetZ;
				unsettled = true;
			} else if (reduced) {
				const target = leafTargets(i, currentSpread, openAmount);
				const targetZ = THREE.MathUtils.lerp(pivot.userData.restZ, pivot.userData.turnedZ, target.z);
				leafAngles[i] = target.angle;
				pivot.rotation.y = target.angle;
				pivot.position.z = targetZ;
			} else {
				const target = leafTargets(i, currentSpread, openAmount);
				const targetZ = THREE.MathUtils.lerp(pivot.userData.restZ, pivot.userData.turnedZ, target.z);
				if (Math.abs(leafAngles[i] - target.angle) < LEAF_ANGLE_EPS) {
					leafAngles[i] = target.angle;
				} else {
					leafAngles[i] = damp(leafAngles[i], target.angle, LEAF_LAMBDA, dt);
					unsettled = true;
				}
				pivot.rotation.y = leafAngles[i];

				if (Math.abs(pivot.position.z - targetZ) < LEAF_Z_EPS) {
					pivot.position.z = targetZ;
				} else {
					pivot.position.z = damp(pivot.position.z, targetZ, LEAF_LAMBDA, dt);
					unsettled = true;
				}
			}

			if (reduced) {
				leafFlex[i] = { curve: 0, curveVelocity: 0, twist: 0, twistVelocity: 0 };
				if (leafDeformed[i]) {
					applyLeafDeform(activeRig, i, 0, 0);
					leafDeformed[i] = false;
				}
				continue;
			}

			// Task 14: a leaf under a *live user drag* (not a programmatic
			// turnPage() ease — the brief's velocity-driven curve is a drag-
			// only detail) gets its flex spring driven by the drag's
			// instantaneous speed/vertical component instead of Task 13's
			// "cover is opening" gentle-curve stand-in.
			const isDragLeaf = !reduced && pagePointerId !== null && pageDragLeafIndex === i;
			let targetCurve: number;
			let targetTwist: number;
			let deformDirection: 1 | -1 = 1;
			if (isDragLeaf) {
				targetCurve = THREE.MathUtils.clamp(
					pageDragVelocity * PAGE_DRAG_CURVE_VELOCITY_SCALE,
					-PAGE_DRAG_CURVE_CLAMP,
					PAGE_DRAG_CURVE_CLAMP
				);
				targetTwist = THREE.MathUtils.clamp(
					pageDragVerticalComponent * PAGE_DRAG_TWIST_SCALE,
					-PAGE_DRAG_TWIST_CLAMP,
					PAGE_DRAG_TWIST_CLAMP
				);
				deformDirection = pageDragDirection ?? 1;
			} else {
				const isTopLeaf = i >= activeRig.pagePivots.length - FLEX_TOP_LEAF_COUNT;
				targetCurve = coverIsAnimating && isTopLeaf ? FLEX_GENTLE_CURVE : 0;
				targetTwist = 0;
			}
			leafFlex[i] = stepFlex(leafFlex[i], targetCurve, targetTwist, dt);
			const flex = leafFlex[i];
			const flexLive =
				Math.abs(flex.curve) + Math.abs(flex.twist) > FLEX_SETTLE_EPS ||
				Math.abs(flex.curveVelocity) > FLEX_SETTLE_EPS ||
				Math.abs(flex.twistVelocity) > FLEX_SETTLE_EPS;

			if (flexLive) {
				applyLeafDeform(activeRig, i, flex.curve, flex.twist, deformDirection);
				unsettled = true;
			}
			leafDeformed[i] = flexLive;
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

	/**
	 * Final review fix (Important 1): the flip side of `canClaimAnyGesture` —
	 * called from every cover/page pointerup/pointercancel handler instead of
	 * the old unconditional `controls.enabled = machine.mode === 'inspect'`.
	 * With the mutual-exclusion guard now refusing a second gesture claim
	 * while either pointerId is live, at most one of coverPointerId/
	 * pagePointerId is ever non-null at a time in practice — but reading both
	 * here rather than assuming that invariant holds is the same belt-and-
	 * suspenders discipline this file already applies everywhere else (see
	 * pinShelfCameraAim's doc comment): controls only ever re-enable once
	 * NEITHER gesture still owns a pointer, so a handler that runs before its
	 * sibling clears its own pointerId (impossible today, but not something
	 * this function should have to assume) can't prematurely hand orbit
	 * control back mid-gesture.
	 */
	function refreshControlsEnabled(): void {
		controls.enabled = machine.mode === 'inspect' && coverPointerId === null && pagePointerId === null;
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
		// Task 9 post-completion regression fix: belt-and-suspenders — a
		// stale controls.target left over from wherever the user last
		// orbited/panned during inspect must never leak into shelf-mode
		// framing on a later cycle (controls.enabled is already false by
		// this point, via beginClosingTransition(), so this can't be
		// clobbered by a controls.update() before the next open()).
		controls.target.copy(cameraTarget);

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
		// Task 9 post-completion regression fix: see finishClosing()'s
		// matching comment — forceReset() can also fire mid-inspect (Finding
		// 4's rig-invalidation path), so the same stale-target risk applies.
		controls.target.copy(cameraTarget);

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
		coverPointerId = null;
		coverDragKindAtStart = null;
		settleTime = 0;
		// Task 14: zeroes currentSpread + drops any in-flight page drag/
		// programmatic turn — a rig that survives a forceReset() mid-turn
		// can't carry a turned page back onto the shelf, mirroring the
		// cover-open reset immediately above.
		resetPageDragState();
		if (rig) {
			rig.frontPivot.rotation.y = 0;
			resetLeafPivots(rig);
		} else {
			resetLeafFlexState();
		}
		// Task 15: mirrors open()'s own reset — see that call site's comment.
		activeSpreadSet = null;

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
		coverPointerId = null;
		coverDragKindAtStart = null;
		settleTime = 0;
		// Task 14: a fresh open() also always starts at spread 0 with no
		// drag/programmatic turn in flight, regardless of whatever the
		// previously inspected book was left at.
		resetPageDragState();
		resetLeafPivots(rig);
		// Task 15: a fresh open() is a different book (or the same book,
		// re-opened) — either way, drop any previous rig's SpreadSet
		// reference so activeSpreadLabels()/activeSpreadCount() fall back to
		// the placeholder until THIS rig's cover is actually opened, rather
		// than briefly reporting the previous book's spread count/labels.
		activeSpreadSet = null;

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
		resetLeafPivots(rig);
		coverAngleCurrent = 0;
		hoverCrackAngle = 0;
		hoverCrackTarget = 0;
		// Code-review fix (Task 12 findings, Important 2): belt-and-suspenders
		// direct assignment (not setReadingOpen — this is unconditional
		// bookkeeping, not a user-facing toggle, and shouldn't announce) so
		// `readingOpen` can never survive onto the shelf even if some future
		// caller manages to flip it back on between close()'s own
		// `setReadingOpen(false)` and this point.
		readingOpen = false;

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
		// Task 14: cancel any in-flight page drag/programmatic turn the same
		// way — never let it commit, just clear the override so the leaf's
		// normal damp-toward-currentSpread path (already running below via
		// updateCoverPivot) eases it back to whatever spread was last
		// actually committed, as part of the same settle window the cover
		// itself uses.
		resetPageDragState();
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
	 *
	 * Code-review fix (Task 12 findings, Important 2): also no-ops unless
	 * `phase === 'idle' && machine.mode === 'inspect'` — otherwise a click on
	 * the HUD "Open book" button (or any other caller) landing during the
	 * `'settling-cover'` close window re-opens the cover, which then
	 * hard-snaps shut when beginClosingTransition()'s belt-and-suspenders
	 * reset fires — a visible glitch plus a `readingOpen=true` that would
	 * otherwise survive back onto the shelf. close()'s own
	 * `setReadingOpen(false)` call still runs fine under this guard: it fires
	 * before `phase` moves off `'idle'` and before `machine.to('closing')`,
	 * see close() below. Every gesture path (click/drag-commit/HUD toggle)
	 * already independently requires `phase === 'idle'` to even begin (cover
	 * drags via raycastCoverHit's own gate, the HUD button only rendering
	 * while `mode === 'inspect'`) — this is the belt to those gestures'
	 * suspenders, catching a click that lands in the same frame the settle
	 * window opens.
	 */
	function setReadingOpen(open: boolean): void {
		if (!activeRig || phase !== 'idle' || machine.mode !== 'inspect' || readingOpen === open) return;
		// Task 15 (§4.4): lazy per-book interior-page generation — the first
		// time (ever, this app session) THIS book's cover opens, build/apply
		// its SpreadSet. coverPipeline.ensureSpreadSet caches by book id, so
		// re-opening the same book later in the same session (or reopening
		// after closing without leaving inspect) is a cheap cache hit, not a
		// re-generation — applySpreads re-running against already-correct
		// materials is a harmless no-visual-op in that case.
		if (open) {
			activeSpreadSet = coverPipeline.ensureSpreadSet(activeRig);
			applySpreads(activeRig, activeSpreadSet);
		}
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
		// Final review fix (Important 1): refuse the claim while EITHER
		// gesture already owns a pointer — see canClaimAnyGesture's doc
		// comment for the exact orphaned-drag/concurrent-drag bugs this
		// prevents. Checked before the raycast (cheaper, and there's no
		// reason to raycast a claim that's going to be refused anyway).
		if (!canClaimAnyGesture(coverPointerId, pagePointerId)) return false;
		if (!raycastCoverHit(event)) return false;
		coverPointerId = event.pointerId;
		coverDragStartClientX = event.clientX;
		coverDragTraveled = false;
		coverDragKindAtStart = readingOpen ? 'cover-close' : 'cover-open';
		// QA round 1 (adjacent fix, "mid-ease cover regrab"): seed `progress`
		// from the cover's actual live angle instead of always starting at 0
		// — otherwise coverOpenAmount (driven 1:1 off `progress` the instant
		// coverDrag.active flips true) evaluates to a hard 0 or 1 on this same
		// frame's updateCoverPivot, snapping the cover instantly to whichever
		// extreme `coverDragKindAtStart` points toward if it was grabbed
		// mid-ease from a just-toggled open/close rather than fully settled.
		// See openAmountFromAngle's/inverseSmoothstep's own doc comments.
		const liveOpenFraction = openAmountFromAngle(coverAngleCurrent);
		const seedProgress =
			coverDragKindAtStart === 'cover-open'
				? inverseSmoothstep(liveOpenFraction)
				: inverseSmoothstep(1 - liveOpenFraction);
		coverDrag = { active: true, kind: coverDragKindAtStart, progress: seedProgress };
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
	function handleCoverPointerUp(event: PointerEvent): boolean {
		if (coverPointerId === null || event.pointerId !== coverPointerId) return false;
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
		refreshControlsEnabled();

		if (!traveled) {
			setReadingOpen(!readingOpen);
		} else if (kind === 'cover-open') {
			setReadingOpen(finalProgress > 0.5);
		} else if (kind === 'cover-close') {
			setReadingOpen(finalProgress <= 0.5);
		}
		experience.requestFrame();
		return true;
	}

	/**
	 * Code-review fix (Task 12 findings, Important 1): `pointercancel` (OS
	 * gesture cancel, palm rejection, touch takeover by a browser gesture)
	 * and `lostpointercapture` (capture lost/revoked out from under us) both
	 * land here via Library3D.svelte's wiring. Unlike handleCoverPointerUp,
	 * this never commits or toggles — an aborted drag isn't a release, it's
	 * "the gesture never happened": clear the drag state and re-enable
	 * OrbitControls exactly like a sub-threshold pointerup, but skip
	 * setReadingOpen entirely so updateCoverPivot's next frame damps
	 * coverAngleCurrent back toward whatever `readingOpen` already was
	 * (coverDrag.active flipping false is what switches it from tracking the
	 * live drag 1:1 back onto the damped settle path) — the same
	 * spring-back the brief's sub-threshold-release case gets, without a
	 * toggle. A no-op if this pointerId isn't the one a drag claimed (e.g.
	 * cancel arrives after close() already cleared coverDrag/coverPointerId
	 * itself, or for an unrelated pointer).
	 */
	function handleCoverPointerCancel(event: PointerEvent): void {
		if (coverPointerId === null || event.pointerId !== coverPointerId) return;
		try {
			experience.renderer.domElement.releasePointerCapture(event.pointerId);
		} catch {
			// See handleCoverPointerDown's matching try/catch.
		}
		coverPointerId = null;
		coverDragKindAtStart = null;
		coverDrag = { active: false, kind: null, progress: 0 };
		refreshControlsEnabled();
		experience.requestFrame();
	}

	/**
	 * Task 14 (§4.4): pointerdown on the container while the book is open and
	 * idle — raycasts `pageSurfaces` and, if hit, claims the drag (pointer
	 * capture, OrbitControls disabled) the same way handleCoverPointerDown
	 * claims a cover drag. Direction/leaf ownership aren't decided yet (see
	 * handlePagePointerMove) — only the pointer is claimed here.
	 *
	 * Critical fix (Task 14 review): must refuse the claim while a
	 * `programmaticTurn` (HUD next/prev ease) is in flight, exactly mirroring
	 * `turnPage`'s own guard — see `canClaimPageDrag`'s doc comment in
	 * pageFlex.ts for the exact double-commit/spring-back bug this prevents.
	 * Before this fix, a page-drag pointerdown mid-ease would claim the
	 * pointer anyway (only `pagePointerId` was checked), letting the drag and
	 * the still-running ease both independently commit the same leaf.
	 */
	function handlePagePointerDown(event: PointerEvent): boolean {
		if (!activeRig || !readingOpen || machine.mode !== 'inspect' || phase !== 'idle') return false;
		// Final review fix (Important 1): refuse the claim while a cover-drag
		// already owns a pointer — canClaimPageDrag alone only arbitrates
		// against programmaticTurn, not against the OTHER pointer-driven
		// gesture. See canClaimAnyGesture's doc comment for the concurrent-
		// drag corruption this prevents.
		if (!canClaimAnyGesture(coverPointerId, pagePointerId)) return false;
		if (!canClaimPageDrag(pagePointerId, programmaticTurn !== null)) return false;
		if (!raycastPageHit(event)) return false;
		pagePointerId = event.pointerId;
		pageDragStartClientX = event.clientX;
		pageDragStartClientY = event.clientY;
		pageDragTraveled = false;
		pageDragDirection = null;
		pageDragLeafIndex = -1;
		pageDragProgress = 0;
		pageDragVelocity = 0;
		pageDragVerticalComponent = 0;
		pageDragLastProgress = 0;
		pageDragLastTimeMs = performance.now();
		controls.enabled = false;
		try {
			experience.renderer.domElement.setPointerCapture(event.pointerId);
		} catch {
			// See handleCoverPointerDown's matching try/catch.
		}
		experience.requestFrame();
		return true;
	}

	/**
	 * Pointermove — a no-op unless `event.pointerId` matches whatever
	 * handlePagePointerDown claimed. §4.4's "direction from initial drag
	 * direction": the first move past the click threshold decides forward
	 * (dragging left, mirrors the cover's own left=open convention) vs.
	 * backward (dragging right), and which leaf that direction owns —
	 * `currentSpread` for forward (the next unturned leaf), `currentSpread -
	 * 1` for backward (the most recently turned leaf) — or leaves the leaf
	 * index unresolved (`-1`, inert — no leaf follows, and release can't
	 * commit) if that direction has nothing left to turn at this end of the
	 * book. Every subsequent move updates progress (px → [0,1], same
	 * bookScreenWidthPx normalization as the cover drag) and the
	 * instantaneous drag velocity (progress/second) + vertical component the
	 * flex spring reads in updateCoverPivot.
	 */
	function handlePagePointerMove(event: PointerEvent): void {
		if (pagePointerId === null || event.pointerId !== pagePointerId || !activeRig) return;
		const deltaX = event.clientX - pageDragStartClientX;
		const deltaY = event.clientY - pageDragStartClientY;
		if (Math.abs(deltaX) > COVER_CLICK_THRESHOLD_PX) pageDragTraveled = true;

		if (pageDragDirection === null) {
			if (!pageDragTraveled) {
				experience.requestFrame();
				return;
			}
			const direction: 1 | -1 = deltaX < 0 ? 1 : -1;
			const canTurn = direction === 1 ? currentSpread < activeSpreadCount() - 1 : currentSpread > 0;
			pageDragDirection = direction;
			pageDragLeafIndex = canTurn ? (direction === 1 ? currentSpread : currentSpread - 1) : -1;
			// Velocity bookkeeping starts fresh from the moment direction (and
			// therefore progress's sign convention) is decided — the
			// "undecided" window before this shouldn't leak into the first
			// velocity sample.
			pageDragLastProgress = 0;
			pageDragLastTimeMs = performance.now();
		}

		const widthPx = bookScreenWidthPx(activeRig);
		const raw = pageDragDirection === 1 ? -deltaX / widthPx : deltaX / widthPx;
		const progress = THREE.MathUtils.clamp(raw, 0, 1);
		const nowMs = performance.now();
		const dtSec = (nowMs - pageDragLastTimeMs) / 1000;
		if (dtSec > 0.0001) {
			pageDragVelocity = (progress - pageDragLastProgress) / dtSec;
		}
		pageDragLastProgress = progress;
		pageDragLastTimeMs = nowMs;
		pageDragProgress = progress;
		pageDragVerticalComponent = deltaY / widthPx;

		experience.requestFrame();
	}

	/**
	 * Pointerup — resolves whatever handlePagePointerDown claimed. Commit vs.
	 * spring-back is decided once, here, via `shouldCommitTurn`: on commit,
	 * `currentSpread` advances immediately (nextSpread) and the announce
	 * fires; either way, clearing `pagePointerId`/`pageDragLeafIndex` is all
	 * that's needed to hand the leaf back to updateCoverPivot's normal
	 * leafTargets/damp path — which, per leafTargets' own contract, now
	 * reads the *post-commit* currentSpread on a commit (so the leaf keeps
	 * easing the way it was already moving) or the *unchanged* currentSpread
	 * on a spring-back (so it eases back to where it started). No dedicated
	 * spring-back code path exists because none is needed.
	 */
	function handlePagePointerUp(event: PointerEvent): boolean {
		if (pagePointerId === null || event.pointerId !== pagePointerId) return false;
		try {
			experience.renderer.domElement.releasePointerCapture(event.pointerId);
		} catch {
			// See handleCoverPointerDown's matching try/catch.
		}
		const leafIndex = pageDragLeafIndex;
		const direction = pageDragDirection;
		const progress = pageDragProgress;
		const velocity = pageDragVelocity;
		pagePointerId = null;
		pageDragDirection = null;
		pageDragLeafIndex = -1;
		refreshControlsEnabled();

		if (leafIndex >= 0 && direction && shouldCommitTurn(progress, Math.abs(velocity))) {
			currentSpread = nextSpread(currentSpread, direction, activeSpreadCount());
			announce(activeSpreadLabels()[currentSpread] ?? '');
		}
		experience.requestFrame();
		return true;
	}

	/**
	 * pointercancel/lostpointercapture recovery for a page drag — mirrors
	 * handleCoverPointerCancel exactly: never commits, just clears the
	 * override so the leaf springs back via the normal damp path.
	 */
	function handlePagePointerCancel(event: PointerEvent): void {
		if (pagePointerId === null || event.pointerId !== pagePointerId) return;
		try {
			experience.renderer.domElement.releasePointerCapture(event.pointerId);
		} catch {
			// See handleCoverPointerDown's matching try/catch.
		}
		pagePointerId = null;
		pageDragDirection = null;
		pageDragLeafIndex = -1;
		refreshControlsEnabled();
		experience.requestFrame();
	}

	/**
	 * Programmatic prev/next page turn (the inspect HUD's page buttons) —
	 * eases the same leaf flow a drag would (progress 0→1 over
	 * PAGE_TURN_DURATION, see updateCoverPivot's `programmaticTurn` branch)
	 * then commits, exactly mirroring a past-threshold drag release. No-ops
	 * at either end of the book (mirrors nextSpread's own clamp — matches
	 * the HUD buttons' own `disabled` state, but guarded here too since
	 * `turnPage` is a public method any future caller might invoke without
	 * checking the button's disabled attribute) and while a gesture already
	 * owns the leaf flow (an in-flight drag, or a turn already in progress —
	 * `canClaimPageDrag`, shared with `handlePagePointerDown`'s symmetric
	 * guard so both directions of the mutual-exclusion rule stay in sync).
	 * Reduced motion (§4.5: "pages jump between spreads with no flex
	 * animation") commits instantly instead of setting up an eased
	 * `programmaticTurn` — the very next frame's reduced-motion branch in
	 * updateCoverPivot already snaps every leaf straight to its
	 * leafTargets() pose from the new `currentSpread`, so no dedicated snap
	 * code is needed here either.
	 */
	function turnPage(direction: 1 | -1): void {
		if (!activeRig || !readingOpen || phase !== 'idle' || machine.mode !== 'inspect') return;
		// Final review fix (Important 1): a programmatic turn is a page-drag
		// claim in every sense but the pointer — refuse it the same way
		// handlePagePointerDown does while a cover-drag is live (e.g. a HUD
		// next-page click landing mid-touch-drag on the cover).
		if (!canClaimAnyGesture(coverPointerId, pagePointerId)) return;
		if (!canClaimPageDrag(pagePointerId, programmaticTurn !== null)) return;
		const target = nextSpread(currentSpread, direction, activeSpreadCount());
		if (target === currentSpread) return;
		const leafIndex = direction === 1 ? currentSpread : currentSpread - 1;

		if (reducedMotion()) {
			currentSpread = target;
			announce(activeSpreadLabels()[currentSpread] ?? '');
			experience.requestFrame();
			return;
		}

		programmaticTurn = { direction, leafIndex, time: 0 };
		experience.requestFrame();
	}

	function resetView(): void {
		if (machine.mode !== 'inspect') return;
		clearOrbitMomentum();
		controls.reset();
		experience.requestFrame();
	}

	/**
	 * Final review fix (Important 3): `computeInspectScale` (used by open()
	 * to size the book once, at open time) reads live `camera.aspect` and
	 * `experience.renderer.domElement.clientWidth` — both of which change on
	 * a container resize, but nothing previously ever revisited the scale
	 * afterward, leaving a book wrongly sized (relative to the new viewport)
	 * for the rest of the inspect session. Library3D.svelte calls this from
	 * its own handleResize, right after `experience.resize()` has already
	 * refreshed `camera.aspect` — see `applySize()`/`resize()` in
	 * experience.ts — so the recomputation below always sees fresh values.
	 *
	 * No-op with no `activeRig` (mode 'shelf' — nothing to resize).
	 *
	 * 'opening'/'closing': a live transition already lerps `root.scale` every
	 * frame from `startBookPose.scale` toward `endBookPose.scale`
	 * (applyBookPose, via `update()`) — snapping `root` directly here would
	 * fight that per-frame lerp and pop. Instead, just correct the captured
	 * `endBookPose.scale` endpoint so the transition's own lerp naturally
	 * arrives at the right value on its very next frame.
	 *
	 * 'idle' / 'settling-cover': the book's pose is otherwise static —
	 * `update()` never touches `root.scale` in either phase — so the new
	 * scale is applied directly.
	 */
	function onResize(): void {
		if (!activeRig) return;
		const scale = computeInspectScale(activeRig);
		if (phase === 'opening' || phase === 'closing') {
			endBookPose = { ...endBookPose, scale };
		} else {
			activeRig.root.scale.setScalar(scale);
		}
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
		handleCoverPointerUp,
		handleCoverPointerCancel,
		get currentSpread() {
			return currentSpread;
		},
		get spreadCount() {
			return activeSpreadCount();
		},
		turnPage,
		handlePagePointerDown,
		handlePagePointerMove,
		handlePagePointerUp,
		handlePagePointerCancel,
		onResize
	};
}
