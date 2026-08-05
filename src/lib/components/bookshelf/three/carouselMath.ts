export const SPACING = 1.34;
export const WRAP_MIN = 5;

export const shouldWrap = (count: number) => count >= WRAP_MIN;

export function wrapOffset(index: number, position: number, count: number, wrap: boolean): number {
	let o = index - position;
	if (wrap && count > 0) o -= Math.round(o / count) * count;
	return o;
}

export function shortestDelta(from: number, to: number, count: number, wrap: boolean): number {
	let d = to - from;
	if (wrap && count > 0) d -= Math.round(d / count) * count;
	return d;
}

export function clampTarget(target: number, count: number, wrap: boolean): number {
	return wrap ? target : Math.min(Math.max(target, 0), Math.max(count - 1, 0));
}

export function damp(current: number, target: number, lambda: number, dt: number): number {
	return target + (current - target) * Math.exp(-lambda * dt);
}

const clamp01 = (t: number) => Math.min(Math.max(t, 0), 1);
export const smoothstep = (t: number) => { const c = clamp01(t); return c * c * (3 - 2 * c); };
export const smootherstep = (t: number) => { const c = clamp01(t); return c * c * c * (c * (c * 6 - 15) + 10); };

/**
 * Closed-form inverse of `smoothstep` (the cubic `3x²-2x³`, solved via the
 * standard trigonometric depressed-cubic substitution) — given a *target*
 * eased value `y`, returns the raw `x` that `smoothstep(x)` would reproduce.
 * QA round 1 (adjacent fix, "mid-ease cover regrab"): a cover-drag pointerdown
 * previously always seeded `coverDrag.progress = 0`, so `coverOpenAmount`
 * evaluated to 0 or 1 on the very first frame of a *re*-grab — snapping the
 * cover instantly to the opposite extreme if the user grabbed it while it was
 * still mid-ease from a just-toggled open/close. Seeding `progress` from this
 * inverse instead makes `coverOpenAmount` reproduce the cover's actual live
 * angle on that first frame, so a regrab picks up continuously. Exact at the
 * endpoints and the midpoint (`inverseSmoothstep(0) = 0`,
 * `inverseSmoothstep(1) = 1`, `inverseSmoothstep(0.5) = 0.5`) — see
 * carouselMath.test.ts's round-trip coverage.
 */
export function inverseSmoothstep(y: number): number {
	const c = clamp01(y);
	const clamped = Math.min(Math.max(1 - 2 * c, -1), 1);
	return 0.5 - Math.sin(Math.asin(clamped) / 3);
}

export interface ShelfPose {
	x: number; y: number; z: number;
	rotY: number; rotZ: number;
	scale: number; opacity: number; focus: number;
}

export function shelfPose(offset: number, bookHeight: number, shelfTop: number): ShelfPose {
	const distance = Math.abs(offset);
	const focus = 1 - clamp01(distance);
	return {
		x: offset * SPACING,
		y: shelfTop + bookHeight * 0.5 + focus * 0.15,
		z: 0.13 + focus * 0.24 - Math.min(distance, 2.8) * 0.07,
		rotY: (-offset * 0.105) || 0,
		rotZ: (-offset * 0.018) || 0,
		scale: 1 + focus * 0.09,
		opacity: 1 - smoothstep((distance - 2.55) / 0.7),
		focus
	};
}
