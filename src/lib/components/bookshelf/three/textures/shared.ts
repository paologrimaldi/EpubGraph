import * as THREE from 'three';
import { seededRandom } from '../bookIdentity';

// Deterministic seed for the walnut grain streaks — this texture is a static
// studio fixture (not per-book), so a fixed seed just needs to be stable and
// reproducible across sessions.
const WOOD_GRAIN_SEED = 20260803;
const WOOD_COLOR_SEED = 4711;

const CLOTH_WEAVE_SEED = 8817231;
const CLOTH_BUMP_SEED = 4291177;
const PAPER_FIBER_SEED = 552019;

let contactShadowTexture: THREE.CanvasTexture | null = null;
let woodGrainTexture: THREE.CanvasTexture | null = null;
let backdropGlowTexture: THREE.CanvasTexture | null = null;
let woodColorTexture: THREE.CanvasTexture | null = null;
let clothNormalTexture: THREE.CanvasTexture | null = null;
let clothRoughnessTexture: THREE.CanvasTexture | null = null;
let clothBumpTexture: THREE.CanvasTexture | null = null;
let paperFaceTexture: THREE.CanvasTexture | null = null;
let pageEdgeForeTexture: THREE.CanvasTexture | null = null;
let pageEdgeHeadTailTexture: THREE.CanvasTexture | null = null;

/** 128² radial gradient (white center → black edge) used as an alphaMap for baked contact shadows. */
export function sharedContactShadowTexture(): THREE.CanvasTexture {
	if (contactShadowTexture) return contactShadowTexture;

	const size = 128;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;

	const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
	gradient.addColorStop(0.7, 'rgba(80, 80, 80, 1)');
	gradient.addColorStop(1, 'rgba(0, 0, 0, 1)');
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, size, size);

	contactShadowTexture = new THREE.CanvasTexture(canvas);
	contactShadowTexture.needsUpdate = true;
	return contactShadowTexture;
}

/** 256² procedural wood-grain bump map — seeded horizontal noise streaks for the walnut shelf board. */
export function sharedWoodGrainTexture(): THREE.CanvasTexture {
	if (woodGrainTexture) return woodGrainTexture;

	const size = 256;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;

	ctx.fillStyle = 'rgb(128, 128, 128)';
	ctx.fillRect(0, 0, size, size);

	const random = seededRandom(WOOD_GRAIN_SEED);
	const streakCount = 140;
	for (let i = 0; i < streakCount; i++) {
		const y = random() * size;
		const shade = Math.round(96 + random() * 96);
		const waveAmp = random() * 3;
		const wavePhase = random() * Math.PI * 2;
		ctx.strokeStyle = `rgba(${shade}, ${shade}, ${shade}, ${(0.25 + random() * 0.35).toFixed(3)})`;
		ctx.lineWidth = 0.6 + random() * 1.8;
		ctx.beginPath();
		ctx.moveTo(0, y);
		for (let x = 0; x <= size; x += 16) {
			ctx.lineTo(x, y + Math.sin((x / size) * Math.PI * 2 + wavePhase) * waveAmp);
		}
		ctx.stroke();
	}

	woodGrainTexture = new THREE.CanvasTexture(canvas);
	woodGrainTexture.wrapS = THREE.RepeatWrapping;
	woodGrainTexture.wrapT = THREE.RepeatWrapping;
	// The board is 17 units wide; a single 256px tile stretched across it reads
	// as smeared horizontal bands. Repeat it along its length so grain streaks
	// stay streak-sized instead of scaling up with the board.
	woodGrainTexture.repeat.set(7, 1);
	woodGrainTexture.needsUpdate = true;
	return woodGrainTexture;
}

/** 256² radial studio-glow paint (bright center → warm gray edge), used as the backdrop's color map. */
export function sharedBackdropGlowTexture(): THREE.CanvasTexture {
	if (backdropGlowTexture) return backdropGlowTexture;

	const size = 256;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;

	const centerX = size * 0.5;
	const centerY = size * 0.62;
	const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, size * 0.75);
	gradient.addColorStop(0, '#ffffff');
	gradient.addColorStop(1, '#b8b0a2');
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, size, size);

	// Darken toward the bottom edge so the wall reads as receding into shadow at
	// the shelf line instead of showing a bright strip between rail and board.
	const darken = ctx.createLinearGradient(0, size * 0.55, 0, size);
	darken.addColorStop(0, 'rgba(0, 0, 0, 0)');
	darken.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
	ctx.fillStyle = darken;
	ctx.fillRect(0, size * 0.55, size, size * 0.45);

	backdropGlowTexture = new THREE.CanvasTexture(canvas);
	backdropGlowTexture.colorSpace = THREE.SRGBColorSpace;
	backdropGlowTexture.needsUpdate = true;
	return backdropGlowTexture;
}

/** 256² dark wood color map — seeded horizontal grain streaks alternating light/dark walnut tones. */
export function sharedWoodColorTexture(): THREE.CanvasTexture {
	if (woodColorTexture) return woodColorTexture;

	const size = 256;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;

	ctx.fillStyle = '#2a1810';
	ctx.fillRect(0, 0, size, size);

	const random = seededRandom(WOOD_COLOR_SEED);
	const streakCount = 40;
	ctx.globalAlpha = 0.5;
	for (let i = 0; i < streakCount; i++) {
		const y = random() * size;
		const streakHeight = 1 + random() * 2;
		ctx.fillStyle = random() < 0.5 ? '#1f0f08' : '#3a2418';
		ctx.fillRect(0, y, size, streakHeight);
	}
	ctx.globalAlpha = 1;

	woodColorTexture = new THREE.CanvasTexture(canvas);
	woodColorTexture.colorSpace = THREE.SRGBColorSpace;
	woodColorTexture.wrapS = THREE.RepeatWrapping;
	woodColorTexture.wrapT = THREE.RepeatWrapping;
	woodColorTexture.repeat.set(7, 1);
	woodColorTexture.needsUpdate = true;
	return woodColorTexture;
}

/**
 * 256² cloth weave — normal + roughness maps derived from a shared height field
 * (crossed `sin` weave plus seeded noise), and an independent per-pixel noise
 * bump layer for fine grain (§5.1). All memoized singletons, tiled via
 * `RepeatWrapping`; tint per-book via the material's `.color`, never baked here.
 */
export function sharedClothMaps(): {
	normal: THREE.CanvasTexture;
	roughness: THREE.CanvasTexture;
	bump: THREE.CanvasTexture;
} {
	if (clothNormalTexture && clothRoughnessTexture && clothBumpTexture) {
		return { normal: clothNormalTexture, roughness: clothRoughnessTexture, bump: clothBumpTexture };
	}

	const size = 256;
	const TAU = Math.PI * 2;
	const weaveRandom = seededRandom(CLOTH_WEAVE_SEED);

	// Height field: two crossed sine waves (the weave's warp/weft) plus seeded
	// per-texel noise. Sampled with wraparound below so the tile is seamless.
	const height = new Float32Array(size * size);
	let min = Infinity;
	let max = -Infinity;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const u = x / size;
			const v = y / size;
			const weave = Math.sin(u * TAU * 48) + Math.sin(v * TAU * 48);
			const h = weave + (weaveRandom() - 0.5) * 0.7;
			height[y * size + x] = h;
			if (h < min) min = h;
			if (h > max) max = h;
		}
	}
	const range = max - min || 1;

	const normalCanvas = document.createElement('canvas');
	normalCanvas.width = size;
	normalCanvas.height = size;
	const normalCtx = normalCanvas.getContext('2d')!;
	const normalImage = normalCtx.createImageData(size, size);

	const roughnessCanvas = document.createElement('canvas');
	roughnessCanvas.width = size;
	roughnessCanvas.height = size;
	const roughnessCtx = roughnessCanvas.getContext('2d')!;
	const roughnessImage = roughnessCtx.createImageData(size, size);

	const strength = 1.6;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const idx = (y * size + x) * 4;
			// Finite differences with wraparound neighbors keep the normal map
			// seamless when repeated across the wide board/cloth faces.
			const left = height[y * size + ((x - 1 + size) % size)];
			const right = height[y * size + ((x + 1) % size)];
			const up = height[((y - 1 + size) % size) * size + x];
			const down = height[((y + 1) % size) * size + x];
			const dx = (left - right) * strength;
			const dy = (up - down) * strength;
			const dz = 1;
			const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
			normalImage.data[idx] = ((dx / len) * 0.5 + 0.5) * 255;
			normalImage.data[idx + 1] = ((dy / len) * 0.5 + 0.5) * 255;
			normalImage.data[idx + 2] = ((dz / len) * 0.5 + 0.5) * 255;
			normalImage.data[idx + 3] = 255;

			const t = (height[y * size + x] - min) / range;
			// Flattened toward the mean (0.88–0.98, not 0.85–1.0) — at fine tiling
			// (8×12 repeats across a board) the earlier wider swing produced a
			// visible checkered sheen instead of an even, whispering weave.
			const rough = Math.round((0.88 + t * 0.1) * 255);
			roughnessImage.data[idx] = rough;
			roughnessImage.data[idx + 1] = rough;
			roughnessImage.data[idx + 2] = rough;
			roughnessImage.data[idx + 3] = 255;
		}
	}
	normalCtx.putImageData(normalImage, 0, 0);
	roughnessCtx.putImageData(roughnessImage, 0, 0);

	const bumpCanvas = document.createElement('canvas');
	bumpCanvas.width = size;
	bumpCanvas.height = size;
	const bumpCtx = bumpCanvas.getContext('2d')!;
	const bumpImage = bumpCtx.createImageData(size, size);
	const bumpRandom = seededRandom(CLOTH_BUMP_SEED);
	for (let i = 0; i < bumpImage.data.length; i += 4) {
		const value = 128 + Math.round((bumpRandom() - 0.5) * 20);
		bumpImage.data[i] = value;
		bumpImage.data[i + 1] = value;
		bumpImage.data[i + 2] = value;
		bumpImage.data[i + 3] = 255;
	}
	bumpCtx.putImageData(bumpImage, 0, 0);

	// Fine tiling: these maps are UV-mapped across a whole board face (roughly
	// [0,1] per plane, per `roundedPlaneGeometry`'s remap and RoundedBoxGeometry's
	// own per-face UVs), so a 1×1 repeat stretches this single weave cycle over
	// the entire board — reading as coarse burlap instead of a fine, barely-visible
	// weave. Tiling it 8× across width / 12× vertically brings each thread back
	// down to a whisper at shelf viewing distance. Consumed only by book rig
	// materials (cloth/art/spine/lining), so it's safe to set globally here.
	const CLOTH_REPEAT_X = 8;
	const CLOTH_REPEAT_Y = 12;

	clothNormalTexture = new THREE.CanvasTexture(normalCanvas);
	clothNormalTexture.colorSpace = THREE.NoColorSpace;
	clothNormalTexture.wrapS = THREE.RepeatWrapping;
	clothNormalTexture.wrapT = THREE.RepeatWrapping;
	clothNormalTexture.repeat.set(CLOTH_REPEAT_X, CLOTH_REPEAT_Y);
	clothNormalTexture.needsUpdate = true;

	clothRoughnessTexture = new THREE.CanvasTexture(roughnessCanvas);
	clothRoughnessTexture.colorSpace = THREE.NoColorSpace;
	clothRoughnessTexture.wrapS = THREE.RepeatWrapping;
	clothRoughnessTexture.wrapT = THREE.RepeatWrapping;
	clothRoughnessTexture.repeat.set(CLOTH_REPEAT_X, CLOTH_REPEAT_Y);
	clothRoughnessTexture.needsUpdate = true;

	clothBumpTexture = new THREE.CanvasTexture(bumpCanvas);
	clothBumpTexture.colorSpace = THREE.NoColorSpace;
	clothBumpTexture.wrapS = THREE.RepeatWrapping;
	clothBumpTexture.wrapT = THREE.RepeatWrapping;
	clothBumpTexture.repeat.set(CLOTH_REPEAT_X, CLOTH_REPEAT_Y);
	clothBumpTexture.needsUpdate = true;

	return { normal: clothNormalTexture, roughness: clothRoughnessTexture, bump: clothBumpTexture };
}

/** 256² light-gray paper fiber grain on `#f5efdf` — color map for the page block/edges. */
export function sharedPaperFaceTexture(): THREE.CanvasTexture {
	if (paperFaceTexture) return paperFaceTexture;

	const size = 256;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;

	ctx.fillStyle = '#f5efdf';
	ctx.fillRect(0, 0, size, size);

	const random = seededRandom(PAPER_FIBER_SEED);
	const fiberCount = 240;
	ctx.strokeStyle = 'rgba(150, 140, 118, 0.35)';
	for (let i = 0; i < fiberCount; i++) {
		const x = random() * size;
		const y = random() * size;
		const angle = random() * Math.PI;
		const len = 2 + random() * 6;
		ctx.lineWidth = 0.4 + random() * 0.5;
		ctx.beginPath();
		ctx.moveTo(x - Math.cos(angle) * len * 0.5, y - Math.sin(angle) * len * 0.5);
		ctx.lineTo(x + Math.cos(angle) * len * 0.5, y + Math.sin(angle) * len * 0.5);
		ctx.stroke();
	}

	paperFaceTexture = new THREE.CanvasTexture(canvas);
	paperFaceTexture.colorSpace = THREE.SRGBColorSpace;
	paperFaceTexture.wrapS = THREE.RepeatWrapping;
	paperFaceTexture.wrapT = THREE.RepeatWrapping;
	paperFaceTexture.needsUpdate = true;
	return paperFaceTexture;
}

/**
 * Fine page-edge line stacks: `fore` (256×512, 1px vertical lines alternating
 * left→right) and `headTail` (512×256, the same alternation rotated to
 * horizontal lines top→bottom).
 */
export function sharedPageEdgeTextures(): { fore: THREE.CanvasTexture; headTail: THREE.CanvasTexture } {
	if (pageEdgeForeTexture && pageEdgeHeadTailTexture) {
		return { fore: pageEdgeForeTexture, headTail: pageEdgeHeadTailTexture };
	}

	const colorA = '#efe6d2';
	const colorB = '#d9cdb4';

	const foreCanvas = document.createElement('canvas');
	foreCanvas.width = 256;
	foreCanvas.height = 512;
	const foreCtx = foreCanvas.getContext('2d')!;
	for (let x = 0; x < foreCanvas.width; x++) {
		foreCtx.fillStyle = x % 2 === 0 ? colorA : colorB;
		foreCtx.fillRect(x, 0, 1, foreCanvas.height);
	}

	const headTailCanvas = document.createElement('canvas');
	headTailCanvas.width = 512;
	headTailCanvas.height = 256;
	const headTailCtx = headTailCanvas.getContext('2d')!;
	for (let y = 0; y < headTailCanvas.height; y++) {
		headTailCtx.fillStyle = y % 2 === 0 ? colorA : colorB;
		headTailCtx.fillRect(0, y, headTailCanvas.width, 1);
	}

	pageEdgeForeTexture = new THREE.CanvasTexture(foreCanvas);
	pageEdgeForeTexture.colorSpace = THREE.SRGBColorSpace;
	pageEdgeForeTexture.needsUpdate = true;

	pageEdgeHeadTailTexture = new THREE.CanvasTexture(headTailCanvas);
	pageEdgeHeadTailTexture.colorSpace = THREE.SRGBColorSpace;
	pageEdgeHeadTailTexture.needsUpdate = true;

	return { fore: pageEdgeForeTexture, headTail: pageEdgeHeadTailTexture };
}

/** Disposes and clears the memoized shared textures (app-lifetime teardown / HMR, not per-mount). */
export function disposeSharedTextures(): void {
	contactShadowTexture?.dispose();
	contactShadowTexture = null;
	woodGrainTexture?.dispose();
	woodGrainTexture = null;
	backdropGlowTexture?.dispose();
	backdropGlowTexture = null;
	woodColorTexture?.dispose();
	woodColorTexture = null;
	clothNormalTexture?.dispose();
	clothNormalTexture = null;
	clothRoughnessTexture?.dispose();
	clothRoughnessTexture = null;
	clothBumpTexture?.dispose();
	clothBumpTexture = null;
	paperFaceTexture?.dispose();
	paperFaceTexture = null;
	pageEdgeForeTexture?.dispose();
	pageEdgeForeTexture = null;
	pageEdgeHeadTailTexture?.dispose();
	pageEdgeHeadTailTexture = null;
}
