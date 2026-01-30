import * as THREE from 'three';
import type { BookshelfData } from './bookshelf';

export interface ScrollState {
	scrollX: number;
	targetScrollX: number;
	velocity: number;
	isDragging: boolean;
	dragStartX: number;
	scrollStartX: number;
	maxScroll: number;
	minScroll: number;
}

export interface ScrollCallbacks {
	onShelfScroll?: (scrollPosition: number) => void;
}

export class ScrollManager {
	private state: ScrollState;
	private container: HTMLElement;
	private bookshelfGroup: THREE.Group | null = null;
	private containerWidth: number;
	private callbacks: ScrollCallbacks;
	private enabled: boolean = false;

	// Inertia settings
	private friction = 0.92;
	private sensitivity = 0.01;

	constructor(container: HTMLElement, callbacks: ScrollCallbacks) {
		this.container = container;
		this.containerWidth = container.clientWidth;
		this.callbacks = callbacks;

		this.state = {
			scrollX: 0,
			targetScrollX: 0,
			velocity: 0,
			isDragging: false,
			dragStartX: 0,
			scrollStartX: 0,
			maxScroll: 0,
			minScroll: 0
		};

		this.bindEvents();
	}

	setBookshelf(data: BookshelfData, minShelfWidthPx: number): void {
		this.bookshelfGroup = data.group;

		// Calculate if scrolling should be enabled
		const contentWidthUnits = data.totalWidth;
		const viewWidthUnits = this.containerWidth * 0.01; // Approximate conversion

		if (contentWidthUnits > viewWidthUnits) {
			this.enabled = true;
			const overflow = contentWidthUnits - viewWidthUnits;
			this.state.maxScroll = overflow / 2;
			this.state.minScroll = -overflow / 2;
		} else {
			this.enabled = false;
			this.state.maxScroll = 0;
			this.state.minScroll = 0;
		}

		// Reset scroll position
		this.state.scrollX = 0;
		this.state.targetScrollX = 0;
		this.state.velocity = 0;

		if (this.bookshelfGroup) {
			this.bookshelfGroup.position.x = 0;
		}
	}

	private bindEvents(): void {
		this.container.addEventListener('wheel', this.handleWheel, { passive: false });
		this.container.addEventListener('mousedown', this.handleMouseDown);
		this.container.addEventListener('mousemove', this.handleMouseMove);
		this.container.addEventListener('mouseup', this.handleMouseUp);
		this.container.addEventListener('mouseleave', this.handleMouseUp);
		this.container.addEventListener('touchstart', this.handleTouchStart, { passive: false });
		this.container.addEventListener('touchmove', this.handleTouchMove, { passive: false });
		this.container.addEventListener('touchend', this.handleTouchEnd);
	}

	private handleWheel = (event: WheelEvent): void => {
		if (!this.enabled) return;

		event.preventDefault();

		const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
		this.state.velocity += delta * this.sensitivity * 0.5;
	};

	private handleMouseDown = (event: MouseEvent): void => {
		if (!this.enabled || event.button !== 0) return;

		this.state.isDragging = true;
		this.state.dragStartX = event.clientX;
		this.state.scrollStartX = this.state.scrollX;
		this.state.velocity = 0;
	};

	private handleMouseMove = (event: MouseEvent): void => {
		if (!this.state.isDragging) return;

		const delta = (event.clientX - this.state.dragStartX) * this.sensitivity;
		this.state.targetScrollX = this.clampScroll(this.state.scrollStartX + delta);
	};

	private handleMouseUp = (): void => {
		if (!this.state.isDragging) return;

		this.state.isDragging = false;
		// Calculate release velocity for inertia
		this.state.velocity = (this.state.targetScrollX - this.state.scrollX) * 0.5;
	};

	private handleTouchStart = (event: TouchEvent): void => {
		if (!this.enabled || event.touches.length !== 1) return;

		event.preventDefault();
		this.state.isDragging = true;
		this.state.dragStartX = event.touches[0].clientX;
		this.state.scrollStartX = this.state.scrollX;
		this.state.velocity = 0;
	};

	private handleTouchMove = (event: TouchEvent): void => {
		if (!this.state.isDragging || event.touches.length !== 1) return;

		event.preventDefault();
		const delta = (event.touches[0].clientX - this.state.dragStartX) * this.sensitivity;
		this.state.targetScrollX = this.clampScroll(this.state.scrollStartX + delta);
	};

	private handleTouchEnd = (): void => {
		if (!this.state.isDragging) return;

		this.state.isDragging = false;
		this.state.velocity = (this.state.targetScrollX - this.state.scrollX) * 0.3;
	};

	private clampScroll(value: number): number {
		return Math.max(this.state.minScroll, Math.min(this.state.maxScroll, value));
	}

	update(): void {
		if (!this.enabled || !this.bookshelfGroup) return;

		if (!this.state.isDragging) {
			// Apply inertia
			this.state.scrollX += this.state.velocity;
			this.state.velocity *= this.friction;

			// Clamp scroll position
			this.state.scrollX = this.clampScroll(this.state.scrollX);

			// Stop tiny movements
			if (Math.abs(this.state.velocity) < 0.0001) {
				this.state.velocity = 0;
			}
		} else {
			// Smooth follow during drag
			this.state.scrollX += (this.state.targetScrollX - this.state.scrollX) * 0.3;
		}

		// Apply to bookshelf group
		this.bookshelfGroup.position.x = this.state.scrollX;

		// Emit scroll event
		if (this.state.velocity !== 0 || this.state.isDragging) {
			this.callbacks.onShelfScroll?.(this.state.scrollX);
		}
	}

	updateContainerSize(width: number): void {
		this.containerWidth = width;
	}

	getScrollPosition(): number {
		return this.state.scrollX;
	}

	scrollTo(position: number): void {
		this.state.targetScrollX = this.clampScroll(position);
		this.state.velocity = (this.state.targetScrollX - this.state.scrollX) * 0.2;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	dispose(): void {
		this.container.removeEventListener('wheel', this.handleWheel);
		this.container.removeEventListener('mousedown', this.handleMouseDown);
		this.container.removeEventListener('mousemove', this.handleMouseMove);
		this.container.removeEventListener('mouseup', this.handleMouseUp);
		this.container.removeEventListener('mouseleave', this.handleMouseUp);
		this.container.removeEventListener('touchstart', this.handleTouchStart);
		this.container.removeEventListener('touchmove', this.handleTouchMove);
		this.container.removeEventListener('touchend', this.handleTouchEnd);
	}
}
