import * as THREE from 'three';
import type { Book, BookMeshUserData } from '../types/book';
import type { LibraryConfig } from '../types/config';
import type { BookshelfData } from './bookshelf';

export interface InteractionState {
	hoveredBook: THREE.Mesh | null;
	selectedBook: THREE.Mesh | null;
	focusedIndex: number;
}

export interface InteractionCallbacks {
	onBookSelected?: (book: Book) => void;
	onBookHover?: (book: Book | null) => void;
	onBookFocus?: (book: Book) => void;
}

interface AnimationTarget {
	position: THREE.Vector3;
	rotation: THREE.Euler;
}

export class InteractionManager {
	private raycaster: THREE.Raycaster;
	private mouse: THREE.Vector2;
	private state: InteractionState;
	private config: LibraryConfig;
	private callbacks: InteractionCallbacks;
	private animationTargets: Map<THREE.Mesh, AnimationTarget>;
	private container: HTMLElement;
	private camera: THREE.Camera;
	private bookshelfData: BookshelfData | null = null;

	constructor(
		container: HTMLElement,
		camera: THREE.Camera,
		config: LibraryConfig,
		callbacks: InteractionCallbacks
	) {
		this.raycaster = new THREE.Raycaster();
		this.mouse = new THREE.Vector2();
		this.state = {
			hoveredBook: null,
			selectedBook: null,
			focusedIndex: -1
		};
		this.config = config;
		this.callbacks = callbacks;
		this.animationTargets = new Map();
		this.container = container;
		this.camera = camera;

		this.bindEvents();
	}

	setBookshelfData(data: BookshelfData): void {
		this.bookshelfData = data;
	}

	private bindEvents(): void {
		this.container.addEventListener('mousemove', this.handleMouseMove);
		this.container.addEventListener('click', this.handleClick);

		if (this.config.enableKeyboardNav) {
			this.container.setAttribute('tabindex', '0');
			this.container.addEventListener('keydown', this.handleKeyDown);
		}
	}

	private handleMouseMove = (event: MouseEvent): void => {
		const rect = this.container.getBoundingClientRect();
		this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

		this.updateHover();
	};

	private handleClick = (): void => {
		if (!this.bookshelfData) return;

		this.raycaster.setFromCamera(this.mouse, this.camera);
		const intersects = this.raycaster.intersectObjects(this.bookshelfData.bookMeshes);

		if (intersects.length > 0) {
			const clickedMesh = intersects[0].object as THREE.Mesh;
			this.selectBook(clickedMesh);
		} else {
			this.deselectBook();
		}
	};

	private handleKeyDown = (event: KeyboardEvent): void => {
		if (!this.bookshelfData || this.bookshelfData.bookMeshes.length === 0) return;

		const bookCount = this.bookshelfData.bookMeshes.length;
		let newIndex = this.state.focusedIndex;

		switch (event.key) {
			case 'ArrowRight':
				newIndex = Math.min(bookCount - 1, newIndex + 1);
				event.preventDefault();
				break;
			case 'ArrowLeft':
				newIndex = Math.max(0, newIndex - 1);
				event.preventDefault();
				break;
			case 'ArrowDown':
				newIndex = Math.min(bookCount - 1, newIndex + this.config.maxBooksPerShelf);
				event.preventDefault();
				break;
			case 'ArrowUp':
				newIndex = Math.max(0, newIndex - this.config.maxBooksPerShelf);
				event.preventDefault();
				break;
			case 'Enter':
			case ' ':
				if (newIndex >= 0) {
					const mesh = this.bookshelfData.bookMeshes[newIndex];
					this.selectBook(mesh);
				}
				event.preventDefault();
				break;
			case 'Escape':
				this.deselectBook();
				event.preventDefault();
				break;
			default:
				return;
		}

		if (newIndex !== this.state.focusedIndex && newIndex >= 0) {
			this.state.focusedIndex = newIndex;
			const mesh = this.bookshelfData.bookMeshes[newIndex];
			this.setHovered(mesh);
			const userData = mesh.userData as BookMeshUserData;
			this.callbacks.onBookFocus?.(userData.book);
		}
	};

	private updateHover(): void {
		if (!this.bookshelfData) return;

		this.raycaster.setFromCamera(this.mouse, this.camera);
		const intersects = this.raycaster.intersectObjects(this.bookshelfData.bookMeshes);

		if (intersects.length > 0) {
			const hoveredMesh = intersects[0].object as THREE.Mesh;
			if (hoveredMesh !== this.state.hoveredBook) {
				this.setHovered(hoveredMesh);
			}
		} else if (this.state.hoveredBook) {
			this.clearHover();
		}
	}

	private setHovered(mesh: THREE.Mesh): void {
		// Clear previous hover
		if (this.state.hoveredBook && this.state.hoveredBook !== mesh) {
			this.clearHoverEffect(this.state.hoveredBook);
		}

		this.state.hoveredBook = mesh;
		const userData = mesh.userData as BookMeshUserData;
		userData.isHovered = true;

		// Apply hover effect - move forward and rotate RIGHT to show cover
		if (!userData.isSelected) {
			this.animationTargets.set(mesh, {
				position: new THREE.Vector3(
					userData.originalPosition.x,
					userData.originalPosition.y,
					userData.originalPosition.z + 0.5
				),
				rotation: new THREE.Euler(
					userData.originalRotation.x,
					userData.originalRotation.y + 0.25, // Rotate RIGHT to show cover (-X face)
					userData.originalRotation.z
				)
			});
		}

		this.container.style.cursor = 'pointer';
		this.callbacks.onBookHover?.(userData.book);
	}

	private clearHover(): void {
		if (this.state.hoveredBook) {
			this.clearHoverEffect(this.state.hoveredBook);
			this.state.hoveredBook = null;
		}
		this.container.style.cursor = 'default';
		this.callbacks.onBookHover?.(null);
	}

	private clearHoverEffect(mesh: THREE.Mesh): void {
		const userData = mesh.userData as BookMeshUserData;
		userData.isHovered = false;

		if (!userData.isSelected) {
			this.animationTargets.set(mesh, {
				position: new THREE.Vector3(
					userData.originalPosition.x,
					userData.originalPosition.y,
					userData.originalPosition.z
				),
				rotation: new THREE.Euler(
					userData.originalRotation.x,
					userData.originalRotation.y,
					userData.originalRotation.z
				)
			});
		}
	}

	private selectBook(mesh: THREE.Mesh): void {
		// Deselect previous
		if (this.state.selectedBook && this.state.selectedBook !== mesh) {
			this.deselectBook();
		}

		this.state.selectedBook = mesh;
		const userData = mesh.userData as BookMeshUserData;
		userData.isSelected = true;

		// Update focused index
		if (this.bookshelfData) {
			this.state.focusedIndex = this.bookshelfData.bookMeshes.indexOf(mesh);
		}

		// Pull book completely out of the shelf, then rotate to show cover
		this.animationTargets.set(mesh, {
			position: new THREE.Vector3(
				userData.originalPosition.x + 0.3, // Shift right slightly to clear neighbors
				userData.originalPosition.y,
				userData.originalPosition.z + 2.5 // Pull far out so rotation doesn't clip
			),
			rotation: new THREE.Euler(
				userData.originalRotation.x,
				userData.originalRotation.y + 0.6, // Rotate RIGHT to show cover (-X face)
				userData.originalRotation.z
			)
		});

		this.callbacks.onBookSelected?.(userData.book);
	}

	private deselectBook(): void {
		if (!this.state.selectedBook) return;

		const mesh = this.state.selectedBook;
		const userData = mesh.userData as BookMeshUserData;
		userData.isSelected = false;

		// Return to original position and rotation
		this.animationTargets.set(mesh, {
			position: new THREE.Vector3(
				userData.originalPosition.x,
				userData.originalPosition.y,
				userData.originalPosition.z
			),
			rotation: new THREE.Euler(
				userData.originalRotation.x,
				userData.originalRotation.y,
				userData.originalRotation.z
			)
		});

		this.state.selectedBook = null;
	}

	update(deltaTime: number): void {
		const speed = this.config.animationSpeed * 60 * deltaTime;

		this.animationTargets.forEach((target, mesh) => {
			// Animate position
			const posDiff = target.position.clone().sub(mesh.position);
			// Animate rotation
			const rotDiff = new THREE.Vector3(
				target.rotation.x - mesh.rotation.x,
				target.rotation.y - mesh.rotation.y,
				target.rotation.z - mesh.rotation.z
			);

			const totalDiff = posDiff.length() + rotDiff.length();

			if (totalDiff < 0.001) {
				mesh.position.copy(target.position);
				mesh.rotation.copy(target.rotation);
				this.animationTargets.delete(mesh);
			} else {
				mesh.position.add(posDiff.multiplyScalar(Math.min(speed, 1)));
				mesh.rotation.x += rotDiff.x * Math.min(speed, 1);
				mesh.rotation.y += rotDiff.y * Math.min(speed, 1);
				mesh.rotation.z += rotDiff.z * Math.min(speed, 1);
			}
		});
	}

	getSelectedBook(): Book | null {
		if (!this.state.selectedBook) return null;
		return (this.state.selectedBook.userData as BookMeshUserData).book;
	}

	selectBookById(bookId: number): void {
		if (!this.bookshelfData) return;

		const mesh = this.bookshelfData.bookMeshes.find(
			(m) => (m.userData as BookMeshUserData).bookId === bookId
		);

		if (mesh) {
			this.selectBook(mesh);
		}
	}

	dispose(): void {
		this.container.removeEventListener('mousemove', this.handleMouseMove);
		this.container.removeEventListener('click', this.handleClick);
		this.container.removeEventListener('keydown', this.handleKeyDown);
		this.animationTargets.clear();
	}
}
