import type * as THREE from 'three';
import { getCoverImage } from '$lib/api/commands';
import type { RigHandle } from './bookRig';
import type { BookPalette } from '../types/experience';
import { paletteFromCover } from './bookIdentity';
import { makeRealCoverTexture } from './textures/artwork';
import { makeSpreads, type SpreadSet } from './textures/pages';
import { EAGER_RADIUS, QUEUE_RADIUS, coverDistance, clampIndex } from './coverWindow';

// ============================================================
// Cover pipeline (§5.2/§5.3, Task 10) — async real-cover hydration + palette
// extraction, lazily fanned out from the selected book outward so the shelf
// never blocks on network/decode work.
//
// Texture ownership (documented once, here, since it's the load-bearing
// decision for this module): this pipeline — not the rig — owns every
// `THREE.CanvasTexture` it ever hands to `RigHandle.applyRealCover`. The
// cache below is keyed by book id and outlives individual `RigHandle`
// instances (rig rebuilds are diff-based in Library3D.svelte; survivors keep
// their rig, but even a brand-new rig for a re-added id gets its texture
// re-applied from cache instead of re-fetched). `dispose()` is therefore the
// only place a pipeline-owned texture is ever freed.
//
// This is safe against double-free: `RigHandle.dispose()` (bookRig.ts) only
// disposes the geometries/materials it tracked at construction time plus
// `art.dispose()` — the *original* `makeArtwork()` CoverArtSet (procedural
// cover/foil/spine/back/endpaper). `applyRealCover(tex)` reassigns
// `front.artMaterial.map` to the pipeline's `tex`, but never stores `tex`
// anywhere `art.dispose()` (or anything else in bookRig.ts) walks — the
// original `art.cover` texture that `art.dispose()` frees is a *different*
// texture object, orphaned from the material but still safe to dispose on
// its own. So a rig disposing itself never touches pipeline-owned memory,
// and no change to bookRig.ts was needed to make that true.
//
// Task 15 (§4.4): `ensureSpreadSet` extends the exact same ownership pattern
// to generated interior-page textures — a second id-keyed cache
// (`spreadSetById`), built lazily (only when inspect.ts's `setReadingOpen`
// first calls it for a given book, not eagerly for the whole shelf like the
// cover cache above), diffed/disposed by the same `hydrate()` removed-id
// pass and `dispose()`. `applySpreads` (textures/pages.ts) only ever
// assigns `SpreadSet.textures` onto a rig's leaf-sheet material `.map`,
// never disposes them — same split as `applyRealCover` above.
// ============================================================

export interface CoverPipeline {
	hydrate(rigs: RigHandle[], selectedIndex: () => number): void;
	onPalette(cb: (bookId: number, palette: BookPalette) => void): void;
	// Task 15: lazily builds (or returns the already-cached) SpreadSet for
	// `rig.identity.id` — the pipeline owns and disposes it (see module doc
	// above); callers (inspect.ts) apply it to a rig via textures/pages.ts's
	// `applySpreads` themselves, since this pipeline never touches rig
	// geometry/materials directly (mirrors how it never calls
	// `rig.applyRealCover` — `hydrate`'s caller-side loop does that too).
	ensureSpreadSet(rig: RigHandle): SpreadSet;
	dispose(): void;
}

type Quality = 'low' | 'medium' | 'high';
type Status = 'queued' | 'inflight' | 'settled';

interface CacheEntry {
	image: HTMLImageElement;
	texture: THREE.CanvasTexture | null;
	palette: BookPalette | null;
}

const SAMPLE_SIZE = 32; // paletteFromCover's coarse-histogram sample canvas
const IDLE_FALLBACK_MS = 200; // setTimeout stand-in where requestIdleCallback is absent (e.g. WKWebView)

const HAS_IDLE_CALLBACK = typeof requestIdleCallback === 'function';

function requestIdle(cb: () => void): number {
	if (HAS_IDLE_CALLBACK) return requestIdleCallback(() => cb());
	return setTimeout(cb, IDLE_FALLBACK_MS) as unknown as number;
}

function cancelIdle(handle: number): void {
	if (HAS_IDLE_CALLBACK) cancelIdleCallback(handle);
	else clearTimeout(handle);
}

function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error('cover image failed to decode'));
		image.src = dataUrl;
	});
}

/** Downsamples onto a 32×32 canvas for `paletteFromCover`'s coarse histogram — full-res readback would be wasted work. */
function extractPalette(image: HTMLImageElement): BookPalette | null {
	const canvas = document.createElement('canvas');
	canvas.width = SAMPLE_SIZE;
	canvas.height = SAMPLE_SIZE;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
	try {
		return paletteFromCover(ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
	} catch (err) {
		// getCoverImage's data: URL is same-origin by construction, so a tainted-
		// canvas SecurityError shouldn't be reachable — guarded defensively
		// anyway per §7 (never throw out of this module).
		console.debug('coverPipeline: getImageData failed, skipping palette extraction', err);
		return null;
	}
}

export function createCoverPipeline(quality: Quality): CoverPipeline {
	let disposed = false;
	let currentRigs: RigHandle[] = [];
	let rigById = new Map<number, RigHandle>();
	let getSelectedIndex: () => number = () => 0;
	let paletteCb: ((bookId: number, palette: BookPalette) => void) | null = null;

	const cache = new Map<number, CacheEntry>();
	const statusById = new Map<number, Status>();
	// Per-id generation counter (Task 10 review Finding 1). hydrate() bumps an
	// id's entry here whenever that id falls out of the current rig list.
	// Deliberately never deleted/reset — only ever incremented — so the
	// comparison in processBook() below stays valid across however many
	// remove/re-add cycles happen while an old fetch is still in flight.
	// Unbounded but negligible (one integer per book id ever seen in this
	// pipeline instance's lifetime).
	const epochById = new Map<number, number>();
	// Tracks, per RigHandle *instance*, the exact texture object last applied
	// to it (Finding 2) — lets reapplyCached tell "already carries this
	// texture, no-op" apart from "genuinely needs it applied" without needing
	// any new accessor on RigHandle itself. A WeakMap so a disposed/replaced
	// rig's entry is simply dropped with it, no manual cleanup required.
	const appliedTextureByRig = new WeakMap<RigHandle, THREE.CanvasTexture>();
	let pendingQueue: number[] = [];
	let idleHandle: number | null = null;

	// Task 15: lazy per-book SpreadSet cache — see module doc and
	// ensureSpreadSet() below. Unlike `cache` above, entries here are only
	// ever created on demand (a book the reader never opens never gets one).
	const spreadSetById = new Map<number, SpreadSet>();

	function ensureSpreadSet(rig: RigHandle): SpreadSet {
		const id = rig.identity.id;
		const existing = spreadSetById.get(id);
		if (existing) return existing;
		const set = makeSpreads(rig.identity, quality);
		spreadSetById.set(id, set);
		return set;
	}

	function firePalette(bookId: number, palette: BookPalette): void {
		paletteCb?.(bookId, palette);
	}

	/** Re-applies an already-cached texture/palette to a rig — used both for a fresh cache hit and for a rig rebuilt/re-added after its cover was already hydrated. */
	function reapplyCached(rig: RigHandle, entry: CacheEntry): void {
		// Finding 2: hydrate() re-runs on every selection change, so without
		// this guard every already-hydrated rig on the shelf would re-run
		// applyRealCover (→ material.needsUpdate churn) on every single
		// navigation, not just the rig that actually changed.
		if (entry.texture && appliedTextureByRig.get(rig) !== entry.texture) {
			rig.applyRealCover(entry.texture);
			appliedTextureByRig.set(rig, entry.texture);
		}
		// Reference check, not a dirty flag: a survivor rig already carries the
		// exact cached palette object from a prior pass (no-op here); a fresh
		// rig instance (new identity object, seed-based default palette) does
		// not, so this only fires the re-theme hook when it's actually new.
		if (entry.palette && rig.identity.palette !== entry.palette) {
			rig.identity.palette = entry.palette;
			firePalette(rig.identity.id, entry.palette);
		}
	}

	async function processBook(id: number): Promise<void> {
		// Generation stamp for this fetch attempt (Finding 1), captured
		// synchronously here — before any await — so it reflects whatever
		// epoch was current the instant this attempt was kicked off. If this
		// id is removed and re-added (a brand-new RigHandle for the same id)
		// before this attempt resolves, hydrate() bumps epochById for it and
		// a second, independent processBook(id) call starts carrying the
		// bumped value while this one still carries the old one — isStale()
		// lets the loser recognize itself right before it would otherwise
		// overwrite cache/rig state that the winner already claimed.
		const epoch = epochById.get(id) ?? 0;
		const isStale = (): boolean => (epochById.get(id) ?? 0) !== epoch;

		try {
			let dataUrl: string | null;
			try {
				dataUrl = await getCoverImage(id);
			} catch (err) {
				// The expected path in a plain-browser dev harness (no Tauri IPC) —
				// §7: never throw, keep the procedural identity, log at debug only.
				console.debug(`coverPipeline: getCoverImage(${id}) rejected — keeping procedural cover`, err);
				if (!isStale()) statusById.set(id, 'settled');
				return;
			}
			if (disposed) return;
			if (!dataUrl) {
				console.debug(`coverPipeline: no cover for book ${id} — keeping procedural cover`);
				if (!isStale()) statusById.set(id, 'settled');
				return;
			}

			let image: HTMLImageElement;
			try {
				image = await decodeImage(dataUrl);
			} catch (err) {
				console.debug(`coverPipeline: cover decode failed for book ${id} — keeping procedural cover`, err);
				if (!isStale()) statusById.set(id, 'settled');
				return;
			}
			if (disposed) return;

			const rig = rigById.get(id);
			if (!rig) {
				// The book was removed from the shelf while its cover was in
				// flight. Deliberately left un-settled/un-cached (not a real
				// failure) so a future hydrate() — the book re-added later —
				// retries cleanly instead of being permanently skipped.
				return;
			}

			const texture = makeRealCoverTexture(rig.identity, image, quality);
			const palette = extractPalette(image);

			if (isStale()) {
				// A second processBook(id) attempt — started after this id was
				// removed and re-added while this one was still in flight —
				// has already claimed (or will claim) this id's cache entry.
				// This continuation lost the race: its texture was never
				// handed to cache.set/applyRealCover, so nothing else will
				// ever free it — dispose it here instead of leaking it.
				texture.dispose();
				return;
			}

			cache.set(id, { image, texture, palette });
			statusById.set(id, 'settled');

			rig.applyRealCover(texture);
			appliedTextureByRig.set(rig, texture);
			if (palette) {
				rig.identity.palette = palette;
				firePalette(id, palette);
			}
		} catch (err) {
			// Belt-and-suspenders: every awaited path above already handles its
			// own failure, but a synchronous throw from canvas/texture work must
			// still never escape this async function as an unhandled rejection.
			console.debug(`coverPipeline: unexpected failure hydrating book ${id} — keeping procedural cover`, err);
			if (!isStale()) statusById.set(id, 'settled');
		}
	}

	/** Pops the queued id nearest the CURRENT selection — re-sorted fresh on every pop, not just at enqueue time (§5.3). */
	function popNearest(): number | undefined {
		if (pendingQueue.length === 0) return undefined;
		const n = currentRigs.length;
		const selected = clampIndex(getSelectedIndex(), n);
		let bestPos = 0;
		let bestDistance = Infinity;
		for (let i = 0; i < pendingQueue.length; i++) {
			const rig = rigById.get(pendingQueue[i]);
			const rigIndex = rig ? currentRigs.indexOf(rig) : -1;
			const distance = rigIndex < 0 ? Infinity : coverDistance(selected, rigIndex, n);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestPos = i;
			}
		}
		const [id] = pendingQueue.splice(bestPos, 1);
		return id;
	}

	function scheduleIdleTick(): void {
		if (disposed || idleHandle !== null || pendingQueue.length === 0) return;
		idleHandle = requestIdle(processNextInQueue);
	}

	function processNextInQueue(): void {
		idleHandle = null;
		if (disposed) return;
		const id = popNearest();
		if (id === undefined) return;
		const rig = rigById.get(id);
		if (!rig || cache.has(id) || statusById.get(id) === 'settled') {
			scheduleIdleTick();
			return;
		}
		statusById.set(id, 'inflight');
		processBook(id).finally(scheduleIdleTick);
	}

	function hydrate(rigs: RigHandle[], selectedIndexFn: () => number): void {
		if (disposed) return;
		currentRigs = rigs;
		getSelectedIndex = selectedIndexFn;
		const previousRigById = rigById;
		rigById = new Map(rigs.map((rig) => [rig.identity.id, rig]));
		const currentIds = rigById; // Map already gives us has()/keys() for the diff below

		// Removed ids: this cache is pipeline-owned (see module doc), so this
		// is also where their textures actually get freed.
		for (const [id, entry] of cache) {
			if (!currentIds.has(id)) {
				entry.texture?.dispose();
				cache.delete(id);
			}
		}
		// Task 15: same removed-id sweep for the SpreadSet cache — a book that
		// falls out of the shelf entirely shouldn't keep its generated page
		// textures alive forever.
		for (const [id, set] of spreadSetById) {
			if (!currentIds.has(id)) {
				set.dispose();
				spreadSetById.delete(id);
			}
		}
		for (const id of statusById.keys()) {
			if (!currentIds.has(id)) statusById.delete(id);
		}
		// Finding 1: bump the generation for every id that just fell out of
		// the rig list, sourced from the *previous* rigById (not epochById's
		// own keys, which would miss an id's very first removal) — this is
		// what lets processBook() tell a stale, pre-removal continuation
		// apart from a fresh one kicked off after a later re-add.
		for (const id of previousRigById.keys()) {
			if (!currentIds.has(id)) epochById.set(id, (epochById.get(id) ?? 0) + 1);
		}
		pendingQueue = pendingQueue.filter((id) => currentIds.has(id));

		const n = rigs.length;
		const selected = clampIndex(selectedIndexFn(), n);

		for (let i = 0; i < n; i++) {
			const rig = rigs[i];
			const id = rig.identity.id;

			const cached = cache.get(id);
			if (cached) {
				reapplyCached(rig, cached);
				continue;
			}

			const status = statusById.get(id);
			if (status === 'settled' || status === 'inflight') continue;

			const distance = coverDistance(selected, i, n);

			if (distance <= EAGER_RADIUS) {
				if (status === 'queued') pendingQueue = pendingQueue.filter((qid) => qid !== id);
				statusById.set(id, 'inflight');
				processBook(id);
			} else if (distance <= QUEUE_RADIUS) {
				if (status !== 'queued') {
					statusById.set(id, 'queued');
					pendingQueue.push(id);
				}
			}
			// else: beyond ±30 — left unattempted; re-evaluated the next time
			// hydrate() runs (Library3D calls this again on every selection
			// change, which is the "cheap hook" that re-scores the window).
		}

		scheduleIdleTick();
	}

	function dispose(): void {
		disposed = true;
		if (idleHandle !== null) {
			cancelIdle(idleHandle);
			idleHandle = null;
		}
		pendingQueue = [];
		statusById.clear();
		epochById.clear();
		rigById = new Map();
		currentRigs = [];
		for (const entry of cache.values()) entry.texture?.dispose();
		cache.clear();
		for (const set of spreadSetById.values()) set.dispose();
		spreadSetById.clear();
		paletteCb = null;
	}

	return {
		hydrate,
		onPalette(cb) {
			paletteCb = cb;
		},
		ensureSpreadSet,
		dispose
	};
}
