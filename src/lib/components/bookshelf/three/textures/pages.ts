import * as THREE from 'three';
import { formatDate, formatFileSize } from '$lib/api/commands';
import type { BookIdentity } from '../../types/experience';
import type { RigHandle } from '../bookRig';
import { mixHex, truncateLabel } from '../bookIdentity';
import { sharedPaperFaceTexture } from './shared';
import { SERIF_STACK, wrapText } from './artwork';

// ============================================================
// Generated interior pages (§4.4, Task 15) — title page, "About" spread(s)
// typeset from `identity.description`, and a colophon metadata page. Content
// is generated, never EPUB-rendered (spec §4.4's explicit non-goal). Every
// canvas here shares one page footprint (`pageCanvasSize`, computed once per
// `makeSpreads` call) so every leaf sheet — which all share one flat
// PlaneGeometry footprint in bookRig.ts — gets a texture at the same aspect.
//
// Ownership: `SpreadSet.textures` are CanvasTextures this module hands to
// `applySpreads`, which only ever assigns them to a rig's leaf-sheet material
// `.map` — the rig never disposes them (mirrors coverPipeline.ts's real-cover
// texture ownership doc). `coverPipeline.ts` is the actual owner (caches one
// SpreadSet per book id, disposes it when that id falls out of the shelf or
// the pipeline itself is disposed) — see that file's `ensureSpreadSet`.
// ============================================================

export interface SpreadSet {
	textures: THREE.CanvasTexture[];
	labels: string[];
	dispose(): void;
}

type Quality = 'low' | 'medium' | 'high';

const LONG_EDGE: Record<Quality, number> = { low: 512, medium: 768, high: 1024 };

// Reference interior style (brief Step 1): cream ground with the shared paper
// grain, ink blended toward the book's cloth color for headings only — body
// text stays the plain, maximally-readable base ink.
const BASE_INK = '#211b16';
const HEADING_INK_BLEND = 0.38;

// "serif ~34ch/line, ≤26 lines/page, up to 2 pages" (brief Step 1/interfaces).
// QA round 1, Finding 5: the "≤26 lines/page" figure was hardcoded
// independently of `bodyFontSize`/line-height — since `fitAboutFontSize`
// solves for font size purely from the *horizontal* target (~34 chars/line),
// a description whose actual character mix picked a larger font produced a
// taller line-height that 26 fixed lines could overflow well past the
// canvas's bottom edge (confirmed: at a 40px font, 26 lines * 62px
// line-height ≈ 1612px against a 768px-tall medium-quality canvas — over 2x
// the drawable height). `ABOUT_MAX_LINES_PER_PAGE` is now *derived* per book
// from real geometry via computeAboutMaxLinesPerPage below, instead of a
// fixed constant — see that function's doc comment.
const ABOUT_TARGET_CHARS_PER_LINE = 34;
const ABOUT_MAX_PAGES = 2;
const ABOUT_FONT_MIN = 14;
const ABOUT_FONT_MAX = 40;
const ABOUT_MARGIN_X_FRACTION = 0.12;
// Shared by paintAboutPage (rendering) and computeAboutMaxLinesPerPage
// (pagination math) so the two can never drift apart — see Finding 5's root
// cause above, which was exactly this kind of derived-vs-assumed mismatch.
const ABOUT_LINE_HEIGHT_FACTOR = 1.55;
const ABOUT_BODY_TOP_FRACTION = 0.16; // where the first body line's baseline sits
// Brief-specified floor ("bottom margin ≥ 6% of canvas height so no glyph
// ever touches the edge") — the *drawable* area for body lines stops this
// far above the canvas bottom.
const ABOUT_BOTTOM_MARGIN_FRACTION = 0.06;

/**
 * How many About-page body lines fit between the body's top start
 * (`ABOUT_BODY_TOP_FRACTION`) and the bottom margin
 * (`ABOUT_BOTTOM_MARGIN_FRACTION`), for a given canvas height and body font
 * size — floored, so a partially-fitting final line is never scheduled (its
 * descenders would land past the margin). Pure (no canvas/DOM), so the
 * pagination math is independently testable — see pages.test.ts.
 */
export function computeAboutMaxLinesPerPage(canvasHeight: number, bodyFontSize: number): number {
	const lineHeight = bodyFontSize * ABOUT_LINE_HEIGHT_FACTOR;
	const drawableHeight = canvasHeight * (1 - ABOUT_BOTTOM_MARGIN_FRACTION - ABOUT_BODY_TOP_FRACTION);
	return Math.max(1, Math.floor(drawableHeight / lineHeight));
}

/**
 * Splits `lines` into at most `ABOUT_MAX_PAGES` pages of up to
 * `maxLinesPerPage` lines each — the lines→pages half of Finding 5's
 * pagination math, factored out so it's testable independent of canvas/DOM
 * (see pages.test.ts). `wrapText` (the caller) already ellipsizes anything
 * past the total `maxLinesPerPage * ABOUT_MAX_PAGES` budget, so this never
 * needs to itself decide what happens past the last page.
 */
export function paginateAboutLines(lines: string[], maxLinesPerPage: number): string[][] {
	if (lines.length === 0) return [];
	const pages: string[][] = [];
	for (let start = 0; start < lines.length && pages.length < ABOUT_MAX_PAGES; start += maxLinesPerPage) {
		pages.push(lines.slice(start, start + maxLinesPerPage));
	}
	return pages;
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

/** Same aspect-derivation as artwork.ts's coverCanvasSize (kept local/duplicated rather than
 * imported so this module's page sizing can be retuned independently of cover art sizing —
 * same "kept local for independent tuning" rationale inspect.ts uses for its own constants). */
function pageCanvasSize(identity: BookIdentity, quality: Quality): { width: number; height: number } {
	const long = LONG_EDGE[quality];
	const aspect = clamp(identity.size.width / identity.size.height, 0.55, 0.85);
	return { width: Math.round(long * aspect), height: long };
}

function withAlpha(hex: string, alpha: number): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Cream paper ground with the shared paper grain (brief: "Cream paper ground (shared grain)")
 * — tiles the actual sharedPaperFaceTexture() canvas as a fill pattern rather than repainting a
 * similar-looking grain, so every generated page shares the identical fiber texture every other
 * paper surface on the rig (page block, edges) already uses. */
function paintPageGround(ctx: CanvasRenderingContext2D, w: number, h: number): void {
	const sharedCanvas = sharedPaperFaceTexture().image as HTMLCanvasElement;
	const pattern = ctx.createPattern(sharedCanvas, 'repeat');
	ctx.fillStyle = pattern ?? '#f5efdf';
	ctx.fillRect(0, 0, w, h);
}

/** "publisher/year rule" (brief): `Publisher · Year`, `Publisher`, `Year`, or nothing —
 * whichever of the two identity fields are actually present. */
function publisherYearLine(identity: BookIdentity): string | null {
	const year = parsePublishYear(identity.publishDate);
	if (identity.publisher && year != null) return `${identity.publisher} · ${year}`;
	if (identity.publisher) return identity.publisher;
	if (year != null) return String(year);
	return null;
}

function parsePublishYear(publishDate: string | null): number | null {
	if (!publishDate) return null;
	const parsed = new Date(publishDate);
	return Number.isNaN(parsed.getTime()) ? null : parsed.getFullYear();
}

/**
 * Picks a font size so that, for THIS description's actual character mix, roughly
 * `targetChars` characters span `maxWidth` — canvas text width scales ~linearly with font
 * size, so a single reference-size measurement is enough to solve for it directly (more
 * accurate than a fixed size/width ratio, since e.g. an all-"i" description and an all-"W"
 * description need very different point sizes to hit the same character count per line).
 * Clamped to a sane floor/ceiling for pathological inputs (very short or very "wide" text).
 */
function fitAboutFontSize(
	ctx: CanvasRenderingContext2D,
	targetChars: number,
	maxWidth: number,
	sampleText: string
): number {
	const REFERENCE_SIZE = 100;
	ctx.font = `${REFERENCE_SIZE}px ${SERIF_STACK}`;
	const base = sampleText.trim() || 'the quiet page';
	const sample =
		base.length >= targetChars ? base.slice(0, targetChars) : base.repeat(Math.ceil(targetChars / base.length)).slice(0, targetChars);
	const measuredWidth = ctx.measureText(sample).width || 1;
	const fitted = Math.round((maxWidth / measuredWidth) * REFERENCE_SIZE);
	return clamp(fitted, ABOUT_FONT_MIN, ABOUT_FONT_MAX);
}

// ============================================================
// [0] Title page — always. Centered: title, foil-tone rule, author, series +
// index, publisher/year line near the foot of the page.
// ============================================================

function paintTitlePage(ctx: CanvasRenderingContext2D, w: number, h: number, identity: BookIdentity, headingInk: string): void {
	paintPageGround(ctx, w, h);
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';

	const titleFontSize = Math.round(h * 0.052);
	ctx.font = `${titleFontSize}px ${SERIF_STACK}`;
	ctx.fillStyle = headingInk;
	const titleLines = wrapText(ctx, identity.title, w * 0.78, 4);
	const titleLineHeight = h * 0.062;
	const titleStartY = h * 0.32 - ((titleLines.length - 1) * titleLineHeight) / 2;
	titleLines.forEach((line, i) => ctx.fillText(line, w / 2, titleStartY + i * titleLineHeight));

	// Foil-tone rule, centered under the (possibly multi-line) title.
	const ruleY = titleStartY + (titleLines.length - 1) * titleLineHeight + titleLineHeight * 0.85;
	ctx.strokeStyle = identity.palette.foil;
	ctx.lineWidth = Math.max(1, w * 0.003);
	ctx.beginPath();
	ctx.moveTo(w * 0.36, ruleY);
	ctx.lineTo(w * 0.64, ruleY);
	ctx.stroke();

	let cursorY = ruleY + h * 0.055;
	if (identity.author) {
		ctx.font = `small-caps ${Math.round(h * 0.03)}px ${SERIF_STACK}`;
		ctx.fillStyle = BASE_INK;
		ctx.fillText(truncateLabel(identity.author, 48), w / 2, cursorY);
		cursorY += h * 0.048;
	}

	if (identity.series) {
		ctx.font = `${Math.round(h * 0.023)}px ${SERIF_STACK}`;
		ctx.fillStyle = withAlpha(BASE_INK, 0.72);
		const seriesLine =
			identity.seriesIndex != null ? `${identity.series} · Book ${identity.seriesIndex}` : identity.series;
		ctx.fillText(truncateLabel(seriesLine, 52), w / 2, cursorY);
	}

	const publisherLine = publisherYearLine(identity);
	if (publisherLine) {
		ctx.font = `${Math.round(h * 0.019)}px ${SERIF_STACK}`;
		ctx.fillStyle = withAlpha(BASE_INK, 0.58);
		ctx.fillText(publisherLine, w / 2, h * 0.88);
	}
}

// ============================================================
// [1..] "About" page(s) — only when `identity.description` is present.
// Left-aligned body copy, small-caps section heading.
// ============================================================

function paintAboutPage(
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number,
	lines: string[],
	bodyFontSize: number,
	headingInk: string
): void {
	paintPageGround(ctx, w, h);
	ctx.textAlign = 'left';
	ctx.textBaseline = 'alphabetic';

	const marginX = w * ABOUT_MARGIN_X_FRACTION;

	ctx.font = `small-caps ${Math.round(h * 0.03)}px ${SERIF_STACK}`;
	ctx.fillStyle = headingInk;
	ctx.fillText('About', marginX, h * 0.1);

	ctx.font = `${bodyFontSize}px ${SERIF_STACK}`;
	ctx.fillStyle = BASE_INK;
	const lineHeight = bodyFontSize * ABOUT_LINE_HEIGHT_FACTOR;
	let y = h * ABOUT_BODY_TOP_FRACTION;
	for (const line of lines) {
		ctx.fillText(line, marginX, y);
		y += lineHeight;
	}
}

// ============================================================
// [last] Colophon — always. Small-caps label / value rows.
// ============================================================

function paintColophonPage(ctx: CanvasRenderingContext2D, w: number, h: number, identity: BookIdentity, headingInk: string): void {
	paintPageGround(ctx, w, h);
	ctx.textAlign = 'left';
	ctx.textBaseline = 'alphabetic';

	const marginX = w * ABOUT_MARGIN_X_FRACTION;

	ctx.font = `small-caps ${Math.round(h * 0.03)}px ${SERIF_STACK}`;
	ctx.fillStyle = headingInk;
	ctx.fillText('Details', marginX, h * 0.12);

	const rows: Array<[string, string]> = [];
	if (identity.isbn) rows.push(['ISBN', identity.isbn]);
	if (identity.language) rows.push(['Language', identity.language]);
	rows.push(['File size', formatFileSize(identity.fileSize)]);
	rows.push(['Added', formatDate(identity.dateAdded)]);

	const labelFontSize = Math.round(h * 0.019);
	const valueFontSize = Math.round(h * 0.023);
	const rowGap = h * 0.075;

	let y = h * 0.22;
	for (const [label, value] of rows) {
		ctx.font = `small-caps ${labelFontSize}px ${SERIF_STACK}`;
		ctx.fillStyle = withAlpha(identity.palette.foil, 0.95);
		ctx.fillText(label, marginX, y);

		ctx.font = `${valueFontSize}px ${SERIF_STACK}`;
		ctx.fillStyle = BASE_INK;
		ctx.fillText(value, marginX, y + labelFontSize * 1.35);

		y += rowGap;
	}
}

function paintTexture(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
	const canvas = createCanvas(w, h);
	const ctx = canvas.getContext('2d')!;
	paint(ctx);
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.needsUpdate = true;
	return texture;
}

/**
 * Builds one book's full generated interior content: [0] title page (always),
 * [1..] up to two "About" pages typeset from `identity.description` (only
 * when present), [last] colophon (always). `textures`/`labels` are index-
 * parallel and share the same length — that shared index space IS the
 * `currentSpread` a reader pages through (inspect.ts consumes it 1:1): leaf
 * turning in this rig advances exactly one leaf per spread (see pageFlex.ts's
 * `leafTargets` — leaves with index < currentSpread are turned, every other
 * leaf, including the active one, rests), and only the topmost *unturned*
 * leaf's FRONT sheet is ever the dominant on-screen page — a leaf's back
 * sheet is only glimpsed transiently mid-turn, never a `currentSpread`
 * destination in its own right. So `textures[i]` must land on leaf `i`'s
 * front sheet specifically (applySpreads' 1:1 mapping below), not spread
 * across a leaf's front+back pair — packing two spreads per leaf would
 * silently double-index every spread past the first (confirmed live: a
 * description that produced a real "About" page here never became visible
 * when paging through, because it landed on leaf 0's back sheet instead of
 * leaf 1's front).
 */
export function makeSpreads(identity: BookIdentity, quality: Quality): SpreadSet {
	const { width: w, height: h } = pageCanvasSize(identity, quality);
	const headingInk = mixHex(BASE_INK, identity.palette.cloth, HEADING_INK_BLEND);

	const measureCanvas = createCanvas(8, 8);
	const measureCtx = measureCanvas.getContext('2d')!;

	const trimmedDescription = (identity.description ?? '').trim();
	const hasDescription = trimmedDescription.length > 0;

	let aboutLines: string[] = [];
	let aboutFontSize = 0;
	let aboutMaxLinesPerPage = 0;
	if (hasDescription) {
		const marginX = w * ABOUT_MARGIN_X_FRACTION;
		const aboutMaxWidth = w - marginX * 2;
		aboutFontSize = fitAboutFontSize(measureCtx, ABOUT_TARGET_CHARS_PER_LINE, aboutMaxWidth, trimmedDescription);
		// QA round 1, Finding 5: derived from THIS book's actual fitted font
		// size/canvas height, not a fixed line count — see
		// computeAboutMaxLinesPerPage's doc comment for why the old fixed
		// value could overflow the canvas.
		aboutMaxLinesPerPage = computeAboutMaxLinesPerPage(h, aboutFontSize);
		measureCtx.font = `${aboutFontSize}px ${SERIF_STACK}`;
		aboutLines = wrapText(measureCtx, trimmedDescription, aboutMaxWidth, aboutMaxLinesPerPage * ABOUT_MAX_PAGES);
	}
	const aboutPages = paginateAboutLines(aboutLines, aboutMaxLinesPerPage);

	const textures: THREE.CanvasTexture[] = [];
	const labels: string[] = [];

	textures.push(paintTexture(w, h, (ctx) => paintTitlePage(ctx, w, h, identity, headingInk)));
	labels.push('Title page');

	aboutPages.forEach((pageLines, page) => {
		textures.push(paintTexture(w, h, (ctx) => paintAboutPage(ctx, w, h, pageLines, aboutFontSize, headingInk)));
		labels.push(aboutPages.length === 1 ? 'About' : `About (${page + 1} of ${aboutPages.length})`);
	});

	textures.push(paintTexture(w, h, (ctx) => paintColophonPage(ctx, w, h, identity, headingInk)));
	labels.push('Details');

	return {
		textures,
		labels,
		dispose(): void {
			for (const texture of textures) texture.dispose();
		}
	};
}

/**
 * Maps `set`'s textures onto `rig`'s leaf FRONT sheets 1:1 — texture `i` onto
 * leaf `i`'s front (matches `currentSpread`'s own index space, see
 * makeSpreads' doc comment: leaf `i`'s front is the only sheet that's ever
 * `currentSpread === i`'s dominant on-screen page). Back sheets are always
 * reset to blank shared paper — a leaf's back is only ever glimpsed
 * transiently mid-turn in this rig, never a page a reader lands on and reads,
 * so there's no `currentSpread` value it needs printed content for. Front
 * sheets beyond the set's length are also reset to blank — needed both for
 * books with fewer spreads than physical leaves (the common case: 6 leaves
 * exist, most books use 2-4 spreads) and for symmetry if this is ever called
 * twice with different-length sets for the same rig. `rig`'s own
 * materials/geometry are untouched otherwise — this only ever swaps `.map`
 * on the two mesh materials per leaf. Mirrors RigHandle.applyRealCover's
 * ownership split: the rig never disposes the texture it's handed (see this
 * module's doc comment for who does).
 */
export function applySpreads(rig: RigHandle, set: SpreadSet): void {
	const blank = sharedPaperFaceTexture();
	const leafCount = rig.pagePivots.length;
	for (let leaf = 0; leaf < leafCount; leaf++) {
		applyPageMap(rig.pageSurfaces[leaf * 2], set.textures[leaf] ?? blank);
		applyPageMap(rig.pageSurfaces[leaf * 2 + 1], blank);
	}
}

function applyPageMap(mesh: THREE.Mesh | undefined, texture: THREE.CanvasTexture): void {
	if (!mesh || Array.isArray(mesh.material)) return;
	const material = mesh.material as THREE.MeshPhysicalMaterial;
	material.map = texture;
	material.needsUpdate = true;
}
