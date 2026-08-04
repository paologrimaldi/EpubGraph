import * as THREE from 'three';
import { seededRandom } from './bookIdentity';
import { SHELF_TOP } from './experience';
import {
	sharedBackdropGlowTexture,
	sharedContactShadowTexture,
	sharedWoodColorTexture,
	sharedWoodGrainTexture
} from './textures/shared';

export interface Room {
	themeTargets: {
		backdrop: THREE.Material & { color: THREE.Color };
		floor: THREE.Material & { color: THREE.Color };
		shadow: THREE.Material;
	};
	dust: THREE.Points | null;
}

const DUST_SEED = 20260803;
const DUST_COUNT = 110;

export function addRoom(scene: THREE.Scene, shelfStage: THREE.Group, reducedMotion: boolean): Room {
	// Floor — 60×40 plane lying flat, just under the shelf (large enough that
	// its far edges never seam into frame at the near-level shelf camera angle).
	const floorMaterial = new THREE.MeshStandardMaterial({ color: '#efe7d8', roughness: 1, metalness: 0 });
	const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 40), floorMaterial);
	floor.rotation.x = -Math.PI / 2;
	floor.position.set(0, -0.02, 0);
	floor.receiveShadow = true;
	scene.add(floor);

	// Backdrop — 28×14 plane facing the camera behind the shelf. The glow map
	// gives it a soft studio hot-spot; .color (set by applyScenePalette) keeps
	// tinting it multiplicatively on top, same as before.
	const backdropMaterial = new THREE.MeshStandardMaterial({
		color: '#efe7d8',
		roughness: 1,
		metalness: 0,
		map: sharedBackdropGlowTexture()
	});
	const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(28, 14), backdropMaterial);
	backdrop.position.set(0, 5.5, -3.3);
	backdrop.receiveShadow = true;
	scene.add(backdrop);

	// Walnut shelf board (top = SHELF_TOP), shared by the board, rail and uprights.
	// color is white so the dark wood color map carries the actual tone.
	const walnutMaterial = new THREE.MeshStandardMaterial({
		color: '#ffffff',
		roughness: 0.82,
		map: sharedWoodColorTexture(),
		bumpMap: sharedWoodGrainTexture(),
		bumpScale: 0.015
	});

	const boardHeight = 0.28;
	const board = new THREE.Mesh(new THREE.BoxGeometry(17, boardHeight, 1.08), walnutMaterial);
	board.position.set(0, SHELF_TOP - boardHeight / 2, -0.03);
	board.castShadow = true;
	board.receiveShadow = true;
	shelfStage.add(board);

	// Lip — darker walnut edge along the shelf front.
	const lipMaterial = new THREE.MeshStandardMaterial({ color: '#241109', roughness: 0.86, metalness: 0 });
	const lip = new THREE.Mesh(new THREE.BoxGeometry(17.05, 0.075, 1.14), lipMaterial);
	lip.position.set(0, 0.205, 0.02);
	lip.castShadow = true;
	lip.receiveShadow = true;
	shelfStage.add(lip);

	// Back rail.
	const rail = new THREE.Mesh(new THREE.BoxGeometry(17, 0.17, 0.2), walnutMaterial);
	rail.position.set(0, 0.68, -0.52);
	rail.castShadow = true;
	rail.receiveShadow = true;
	shelfStage.add(rail);

	// Uprights — flank the board at x = ±7.65, grounded on the floor.
	const uprightGeometry = new THREE.BoxGeometry(0.2, 3.8, 0.72);
	const uprightLeft = new THREE.Mesh(uprightGeometry, walnutMaterial);
	uprightLeft.position.set(-7.65, 1.9, -0.03);
	uprightLeft.castShadow = true;
	uprightLeft.receiveShadow = true;
	shelfStage.add(uprightLeft);

	const uprightRight = new THREE.Mesh(uprightGeometry, walnutMaterial);
	uprightRight.position.set(7.65, 1.9, -0.03);
	uprightRight.castShadow = true;
	uprightRight.receiveShadow = true;
	shelfStage.add(uprightRight);

	// Contact-shadow strip — radial-gradient alpha plane under the books.
	const shadowMaterial = new THREE.MeshBasicMaterial({
		color: 0x000000,
		transparent: true,
		opacity: 0.15,
		alphaMap: sharedContactShadowTexture(),
		depthWrite: false
	});
	const shadowStrip = new THREE.Mesh(new THREE.PlaneGeometry(16.5, 0.5), shadowMaterial);
	shadowStrip.rotation.x = -Math.PI / 2;
	shadowStrip.position.set(0, 0.49, 0.06);
	shelfStage.add(shadowStrip);

	// Dust motes — skipped entirely under reduced motion.
	let dust: THREE.Points | null = null;
	if (!reducedMotion) {
		const random = seededRandom(DUST_SEED);
		const positions = new Float32Array(DUST_COUNT * 3);
		for (let i = 0; i < DUST_COUNT; i++) {
			positions[i * 3] = (random() - 0.5) * 14;
			positions[i * 3 + 1] = 0.3 + random() * 3.3;
			positions[i * 3 + 2] = -3 + random() * 7;
		}
		const dustGeometry = new THREE.BufferGeometry();
		dustGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		const dustMaterial = new THREE.PointsMaterial({
			color: '#fff2df',
			size: 0.014,
			transparent: true,
			opacity: 0.3,
			depthWrite: false,
			sizeAttenuation: true
		});
		dust = new THREE.Points(dustGeometry, dustMaterial);
		scene.add(dust);
	}

	return {
		themeTargets: {
			backdrop: backdropMaterial,
			floor: floorMaterial,
			shadow: shadowMaterial
		},
		dust
	};
}
