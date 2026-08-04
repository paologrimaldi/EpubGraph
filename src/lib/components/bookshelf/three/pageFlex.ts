import type * as THREE from 'three';
import { smoothstep } from './carouselMath';

/**
 * Cover-drag state (§4.4) — owned by inspect.ts, read here purely. `kind`
 * distinguishes which endpoint the drag is easing toward: `'cover-open'`
 * starts from closed (progress 0→1 eases openAmount 0→1), `'cover-close'`
 * starts from open (progress 0→1 eases openAmount 1→0). `progress` is raw
 * (not yet eased) — `coverOpenAmount` applies `smoothstep` itself so callers
 * never hand in pre-eased values.
 */
export interface CoverDrag {
	active: boolean;
	kind: 'cover-open' | 'cover-close' | null;
	progress: number;
}

/**
 * Front-cover open amount ∈ [0, 1] — mirrors the reference
 * `getDetailOpenAmount` recipe: an active drag overrides the settled
 * `readingOpen` state and eases via `smoothstep` (which itself clamps to
 * [0,1], so out-of-range `progress` is handled for free); with no active
 * drag it's the plain settled state, 0 or 1.
 */
export function coverOpenAmount(readingOpen: boolean, drag: CoverDrag): number {
	if (drag.active && drag.kind === 'cover-open') return smoothstep(drag.progress);
	if (drag.active && drag.kind === 'cover-close') return 1 - smoothstep(drag.progress);
	return readingOpen ? 1 : 0;
}

// Fully open stops 0.22rad short of a flat 180° swing (matches the rig's
// frontPivot hinge range documented on RigHandle: rotation.y ∈ [-π+0.2, 0]).
const OPEN_ANGLE = -(Math.PI - 0.22);

/**
 * `openAmount` → `frontPivot.rotation.y`, 0 (closed) … `OPEN_ANGLE` (open).
 * Guards the `openAmount = 0` case explicitly rather than trusting
 * `OPEN_ANGLE * 0` — that product is `-0` (negative × 0 in IEEE754), which
 * reads as "closed" everywhere it's used but isn't `Object.is`-equal to the
 * `0` callers (and this file's own tests) reasonably expect.
 */
export function coverAngle(openAmount: number): number {
	const t = Math.min(Math.max(openAmount, 0), 1);
	return t === 0 ? 0 : OPEN_ANGLE * t;
}

// Shared with carousel.ts's shelf-mode hover-crack (same tuned angle, see
// carousel.ts's own HOVER_CRACK) — re-exported here so inspect.ts's cover
// interactions (Task 12) can depend on pageFlex.ts alone for every open/
// close/crack constant instead of reaching into carousel.ts for one more.
export const HOVER_CRACK = -0.085;

// ============================================================
// Task 13 (§4.5): flexible page-leaf spring + deformation. Still pure — no
// THREE runtime import (just the `BufferAttribute` type for deformSheet's
// signature) and no rig/pivot knowledge, mirroring the cover slice above.
// ============================================================

/** A single leaf's curve/twist spring — `curve` bends the sheet along its
 * width (hinge→free-edge), `twist` ramps that bend across its height; each
 * channel carries its own velocity so `stepFlex` can integrate them
 * independently. */
export interface FlexState {
	curve: number;
	curveVelocity: number;
	twist: number;
	twistVelocity: number;
}

// Brief-specified spring constants — stiffness pulls velocity toward closing
// the (target − x) gap, damping is an exponential per-frame velocity decay
// (bounded in (0, 1] regardless of `dt`, unlike a naive undamped Euler
// spring, which is what keeps a single large-`dt` step from ever adding
// unbounded energy — see pageFlex.test.ts's "large dt" case).
const FLEX_STIFFNESS = 140;
const FLEX_DAMPING = 16;

/** One spring channel: `v += (target−x)·stiffness·dt; v *= e^(−damping·dt); x += v·dt`. */
function stepChannel(x: number, v: number, target: number, dt: number): [x: number, v: number] {
	let nextV = v + (target - x) * FLEX_STIFFNESS * dt;
	nextV *= Math.exp(-FLEX_DAMPING * dt);
	return [x + nextV * dt, nextV];
}

/** Advances a leaf's curve/twist spring one frame toward `targetCurve`/
 * `targetTwist` — both channels step independently via `stepChannel`. */
export function stepFlex(s: FlexState, targetCurve: number, targetTwist: number, dt: number): FlexState {
	const [curve, curveVelocity] = stepChannel(s.curve, s.curveVelocity, targetCurve, dt);
	const [twist, twistVelocity] = stepChannel(s.twist, s.twistVelocity, targetTwist, dt);
	return { curve, curveVelocity, twist, twistVelocity };
}

/**
 * Writes a curl (`curve`) + twist into `out` from `base` — the sheet's
 * pristine, undeformed positions (a flat `PlaneGeometry`, so every vertex's
 * local x/y already spans [-0.5, 0.5]). `u`/`v` remap that span to [0, 1]:
 * `u` runs hinge→free-edge across the leaf's width and drives the bend via a
 * half-sine arch (`sin(u·π)` is 0 at both edges, peak at the midpoint) so a
 * curling page reads as a smooth bulge rather than a hinge-straight ramp;
 * `v` runs across the leaf's height and drives an additional twist ramp
 * centered on the vertical midline (`v − 0.5`), so a nonzero twist tilts the
 * top and bottom edges of the page in opposite directions instead of
 * uniformly offsetting the whole sheet in z. `direction` flips the sign of
 * both terms — which physical side of a turn a leaf is curling toward (Task
 * 13 always passes a fixed `1`; Task 14 wires it to real page-turn
 * gestures).
 *
 * Caller-side responsibility (deliberately not done here, so a caller can
 * batch it — see inspect.ts's per-leaf perf guard, which skips both entirely
 * once a leaf's curve/twist has settled back to ~flat): set
 * `out.needsUpdate = true` and call `geometry.computeVertexNormals()`.
 */
export function deformSheet(
	base: Float32Array,
	out: THREE.BufferAttribute,
	curve: number,
	twist: number,
	direction: 1 | -1
): void {
	for (let i = 0; i < out.count; i++) {
		const u = base[i * 3] + 0.5;
		const v = base[i * 3 + 1] + 0.5;
		const bend = Math.sin(u * Math.PI) * curve * direction;
		const twistRamp = (v - 0.5) * twist * direction;
		out.setZ(i, base[i * 3 + 2] + bend + twistRamp);
	}
}

// A fully turned leaf stops 0.14rad short of a flat 180° swing — mirrors
// coverAngle's OPEN_ANGLE (0.22rad short) so a turned page still shows a
// hair of paper thickness against its neighbor rather than lying perfectly
// flat.
const LEAF_TURNED_ANGLE = -(Math.PI - 0.14);

/**
 * Per-leaf rest/turned target — pure function of the leaf's index against
 * the book's `currentSpread` (how many leaves, counting from the spine, are
 * already turned) and the front cover's `openAmount`. Leaves before
 * `currentSpread` are "turned": `angle` sweeps toward `LEAF_TURNED_ANGLE`
 * and `z` blends toward 1 (the caller lerps that toward
 * `pivot.userData.turnedZ` — this module has no THREE/rig knowledge, see
 * the module doc above). Every other leaf — including *every* leaf while
 * the book is fully closed (`openAmount === 0`), regardless of
 * `currentSpread` — rests at `angle` 0 / `z` 0 (→ `pivot.userData.restZ`).
 */
export function leafTargets(
	leafIndex: number,
	currentSpread: number,
	openAmount: number
): { angle: number; z: number } {
	const t = Math.min(Math.max(openAmount, 0), 1);
	if (t === 0 || leafIndex >= currentSpread) return { angle: 0, z: 0 };
	return { angle: LEAF_TURNED_ANGLE * t, z: t };
}
