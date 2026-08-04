import { describe, it, expect } from 'vitest';
import { createModeMachine } from './state';

describe('mode machine', () => {
	it('starts on shelf and walks the legal ring', () => {
		const m = createModeMachine();
		expect(m.mode).toBe('shelf');
		expect(m.to('opening')).toBe(true);
		expect(m.to('inspect')).toBe(true);
		expect(m.to('closing')).toBe(true);
		expect(m.to('shelf')).toBe(true);
	});
	it('rejects illegal jumps without changing mode', () => {
		const m = createModeMachine();
		expect(m.to('inspect')).toBe(false);
		expect(m.to('closing')).toBe(false);
		expect(m.mode).toBe('shelf');
		m.to('opening');
		expect(m.to('shelf')).toBe(false); // opening cannot abort backwards
		expect(m.mode).toBe('opening');
	});
	it('can() predicts to() without mutating', () => {
		const m = createModeMachine();
		expect(m.can('opening')).toBe(true);
		expect(m.can('inspect')).toBe(false);
		expect(m.mode).toBe('shelf');
	});
});
