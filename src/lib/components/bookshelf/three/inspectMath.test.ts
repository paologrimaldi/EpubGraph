import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { capturePose, lerpPose } from './inspectMath';
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
