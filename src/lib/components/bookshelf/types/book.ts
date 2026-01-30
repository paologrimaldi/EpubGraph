// Re-export Book type from API commands for consistency
// The bookshelf component uses the app's Book type directly
export type { Book, ReadStatus, EmbeddingStatus } from '$lib/api/commands';

export interface BookMeshUserData {
	bookId: number;
	book: import('$lib/api/commands').Book;
	originalPosition: { x: number; y: number; z: number };
	originalRotation: { x: number; y: number; z: number };
	isHovered: boolean;
	isSelected: boolean;
}
