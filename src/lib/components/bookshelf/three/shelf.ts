import * as THREE from 'three';
import type { LibraryConfig } from '../types/config';
import { createShelfMaterial } from './materials';

export interface ShelfDimensions {
	width: number;
	height: number;
	depth: number;
	thickness: number;
}

export function createShelfMesh(
	width: number,
	config: LibraryConfig,
	position: THREE.Vector3
): THREE.Group {
	const group = new THREE.Group();
	const material = createShelfMaterial();

	const thickness = config.shelfThickness;
	const depth = 0.8; // Shelf depth (how far books can sit)

	// Main shelf board (horizontal platform)
	const shelfGeometry = new THREE.BoxGeometry(width, thickness, depth);
	const shelf = new THREE.Mesh(shelfGeometry, material);
	shelf.position.set(0, 0, 0);
	shelf.castShadow = true;
	shelf.receiveShadow = true;
	group.add(shelf);

	// Back panel (thin vertical strip behind books)
	const backHeight = 0.3;
	const backGeometry = new THREE.BoxGeometry(width, backHeight, thickness / 2);
	const back = new THREE.Mesh(backGeometry, material.clone());
	back.position.set(0, backHeight / 2 + thickness / 2, -depth / 2 + thickness / 4);
	back.castShadow = true;
	back.receiveShadow = true;
	group.add(back);

	group.position.copy(position);

	return group;
}

export function calculateShelfWidth(
	bookCount: number,
	bookWidths: number[],
	bookGap: number,
	minWidth: number
): number {
	const totalBookWidth = bookWidths.reduce((sum, w) => sum + w, 0);
	const totalGaps = bookGap * Math.max(0, bookCount - 1);
	const contentWidth = totalBookWidth + totalGaps + 0.4; // 0.4 padding on sides

	return Math.max(contentWidth, minWidth / 100);
}

export function disposeShelfMesh(group: THREE.Group): void {
	group.traverse((child) => {
		if (child instanceof THREE.Mesh) {
			child.geometry.dispose();
			if (child.material instanceof THREE.Material) {
				if (child.material instanceof THREE.MeshStandardMaterial && child.material.map) {
					child.material.map.dispose();
				}
				child.material.dispose();
			}
		}
	});
}
