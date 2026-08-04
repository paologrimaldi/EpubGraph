import { describe, it, expect } from 'vitest';
import {
	hashSeed, seededRandom, deriveSize, paletteFromSeed,
	truncateLabel, buildIdentity, mixHex, luminance
} from './bookIdentity';
import type { Book } from '$lib/api/commands';

const fakeBook = (id: number): Book => ({
	id, path: '/x.epub', coverPath: null, title: 'Project Hail Mary',
	sortTitle: null, author: 'Andy Weir', authorSort: null, series: null,
	seriesIndex: null, description: 'A lone astronaut.', language: 'en',
	publisher: 'Ballantine', publishDate: '2021-05-04', isbn: '978-0-593-13520-4',
	fileSize: 1048576, fileHash: null,
	calibreId: null, source: 'local', dateAdded: 1700000000, dateModified: 0,
	dateIndexed: null, embeddingStatus: 'complete', embeddingModel: null,
	hidden: false, rating: null, readStatus: 'want'
});

describe('determinism', () => {
	it('same id → identical identity, different ids differ', () => {
		const a1 = buildIdentity(fakeBook(7)), a2 = buildIdentity(fakeBook(7));
		expect(a1).toEqual(a2);
		expect(buildIdentity(fakeBook(8)).seed).not.toBe(a1.seed);
	});
	it('seededRandom repeats per seed and stays in [0,1)', () => {
		const r1 = seededRandom(123), r2 = seededRandom(123);
		for (let i = 0; i < 100; i++) {
			const v = r1();
			expect(v).toBe(r2());
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});
});

describe('size bounds (§5.1)', () => {
	it('every seed lands in spec ranges', () => {
		for (let id = 0; id < 200; id++) {
			const s = deriveSize(hashSeed(id));
			expect(s.width).toBeGreaterThanOrEqual(0.92); expect(s.width).toBeLessThanOrEqual(1.10);
			expect(s.height).toBeGreaterThanOrEqual(1.46); expect(s.height).toBeLessThanOrEqual(1.58);
			expect(s.depth).toBeGreaterThanOrEqual(0.22); expect(s.depth).toBeLessThanOrEqual(0.30);
		}
	});
});

describe('palette', () => {
	it('valid hex everywhere, ink readable against cloth', () => {
		for (let id = 0; id < 20; id++) {
			const p = paletteFromSeed(hashSeed(id));
			for (const v of Object.values(p)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
			expect(Math.abs(luminance(p.ink) - luminance(p.cloth))).toBeGreaterThan(0.3);
		}
	});
});

describe('buildIdentity field pass-through (§4.4/Task 15)', () => {
	it('carries publisher/publishDate/isbn/language/fileSize/dateAdded straight off Book', () => {
		const identity = buildIdentity(fakeBook(7));
		expect(identity.publisher).toBe('Ballantine');
		expect(identity.publishDate).toBe('2021-05-04');
		expect(identity.isbn).toBe('978-0-593-13520-4');
		expect(identity.language).toBe('en');
		expect(identity.fileSize).toBe(1048576);
		expect(identity.dateAdded).toBe(1700000000);
	});
	it('passes through null fields untouched', () => {
		const book = fakeBook(9);
		book.publisher = null;
		book.publishDate = null;
		book.isbn = null;
		book.language = null;
		const identity = buildIdentity(book);
		expect(identity.publisher).toBeNull();
		expect(identity.publishDate).toBeNull();
		expect(identity.isbn).toBeNull();
		expect(identity.language).toBeNull();
	});
});

describe('helpers', () => {
	it('truncateLabel', () => {
		expect(truncateLabel('short')).toBe('short');
		const long = 'x'.repeat(60);
		expect(truncateLabel(long)).toHaveLength(41); // 40 + '…'
		expect(truncateLabel(long).endsWith('…')).toBe(true);
	});
	it('mixHex endpoints and midpoint', () => {
		expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
		expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
		expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
	});
});
