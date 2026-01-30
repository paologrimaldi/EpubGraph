export { createScene, createLighting, updateCameraSize, type SceneSetup } from './scene';
export { createShelfMaterial, createBookSideMaterial, createBookSpineMaterial, createBookCoverMaterial, createWallMaterial, disposeTextures } from './materials';
export { createBookMesh, getBookDimensions, disposeBookMesh } from './book';
export { createShelfMesh, calculateShelfWidth, disposeShelfMesh, type ShelfDimensions } from './shelf';
export {
	createBookshelf,
	updateBookshelf,
	disposeBookshelf,
	getBookMeshById,
	getBookMeshAtPosition,
	type BookshelfData
} from './bookshelf';
export { InteractionManager, type InteractionState, type InteractionCallbacks } from './interaction';
export { ScrollManager, type ScrollState, type ScrollCallbacks } from './scroll';
