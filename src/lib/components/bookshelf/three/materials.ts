import * as THREE from 'three';
import type { BookDimensions } from '../types/config';

const textureLoader = new THREE.TextureLoader();
const textureCache = new Map<string, THREE.Texture>();

// ============================================
// UTILITY FUNCTIONS FOR PBR TEXTURE GENERATION
// ============================================

// Generate a normal map from height data (grayscale)
function generateNormalMapFromHeight(heightCanvas: HTMLCanvasElement, strength: number = 1): THREE.CanvasTexture {
	const width = heightCanvas.width;
	const height = heightCanvas.height;

	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d')!;

	// Get height data
	const heightCtx = heightCanvas.getContext('2d')!;
	const heightData = heightCtx.getImageData(0, 0, width, height).data;

	const normalData = ctx.createImageData(width, height);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const idx = (y * width + x) * 4;

			// Sample neighboring pixels for gradient
			const left = x > 0 ? heightData[idx - 4] : heightData[idx];
			const right = x < width - 1 ? heightData[idx + 4] : heightData[idx];
			const up = y > 0 ? heightData[idx - width * 4] : heightData[idx];
			const down = y < height - 1 ? heightData[idx + width * 4] : heightData[idx];

			// Calculate normal from height differences
			const dx = (left - right) * strength / 255;
			const dy = (up - down) * strength / 255;
			const dz = 1;

			// Normalize
			const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

			// Convert to RGB (normal map format: R=X, G=Y, B=Z)
			normalData.data[idx] = ((dx / len) * 0.5 + 0.5) * 255;
			normalData.data[idx + 1] = ((dy / len) * 0.5 + 0.5) * 255;
			normalData.data[idx + 2] = ((dz / len) * 0.5 + 0.5) * 255;
			normalData.data[idx + 3] = 255;
		}
	}

	ctx.putImageData(normalData, 0, 0);

	const texture = new THREE.CanvasTexture(canvas);
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	return texture;
}

// ============================================
// WALL TEXTURES (White plaster/stucco)
// ============================================

function createWallColorMap(darkMode: boolean = false): THREE.CanvasTexture {
	const canvas = document.createElement('canvas');
	canvas.width = 512;
	canvas.height = 512;
	const ctx = canvas.getContext('2d')!;

	// Base color: off-white for light mode, dark gray-blue for dark mode
	ctx.fillStyle = darkMode ? '#1a1a2e' : '#f5f5f0';
	ctx.fillRect(0, 0, 512, 512);

	// Subtle color variations for plaster effect
	const imageData = ctx.getImageData(0, 0, 512, 512);
	const data = imageData.data;

	for (let i = 0; i < data.length; i += 4) {
		const variation = (Math.random() - 0.5) * 10;
		data[i] = Math.max(0, Math.min(255, data[i] + variation));
		data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + variation));
		data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + variation - 3));
	}

	ctx.putImageData(imageData, 0, 0);

	const texture = new THREE.CanvasTexture(canvas);
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}

function createWallHeightMap(): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = 512;
	canvas.height = 512;
	const ctx = canvas.getContext('2d')!;

	// Gray base
	ctx.fillStyle = '#808080';
	ctx.fillRect(0, 0, 512, 512);

	// Add stucco-like bumps
	const imageData = ctx.getImageData(0, 0, 512, 512);
	const data = imageData.data;

	// Multiple noise passes for realistic stucco
	for (let i = 0; i < data.length; i += 4) {
		const noise = (Math.random() - 0.5) * 40;
		const value = 128 + noise;
		data[i] = value;
		data[i + 1] = value;
		data[i + 2] = value;
	}

	ctx.putImageData(imageData, 0, 0);

	// Add some larger bumps
	for (let i = 0; i < 100; i++) {
		const x = Math.random() * 512;
		const y = Math.random() * 512;
		const r = 2 + Math.random() * 8;
		const brightness = 100 + Math.random() * 50;

		ctx.fillStyle = `rgb(${brightness}, ${brightness}, ${brightness})`;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fill();
	}

	return canvas;
}

function createWallRoughnessMap(): THREE.CanvasTexture {
	const canvas = document.createElement('canvas');
	canvas.width = 512;
	canvas.height = 512;
	const ctx = canvas.getContext('2d')!;

	// High roughness base (plaster is rough)
	ctx.fillStyle = '#d0d0d0'; // ~0.8 roughness
	ctx.fillRect(0, 0, 512, 512);

	// Variations
	const imageData = ctx.getImageData(0, 0, 512, 512);
	const data = imageData.data;

	for (let i = 0; i < data.length; i += 4) {
		const noise = (Math.random() - 0.5) * 30;
		const value = Math.max(180, Math.min(240, data[i] + noise));
		data[i] = value;
		data[i + 1] = value;
		data[i + 2] = value;
	}

	ctx.putImageData(imageData, 0, 0);

	const texture = new THREE.CanvasTexture(canvas);
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	return texture;
}

export function createWallMaterial(darkMode: boolean = false): THREE.MeshStandardMaterial {
	const colorMap = createWallColorMap(darkMode);
	const heightCanvas = createWallHeightMap();
	const normalMap = generateNormalMapFromHeight(heightCanvas, 2);
	const roughnessMap = createWallRoughnessMap();

	colorMap.repeat.set(4, 4);
	normalMap.repeat.set(4, 4);
	roughnessMap.repeat.set(4, 4);

	return new THREE.MeshStandardMaterial({
		map: colorMap,
		normalMap: normalMap,
		normalScale: new THREE.Vector2(0.5, 0.5),
		roughnessMap: roughnessMap,
		roughness: 0.9,
		metalness: 0.0
	});
}

// ============================================
// WOOD TEXTURES (Realistic oak)
// ============================================

function createWoodColorMap(): THREE.CanvasTexture {
	const canvas = document.createElement('canvas');
	canvas.width = 512;
	canvas.height = 256;
	const ctx = canvas.getContext('2d')!;

	// Rich wood base color
	const gradient = ctx.createLinearGradient(0, 0, 0, 256);
	gradient.addColorStop(0, '#8B6914');
	gradient.addColorStop(0.5, '#A0522D');
	gradient.addColorStop(1, '#8B4513');
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, 512, 256);

	// Wood grain lines
	ctx.strokeStyle = '#6B4423';
	ctx.lineWidth = 1;

	for (let i = 0; i < 60; i++) {
		const y = (i / 60) * 256;
		const amplitude = 2 + Math.random() * 4;
		const frequency = 0.01 + Math.random() * 0.02;
		const opacity = 0.3 + Math.random() * 0.4;

		ctx.strokeStyle = `rgba(60, 40, 20, ${opacity})`;
		ctx.beginPath();
		ctx.moveTo(0, y);

		for (let x = 0; x < 512; x += 3) {
			const offset = Math.sin(x * frequency) * amplitude;
			ctx.lineTo(x, y + offset);
		}
		ctx.stroke();
	}

	// Add some knots
	for (let i = 0; i < 2; i++) {
		const x = 50 + Math.random() * 400;
		const y = 30 + Math.random() * 200;
		const rx = 15 + Math.random() * 20;
		const ry = 10 + Math.random() * 15;

		const knotGradient = ctx.createRadialGradient(x, y, 0, x, y, rx);
		knotGradient.addColorStop(0, '#3D2817');
		knotGradient.addColorStop(0.6, '#5D4037');
		knotGradient.addColorStop(1, 'transparent');

		ctx.fillStyle = knotGradient;
		ctx.beginPath();
		ctx.ellipse(x, y, rx, ry, Math.random() * Math.PI, 0, Math.PI * 2);
		ctx.fill();
	}

	const texture = new THREE.CanvasTexture(canvas);
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}

function createWoodHeightMap(): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = 512;
	canvas.height = 256;
	const ctx = canvas.getContext('2d')!;

	ctx.fillStyle = '#808080';
	ctx.fillRect(0, 0, 512, 256);

	// Wood grain height variations
	for (let i = 0; i < 60; i++) {
		const y = (i / 60) * 256;
		const brightness = 110 + Math.random() * 35;

		ctx.strokeStyle = `rgb(${brightness}, ${brightness}, ${brightness})`;
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(0, y);

		for (let x = 0; x < 512; x += 3) {
			const offset = Math.sin(x * 0.015) * 3;
			ctx.lineTo(x, y + offset);
		}
		ctx.stroke();
	}

	return canvas;
}

function createWoodRoughnessMap(): THREE.CanvasTexture {
	const canvas = document.createElement('canvas');
	canvas.width = 512;
	canvas.height = 256;
	const ctx = canvas.getContext('2d')!;

	// Medium-high roughness for wood
	ctx.fillStyle = '#a0a0a0'; // ~0.6 roughness
	ctx.fillRect(0, 0, 512, 256);

	// Grain has slightly different roughness
	for (let i = 0; i < 40; i++) {
		const y = (i / 40) * 256;
		const brightness = 140 + Math.random() * 40;

		ctx.strokeStyle = `rgb(${brightness}, ${brightness}, ${brightness})`;
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(512, y + (Math.random() - 0.5) * 10);
		ctx.stroke();
	}

	const texture = new THREE.CanvasTexture(canvas);
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	return texture;
}

export function createShelfMaterial(): THREE.MeshStandardMaterial {
	const colorMap = createWoodColorMap();
	const heightCanvas = createWoodHeightMap();
	const normalMap = generateNormalMapFromHeight(heightCanvas, 3);
	const roughnessMap = createWoodRoughnessMap();

	return new THREE.MeshStandardMaterial({
		map: colorMap,
		normalMap: normalMap,
		normalScale: new THREE.Vector2(0.3, 0.3),
		roughnessMap: roughnessMap,
		roughness: 0.7,
		metalness: 0.0
	});
}

// ============================================
// LEATHER TEXTURES (Realistic leather)
// ============================================

function createLeatherColorMap(color: THREE.Color): THREE.CanvasTexture {
	const canvas = document.createElement('canvas');
	canvas.width = 256;
	canvas.height = 256;
	const ctx = canvas.getContext('2d')!;

	// Base color with subtle gradient
	const hex = color.getHexString();
	const darker = color.clone().multiplyScalar(0.85);

	const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 200);
	gradient.addColorStop(0, `#${hex}`);
	gradient.addColorStop(1, `#${darker.getHexString()}`);
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, 256, 256);

	// Leather grain - fine noise
	const imageData = ctx.getImageData(0, 0, 256, 256);
	const data = imageData.data;

	for (let i = 0; i < data.length; i += 4) {
		const noise = (Math.random() - 0.5) * 18;
		data[i] = Math.max(0, Math.min(255, data[i] + noise));
		data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
		data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
	}

	ctx.putImageData(imageData, 0, 0);

	// Add subtle creases
	ctx.strokeStyle = `rgba(0, 0, 0, 0.08)`;
	ctx.lineWidth = 1;

	for (let i = 0; i < 30; i++) {
		const x1 = Math.random() * 256;
		const y1 = Math.random() * 256;
		const length = 20 + Math.random() * 40;
		const angle = Math.random() * Math.PI * 2;

		ctx.beginPath();
		ctx.moveTo(x1, y1);
		ctx.quadraticCurveTo(
			x1 + Math.cos(angle) * length * 0.5 + (Math.random() - 0.5) * 20,
			y1 + Math.sin(angle) * length * 0.5 + (Math.random() - 0.5) * 20,
			x1 + Math.cos(angle) * length,
			y1 + Math.sin(angle) * length
		);
		ctx.stroke();
	}

	const texture = new THREE.CanvasTexture(canvas);
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}

function createLeatherHeightMap(): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = 256;
	canvas.height = 256;
	const ctx = canvas.getContext('2d')!;

	ctx.fillStyle = '#808080';
	ctx.fillRect(0, 0, 256, 256);

	// Fine leather grain bumps
	const imageData = ctx.getImageData(0, 0, 256, 256);
	const data = imageData.data;

	for (let i = 0; i < data.length; i += 4) {
		const noise = (Math.random() - 0.5) * 50;
		const value = 128 + noise;
		data[i] = value;
		data[i + 1] = value;
		data[i + 2] = value;
	}

	ctx.putImageData(imageData, 0, 0);

	// Pore-like indentations
	for (let i = 0; i < 200; i++) {
		const x = Math.random() * 256;
		const y = Math.random() * 256;
		const r = 1 + Math.random() * 2;

		ctx.fillStyle = `rgb(${90 + Math.random() * 30}, ${90 + Math.random() * 30}, ${90 + Math.random() * 30})`;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fill();
	}

	return canvas;
}

function createLeatherRoughnessMap(): THREE.CanvasTexture {
	const canvas = document.createElement('canvas');
	canvas.width = 256;
	canvas.height = 256;
	const ctx = canvas.getContext('2d')!;

	// Leather is moderately rough with variations
	ctx.fillStyle = '#909090'; // ~0.55 roughness base
	ctx.fillRect(0, 0, 256, 256);

	const imageData = ctx.getImageData(0, 0, 256, 256);
	const data = imageData.data;

	for (let i = 0; i < data.length; i += 4) {
		const noise = (Math.random() - 0.5) * 40;
		const value = Math.max(100, Math.min(180, data[i] + noise));
		data[i] = value;
		data[i + 1] = value;
		data[i + 2] = value;
	}

	ctx.putImageData(imageData, 0, 0);

	// Some smoother worn areas
	for (let i = 0; i < 5; i++) {
		const x = Math.random() * 256;
		const y = Math.random() * 256;
		const r = 15 + Math.random() * 25;

		const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
		gradient.addColorStop(0, 'rgba(70, 70, 70, 0.5)');
		gradient.addColorStop(1, 'transparent');

		ctx.fillStyle = gradient;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fill();
	}

	const texture = new THREE.CanvasTexture(canvas);
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	return texture;
}

export function createBookSideMaterial(color: THREE.Color): THREE.MeshStandardMaterial {
	const colorMap = createLeatherColorMap(color);
	const heightCanvas = createLeatherHeightMap();
	const normalMap = generateNormalMapFromHeight(heightCanvas, 4);
	const roughnessMap = createLeatherRoughnessMap();

	return new THREE.MeshStandardMaterial({
		map: colorMap,
		normalMap: normalMap,
		normalScale: new THREE.Vector2(0.6, 0.6),
		roughnessMap: roughnessMap,
		roughness: 0.6,
		metalness: 0.0
	});
}

// ============================================
// BOOK SPINE MATERIAL
// ============================================

export function createBookSpineMaterial(
	title: string,
	author: string | null,
	color: THREE.Color,
	dimensions: BookDimensions
): THREE.MeshStandardMaterial {
	const canvasWidth = 128;
	const canvasHeight = 512;

	const canvas = document.createElement('canvas');
	canvas.width = canvasWidth;
	canvas.height = canvasHeight;
	const ctx = canvas.getContext('2d')!;

	// Leather base with gradient
	const gradient = ctx.createLinearGradient(0, 0, canvasWidth, 0);
	gradient.addColorStop(0, `#${color.clone().multiplyScalar(0.9).getHexString()}`);
	gradient.addColorStop(0.5, `#${color.getHexString()}`);
	gradient.addColorStop(1, `#${color.clone().multiplyScalar(0.85).getHexString()}`);
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, canvasWidth, canvasHeight);

	// Leather grain
	const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
	const data = imageData.data;
	for (let i = 0; i < data.length; i += 4) {
		const noise = (Math.random() - 0.5) * 15;
		data[i] = Math.max(0, Math.min(255, data[i] + noise));
		data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
		data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
	}
	ctx.putImageData(imageData, 0, 0);

	// Decorative bands
	const goldColor = 'rgba(212, 175, 55, 0.8)';
	ctx.fillStyle = goldColor;
	ctx.fillRect(8, 25, canvasWidth - 16, 3);
	ctx.fillRect(8, 35, canvasWidth - 16, 1);
	ctx.fillRect(8, canvasHeight - 40, canvasWidth - 16, 3);
	ctx.fillRect(8, canvasHeight - 30, canvasWidth - 16, 1);

	// Title
	ctx.save();
	ctx.translate(canvasWidth / 2, canvasHeight / 2);
	ctx.rotate(-Math.PI / 2);

	ctx.fillStyle = '#D4AF37';
	ctx.font = 'bold 28px "Georgia", "Times New Roman", serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.shadowColor = 'rgba(0,0,0,0.6)';
	ctx.shadowBlur = 3;
	ctx.shadowOffsetX = 1;
	ctx.shadowOffsetY = 1;

	let displayTitle = title;
	const maxWidth = canvasHeight - 100;
	while (ctx.measureText(displayTitle).width > maxWidth && displayTitle.length > 3) {
		displayTitle = displayTitle.slice(0, -4) + '...';
	}
	ctx.fillText(displayTitle, 0, author ? -14 : 0);

	if (author) {
		ctx.font = '18px "Georgia", "Times New Roman", serif';
		ctx.fillStyle = 'rgba(212, 175, 55, 0.85)';
		let displayAuthor = author;
		while (ctx.measureText(displayAuthor).width > maxWidth && displayAuthor.length > 3) {
			displayAuthor = displayAuthor.slice(0, -4) + '...';
		}
		ctx.fillText(displayAuthor, 0, 16);
	}
	ctx.restore();

	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;

	return new THREE.MeshStandardMaterial({
		map: texture,
		roughness: 0.5,
		metalness: 0.15
	});
}

// ============================================
// BOOK COVER MATERIAL
// ============================================

export function createBookCoverMaterial(
	title: string,
	author: string | null,
	coverPath: string | null,
	color: THREE.Color
): THREE.MeshStandardMaterial {
	const canvasWidth = 512;
	const canvasHeight = 700;

	const canvas = document.createElement('canvas');
	canvas.width = canvasWidth;
	canvas.height = canvasHeight;
	const ctx = canvas.getContext('2d')!;

	// Leather gradient
	const bgGradient = ctx.createLinearGradient(0, 0, canvasWidth, canvasHeight);
	bgGradient.addColorStop(0, `#${color.getHexString()}`);
	bgGradient.addColorStop(1, `#${color.clone().multiplyScalar(0.8).getHexString()}`);
	ctx.fillStyle = bgGradient;
	ctx.fillRect(0, 0, canvasWidth, canvasHeight);

	// Leather grain
	const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
	const data = imageData.data;
	for (let i = 0; i < data.length; i += 4) {
		const noise = (Math.random() - 0.5) * 12;
		data[i] = Math.max(0, Math.min(255, data[i] + noise));
		data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
		data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
	}
	ctx.putImageData(imageData, 0, 0);

	// Gold decorative border
	ctx.strokeStyle = 'rgba(212, 175, 55, 0.5)';
	ctx.lineWidth = 4;
	ctx.strokeRect(20, 20, canvasWidth - 40, canvasHeight - 40);
	ctx.lineWidth = 1;
	ctx.strokeRect(30, 30, canvasWidth - 60, canvasHeight - 60);

	// Title
	ctx.fillStyle = '#D4AF37';
	ctx.font = 'bold 42px "Georgia", "Times New Roman", serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.shadowColor = 'rgba(0,0,0,0.7)';
	ctx.shadowBlur = 6;
	ctx.shadowOffsetX = 2;
	ctx.shadowOffsetY = 2;

	const words = title.split(' ');
	const lines: string[] = [];
	let currentLine = '';
	const maxLineWidth = canvasWidth - 80;

	for (const word of words) {
		const testLine = currentLine ? `${currentLine} ${word}` : word;
		if (ctx.measureText(testLine).width > maxLineWidth) {
			if (currentLine) lines.push(currentLine);
			currentLine = word;
		} else {
			currentLine = testLine;
		}
	}
	if (currentLine) lines.push(currentLine);

	const lineHeight = 50;
	const titleStartY = 200;
	lines.forEach((line, i) => {
		ctx.fillText(line, canvasWidth / 2, titleStartY + i * lineHeight);
	});

	if (author) {
		ctx.font = '28px "Georgia", "Times New Roman", serif';
		ctx.fillStyle = 'rgba(212, 175, 55, 0.9)';
		ctx.fillText(author, canvasWidth / 2, canvasHeight - 120);
	}

	// Decorative line
	ctx.strokeStyle = 'rgba(212, 175, 55, 0.5)';
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.moveTo(100, canvasHeight - 180);
	ctx.lineTo(canvasWidth - 100, canvasHeight - 180);
	ctx.stroke();

	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;

	const material = new THREE.MeshStandardMaterial({
		map: texture,
		roughness: 0.5,
		metalness: 0.1
	});

	if (coverPath) {
		textureLoader.load(
			coverPath,
			(loadedTexture) => {
				loadedTexture.colorSpace = THREE.SRGBColorSpace;
				material.map = loadedTexture;
				material.needsUpdate = true;
			},
			undefined, // onProgress
			(error) => {
				// Cover failed to load, keep the generated texture
				console.debug('Cover not found, using generated texture:', coverPath);
			}
		);
	}

	return material;
}

export function disposeTextures(): void {
	textureCache.forEach((texture) => texture.dispose());
	textureCache.clear();
}
