import { describe, it, expect } from 'vitest';
import {
	SPACING, shouldWrap, wrapOffset, shortestDelta, clampTarget,
	damp, smoothstep, smootherstep, inverseSmoothstep, shelfPose
} from './carouselMath';

describe('wrapping', () => {
	it('wraps only at 5+', () => {
		expect(shouldWrap(4)).toBe(false);
		expect(shouldWrap(5)).toBe(true);
	});
	it('wrapOffset picks the near copy across the seam', () => {
		// 12 books, position at 11: book 0 is +1 away, not -11
		expect(wrapOffset(0, 11, 12, true)).toBe(1);
		expect(wrapOffset(11, 0, 12, true)).toBe(-1);
		expect(wrapOffset(6, 0, 12, true)).toBe(6 - 12); // ties round toward -count/2 side
	});
	it('non-wrap mode is plain subtraction', () => {
		expect(wrapOffset(0, 3, 4, false)).toBe(-3);
	});
	it('shortestDelta goes through the seam when closer', () => {
		expect(shortestDelta(11, 1, 12, true)).toBe(2);
		expect(shortestDelta(1, 11, 12, true)).toBe(-2);
		expect(shortestDelta(1, 3, 12, false)).toBe(2);
	});
	it('clampTarget clamps only when not wrapping', () => {
		expect(clampTarget(-2, 4, false)).toBe(0);
		expect(clampTarget(9, 4, false)).toBe(3);
		expect(clampTarget(-2, 12, true)).toBe(-2);
	});
});

describe('damp/easing', () => {
	it('damp is frame-rate independent', () => {
		// one 0.1s step == two 0.05s steps
		const one = damp(0, 1, 9.5, 0.1);
		const two = damp(damp(0, 1, 9.5, 0.05), 1, 9.5, 0.05);
		expect(one).toBeCloseTo(two, 10);
	});
	it('easings hit exact endpoints', () => {
		expect(smoothstep(0)).toBe(0); expect(smoothstep(1)).toBe(1);
		expect(smootherstep(0)).toBe(0); expect(smootherstep(1)).toBe(1);
		expect(smootherstep(0.5)).toBeCloseTo(0.5, 10);
	});
});

describe('inverseSmoothstep (QA round 1: mid-ease cover regrab continuity)', () => {
	it('hits exact endpoints and midpoint', () => {
		expect(inverseSmoothstep(0)).toBeCloseTo(0, 10);
		expect(inverseSmoothstep(1)).toBeCloseTo(1, 10);
		expect(inverseSmoothstep(0.5)).toBeCloseTo(0.5, 10);
	});
	it('round-trips through smoothstep for a spread of values', () => {
		for (const y of [0.05, 0.18, 0.3, 0.42, 0.6, 0.73, 0.88, 0.97]) {
			expect(smoothstep(inverseSmoothstep(y))).toBeCloseTo(y, 9);
		}
	});
	it('clamps out-of-range input like smoothstep does', () => {
		expect(inverseSmoothstep(-1)).toBeCloseTo(0, 10);
		expect(inverseSmoothstep(2)).toBeCloseTo(1, 10);
	});
});

describe('shelfPose (§4.2 recipe)', () => {
	const shelfTop = 0.47, h = 1.5;
	it('focused book: lifted, forward, upscaled, opaque', () => {
		const p = shelfPose(0, h, shelfTop);
		expect(p.x).toBe(0);
		expect(p.y).toBeCloseTo(shelfTop + h / 2 + 0.15, 10);
		expect(p.z).toBeCloseTo(0.37, 10);
		expect(p.rotY).toBe(0);
		expect(p.scale).toBeCloseTo(1.09, 10);
		expect(p.opacity).toBe(1);
		expect(p.focus).toBe(1);
	});
	it('offset 2: arced away, no lift, full opacity', () => {
		const p = shelfPose(2, h, shelfTop);
		expect(p.x).toBeCloseTo(2 * SPACING, 10);
		expect(p.rotY).toBeCloseTo(-0.21, 10);
		expect(p.rotZ).toBeCloseTo(-0.036, 10);
		expect(p.focus).toBe(0);
		expect(p.opacity).toBe(1);
	});
	it('fade band: opacity 1 at 2.55, 0 at 3.25, monotone between', () => {
		expect(shelfPose(2.55, h, shelfTop).opacity).toBeCloseTo(1, 10);
		expect(shelfPose(3.25, h, shelfTop).opacity).toBeCloseTo(0, 10);
		const mid = shelfPose(2.9, h, shelfTop).opacity;
		expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(1);
	});
});
