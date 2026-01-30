import * as THREE from 'three';
import type { Book } from '../types/book';
import type { BookMeshUserData } from '../types/book';
import type { LibraryConfig, BookDimensions } from '../types/config';
import { calculateBookDimensions } from '../types/config';
import { createBookSpineMaterial, createBookSideMaterial, createBookCoverMaterial } from './materials';

export function createBookMesh(
	book: Book,
	config: LibraryConfig,
	position: THREE.Vector3
): THREE.Mesh {
	// Use a default page count since the app's Book type doesn't have pageCount
	const dimensions = calculateBookDimensions(undefined);

	// Book geometry: width = thickness (spine), height = book height, depth = book depth
	const geometry = new THREE.BoxGeometry(
		dimensions.width,  // thickness (spine width)
		dimensions.height, // height
		dimensions.depth   // depth
	);

	// Create materials for each face
	const materials = createBookMaterials(book, config, dimensions);

	const mesh = new THREE.Mesh(geometry, materials);
	mesh.position.copy(position);

	// Slight tilt to the RIGHT (positive Y rotation) so cover becomes visible when tilted more
	const baseRotation = 0.1; // About 6 degrees tilted right
	mesh.rotation.y = baseRotation;

	mesh.castShadow = true;
	mesh.receiveShadow = true;

	// Store book data for interactions
	const userData: BookMeshUserData = {
		bookId: book.id,
		book: book,
		originalPosition: { x: position.x, y: position.y, z: position.z },
		originalRotation: { x: 0, y: baseRotation, z: 0 },
		isHovered: false,
		isSelected: false
	};
	mesh.userData = userData;

	return mesh;
}

function createBookMaterials(book: Book, config: LibraryConfig, dimensions: BookDimensions): THREE.Material[] {
	// Color based on book ID for variety
	const bookColors = [
		0x8b0000, 0x00008b, 0x006400, 0x4b0082, 0x8b4513,
		0x2f4f4f, 0x800020, 0x191970, 0x3d0c02, 0x1a1a2e
	];
	const colorIndex = book.id % bookColors.length;
	const baseColor = new THREE.Color(bookColors[colorIndex]);

	// Slight variation
	const hsl = { h: 0, s: 0, l: 0 };
	baseColor.getHSL(hsl);
	hsl.l = Math.max(0.15, Math.min(0.35, hsl.l + (Math.random() - 0.5) * 0.1));
	baseColor.setHSL(hsl.h, hsl.s, hsl.l);

	const sideMaterial = createBookSideMaterial(baseColor);
	const pagesMaterial = new THREE.MeshStandardMaterial({
		color: 0xf5f5dc,
		roughness: 0.9,
		metalness: 0.0
	});

	// Spine material (faces front +Z)
	const spineMaterial = createBookSpineMaterial(book.title, book.author, baseColor, dimensions);

	// Cover material (on -X face, visible when book rotates right)
	const coverMaterial = createBookCoverMaterial(book.title, book.author, book.coverPath, baseColor);

	// BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z
	return [
		pagesMaterial,        // +X right (pages - visible edge)
		coverMaterial,        // -X left (COVER - visible when rotated right)
		sideMaterial.clone(), // +Y top
		sideMaterial.clone(), // -Y bottom
		spineMaterial,        // +Z front (SPINE - faces camera)
		sideMaterial.clone()  // -Z back
	];
}

export function getBookDimensions(book: Book): BookDimensions {
	return calculateBookDimensions(undefined);
}

export function disposeBookMesh(mesh: THREE.Mesh): void {
	mesh.geometry.dispose();

	if (Array.isArray(mesh.material)) {
		mesh.material.forEach((mat) => {
			if (mat instanceof THREE.MeshStandardMaterial && mat.map) {
				mat.map.dispose();
			}
			mat.dispose();
		});
	} else if (mesh.material instanceof THREE.Material) {
		if (mesh.material instanceof THREE.MeshStandardMaterial && mesh.material.map) {
			mesh.material.map.dispose();
		}
		mesh.material.dispose();
	}
}
