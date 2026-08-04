// Barrel for the Up Next 3D shelf's three.js modules (§6). The legacy grid
// implementation (book.ts, bookshelf.ts, shelf.ts, scroll.ts, scene.ts,
// interaction.ts, materials.ts) is gone — nothing outside this directory
// depended on it (grep confirmed at deletion time), and its shared bits
// (LibraryConfig/textureQuality) either had no surviving consumer or already
// live inline where they're used (Library3D.svelte's `textureQuality` prop,
// each module's own local `Quality` alias).
export {
	createExperience,
	SHELF_CAMERA_POSITION,
	SHELF_CAMERA_TARGET,
	SHELF_TOP,
	type Experience,
	type FrameCallback,
	type ReducedMotionCallback,
	type ContextLostCallback
} from './experience';
export { createCarousel, HOVER_CRACK, type Carousel } from './carousel';
export { createBookRig, type RigHandle } from './bookRig';
export {
	createInspect,
	INSPECT_BOOK_POSITION,
	INSPECT_CAMERA_POSITION,
	INSPECT_CAMERA_TARGET,
	SIDEBAR_WIDTH_PX,
	type InspectController
} from './inspect';
export { blendPaletteWithMode, easeSceneColor, createThemeDriver } from './theme';
export { createModeMachine, type ModeMachine } from './state';
export {
	SPACING,
	WRAP_MIN,
	shouldWrap,
	wrapOffset,
	shortestDelta,
	clampTarget,
	damp,
	smoothstep,
	smootherstep,
	shelfPose,
	type ShelfPose
} from './carouselMath';
export {
	hashSeed,
	seededRandom,
	deriveSize,
	mixHex,
	luminance,
	paletteFromSeed,
	buildPalette,
	truncateLabel,
	buildIdentity,
	paletteFromCover
} from './bookIdentity';
export { createCoverPipeline, type CoverPipeline } from './coverPipeline';
