import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { coverDistance, EAGER_RADIUS, QUEUE_RADIUS } from './coverWindow';
import type { RigHandle } from './bookRig';
import type { BookIdentity } from '../types/experience';
import type * as THREE from 'three';

// Pure-logic coverage (§5.3 window math, lives in coverWindow.ts so it's
// importable without dragging in `$lib/api/commands` → `$app/environment`,
// which this repo's bare vitest.config.ts can't resolve). The rest of
// coverPipeline.ts is DOM/network orchestration (Image decode, canvas
// readback, idle scheduling) — see the "coverPipeline orchestration" describe
// block below for that half, added in the Task 10 review pass.

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

// ============================================================
// coverPipeline orchestration (Task 10 review findings 1-3)
// ============================================================
//
// getCoverImage is mocked at the module boundary, before coverPipeline.ts is
// imported, so this file never has to resolve `$lib/api/commands`'s own
// transitive `$app/environment` import — this repo's bare vitest.config.ts
// (no SvelteKit vite plugin, `environment: 'node'`) can't do that. Likewise
// `makeRealCoverTexture` does real <canvas> 2D drawing this Node environment
// has no canvas implementation for, so it's replaced with a controllable
// fake that hands back a `{ dispose: vi.fn() }` stand-in — all
// coverPipeline.ts's orchestration logic (cache/dispose/apply bookkeeping)
// ever does with a CanvasTexture is hold a reference to it and call
// .dispose(), so that's all the fake needs to support.
const { getCoverImageMock, makeRealCoverTextureMock } = vi.hoisted(() => ({
	getCoverImageMock: vi.fn(),
	makeRealCoverTextureMock: vi.fn((..._args: unknown[]) => ({ dispose: vi.fn() }))
}));

vi.mock('$lib/api/commands', () => ({
	getCoverImage: (id: number) => getCoverImageMock(id)
}));

vi.mock('./textures/artwork', () => ({
	makeRealCoverTexture: (...args: unknown[]) => makeRealCoverTextureMock(...args)
}));

import { createCoverPipeline } from './coverPipeline';

const PALETTE = {
	cloth: '#000000',
	foil: '#000000',
	paper: '#000000',
	paperPale: '#000000',
	ink: '#000000',
	floor: '#000000',
	light: '#000000',
	fill: '#000000'
};

function makeIdentity(id: number): BookIdentity {
	return {
		id,
		seed: id,
		size: { width: 0.2, height: 0.3, depth: 0.03 },
		palette: PALETTE,
		motifIndex: 0,
		title: `Book ${id}`,
		author: null,
		series: null,
		seriesIndex: null,
		description: null
	};
}

/** Minimal RigHandle stand-in — coverPipeline.ts only ever reads
 * rig.identity and calls rig.applyRealCover(); it never touches
 * root/motion/pivots/etc, so unlike carousel.test.ts's makeMockRig these
 * don't need to be real THREE objects. `applyRealCoverLog` records every
 * applyRealCover call so tests can inspect exactly which texture(s) landed
 * on a given rig, and how many times. */
function makeMockRig(id: number): RigHandle & { applyRealCoverLog: THREE.CanvasTexture[] } {
	const applyRealCoverLog: THREE.CanvasTexture[] = [];
	return {
		identity: makeIdentity(id),
		root: {} as THREE.Group,
		motion: {} as THREE.Group,
		frontPivot: {} as THREE.Group,
		pagePivots: [],
		pageSurfaces: [],
		hit: {} as THREE.Mesh,
		contactShadow: {} as THREE.Mesh,
		fadeMaterials: [],
		setOpacity() {},
		applyRealCover(tex: THREE.CanvasTexture) {
			applyRealCoverLog.push(tex);
		},
		dispose() {},
		applyRealCoverLog
	};
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** Fake `Image` — decodeImage's only touchpoint. A real Image decodes
 * asynchronously off the network/disk; this stand-in resolves/rejects off
 * its own `src` setter via a microtask, which is enough to exercise
 * coverPipeline.ts's async control flow without an actual image decoder
 * (this Node vitest environment has none). `src === 'BAD_IMAGE_URL'`
 * simulates a decode failure. */
class FakeImage {
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	private _src = '';
	set src(value: string) {
		this._src = value;
		if (value === 'BAD_IMAGE_URL') {
			queueMicrotask(() => this.onerror?.());
		} else {
			queueMicrotask(() => this.onload?.());
		}
	}
	get src(): string {
		return this._src;
	}
}

const VALID_COVER = 'data:image/png;base64,VALID';

describe('coverPipeline orchestration', () => {
	beforeEach(() => {
		getCoverImageMock.mockReset();
		makeRealCoverTextureMock.mockClear();
		vi.stubGlobal('Image', FakeImage);
		vi.stubGlobal('document', {
			createElement: (tag: string) => {
				if (tag !== 'canvas') throw new Error(`unexpected document.createElement(${tag})`);
				// getContext() => null routes extractPalette through its "no ctx"
				// early-return branch. Palette extraction itself (paletteFromCover)
				// has its own coverage elsewhere; this suite is about cache/
				// texture/status orchestration, not pixel math.
				return { width: 0, height: 0, getContext: () => null };
			}
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('(a) removing a hydrated book disposes its cached texture', async () => {
		const rig = makeMockRig(1);
		getCoverImageMock.mockResolvedValueOnce(VALID_COVER);
		const pipeline = createCoverPipeline('low');

		pipeline.hydrate([rig], () => 0);
		await vi.waitFor(() => expect(rig.applyRealCoverLog).toHaveLength(1));
		const texture = rig.applyRealCoverLog[0];
		expect(texture.dispose).not.toHaveBeenCalled();

		pipeline.hydrate([], () => 0);

		expect(texture.dispose).toHaveBeenCalledTimes(1);
	});

	it('(b) [Finding 1] remove-then-re-add while a fetch is in flight: the stale continuation disposes its own texture instead of clobbering the winner', async () => {
		const rigA = makeMockRig(1);
		const deferredA = deferred<string | null>();
		getCoverImageMock.mockReturnValueOnce(deferredA.promise);

		const pipeline = createCoverPipeline('low');
		pipeline.hydrate([rigA], () => 0);
		expect(getCoverImageMock).toHaveBeenCalledTimes(1);

		// Remove the book while book 1's cover fetch is still pending...
		pipeline.hydrate([], () => 0);

		// ...then re-add it as a brand-new RigHandle (exactly what a real
		// diff-based rig rebuild hands the pipeline) before the original
		// fetch has resolved.
		const rigB = makeMockRig(1);
		const deferredB = deferred<string | null>();
		getCoverImageMock.mockReturnValueOnce(deferredB.promise);
		pipeline.hydrate([rigB], () => 0);
		expect(getCoverImageMock).toHaveBeenCalledTimes(2);

		// The fresh (post-re-add) fetch wins the race, resolving first.
		deferredB.resolve(VALID_COVER);
		await vi.waitFor(() => expect(makeRealCoverTextureMock).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(rigB.applyRealCoverLog).toHaveLength(1));
		const survivingTexture = rigB.applyRealCoverLog[0];

		// The stale (pre-removal) fetch resolves after.
		deferredA.resolve(VALID_COVER);
		await vi.waitFor(() => expect(makeRealCoverTextureMock).toHaveBeenCalledTimes(2));
		const staleTexture = makeRealCoverTextureMock.mock.results[1].value as THREE.CanvasTexture;
		await vi.waitFor(() => expect(staleTexture.dispose).toHaveBeenCalledTimes(1));

		// The winner must be untouched by the loser: still the only texture
		// ever applied to rigB, and never disposed.
		expect(rigB.applyRealCoverLog).toEqual([survivingTexture]);
		expect(survivingTexture.dispose).not.toHaveBeenCalled();
		// The loser must never reach the removed rig either.
		expect(rigA.applyRealCoverLog).toEqual([]);
	});

	it('(c) hydrate() called again with the same rigs does not re-fetch a cover already in flight or already settled', async () => {
		const rig = makeMockRig(1);
		const pending = deferred<string | null>();
		getCoverImageMock.mockReturnValueOnce(pending.promise);

		const pipeline = createCoverPipeline('low');
		pipeline.hydrate([rig], () => 0);
		expect(getCoverImageMock).toHaveBeenCalledTimes(1);

		// Re-hydrate with the exact same rig list several times, as
		// Library3D does on every selection change — none of these should
		// kick off a second fetch for the still-inflight id.
		pipeline.hydrate([rig], () => 0);
		pipeline.hydrate([rig], () => 0);
		expect(getCoverImageMock).toHaveBeenCalledTimes(1);

		pending.resolve(VALID_COVER);
		await vi.waitFor(() => expect(rig.applyRealCoverLog).toHaveLength(1));

		// And once settled+cached, further re-hydrates still don't re-fetch.
		pipeline.hydrate([rig], () => 0);
		pipeline.hydrate([rig], () => 0);
		expect(getCoverImageMock).toHaveBeenCalledTimes(1);
	});

	it('[Finding 2] hydrate() called again with the same rig does not re-apply an already-applied cached texture', async () => {
		const rig = makeMockRig(1);
		getCoverImageMock.mockResolvedValueOnce(VALID_COVER);

		const pipeline = createCoverPipeline('low');
		pipeline.hydrate([rig], () => 0);
		await vi.waitFor(() => expect(rig.applyRealCoverLog).toHaveLength(1));

		// Selection changes re-call hydrate() on every navigation — for a rig
		// that's already carrying its cached texture, this must be a no-op,
		// not a repeat applyRealCover() (→ material.needsUpdate churn) on
		// every navigation for every already-hydrated book on the shelf.
		pipeline.hydrate([rig], () => 0);
		pipeline.hydrate([rig], () => 0);
		pipeline.hydrate([rig], () => 0);

		expect(rig.applyRealCoverLog).toHaveLength(1);
	});

	it('(d) dispose() cancels pending idle-queued work', async () => {
		vi.useFakeTimers();
		// n=40 with EAGER_RADIUS=4/QUEUE_RADIUS=30: selecting index 0 puts a
		// handful of indices inside the eager window (fired synchronously by
		// hydrate()) and the rest inside the ±30 queued band, which only ever
		// runs through the idle scheduler. This repo's Node vitest
		// environment has no `requestIdleCallback` global, so
		// coverPipeline.ts's own feature-detected fallback (setTimeout) is
		// exactly what's under test here — no separate requestIdleCallback
		// mock is needed to exercise the same cancel-path code.
		const rigs = Array.from({ length: 40 }, (_, i) => makeMockRig(i + 1));
		getCoverImageMock.mockImplementation(() => new Promise<string | null>(() => {})); // never resolves — irrelevant to this test
		const pipeline = createCoverPipeline('low');

		pipeline.hydrate(rigs, () => 0);
		const callsAfterEagerPass = getCoverImageMock.mock.calls.length;
		expect(callsAfterEagerPass).toBeGreaterThan(0); // the eager window fired synchronously
		expect(callsAfterEagerPass).toBeLessThan(rigs.length); // the rest is queued, not fired yet

		pipeline.dispose();
		await vi.advanceTimersByTimeAsync(5000);

		// No further fetch should ever fire once dispose() cancelled the
		// pending idle-scheduled work.
		expect(getCoverImageMock.mock.calls.length).toBe(callsAfterEagerPass);
	});
});
