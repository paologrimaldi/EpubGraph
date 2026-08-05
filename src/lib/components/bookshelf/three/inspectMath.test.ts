import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { capturePose, lerpPose, inspectScale } from './inspectMath';
import { smootherstep } from './carouselMath';

describe('deterministic transitions (§4.3)', () => {
	const obj = new THREE.Object3D();
	obj.position.set(1.3, 0.9, 0.4);
	obj.rotation.set(0, -0.3, 0.05);
	obj.scale.setScalar(1.09);
	obj.updateMatrixWorld(true);
	const start = capturePose(obj);
	const end = {
		position: [0, 1.45, 0] as [number, number, number],
		quaternion: [0, 0, 0, 1] as [number, number, number, number],
		scale: 1.6
	};
	const out = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3() };

	it('t=0 equals captured start exactly', () => {
		lerpPose(start, end, smootherstep(0), out);
		expect(out.position.x).toBeCloseTo(1.3, 12);
		expect(out.scale.x).toBeCloseTo(1.09, 12);
	});
	it('t=1 equals end exactly', () => {
		lerpPose(start, end, smootherstep(1), out);
		expect(out.position.y).toBeCloseTo(1.45, 12);
		expect(out.quaternion.w).toBeCloseTo(1, 12);
		expect(out.scale.x).toBeCloseTo(1.6, 12);
	});
	it('midpoints are monotone in t for position', () => {
		lerpPose(start, end, 0.25, out);
		const x25 = out.position.x;
		lerpPose(start, end, 0.75, out);
		const x75 = out.position.x;
		expect(Math.abs(end.position[0] - x75)).toBeLessThan(Math.abs(end.position[0] - x25));
	});
});

describe('inspectScale (QA round 1, Finding 2: fit BOTH axes, not width only)', () => {
	// Every real book is portrait (bookRig.ts/artwork.ts clamp width/height
	// aspect to [0.55, 0.85]) — what actually varies in practice, and is what
	// the finding's "wide/short aspects" refers to, is the FRAME's own aspect
	// ratio (viewport width vs. frustum height), not the book's. A wide/short
	// frame (width comfortably larger than height, e.g. a wide desktop window
	// with limited vertical room) is exactly where the old width-only fit
	// overflowed: it had generous width budget to scale the book up by, with
	// nothing capping how tall that made it relative to the frame's own
	// limited height.
	const viewportWidthPx = 1200;
	const safeWidthPx = 1200; // no sidebar subtracted, isolates the width term
	const bookWidth = 0.6; // representative portrait aspect (~0.6 of height)
	const bookHeight = 1;

	it('a wide/short frame is constrained by height, not width — the finding\'s exact repro', () => {
		const frustumWidthAtBook = 4;
		const frustumHeightAtBook = 1.4; // short relative to width — wide/short frame
		const scale = inspectScale(bookWidth, bookHeight, safeWidthPx, viewportWidthPx, frustumWidthAtBook, frustumHeightAtBook);
		const widthFit = (safeWidthPx / viewportWidthPx) * 0.72 * (frustumWidthAtBook / bookWidth);
		const heightFit = 0.82 * (frustumHeightAtBook / bookHeight);
		expect(heightFit).toBeLessThan(widthFit); // sanity: height is the binding constraint here
		expect(scale).toBeCloseTo(heightFit, 10);
		// The whole book's height must fit within 82% of the frame height —
		// exactly the margin the old width-only fit violated.
		expect(bookHeight * scale).toBeLessThanOrEqual(frustumHeightAtBook * 0.82 + 1e-9);
	});

	it('a narrow/tall frame stays constrained by width, as before the fix', () => {
		const frustumWidthAtBook = 1.4; // narrow relative to height
		const frustumHeightAtBook = 4;
		const scale = inspectScale(bookWidth, bookHeight, safeWidthPx, viewportWidthPx, frustumWidthAtBook, frustumHeightAtBook);
		const widthFit = (safeWidthPx / viewportWidthPx) * 0.72 * (frustumWidthAtBook / bookWidth);
		const heightFit = 0.82 * (frustumHeightAtBook / bookHeight);
		expect(widthFit).toBeLessThan(heightFit);
		expect(scale).toBeCloseTo(widthFit, 10);
		expect(bookWidth * scale).toBeLessThanOrEqual(frustumWidthAtBook * (safeWidthPx / viewportWidthPx) * 0.72 + 1e-9);
	});

	it('never exceeds either axis budget regardless of book or frame aspect', () => {
		const bookAspects: Array<[number, number]> = [
			[0.55, 1],
			[0.85, 1],
			[1.6, 0.5],
			[0.4, 1.6],
			[1, 1]
		];
		const frustumAspects: Array<[number, number]> = [
			[4, 1.4], // wide/short frame
			[1.4, 4], // narrow/tall frame
			[3, 2]
		];
		for (const [bookWidth, bookHeight] of bookAspects) {
			for (const [frustumWidthAtBook, frustumHeightAtBook] of frustumAspects) {
				const scale = inspectScale(
					bookWidth,
					bookHeight,
					safeWidthPx,
					viewportWidthPx,
					frustumWidthAtBook,
					frustumHeightAtBook
				);
				const widthFit = (safeWidthPx / viewportWidthPx) * 0.72 * (frustumWidthAtBook / bookWidth);
				const heightFit = 0.82 * (frustumHeightAtBook / bookHeight);
				expect(scale).toBeLessThanOrEqual(widthFit + 1e-9);
				expect(scale).toBeLessThanOrEqual(heightFit + 1e-9);
			}
		}
	});
});
