import { describe, it, expect } from 'vitest';
import { coverOpenAmount, coverAngle } from './pageFlex';

describe('coverOpenAmount', () => {
	it('closed book, no drag → 0; open book → 1', () => {
		expect(coverOpenAmount(false, { active: false, kind: null, progress: 0 })).toBe(0);
		expect(coverOpenAmount(true, { active: false, kind: null, progress: 0 })).toBe(1);
	});
	it('drag-open eases progress; endpoints exact', () => {
		expect(coverOpenAmount(false, { active: true, kind: 'cover-open', progress: 0 })).toBe(0);
		expect(coverOpenAmount(false, { active: true, kind: 'cover-open', progress: 1 })).toBe(1);
	});
	it('drag-close inverts from open', () => {
		expect(coverOpenAmount(true, { active: true, kind: 'cover-close', progress: 1 })).toBe(0);
	});
});
describe('coverAngle', () => {
	it('0 → 0, 1 → open angle, monotone', () => {
		expect(coverAngle(0)).toBe(0);
		expect(coverAngle(1)).toBeCloseTo(-(Math.PI - 0.22), 10);
		expect(coverAngle(0.5)).toBeLessThan(0);
	});
});
