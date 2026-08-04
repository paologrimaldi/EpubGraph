import { describe, it, expect } from 'vitest';
import { coverDistance, EAGER_RADIUS, QUEUE_RADIUS } from './coverWindow';

// Pure-logic coverage only (§5.3 window math, lives in coverWindow.ts so it's
// importable without dragging in `$lib/api/commands` → `$app/environment`,
// which this repo's bare vitest.config.ts can't resolve). The rest of
// coverPipeline.ts is DOM/network orchestration (Image decode, canvas
// readback, idle scheduling) exercised via the required browser
// self-verification instead, matching this codebase's existing split between
// colocated unit tests for pure modules and manual /dev/shelf verification
// for DOM-touching ones (bookRig.ts, artwork.ts, room.ts, etc. have none
// either).

describe('coverDistance (§5.3 eager/queue window)', () => {
	it('is 0 for the selected index itself', () => {
		expect(coverDistance(3, 3, 8)).toBe(0);
	});

	it('grows with plain (non-wrapping) index distance below the wrap threshold', () => {
		// count < WRAP_MIN(5) never wraps — carouselMath.shouldWrap(count)
		expect(coverDistance(0, 3, 4)).toBe(3);
	});

	it('routes the short way around the seam once wrapping is active', () => {
		// count >= WRAP_MIN(5): index 0 and index 7 of an 8-book wrapped shelf
		// are adjacent through the seam, not 7 apart.
		expect(coverDistance(0, 7, 8)).toBe(1);
	});

	it('is symmetric', () => {
		expect(coverDistance(1, 6, 10)).toBe(coverDistance(6, 1, 10));
	});
});

describe('§5.3 window radii', () => {
	it('eager radius is tighter than the queue radius', () => {
		expect(EAGER_RADIUS).toBeLessThan(QUEUE_RADIUS);
	});

	it('classifies a large library into eager / queued / unqueued bands', () => {
		const n = 80;
		const selected = 40;
		const classify = (index: number): 'eager' | 'queued' | 'unqueued' => {
			const d = coverDistance(selected, index, n);
			if (d <= EAGER_RADIUS) return 'eager';
			if (d <= QUEUE_RADIUS) return 'queued';
			return 'unqueued';
		};
		expect(classify(selected)).toBe('eager');
		expect(classify(selected + EAGER_RADIUS)).toBe('eager');
		expect(classify(selected + EAGER_RADIUS + 1)).toBe('queued');
		expect(classify(selected + QUEUE_RADIUS)).toBe('queued');
		expect(classify(selected + QUEUE_RADIUS + 1)).toBe('unqueued');
	});
});
