import * as THREE from 'three';
import type { Book } from '../types/book';
import type { LibraryConfig } from '../types/config';
import { createBookMesh, getBookDimensions, disposeBookMesh } from './book';
import { createShelfMesh, calculateShelfWidth, disposeShelfMesh } from './shelf';

export interface BookshelfData {
	group: THREE.Group;
	bookMeshes: THREE.Mesh[];
	shelfGroups: THREE.Group[];
	totalWidth: number;
	totalHeight: number;
	shelfCount: number;
	shelfWidths: number[];
}

export function createBookshelf(books: Book[], config: LibraryConfig): BookshelfData {
	const group = new THREE.Group();
	const bookMeshes: THREE.Mesh[] = [];
	const shelfGroups: THREE.Group[] = [];
	const shelfWidths: number[] = [];

	// Split books into shelf rows
	const shelves: Book[][] = [];
	for (let i = 0; i < books.length; i += config.maxBooksPerShelf) {
		shelves.push(books.slice(i, i + config.maxBooksPerShelf));
	}

	const shelfCount = shelves.length;
	const shelfHeight = 4.5; // Height between shelves (increased for bigger books)
	const totalHeight = shelfCount * shelfHeight;

	// Calculate dimensions for each shelf
	const shelfData = shelves.map((shelfBooks) => {
		const bookDimensions = shelfBooks.map((book) => getBookDimensions(book));
		const bookWidths = bookDimensions.map((d) => d.width);
		const shelfWidth = calculateShelfWidth(
			shelfBooks.length,
			bookWidths,
			config.bookGap,
			config.minShelfWidth
		);

		return {
			books: shelfBooks,
			dimensions: bookDimensions,
			width: shelfWidth,
			bookWidths
		};
	});

	// Use the maximum width for uniform shelves
	const maxShelfWidth = Math.max(...shelfData.map((s) => s.width), 15);

	// Create shelves from top to bottom
	shelfData.forEach((shelf, shelfIndex) => {
		// Calculate Y position - top shelf is highest
		const shelfY = (totalHeight / 2) - (shelfIndex * shelfHeight) - shelfHeight / 2;

		shelfWidths.push(maxShelfWidth);

		// Create shelf
		const shelfGroup = createShelfMesh(
			maxShelfWidth,
			config,
			new THREE.Vector3(0, shelfY, 0)
		);
		shelfGroups.push(shelfGroup);
		group.add(shelfGroup);

		// Place books on shelf, centered
		const totalBooksWidth = shelf.bookWidths.reduce((sum, w) => sum + w, 0) +
			config.bookGap * Math.max(0, shelf.books.length - 1);
		let currentX = -totalBooksWidth / 2;

		shelf.books.forEach((book, bookIndex) => {
			const dimensions = shelf.dimensions[bookIndex];
			const bookX = currentX + dimensions.width / 2;
			// Book stands on shelf: Y = shelf top + half book height
			const bookY = shelfY + config.shelfThickness / 2 + dimensions.height / 2;
			const bookZ = 0;

			const bookMesh = createBookMesh(book, config, new THREE.Vector3(bookX, bookY, bookZ));
			bookMeshes.push(bookMesh);
			group.add(bookMesh);

			currentX += dimensions.width + config.bookGap;
		});
	});

	return {
		group,
		bookMeshes,
		shelfGroups,
		totalWidth: maxShelfWidth,
		totalHeight,
		shelfCount,
		shelfWidths
	};
}

export function updateBookshelf(
	existingData: BookshelfData,
	books: Book[],
	config: LibraryConfig,
	scene: THREE.Scene
): BookshelfData {
	disposeBookshelf(existingData);
	scene.remove(existingData.group);

	const newData = createBookshelf(books, config);
	scene.add(newData.group);

	return newData;
}

export function disposeBookshelf(data: BookshelfData): void {
	data.bookMeshes.forEach((mesh) => disposeBookMesh(mesh));
	data.shelfGroups.forEach((group) => disposeShelfMesh(group));
	data.group.clear();
}

export function getBookMeshById(bookshelfData: BookshelfData, bookId: number): THREE.Mesh | null {
	return bookshelfData.bookMeshes.find((mesh) => mesh.userData.bookId === bookId) ?? null;
}

export function getBookMeshAtPosition(
	bookshelfData: BookshelfData,
	raycaster: THREE.Raycaster
): THREE.Mesh | null {
	const intersects = raycaster.intersectObjects(bookshelfData.bookMeshes);
	return intersects.length > 0 ? (intersects[0].object as THREE.Mesh) : null;
}
