import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createCarousel } from './carousel';
import type { RigHandle } from './bookRig';
import type { BookIdentity } from '../types/experience';

// Pure-logic carousel regression tests — mocked RigHandles (plain THREE math
// objects: Group/Mesh construct fine with no WebGL context) so these run
// without a renderer, per the Task 9 review's ask for colocated carousel
// coverage that a WebGL-touching test suite would make expensive/flaky.

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

/** Minimal RigHandle stand-in — carousel.ts only ever reads/writes
 * root/motion/frontPivot transforms, calls setOpacity, and reads
 * identity.id/identity.size.height. `opacityLog` records every setOpacity
 * call so tests can inspect what a given frame committed (real RigHandle's
 * setOpacity writes into material uniforms we have no WebGL context for
 * here). */
function makeMockRig(id: number, height = 0.3): RigHandle & { opacityLog: number[] } {
	const opacityLog: number[] = [];
	const identity: BookIdentity = {
		id,
		seed: id,
		size: { width: 0.2, height, depth: 0.03 },
		palette: PALETTE,
		motifIndex: 0,
		title: `Book ${id}`,
		author: null,
		series: null,
		seriesIndex: null,
		description: null
	};
	return {
		identity,
		root: new THREE.Group(),
		motion: new THREE.Group(),
		frontPivot: new THREE.Group(),
		pagePivots: [],
		pageSurfaces: [],
		hit: new THREE.Mesh(),
		contactShadow: new THREE.Mesh(),
		fadeMaterials: [],
		setOpacity(o: number) {
			opacityLog.push(o);
		},
		applyRealCover() {},
		dispose() {},
		opacityLog
	};
}

function makeCarousel(n: number, reducedRef: { value: boolean }) {
	const shelfStage = new THREE.Group();
	const rigs = Array.from({ length: n }, (_, i) => makeMockRig(i + 1));
	const carousel = createCarousel(shelfStage, {
		shelfTop: 0.47,
		reducedMotion: () => reducedRef.value
	});
	carousel.setRigs(rigs);
	return { carousel, rigs, shelfStage };
}

describe('carousel idle liveness (regression fixed in fc13198)', () => {
	it('a settled shelf with reduced motion off keeps reporting unsettled (idle bob)', () => {
		const reduced = { value: false };
		const { carousel } = makeCarousel(3, reduced);
		carousel.snapAll();
		// Bob is a perpetual sine of elapsed for the focused (and any
		// partially-focused) rig — it never itself eps-settles, so the
		// on-demand frame loop must keep getting told "still moving" even
		// when every eased channel has fully converged.
		expect(carousel.update(1 / 60, 10)).toBe(true);
	});

	it('a settled shelf with reduced motion on reports fully settled (no perpetual repaint)', () => {
		const reduced = { value: true };
		const { carousel } = makeCarousel(3, reduced);
		carousel.snapAll();
		expect(carousel.update(1 / 60, 10)).toBe(false);
	});
});

describe('carousel navigation convergence', () => {
	it('navigateTo converges position/selectedIndex to the target within ~1.5s at 60fps', () => {
		const reduced = { value: false };
		const { carousel } = makeCarousel(4, reduced);
		carousel.navigateTo(3);

		let elapsed = 0;
		for (let i = 0; i < 90; i++) {
			carousel.update(1 / 60, elapsed);
			elapsed += 1 / 60;
		}

		expect(carousel.position).toBeCloseTo(3, 6);
		expect(carousel.selectedIndex).toBe(3);
	});

	it('a wheel nudge converges to the nearest index within ~1.5s at 60fps', () => {
		const reduced = { value: false };
		const { carousel } = makeCarousel(4, reduced);
		carousel.nudge(400); // a single deliberate trackpad-flick-sized impulse

		let elapsed = 0;
		for (let i = 0; i < 90; i++) {
			carousel.update(1 / 60, elapsed);
			elapsed += 1 / 60;
		}

		expect(Number.isInteger(carousel.position)).toBe(true);
		expect(carousel.selectedIndex).toBe(Math.round(carousel.position));
	});
});

describe('carousel seam wrap', () => {
	it('snaps x and drops opacity for the rig that crosses the seam, then eases it back up', () => {
		const reduced = { value: false };
		const { carousel, rigs } = makeCarousel(6, reduced); // >= WRAP_MIN(5): wrapping is active

		// Settle at rest (index 0 selected).
		for (let i = 0; i < 30; i++) carousel.update(1 / 60, i / 60);

		// Shortest-path routes backward through the seam between index 0 and
		// index n-1 rather than sweeping forward across every slot.
		carousel.navigateTo(rigs.length - 1);

		// A seam crossing is detected empirically rather than at a hardcoded
		// frame/index: the wrapped offset (and therefore root.x) is hard-*set*
		// to its new target instead of eased toward it (a large one-frame jump,
		// vs. every other frame's small RIG_LAMBDA-damped step), and opacity is
		// hard-set to 0 in the same instant before easing resumes from there —
		// observable as a sharp one-frame dip even though same-frame easing
		// (large dt would be unrealistic here; this uses real 60fps dt) means
		// the *committed* value isn't literally 0 by the time it's written.
		const prevOpacity = rigs.map((r) => r.opacityLog.at(-1) ?? 1);
		const prevX = rigs.map((r) => r.root.position.x);
		let seamIndex = -1;
		for (let frame = 0; frame < 200 && seamIndex < 0; frame++) {
			carousel.update(1 / 60, 30 / 60 + frame / 60);
			for (let i = 0; i < rigs.length; i++) {
				const opacity = rigs[i].opacityLog.at(-1)!;
				const opacityDrop = prevOpacity[i] - opacity;
				const xJump = Math.abs(rigs[i].root.position.x - prevX[i]);
				// Every other rig's per-frame drift under RIG_LAMBDA damping is
				// small and smooth — a drop/jump this large in a single frame is
				// the seam snap, not ordinary easing.
				if (opacityDrop > 0.15 && xJump > 0.3) seamIndex = i;
				prevOpacity[i] = opacity;
				prevX[i] = rigs[i].root.position.x;
			}
		}

		expect(seamIndex).toBeGreaterThanOrEqual(0);
		const seamRig = rigs[seamIndex];
		const dippedOpacity = seamRig.opacityLog.at(-1)!;
		expect(dippedOpacity).toBeLessThan(0.15);

		// Subsequent normal-dt frames ease the seam-hidden rig's opacity back
		// up from the dip.
		carousel.update(1 / 60, 1000);
		carousel.update(1 / 60, 1000 + 1 / 60);
		carousel.update(1 / 60, 1000 + 2 / 60);

		expect(seamRig.opacityLog.at(-1)!).toBeGreaterThan(dippedOpacity);
	});
});
