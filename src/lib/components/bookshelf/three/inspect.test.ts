import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SHELF_CAMERA_POSITION, SHELF_CAMERA_TARGET } from './experience';

// inspect.ts's runtime import of ./textures/pages (for applySpreads) pulls in
// `$lib/api/commands`'s own transitive `$app/environment` import, which this
// repo's bare vitest.config.ts (no SvelteKit vite plugin, `environment:
// 'node'`) can't resolve — mocked at the module boundary before inspect.ts
// is imported, same pattern coverPipeline.test.ts already uses for the same
// reason. Neither function is ever called by the pinShelfCameraAim tests
// below, so the stubs just need to exist.
vi.mock('$lib/api/commands', () => ({
	formatDate: () => '',
	formatFileSize: () => ''
}));

import { pinShelfCameraAim } from './inspect';

// Post-completion regression fix (Task 9): the whole shelf scene rendered
// ~30% higher on screen than SHELF_CAMERA_POSITION/SHELF_CAMERA_TARGET
// dictate — root cause was OrbitControls' constructor unconditionally
// calling its own internal update() once, synchronously, while
// controls.target still held its just-constructed default of (0,0,0),
// re-aiming the camera's orientation at the origin instead of
// SHELF_CAMERA_TARGET. Neither the constructor call nor its update()
// touches the DOM when domElement is null (event listener wiring is the
// only DOM-dependent part, guarded by `if (this.domElement !== null)`), so
// this whole mechanism — and its fix — is reproducible with plain
// THREE/OrbitControls objects under vitest's bare `node` environment, no
// WebGL/jsdom required.
describe('OrbitControls constructor self-inflicted re-aim (Task 9 regression)', () => {
	function freshShelfCamera(): THREE.PerspectiveCamera {
		const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 60);
		camera.position.set(...SHELF_CAMERA_POSITION);
		camera.lookAt(...SHELF_CAMERA_TARGET);
		return camera;
	}

	it('documents the regression mechanism: constructing OrbitControls with its default target mis-aims an already-correctly-aimed camera', () => {
		const camera = freshShelfCamera();
		const correctQuaternion = camera.quaternion.clone();

		// eslint-disable-next-line no-new -- constructing for its side effect on `camera`
		new OrbitControls(camera, null);

		// Position is untouched (verified against OrbitControls.js: update()'s
		// spherical decomposition preserves distance/direction relative to
		// whatever target it's given, so it reconstructs the same position
		// when target is unchanged) — only orientation drifts.
		expect(camera.position.toArray()).toEqual(SHELF_CAMERA_POSITION);

		const driftDegrees = THREE.MathUtils.radToDeg(camera.quaternion.angleTo(correctQuaternion));
		// atan(1.45/6.1) − atan(0.3/6.1) ≈ 10.6°, matching the live-browser
		// symptom (shelf board top at ~39% frame height instead of ~72%).
		expect(driftDegrees).toBeGreaterThan(10);
		expect(driftDegrees).toBeLessThan(11);
	});

	it('pinShelfCameraAim (the production fix) restores exact position, orientation, and controls.target after the constructor mis-aims the camera', () => {
		const camera = freshShelfCamera();
		const correctQuaternion = camera.quaternion.clone();

		const controls = new OrbitControls(camera, null);
		// Sanity: the constructor did mis-aim it (otherwise this test would
		// pass vacuously without the fix doing anything).
		expect(camera.quaternion.angleTo(correctQuaternion)).toBeGreaterThan(0.1);

		pinShelfCameraAim(camera, controls);

		expect(camera.position.toArray()).toEqual(SHELF_CAMERA_POSITION);
		expect(camera.quaternion.angleTo(correctQuaternion)).toBeLessThan(1e-9);
		expect(controls.target.toArray()).toEqual(SHELF_CAMERA_TARGET);
	});

	it('pinShelfCameraAim also recovers from an inspect-session pan/orbit (finishClosing/forceReset belt-and-suspenders)', () => {
		const camera = freshShelfCamera();
		const correctQuaternion = camera.quaternion.clone();
		const controls = new OrbitControls(camera, null);

		// Simulate an inspect session that panned/orbited controls.target
		// away from the shelf target and moved the camera off its shelf pose
		// — the state finishClosing()/forceReset() must recover from.
		controls.target.set(0, 1.35, 0.6);
		camera.position.set(0, 1.42, 3.4);
		camera.lookAt(controls.target);
		// Sanity: confirms the simulated inspect pan actually left the camera
		// pointed away from the shelf target (not a vacuous pass) — smaller
		// threshold than the constructor-drift test above since the inspect
		// pose's own target is much closer to the shelf target than the
		// origin is.
		expect(camera.quaternion.angleTo(correctQuaternion)).toBeGreaterThan(0.01);

		pinShelfCameraAim(camera, controls);

		expect(camera.position.toArray()).toEqual(SHELF_CAMERA_POSITION);
		expect(camera.quaternion.angleTo(correctQuaternion)).toBeLessThan(1e-9);
		expect(controls.target.toArray()).toEqual(SHELF_CAMERA_TARGET);
	});
});
