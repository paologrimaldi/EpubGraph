import * as THREE from 'three';
import { seededRandom } from '../bookIdentity';

// Deterministic seed for the walnut grain streaks — this texture is a static
// studio fixture (not per-book), so a fixed seed just needs to be stable and
// reproducible across sessions.
const WOOD_GRAIN_SEED = 20260803;

let contactShadowTexture: THREE.CanvasTexture | null = null;
let woodGrainTexture: THREE.CanvasTexture | null = null;
let backdropGlowTexture: THREE.CanvasTexture | null = null;

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

	backdropGlowTexture = new THREE.CanvasTexture(canvas);
	backdropGlowTexture.colorSpace = THREE.SRGBColorSpace;
	backdropGlowTexture.needsUpdate = true;
	return backdropGlowTexture;
}

/** Disposes and clears the memoized shared textures (app-lifetime teardown / HMR, not per-mount). */
export function disposeSharedTextures(): void {
	contactShadowTexture?.dispose();
	contactShadowTexture = null;
	woodGrainTexture?.dispose();
	woodGrainTexture = null;
	backdropGlowTexture?.dispose();
	backdropGlowTexture = null;
}
