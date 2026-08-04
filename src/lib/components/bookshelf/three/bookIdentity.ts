import type { Book } from '$lib/api/commands';
import type { BookIdentity, BookPalette, BookSize } from '../types/experience';

export function hashSeed(id: number): number {
	let h = 2166136261 >>> 0;
	const s = `book-${id}`;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h >>> 0;
}

export function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function deriveSize(seed: number): BookSize {
	const r = seededRandom(seed);
	return {
		width: 0.92 + r() * 0.18,
		height: 1.46 + r() * 0.12,
		depth: 0.22 + r() * 0.08
	};
}

const hexToRgb = (hex: string): [number, number, number] => [
	parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)
];
const rgbToHex = (r: number, g: number, b: number) =>
	'#' + [r, g, b].map((v) => Math.round(Math.min(Math.max(v, 0), 255)).toString(16).padStart(2, '0')).join('');

export function mixHex(a: string, b: string, t: number): string {
	const [ar, ag, ab] = hexToRgb(a), [br, bg, bb] = hexToRgb(b);
	return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

export function luminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// 10-color editorial cloth ramp with paired foils (reference-derived, §5.2)
const CLOTHS = ['#182a43', '#c24d24', '#5f2a1e', '#1537a1', '#2f4a3e',
	'#7a1f2b', '#3c3a63', '#8a6d3b', '#233138', '#4a1f3d'];
const FOILS = ['#c87046', '#efc16d', '#e0b487', '#dbe8f1', '#cfd8c2',
	'#e3b587', '#c9c3e8', '#f1e3c0', '#9fb3c9', '#e8c9d8'];

export function paletteFromSeed(seed: number): BookPalette {
	const i = seed % CLOTHS.length;
	return buildPalette(CLOTHS[i], FOILS[i]);
}

export function buildPalette(cloth: string, foil: string): BookPalette {
	const dark = luminance(cloth) < 0.35;
	return {
		cloth,
		foil,
		paper: mixHex(cloth, '#171a20', 0.45),
		paperPale: '#f1eadf',
		ink: dark ? '#f4eee6' : '#171914',
		floor: mixHex(cloth, '#d8c8aa', 0.72),
		light: mixHex(foil, '#f4d7b9', 0.6),
		fill: mixHex(cloth, '#d8e3e7', 0.75)
	};
}

export function truncateLabel(text: string, max = 40): string {
	return text.length <= max ? text : text.slice(0, max) + '…';
}

export function buildIdentity(book: Book): BookIdentity {
	const seed = hashSeed(book.id);
	return {
		id: book.id,
		seed,
		size: deriveSize(seed),
		palette: paletteFromSeed(seed),
		motifIndex: seed % 6,
		title: book.title,
		author: book.author,
		series: book.series,
		seriesIndex: book.seriesIndex,
		description: book.description
	};
}
