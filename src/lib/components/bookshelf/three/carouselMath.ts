export const SPACING = 1.18;
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
