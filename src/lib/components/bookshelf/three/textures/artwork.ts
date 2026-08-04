import * as THREE from 'three';
import { seededRandom, truncateLabel, mixHex } from '../bookIdentity';
import type { BookIdentity } from '../../types/experience';

/** Shared serif stack for every canvas-painted text label on a book (§5.2). */
export const SERIF_STACK = `'Iowan Old Style', 'Baskerville', 'Georgia', serif`;

type Quality = 'low' | 'medium' | 'high';

const LONG_EDGE: Record<Quality, number> = { low: 512, medium: 768, high: 1024 };

// Independent seeded-noise streams layered onto each per-book canvas — salted
// off the book's own seed so grain differs between faces without desyncing
// the motif/title geometry that has to match between a color layer and its
// foil (alpha) duplicate.
const GRAIN_SALT_COVER = 0x9e3779b1;
const GRAIN_SALT_SPINE = 0x85ebca77;
const GRAIN_SALT_BACK = 0xc2b2ae3d;
const ENDPAPER_SALT = 0x27d4eb2f;

export interface CoverArtSet {
	cover: THREE.CanvasTexture; // procedural typography cover (used until/unless real cover)
	foil: THREE.CanvasTexture | null; // alpha motif layer (null once a real cover is applied)
	spine: THREE.CanvasTexture;
	spineFoil: THREE.CanvasTexture;
	back: THREE.CanvasTexture;
	endpaper: THREE.CanvasTexture;
	dispose(): void;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

function coverCanvasSize(identity: BookIdentity, quality: Quality): { width: number; height: number } {
	const long = LONG_EDGE[quality];
	const aspect = clamp(identity.size.width / identity.size.height, 0.55, 0.85);
	return { width: Math.round(long * aspect), height: long };
}

function spineCanvasSize(quality: Quality): { width: number; height: number } {
	const long = LONG_EDGE[quality];
	return { width: Math.round(long * 0.22), height: long };
}

function withAlpha(hex: string, alpha: number): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Lays a soft seeded-noise grain over the current canvas via a small repeating tile (cheap vs. a full-size per-pixel pass). */
function paintGrainOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, amount = 9): void {
	const tile = 64;
	const tileCanvas = createCanvas(tile, tile);
	const tileCtx = tileCanvas.getContext('2d')!;
	const imageData = tileCtx.createImageData(tile, tile);
	const random = seededRandom(seed);
	for (let i = 0; i < imageData.data.length; i += 4) {
		const n = 128 + Math.round((random() - 0.5) * amount * 2);
		imageData.data[i] = n;
		imageData.data[i + 1] = n;
		imageData.data[i + 2] = n;
		imageData.data[i + 3] = 255;
	}
	tileCtx.putImageData(imageData, 0, 0);
	const pattern = ctx.createPattern(tileCanvas, 'repeat');
	if (!pattern) return;
	ctx.save();
	ctx.globalCompositeOperation = 'overlay';
	ctx.globalAlpha = 0.5;
	ctx.fillStyle = pattern;
	ctx.fillRect(0, 0, w, h);
	ctx.restore();
}

function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
	if (ctx.measureText(text).width <= maxWidth) return text;
	let out = text;
	while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
		out = out.slice(0, -1);
	}
	return `${out.trimEnd()}…`;
}

/** Word-wraps `text` into at most `maxLines` lines, ellipsizing the final line if it still overflows. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = '';
	for (let i = 0; i < words.length; i++) {
		const test = current ? `${current} ${words[i]}` : words[i];
		if (current && ctx.measureText(test).width > maxWidth) {
			if (lines.length === maxLines - 1) {
				lines.push(truncateToWidth(ctx, `${current} ${words.slice(i).join(' ')}`, maxWidth));
				return lines;
			}
			lines.push(current);
			current = words[i];
		} else {
			current = test;
		}
	}
	if (current) lines.push(current);
	return lines.slice(0, maxLines);
}

// ============================================================
// Motifs — 6 abstract foil marks chosen by identity.motifIndex, each stroke
// -only (no fills) and jittered by a precomputed seeded sequence so the same
// geometry can be redrawn identically on both the color and foil canvases.
// ============================================================

type MotifPainter = (ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, jitter: number[]) => void;

function drawNestedBrackets(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, jitter: number[]): void {
	const count = 3;
	for (let i = 0; i < count; i++) {
		const rr = r * (1 - i * 0.24) * (0.9 + jitter[i] * 0.2);
		const arm = rr * 0.42;
		ctx.beginPath();
		ctx.moveTo(cx - rr + arm, cy - rr);
		ctx.lineTo(cx - rr, cy - rr);
		ctx.lineTo(cx - rr, cy + rr);
		ctx.lineTo(cx - rr + arm, cy + rr);
		ctx.moveTo(cx + rr - arm, cy - rr);
		ctx.lineTo(cx + rr, cy - rr);
		ctx.lineTo(cx + rr, cy + rr);
		ctx.lineTo(cx + rr - arm, cy + rr);
		ctx.stroke();
	}
}

function drawInterlacedArcs(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, jitter: number[]): void {
	const n = 3;
	for (let i = 0; i < n; i++) {
		const offset = (i - (n - 1) / 2) * r * 0.42 * (0.85 + jitter[i] * 0.3);
		ctx.beginPath();
		ctx.arc(cx + offset, cy, r * 0.55, 0, Math.PI * 2);
		ctx.stroke();
	}
}

function drawCaretColumn(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, jitter: number[]): void {
	const n = 5;
	const spacing = r * 0.34;
	for (let i = 0; i < n; i++) {
		const y = cy - ((n - 1) * spacing) / 2 + i * spacing + (jitter[i] - 0.5) * spacing * 0.3;
		const w = r * 0.5;
		ctx.beginPath();
		ctx.moveTo(cx - w / 2, y + w * 0.3);
		ctx.lineTo(cx, y - w * 0.3);
		ctx.lineTo(cx + w / 2, y + w * 0.3);
		ctx.stroke();
	}
}

function drawOrbitCircles(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, jitter: number[]): void {
	ctx.beginPath();
	ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
	ctx.stroke();
	const n = 4;
	for (let i = 0; i < n; i++) {
		const angle = (i / n) * Math.PI * 2 + jitter[i] * Math.PI * 2;
		const ox = cx + Math.cos(angle) * r * 0.62;
		const oy = cy + Math.sin(angle) * r * 0.62;
		ctx.beginPath();
		ctx.arc(ox, oy, r * 0.07, 0, Math.PI * 2);
		ctx.stroke();
	}
}

function drawHorizonLines(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, jitter: number[]): void {
	const n = 5;
	for (let i = 0; i < n; i++) {
		const y = cy - r * 0.5 + i * (r / (n - 1));
		const width = r * (0.4 + jitter[i] * 0.6);
		ctx.beginPath();
		ctx.moveTo(cx - width / 2, y);
		ctx.lineTo(cx + width / 2, y);
		ctx.stroke();
	}
}

function drawConcentricFrames(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, jitter: number[]): void {
	const n = 3;
	for (let i = 0; i < n; i++) {
		const rr = r * (1 - i * 0.26) * (0.92 + jitter[i] * 0.16);
		const radius = rr * 0.18;
		ctx.beginPath();
		ctx.roundRect(cx - rr, cy - rr * 0.72, rr * 2, rr * 1.44, radius);
		ctx.stroke();
	}
}

const MOTIF_PAINTERS: MotifPainter[] = [
	drawNestedBrackets,
	drawInterlacedArcs,
	drawCaretColumn,
	drawOrbitCircles,
	drawHorizonLines,
	drawConcentricFrames
];

function drawMotif(
	ctx: CanvasRenderingContext2D,
	motifIndex: number,
	cx: number,
	cy: number,
	r: number,
	jitter: number[],
	strokeStyle: string,
	lineWidth: number
): void {
	ctx.save();
	ctx.strokeStyle = strokeStyle;
	ctx.lineWidth = lineWidth;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	MOTIF_PAINTERS[((motifIndex % MOTIF_PAINTERS.length) + MOTIF_PAINTERS.length) % MOTIF_PAINTERS.length](
		ctx,
		cx,
		cy,
		r,
		jitter
	);
	ctx.restore();
}

// Roman-ish numeral badge for series index (deterministic, no rounding surprises past small ints).
const ROMAN_TABLE: Array<[number, string]> = [
	[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
	[50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
];
function toRomanish(n: number): string {
	let remaining = Math.round(n);
	if (remaining <= 0) return String(n);
	let out = '';
	for (const [value, symbol] of ROMAN_TABLE) {
		while (remaining >= value) {
			out += symbol;
			remaining -= value;
		}
	}
	return out || String(n);
}

// ============================================================
// Cover — cloth ground + noise grain, motif in foil at low alpha upper
// third, wrapped title, small-caps author, double foil rule. The foil
// (alpha) canvas re-strokes only the motif + title in white on black so it
// can drive an alphaMap/bumpMap pair on the rig's separate foil plane.
// ============================================================

function paintCoverLayer(
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number,
	identity: BookIdentity,
	motifJitter: number[],
	mode: 'color' | 'foil'
): void {
	if (mode === 'color') {
		ctx.fillStyle = identity.palette.cloth;
		ctx.fillRect(0, 0, w, h);
		paintGrainOverlay(ctx, w, h, identity.seed ^ GRAIN_SALT_COVER);
	} else {
		ctx.fillStyle = '#000000';
		ctx.fillRect(0, 0, w, h);
	}

	const motifStroke = mode === 'color' ? withAlpha(identity.palette.foil, 0.35) : '#ffffff';
	drawMotif(ctx, identity.motifIndex, w / 2, h * 0.18, Math.min(w, h) * 0.16, motifJitter, motifStroke, Math.max(1.5, w * 0.004));

	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillStyle = mode === 'color' ? identity.palette.ink : '#ffffff';
	ctx.font = `${Math.round(h * 0.052)}px ${SERIF_STACK}`;
	const lines = wrapText(ctx, identity.title, w * 0.78, 3);
	const lineHeight = h * 0.06;
	const startY = h * 0.44 - ((lines.length - 1) * lineHeight) / 2;
	lines.forEach((line, i) => ctx.fillText(line, w / 2, startY + i * lineHeight));

	if (mode === 'color') {
		ctx.strokeStyle = identity.palette.foil;
		ctx.lineWidth = Math.max(1, w * 0.0025);
		const ruleY = h * 0.62;
		ctx.beginPath();
		ctx.moveTo(w * 0.32, ruleY);
		ctx.lineTo(w * 0.68, ruleY);
		ctx.stroke();
		ctx.beginPath();
		ctx.moveTo(w * 0.32, ruleY + Math.max(3, h * 0.007));
		ctx.lineTo(w * 0.68, ruleY + Math.max(3, h * 0.007));
		ctx.stroke();

		if (identity.author) {
			ctx.font = `small-caps ${Math.round(h * 0.028)}px ${SERIF_STACK}`;
			ctx.fillStyle = identity.palette.ink;
			const author = truncateToWidth(ctx, identity.author, w * 0.8);
			ctx.fillText(author, w / 2, h * 0.7);
		}
	}
}

// ============================================================
// Spine — always procedural: cloth ground, foil rules top/bottom, rotated
// title, author surname, roman-ish series badge. SpineFoil duplicates the
// rules + title in white on black for the metallic layer.
// ============================================================

function paintSpineLayer(
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number,
	identity: BookIdentity,
	mode: 'color' | 'foil'
): void {
	if (mode === 'color') {
		ctx.fillStyle = identity.palette.cloth;
		ctx.fillRect(0, 0, w, h);
		paintGrainOverlay(ctx, w, h, identity.seed ^ GRAIN_SALT_SPINE);
	} else {
		ctx.fillStyle = '#000000';
		ctx.fillRect(0, 0, w, h);
	}

	const foilColor = mode === 'color' ? identity.palette.foil : '#ffffff';
	const margin = w * 0.22;
	ctx.strokeStyle = foilColor;
	ctx.lineWidth = Math.max(1, w * 0.035);
	for (const y of [h * 0.06, h * 0.94]) {
		ctx.beginPath();
		ctx.moveTo(margin, y);
		ctx.lineTo(w - margin, y);
		ctx.stroke();
	}

	// Text runs along the spine's length: rotating the frame 90° makes a normal
	// horizontal fillText read top-to-bottom. Post-rotation, the fillText x
	// argument maps to the global Y axis (spine length) — that's what
	// positions title vs. author along the spine. The y argument maps to the
	// global X axis (spine width) and stays 0 to keep both lines centered
	// across the spine's thin face.
	const centerY = h / 2;
	ctx.save();
	ctx.translate(w / 2, centerY);
	ctx.rotate(Math.PI / 2);
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillStyle = mode === 'color' ? identity.palette.ink : '#ffffff';

	const titleFontSize = Math.round(h * 0.045);
	ctx.font = `${titleFontSize}px ${SERIF_STACK}`;
	let title = truncateLabel(identity.title, 40);
	const titleMaxRun = identity.author ? h * 0.3 : h * 0.5;
	while (ctx.measureText(title).width > titleMaxRun && title.length > 3) {
		title = `${title.slice(0, -2)}…`;
	}
	const titleCenterFrac = identity.author ? 0.34 : 0.5;
	ctx.fillText(title, titleCenterFrac * h - centerY, 0);

	// Author surname is part of the readable (color) face only — the foil
	// duplicate is scoped to rules + title per §5.2. `identity.author` still
	// gates the title's reserved position/budget above so both canvases keep
	// identical title placement (the foil plane overlays the color spine).
	if (identity.author && mode === 'color') {
		const surnameFontSize = Math.round(h * 0.026);
		ctx.font = `${surnameFontSize}px ${SERIF_STACK}`;
		ctx.fillStyle = identity.palette.foil;
		const surname = identity.author.trim().split(/\s+/).pop() ?? identity.author;
		let surnameLabel = surname;
		const authorMaxRun = h * 0.2;
		while (ctx.measureText(surnameLabel).width > authorMaxRun && surnameLabel.length > 3) {
			surnameLabel = `${surnameLabel.slice(0, -2)}…`;
		}
		ctx.fillText(surnameLabel, 0.62 * h - centerY, 0);
	}
	ctx.restore();

	// Series badge is part of the readable (color) face only — the foil
	// duplicate is scoped to rules + title per §5.2.
	if (identity.seriesIndex != null && mode === 'color') {
		const cx = w / 2;
		const cy = h * 0.86;
		const badgeR = w * 0.34;
		ctx.beginPath();
		ctx.arc(cx, cy, badgeR, 0, Math.PI * 2);
		ctx.strokeStyle = identity.palette.foil;
		ctx.lineWidth = Math.max(1, w * 0.02);
		ctx.stroke();
		ctx.fillStyle = identity.palette.foil;
		ctx.font = `${Math.round(badgeR * 0.72)}px ${SERIF_STACK}`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(toRomanish(identity.seriesIndex), cx, cy);
	}
}

// ============================================================
// Back — cloth ground, blurb wrapped ≤6 lines over a subtle inset frame.
// ============================================================

function paintBack(ctx: CanvasRenderingContext2D, w: number, h: number, identity: BookIdentity): void {
	ctx.fillStyle = identity.palette.cloth;
	ctx.fillRect(0, 0, w, h);
	paintGrainOverlay(ctx, w, h, identity.seed ^ GRAIN_SALT_BACK);

	const inset = w * 0.06;
	ctx.strokeStyle = withAlpha(identity.palette.foil, 0.25);
	ctx.lineWidth = Math.max(1, w * 0.004);
	ctx.strokeRect(inset, inset, w - inset * 2, h - inset * 2);

	if (!identity.description) return;

	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillStyle = withAlpha(identity.palette.ink, 0.8);
	ctx.font = `${Math.round(h * 0.026)}px ${SERIF_STACK}`;
	const lines = wrapText(ctx, identity.description, w * 0.72, 6);
	const lineHeight = h * 0.036;
	const startY = h * 0.5 - ((lines.length - 1) * lineHeight) / 2;
	lines.forEach((line, i) => ctx.fillText(line, w / 2, startY + i * lineHeight));
}

// ============================================================
// Endpaper — pale paper ground + seeded marbled swirls.
// ============================================================

function paintEndpaper(ctx: CanvasRenderingContext2D, w: number, h: number, identity: BookIdentity): void {
	ctx.fillStyle = identity.palette.paperPale;
	ctx.fillRect(0, 0, w, h);

	const swirlColor = mixHex(identity.palette.cloth, identity.palette.paperPale, 0.7);
	const random = seededRandom(identity.seed ^ ENDPAPER_SALT);
	ctx.strokeStyle = swirlColor;
	ctx.lineCap = 'round';
	const swirlCount = 14;
	for (let i = 0; i < swirlCount; i++) {
		const cx = random() * w;
		const cy = random() * h;
		const r = w * (0.06 + random() * 0.12);
		const turns = 1.4 + random() * 1.2;
		ctx.lineWidth = 0.8 + random() * 1.6;
		ctx.globalAlpha = 0.25 + random() * 0.35;
		ctx.beginPath();
		for (let t = 0; t <= 1; t += 0.02) {
			const angle = t * Math.PI * 2 * turns;
			const radius = r * t;
			const x = cx + Math.cos(angle) * radius;
			const y = cy + Math.sin(angle) * radius * 0.6;
			if (t === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.stroke();
	}
	ctx.globalAlpha = 1;
}

/** Builds the full procedural artwork set (cover, foil, spine, spineFoil, back, endpaper) for one book identity. */
export function makeArtwork(identity: BookIdentity, quality: Quality): CoverArtSet {
	const { width: coverW, height: coverH } = coverCanvasSize(identity, quality);
	const { width: spineW, height: spineH } = spineCanvasSize(quality);

	// Motif jitter is precomputed once so the cover and foil canvases redraw
	// the identical motif geometry — only the stroke color/ground differ.
	const jitterRandom = seededRandom(identity.seed);
	const motifJitter = Array.from({ length: 8 }, () => jitterRandom());

	const coverCanvas = createCanvas(coverW, coverH);
	paintCoverLayer(coverCanvas.getContext('2d')!, coverW, coverH, identity, motifJitter, 'color');
	const cover = new THREE.CanvasTexture(coverCanvas);
	cover.colorSpace = THREE.SRGBColorSpace;
	cover.needsUpdate = true;

	const foilCanvas = createCanvas(coverW, coverH);
	paintCoverLayer(foilCanvas.getContext('2d')!, coverW, coverH, identity, motifJitter, 'foil');
	const foil = new THREE.CanvasTexture(foilCanvas);
	foil.colorSpace = THREE.SRGBColorSpace;
	foil.needsUpdate = true;

	const spineCanvas = createCanvas(spineW, spineH);
	paintSpineLayer(spineCanvas.getContext('2d')!, spineW, spineH, identity, 'color');
	const spine = new THREE.CanvasTexture(spineCanvas);
	spine.colorSpace = THREE.SRGBColorSpace;
	spine.needsUpdate = true;

	const spineFoilCanvas = createCanvas(spineW, spineH);
	paintSpineLayer(spineFoilCanvas.getContext('2d')!, spineW, spineH, identity, 'foil');
	const spineFoil = new THREE.CanvasTexture(spineFoilCanvas);
	spineFoil.colorSpace = THREE.SRGBColorSpace;
	spineFoil.needsUpdate = true;

	const backCanvas = createCanvas(coverW, coverH);
	paintBack(backCanvas.getContext('2d')!, coverW, coverH, identity);
	const back = new THREE.CanvasTexture(backCanvas);
	back.colorSpace = THREE.SRGBColorSpace;
	back.needsUpdate = true;

	const endpaperCanvas = createCanvas(coverW, coverH);
	paintEndpaper(endpaperCanvas.getContext('2d')!, coverW, coverH, identity);
	const endpaper = new THREE.CanvasTexture(endpaperCanvas);
	endpaper.colorSpace = THREE.SRGBColorSpace;
	endpaper.needsUpdate = true;

	return {
		cover,
		foil,
		spine,
		spineFoil,
		back,
		endpaper,
		dispose(): void {
			cover.dispose();
			foil.dispose();
			spine.dispose();
			spineFoil.dispose();
			back.dispose();
			endpaper.dispose();
		}
	};
}

/** Cloth ground with the real cover image inset ~3% each side (tipped-on print look, §5.2). */
export function makeRealCoverTexture(identity: BookIdentity, image: HTMLImageElement, quality: Quality): THREE.CanvasTexture {
	const { width: w, height: h } = coverCanvasSize(identity, quality);
	const canvas = createCanvas(w, h);
	const ctx = canvas.getContext('2d')!;

	ctx.fillStyle = identity.palette.cloth;
	ctx.fillRect(0, 0, w, h);
	paintGrainOverlay(ctx, w, h, identity.seed ^ GRAIN_SALT_COVER);

	const insetX = Math.round(w * 0.03);
	const insetY = Math.round(h * 0.03);
	const drawW = w - insetX * 2;
	const drawH = h - insetY * 2;
	const shadowOffset = Math.round(w * 0.02);

	ctx.save();
	ctx.globalAlpha = 0.35;
	ctx.fillStyle = '#000000';
	ctx.fillRect(insetX + shadowOffset, insetY + shadowOffset, drawW, drawH);
	ctx.restore();

	ctx.drawImage(image, insetX, insetY, drawW, drawH);
	ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
	ctx.lineWidth = Math.max(1, w * 0.003);
	ctx.strokeRect(insetX, insetY, drawW, drawH);

	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.needsUpdate = true;
	return texture;
}

/** Clones a painted canvas texture to grayscale for use as an emboss bump map. */
export function makeEmbossFrom(texture: THREE.CanvasTexture, name: string): THREE.CanvasTexture {
	const source = texture.image as HTMLCanvasElement;
	const canvas = createCanvas(source.width, source.height);
	const ctx = canvas.getContext('2d')!;
	ctx.drawImage(source, 0, 0);

	const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	const data = imageData.data;
	for (let i = 0; i < data.length; i += 4) {
		const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
		data[i] = gray;
		data[i + 1] = gray;
		data[i + 2] = gray;
	}
	ctx.putImageData(imageData, 0, 0);

	const embossTexture = new THREE.CanvasTexture(canvas);
	embossTexture.name = name;
	embossTexture.colorSpace = THREE.NoColorSpace;
	embossTexture.needsUpdate = true;
	return embossTexture;
}
