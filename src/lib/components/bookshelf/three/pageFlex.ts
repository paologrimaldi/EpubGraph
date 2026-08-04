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
