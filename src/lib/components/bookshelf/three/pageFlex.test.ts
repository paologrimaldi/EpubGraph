import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { coverOpenAmount, coverAngle, stepFlex, deformSheet, leafTargets, type FlexState } from './pageFlex';

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

describe('stepFlex', () => {
	it('converges to target and stays finite', () => {
		let s: FlexState = { curve: 0, curveVelocity: 0, twist: 0, twistVelocity: 0 };
		for (let i = 0; i < 600; i++) s = stepFlex(s, 0.4, -0.1, 1 / 120);
		expect(s.curve).toBeCloseTo(0.4, 2);
		expect(s.twist).toBeCloseTo(-0.1, 2);
		expect(Number.isFinite(s.curveVelocity)).toBe(true);
		expect(Number.isFinite(s.twistVelocity)).toBe(true);
	});
	it('large dt does not explode', () => {
		let s: FlexState = { curve: 0, curveVelocity: 0, twist: 0, twistVelocity: 0 };
		for (let i = 0; i < 60; i++) s = stepFlex(s, 0.4, 0, 0.05);
		expect(Math.abs(s.curve)).toBeLessThan(2);
		expect(Number.isFinite(s.curve)).toBe(true);
	});
	it('idle state (target 0) stays at rest', () => {
		let s: FlexState = { curve: 0, curveVelocity: 0, twist: 0, twistVelocity: 0 };
		for (let i = 0; i < 30; i++) s = stepFlex(s, 0, 0, 1 / 60);
		expect(s.curve).toBe(0);
		expect(s.twist).toBe(0);
		expect(s.curveVelocity).toBe(0);
		expect(s.twistVelocity).toBe(0);
	});
});

describe('leafTargets', () => {
	it('leaves before currentSpread are turned, after are resting', () => {
		expect(leafTargets(0, 2, 1).angle).toBeLessThan(-2);
		expect(leafTargets(4, 2, 1).angle).toBe(0);
	});
	it('closed book (openAmount 0) keeps all leaves at rest', () => {
		expect(leafTargets(0, 2, 0).angle).toBe(0);
		expect(leafTargets(0, 2, 0).z).toBe(0);
	});
	it('turned leaf z blends toward 1 (caller lerps to userData.turnedZ)', () => {
		expect(leafTargets(0, 2, 1).z).toBe(1);
		expect(leafTargets(4, 2, 1).z).toBe(0);
	});
	it('mid-openAmount scales the turned angle/z proportionally', () => {
		const target = leafTargets(0, 2, 0.5);
		expect(target.angle).toBeCloseTo(-(Math.PI - 0.14) * 0.5, 10);
		expect(target.z).toBeCloseTo(0.5, 10);
	});
});

describe('deformSheet', () => {
	// A tiny 3-vertex "plane" spanning local x [-0.5, 0.5], y fixed at 0 (so
	// v = 0.5 throughout — isolates the bend term from twist).
	function makeBase(): { base: Float32Array; attr: THREE.BufferAttribute } {
		// x: -0.5, 0, 0.5 — hinge edge, midpoint, free edge (u = 0, 0.5, 1).
		const base = new Float32Array([-0.5, 0, 0, 0, 0, 0, 0.5, 0, 0]);
		const attr = new THREE.BufferAttribute(base.slice(), 3);
		return { base, attr };
	}

	it('bends the midpoint, leaves both edges at base z (sin(0)=sin(π)=0)', () => {
		const { base, attr } = makeBase();
		deformSheet(base, attr, 0.3, 0, 1);
		// Float32-backed attribute — Float32Array precision (~1e-7), not Float64.
		expect(attr.getZ(0)).toBeCloseTo(0, 5);
		expect(attr.getZ(1)).toBeCloseTo(0.3, 5);
		expect(attr.getZ(2)).toBeCloseTo(0, 5);
	});

	it('direction flips the sign of the bend', () => {
		const { base, attr } = makeBase();
		deformSheet(base, attr, 0.3, 0, -1);
		expect(attr.getZ(1)).toBeCloseTo(-0.3, 5);
	});

	it('zero curve/twist leaves positions at base z', () => {
		const { base, attr } = makeBase();
		deformSheet(base, attr, 0, 0, 1);
		expect(attr.getZ(0)).toBe(0);
		expect(attr.getZ(1)).toBe(0);
		expect(attr.getZ(2)).toBe(0);
	});

	it('does not touch the attribute version itself (needsUpdate is caller-side)', () => {
		// BufferAttribute.needsUpdate is a write-only setter that bumps
		// .version — reading .version (rather than .needsUpdate, which has no
		// getter and always reads back `undefined`) is what actually proves
		// deformSheet never marks the attribute dirty itself.
		const { base, attr } = makeBase();
		const versionBefore = attr.version;
		deformSheet(base, attr, 0.3, 0, 1);
		expect(attr.version).toBe(versionBefore);
	});
});
