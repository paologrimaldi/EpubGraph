import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
	coverOpenAmount,
	coverAngle,
	stepFlex,
	deformSheet,
	leafTargets,
	shouldCommitTurn,
	nextSpread,
	canClaimPageDrag,
	canClaimAnyGesture,
	shouldResetSpreadOnClose,
	type FlexState,
	type CoverDrag
} from './pageFlex';

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

describe('shouldCommitTurn (§4.4: committed page never springs back)', () => {
	it('past midpoint commits regardless of velocity', () => {
		expect(shouldCommitTurn(0.51, 0)).toBe(true);
	});
	it('flick commits early', () => {
		expect(shouldCommitTurn(0.2, 2.0)).toBe(true);
		expect(shouldCommitTurn(0.2, 0.5)).toBe(false);
	});
	it('small drags spring back', () => {
		expect(shouldCommitTurn(0.1, 5)).toBe(false);
	});
});

describe('nextSpread', () => {
	it('clamps at both ends', () => {
		expect(nextSpread(0, -1, 4)).toBe(0);
		expect(nextSpread(3, 1, 4)).toBe(3);
		expect(nextSpread(1, 1, 4)).toBe(2);
	});
});

describe('canClaimPageDrag (Task 14 review fix: mutual exclusion with programmaticTurn)', () => {
	it('allows a claim when nothing owns the leaf flow', () => {
		expect(canClaimPageDrag(null, false)).toBe(true);
	});

	it('refuses a claim while a drag already owns the pointer', () => {
		expect(canClaimPageDrag(7, false)).toBe(false);
	});

	it('refuses a claim while a programmatic turn is in flight', () => {
		expect(canClaimPageDrag(null, true)).toBe(false);
	});

	it('refuses a claim when both would somehow be true at once', () => {
		expect(canClaimPageDrag(7, true)).toBe(false);
	});

	it('regression: HUD turnPage() followed immediately by a page-drag claim, within the ease window, is refused — the drag must not be able to double-commit the spread turnPage() already started', () => {
		// Simulates the exact interleaving from the Task 14 review: a HUD
		// next-arrow click starts an eased programmatic turn (turnPage's own
		// guard already passed — nothing owned the leaf flow yet); before that
		// ease reaches PAGE_TURN_DURATION and commits, a page-drag pointerdown
		// arrives on the same leaf.
		let currentSpread = 0;
		const spreadCount = 4;
		const pagePointerId: number | null = null;

		// Before the HUD click: nothing owns the leaf flow, so turnPage(1)'s
		// own guard passes and it sets `programmaticTurn = { direction: 1, ... }`.
		let programmaticTurnActive = false;
		expect(canClaimPageDrag(pagePointerId, programmaticTurnActive)).toBe(true); // turnPage's own guard passes here
		programmaticTurnActive = true; // turnPage() just started its ease

		// A page-drag pointerdown now arrives mid-ease, before that ease has
		// reached PAGE_TURN_DURATION and committed. Pre-fix,
		// handlePagePointerDown only checked `pagePointerId` (still null here),
		// so it would have wrongly claimed the drag on top of the still-running
		// ease. Post-fix, canClaimPageDrag must refuse it.
		const dragClaimed = canClaimPageDrag(pagePointerId, programmaticTurnActive);
		expect(dragClaimed).toBe(false);

		// Since the claim is refused, no drag-driven commit happens here —
		// currentSpread only ever advances once, when the programmatic turn's
		// own ease later completes.
		if (dragClaimed) currentSpread = nextSpread(currentSpread, 1, spreadCount); // must not run
		expect(currentSpread).toBe(0);

		// The programmatic turn completes on its own (its ease reaches
		// PAGE_TURN_DURATION) — this is the only commit for this gesture.
		programmaticTurnActive = false;
		currentSpread = nextSpread(currentSpread, 1, spreadCount);
		expect(currentSpread).toBe(1); // advanced by exactly 1 total, never double-advanced

		// Only *after* programmaticTurn clears can a fresh drag claim succeed.
		expect(canClaimPageDrag(pagePointerId, programmaticTurnActive)).toBe(true);
	});
});

describe('canClaimAnyGesture (final review fix, Important 1: cover/page mutual exclusion)', () => {
	it('allows a claim when both gestures are idle', () => {
		expect(canClaimAnyGesture(null, null)).toBe(true);
	});

	it('refuses a new claim while a cover-drag already owns a pointer', () => {
		expect(canClaimAnyGesture(3, null)).toBe(false);
	});

	it('refuses a new claim while a page-drag already owns a pointer', () => {
		expect(canClaimAnyGesture(null, 5)).toBe(false);
	});

	it('refuses when both somehow own a pointer at once', () => {
		expect(canClaimAnyGesture(3, 5)).toBe(false);
	});

	it('regression: a second pointerdown on the cover mid-drag must not be allowed to overwrite the first drag\'s pointerId', () => {
		// Pointer A starts a cover drag — inspect.ts's handleCoverPointerDown
		// checks this exact guard before raycasting, then claims the pointer.
		let coverPointerId: number | null = null;
		const pagePointerId: number | null = null;
		expect(canClaimAnyGesture(coverPointerId, pagePointerId)).toBe(true);
		coverPointerId = 1; // pointer A claims the cover drag

		// Pointer B lands on the cover a second time while A's drag is still
		// live. Pre-fix, handleCoverPointerDown had no such guard and would
		// have raycast-hit-tested and overwritten coverPointerId with B's id,
		// orphaning A's drag (its future move/up events stop matching).
		const claimedByB = canClaimAnyGesture(coverPointerId, pagePointerId);
		expect(claimedByB).toBe(false);
		if (claimedByB) coverPointerId = 2; // must not run
		expect(coverPointerId).toBe(1); // A's drag is still the sole owner
	});

	it('regression: a page-drag pointerdown must not be able to claim a second pointer while a cover-drag is live', () => {
		const coverPointerId = 1; // cover drag already claimed by pointer A
		let pagePointerId: number | null = null;

		// Pointer B lands on a page while A's cover drag is in flight.
		// Pre-fix, handlePagePointerDown only checked pagePointerId (still
		// null here) via canClaimPageDrag, so it would have wrongly claimed
		// B, running a page-drag and a cover-drag concurrently.
		const claimedByB = canClaimAnyGesture(coverPointerId, pagePointerId);
		expect(claimedByB).toBe(false);
		if (claimedByB) pagePointerId = 2; // must not run
		expect(pagePointerId).toBe(null);
	});
});

describe('shouldResetSpreadOnClose (QA round 1, Finding 3/6: stale currentSpread after cover close)', () => {
	it('false while the book is still open', () => {
		expect(shouldResetSpreadOnClose(true, false, 1, 2)).toBe(false);
	});
	it('false while a drag is still deciding open vs. closed, even at openAmount 0', () => {
		expect(shouldResetSpreadOnClose(false, true, 0, 2)).toBe(false);
	});
	it('false while the cover has not yet finished easing shut', () => {
		expect(shouldResetSpreadOnClose(false, false, 0.2, 2)).toBe(false);
	});
	it('false once already reset — a one-time edge trigger, not a per-frame re-run', () => {
		expect(shouldResetSpreadOnClose(false, false, 0, 0)).toBe(false);
	});
	it('true exactly when settled closed, no drag, and there is a stale spread to clear', () => {
		expect(shouldResetSpreadOnClose(false, false, 0, 2)).toBe(true);
	});

	it('regression: open → turn twice → close (drag-commit) → settled state is spread 0, every leaf resting — matches the reported "stuck to the cover" repro', () => {
		const spreadCount = 4; // e.g. title/about/colophon-ish fixture
		let currentSpread = 0;
		let readingOpen = false;
		let coverDrag: CoverDrag = { active: false, kind: null, progress: 0 };

		// Open the cover.
		readingOpen = true;
		expect(leafTargets(0, currentSpread, coverOpenAmount(readingOpen, coverDrag)).angle).toBe(0);

		// Turn to page 2 via two committed HUD/drag turns.
		currentSpread = nextSpread(currentSpread, 1, spreadCount);
		currentSpread = nextSpread(currentSpread, 1, spreadCount);
		expect(currentSpread).toBe(2);
		// Sanity: with the cover open, leaves 0 and 1 now read as turned.
		const openAmountWhileOpen = coverOpenAmount(readingOpen, coverDrag);
		expect(leafTargets(0, currentSpread, openAmountWhileOpen).angle).toBeLessThan(-2);
		expect(leafTargets(1, currentSpread, openAmountWhileOpen).angle).toBeLessThan(-2);

		// Drag the cover closed and commit (mirrors inspect.ts's
		// handleCoverPointerUp: coverDrag clears, then readingOpen flips
		// false via setReadingOpen).
		coverDrag = { active: false, kind: null, progress: 0 };
		readingOpen = false;
		const openAmountAfterClose = coverOpenAmount(readingOpen, coverDrag);
		expect(openAmountAfterClose).toBe(0);

		// The bug: without the fix, currentSpread is still 2 here.
		expect(shouldResetSpreadOnClose(readingOpen, coverDrag.active, openAmountAfterClose, currentSpread)).toBe(
			true
		);
		// inspect.ts's updateCoverPivot applies the reset the frame this
		// becomes true (resetLeafPivots → resetLeafFlexState).
		currentSpread = 0;
		expect(currentSpread).toBe(0);

		// Now simulate the regrab-open drag the user reported ("lands on
		// page 3"): with the fix, currentSpread is 0, so no leaf is "turned"
		// as the cover opens back up — every leaf tracks the cover 1:1 at
		// rest, never gluing to it.
		coverDrag = { active: true, kind: 'cover-open', progress: 1 };
		const reopenAmount = coverOpenAmount(false, coverDrag);
		for (let leaf = 0; leaf < 6; leaf++) {
			expect(leafTargets(leaf, currentSpread, reopenAmount).angle).toBe(0);
			expect(leafTargets(leaf, currentSpread, reopenAmount).z).toBe(0);
		}

		// And the reset is idempotent — asking again with the same
		// (now-zeroed) state must not re-trigger.
		expect(shouldResetSpreadOnClose(false, false, 0, currentSpread)).toBe(false);
	});
});
