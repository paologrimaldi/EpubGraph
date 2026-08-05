import { describe, it, expect, vi } from 'vitest';

// pages.ts's `paintColophonPage` imports formatDate/formatFileSize from
// `$lib/api/commands`, which transitively imports `$app/environment` — not
// resolvable under this repo's bare vitest.config.ts (no SvelteKit vite
// plugin, `environment: 'node'`). Mocked at the module boundary before
// pages.ts is imported, same pattern inspect.test.ts/coverPipeline.test.ts
// already use for the same reason. Neither stub is ever called by the pure
// pagination-math tests below.
vi.mock('$lib/api/commands', () => ({
	formatDate: () => '',
	formatFileSize: () => ''
}));

import { computeAboutMaxLinesPerPage, paginateAboutLines } from './pages';

// QA round 1, Finding 5: the About page's line budget previously came from a
// fixed constant (26 lines/page) computed independently of the actual fitted
// font size — a description whose character mix picked a larger font (still
// within the horizontal ~34-chars/line target) produced a taller line-height
// that 26 fixed lines could overflow the canvas by more than 2x. These tests
// cover the pure pagination math extracted to fix that: the line budget is
// now derived from real geometry (canvas height, font size, margins) instead
// of assumed.
describe('computeAboutMaxLinesPerPage (QA round 1, Finding 5)', () => {
	it('derives fewer lines/page for a larger font at the same canvas height', () => {
		const small = computeAboutMaxLinesPerPage(768, 18);
		const large = computeAboutMaxLinesPerPage(768, 36);
		expect(large).toBeLessThan(small);
	});

	it('derives more lines/page for a taller canvas at the same font size', () => {
		const short = computeAboutMaxLinesPerPage(512, 24);
		const tall = computeAboutMaxLinesPerPage(1024, 24);
		expect(tall).toBeGreaterThan(short);
	});

	it('never returns fewer than 1 line, even for a pathologically large font', () => {
		expect(computeAboutMaxLinesPerPage(512, 400)).toBeGreaterThanOrEqual(1);
	});

	it('the old fixed 26-line budget genuinely overflowed at a large fitted font — this is what the fix corrects', () => {
		// Reproduces the exact failure mode from the bug report: at a
		// near-ABOUT_FONT_MAX (40px) font on a medium-quality (768px-tall)
		// canvas, 26 fixed lines would have run well past the canvas.
		const canvasHeight = 768;
		const bodyFontSize = 40;
		const oldFixedBudget = 26;
		const lineHeight = bodyFontSize * 1.55;
		const oldBottomOfLastLine = canvasHeight * 0.16 + oldFixedBudget * lineHeight;
		expect(oldBottomOfLastLine).toBeGreaterThan(canvasHeight); // confirms the old bug was real

		const fixed = computeAboutMaxLinesPerPage(canvasHeight, bodyFontSize);
		expect(fixed).toBeLessThan(oldFixedBudget);
		const newBottomOfLastLine = canvasHeight * 0.16 + fixed * lineHeight;
		// Stays within the bottom-margin floor (≥ 6% of canvas height).
		expect(newBottomOfLastLine).toBeLessThanOrEqual(canvasHeight * 0.94 + 1e-9);
	});

	it('every derived budget respects the ≥6%-of-height bottom margin', () => {
		for (const canvasHeight of [512, 768, 1024]) {
			for (const bodyFontSize of [14, 18, 24, 32, 40]) {
				const maxLines = computeAboutMaxLinesPerPage(canvasHeight, bodyFontSize);
				const lineHeight = bodyFontSize * 1.55;
				const bottomOfLastLine = canvasHeight * 0.16 + maxLines * lineHeight;
				expect(bottomOfLastLine).toBeLessThanOrEqual(canvasHeight * 0.94 + 1e-9);
			}
		}
	});
});

describe('paginateAboutLines (QA round 1, Finding 5: lines→pages split)', () => {
	it('empty input produces zero pages', () => {
		expect(paginateAboutLines([], 10)).toEqual([]);
	});

	it('fits entirely on one page when under budget', () => {
		const lines = ['a', 'b', 'c'];
		expect(paginateAboutLines(lines, 10)).toEqual([['a', 'b', 'c']]);
	});

	it('splits cleanly across exactly two pages when over budget', () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
		const pages = paginateAboutLines(lines, 20);
		expect(pages.length).toBe(2);
		expect(pages[0].length).toBe(20);
		expect(pages[1].length).toBe(10);
		expect(pages[0][0]).toBe('line 0');
		expect(pages[1][9]).toBe('line 29');
	});

	it('never produces more than 2 pages, even with far more lines than 2 pages could hold', () => {
		// wrapText (the caller) is responsible for ellipsizing anything past
		// the 2-page budget before it ever reaches here — this just proves
		// paginateAboutLines itself won't silently manufacture a 3rd page if
		// that contract is ever violated upstream.
		const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
		const pages = paginateAboutLines(lines, 20);
		expect(pages.length).toBe(2);
	});
});
