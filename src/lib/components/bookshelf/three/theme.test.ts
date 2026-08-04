import { describe, it, expect } from 'vitest';
import { blendPaletteWithMode, easeSceneColor } from './theme';
import { paletteFromSeed, luminance, paletteFromCover } from './bookIdentity';

const p = paletteFromSeed(42);

describe('blendPaletteWithMode (§4.1)', () => {
	it('dark mode pulls backdrop/floor darker than light mode', () => {
		const d = blendPaletteWithMode(p, true), l = blendPaletteWithMode(p, false);
		expect(luminance(d.backdrop)).toBeLessThan(luminance(l.backdrop));
		expect(luminance(d.floor)).toBeLessThan(luminance(l.floor));
	});
	it('accent passes through as the book foil', () => {
		expect(blendPaletteWithMode(p, true).accent).toBe(p.foil);
	});
	it('fog matches backdrop', () => {
		const d = blendPaletteWithMode(p, true);
		expect(d.fog).toBe(d.backdrop);
	});
});

describe('easeSceneColor', () => {
	it('converges and snaps exactly to target', () => {
		let c = '#000000';
		for (let i = 0; i < 400; i++) c = easeSceneColor(c, '#a05020', 6, 1 / 60);
		expect(c).toBe('#a05020');
	});
	it('is a no-op at target', () => {
		expect(easeSceneColor('#a05020', '#a05020', 6, 1 / 60)).toBe('#a05020');
	});
});

describe('paletteFromCover', () => {
	const px = (rgb: [number, number, number], n: number) => {
		const a = new Uint8ClampedArray(n * 4);
		for (let i = 0; i < n; i++) { a[i * 4] = rgb[0]; a[i * 4 + 1] = rgb[1]; a[i * 4 + 2] = rgb[2]; a[i * 4 + 3] = 255; }
		return a;
	};
	it('dominant color becomes cloth', () => {
		const cover = paletteFromCover(px([180, 40, 30], 1024))!;
		// dominant red family → cloth in red family
		const [r, g, b] = [cover.cloth.slice(1, 3), cover.cloth.slice(3, 5), cover.cloth.slice(5, 7)]
			.map((h) => parseInt(h, 16));
		expect(r).toBeGreaterThan(g); expect(r).toBeGreaterThan(b);
	});
	it('near-white/near-black covers yield null (fallback to seed palette)', () => {
		expect(paletteFromCover(px([250, 250, 250], 1024))).toBeNull();
		expect(paletteFromCover(px([5, 5, 5], 1024))).toBeNull();
	});
});
