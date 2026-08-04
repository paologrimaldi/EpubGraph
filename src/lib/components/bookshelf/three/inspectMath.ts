import * as THREE from 'three';
import type { Pose } from '../types/experience';

export interface PoseTargets {
	position: THREE.Vector3;
	quaternion: THREE.Quaternion;
	scale: THREE.Vector3;
}

const scratchPosition = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();

const lerpPositionA = new THREE.Vector3();
const lerpPositionB = new THREE.Vector3();
const lerpQuaternionA = new THREE.Quaternion();
const lerpQuaternionB = new THREE.Quaternion();

/**
 * World-decomposed snapshot of `object`'s current pose — the deterministic-
 * transition endpoint format (§4.3). Returns a plain-array `Pose`, not live
 * THREE instances, so a captured start/end pair stays immutable for the
 * lifetime of a transition regardless of what else mutates the scene graph
 * (or reuses these scratch vectors) afterward.
 */
export function capturePose(object: THREE.Object3D): Pose {
	object.updateWorldMatrix(true, true);
	object.matrixWorld.decompose(scratchPosition, scratchQuaternion, scratchScale);
	return {
		position: [scratchPosition.x, scratchPosition.y, scratchPosition.z],
		quaternion: [scratchQuaternion.x, scratchQuaternion.y, scratchQuaternion.z, scratchQuaternion.w],
		// Every animated pose in this system is uniformly scaled (`.setScalar`
		// throughout bookRig.ts/carousel.ts) — the x component alone fully
		// represents it, matching `Pose.scale`'s single-number shape.
		scale: scratchScale.x
	};
}

/**
 * Writes the pose at eased time `t` (already run through `smootherstep` by
 * the caller — this function itself does no easing) into `out`. Position and
 * scale lerp linearly in `t`; orientation slerps. `t=0`/`t=1` reproduce `a`/
 * `b` exactly (pinned by inspectMath.test.ts) — the determinism the
 * reference's opening/closing transitions depend on: endpoints are computed
 * once at transition start, and the first/last animated frames must match
 * them bit-for-bit, not just "close enough".
 */
export function lerpPose(a: Pose, b: Pose, t: number, out: PoseTargets): void {
	lerpPositionA.set(a.position[0], a.position[1], a.position[2]);
	lerpPositionB.set(b.position[0], b.position[1], b.position[2]);
	out.position.lerpVectors(lerpPositionA, lerpPositionB, t);

	lerpQuaternionA.set(a.quaternion[0], a.quaternion[1], a.quaternion[2], a.quaternion[3]);
	lerpQuaternionB.set(b.quaternion[0], b.quaternion[1], b.quaternion[2], b.quaternion[3]);
	out.quaternion.slerpQuaternions(lerpQuaternionA, lerpQuaternionB, t);

	out.scale.setScalar(a.scale + (b.scale - a.scale) * t);
}

// Book ≈ 72% of the "safe" width (§4.3) — the canvas width not covered by
// the inspect sidebar.
const SAFE_WIDTH_FRACTION = 0.72;

/**
 * Uniform scale so the inspected book renders at ~72% of the safe width:
 * `(safeWidth/viewport) * 0.72 * (frustumWidthAtBook / bookWidth)`.
 * `frustumWidthAtBook` — the world-space width visible across the *full*
 * viewport at the book's depth (`2·tan(fov/2)·distance·aspect`) — is an
 * explicit parameter rather than derived here from camera/scene state, so
 * this stays pure THREE-math with no WebGL/camera coupling; the caller
 * (inspect.ts) owns fov/distance/aspect alongside its own named,
 * one-line-retunable inspect camera/book position constants.
 */
export function inspectScale(
	bookWidth: number,
	safeWidthPx: number,
	viewportWidthPx: number,
	frustumWidthAtBook: number
): number {
	return (safeWidthPx / viewportWidthPx) * SAFE_WIDTH_FRACTION * (frustumWidthAtBook / bookWidth);
}
