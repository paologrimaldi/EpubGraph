import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { BookIdentity } from '../types/experience';
import { seededRandom } from './bookIdentity';
import { makeArtwork, makeEmbossFrom } from './textures/artwork';
import {
	sharedClothMaps,
	sharedPaperFaceTexture,
	sharedPageEdgeTextures,
	sharedContactShadowTexture
} from './textures/shared';

export interface RigHandle {
	identity: BookIdentity;
	root: THREE.Group; // carousel slot pose target
	motion: THREE.Group; // idle/hover offsets live here
	frontPivot: THREE.Group; // cover crack/open hinge (rotation.y ∈ [-π+0.2, 0])
	pagePivots: THREE.Group[]; // 6 leaves, hinge groups (Phase 2 animates)
	pageSurfaces: THREE.Mesh[]; // raycast targets for page drag (Phase 2)
	hit: THREE.Mesh; // oversized invisible click target, userData.bookId
	contactShadow: THREE.Mesh;
	fadeMaterials: THREE.Material[]; // opacity-driven set
	setOpacity(o: number): void; // writes fadeMaterials + hit.visible (< 0.12 rule)
	applyRealCover(tex: THREE.CanvasTexture): void; // swaps cover map, hides foil plane
	dispose(): void; // geometries + materials + textures
}

type Quality = 'low' | 'medium' | 'high';

// §5.1 anatomy constants — see task-7 brief for the exact numeric derivation.
const BOARD = 0.032;
const COVER_RADIUS = 0.0045;
const PAGE_RADIUS = 0.0025;
const SPINE_BOARD_THICKNESS = 0.014;
const SPINE_WIDTH = 0.082;
const LEAF_COUNT = 6;
const HIT_OPACITY_THRESHOLD = 0.12;
const CONTACT_SHADOW_FACTOR = 0.24;

/** Rounded-rect path centered on the origin, corner radius clamped to the shorter half-extent. */
function roundedRectShape(width: number, height: number, radius: number): THREE.Shape {
	const w2 = width / 2;
	const h2 = height / 2;
	const r = Math.min(radius, w2, h2);
	const shape = new THREE.Shape();
	shape.moveTo(-w2 + r, -h2);
	shape.lineTo(w2 - r, -h2);
	shape.quadraticCurveTo(w2, -h2, w2, -h2 + r);
	shape.lineTo(w2, h2 - r);
	shape.quadraticCurveTo(w2, h2, w2 - r, h2);
	shape.lineTo(-w2 + r, h2);
	shape.quadraticCurveTo(-w2, h2, -w2, h2 - r);
	shape.lineTo(-w2, -h2 + r);
	shape.quadraticCurveTo(-w2, -h2, -w2 + r, -h2);
	return shape;
}

/**
 * Rounded-rect `ShapeGeometry` sized to `width × height`, with UVs remapped to the plane's own
 * bounding box — `ShapeGeometry`'s default UVs are raw local (world) coordinates, not normalized
 * to [0,1], which would clamp any mapped texture to a sliver near its center.
 */
function roundedPlaneGeometry(width: number, height: number, radius: number): THREE.ShapeGeometry {
	const geometry = new THREE.ShapeGeometry(roundedRectShape(width, height, radius), 6);
	const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
	const position = geometry.getAttribute('position') as THREE.BufferAttribute;
	for (let i = 0; i < uv.count; i++) {
		uv.setXY(i, position.getX(i) / width + 0.5, position.getY(i) / height + 0.5);
	}
	uv.needsUpdate = true;
	return geometry;
}

export function createBookRig(identity: BookIdentity, quality: Quality): RigHandle {
	const { width: w, height: h, depth: d } = identity.size;
	const { cloth, foil, paperPale } = identity.palette;

	const pageWidth = w - 0.074;
	const pageHeight = h - 0.068;
	const pageDepth = d - 0.026;

	const root = new THREE.Group();
	root.name = `book-root-${identity.id}`;
	const motion = new THREE.Group();
	motion.name = `book-motion-${identity.id}`;
	root.add(motion);

	const art = makeArtwork(identity, quality);
	const clothMaps = sharedClothMaps();
	const pageEdges = sharedPageEdgeTextures();

	// ---- disposal bookkeeping ----
	const geometries: THREE.BufferGeometry[] = [];
	const allMaterials: THREE.Material[] = [];
	const fadeMaterials: THREE.Material[] = [];
	const embossTextures: THREE.CanvasTexture[] = [];

	function track<T extends THREE.BufferGeometry>(geometry: T): T {
		geometries.push(geometry);
		return geometry;
	}

	function registerMaterial<T extends THREE.Material>(material: T, options: { fade?: boolean } = {}): T {
		material.transparent = true;
		allMaterials.push(material);
		if (options.fade !== false) fadeMaterials.push(material);
		return material;
	}

	// ---- material recipes (§5.1) ----

	/** Cloth: shared weave normal/roughness/bump, normalScale 0.3, sheen 0.27 tinted foil. */
	function clothMaterial(
		tint: THREE.ColorRepresentation,
		extra: Partial<THREE.MeshPhysicalMaterialParameters> = {}
	): THREE.MeshPhysicalMaterial {
		return registerMaterial(
			new THREE.MeshPhysicalMaterial({
				color: tint,
				normalMap: clothMaps.normal,
				normalScale: new THREE.Vector2(0.3, 0.3),
				roughnessMap: clothMaps.roughness,
				roughness: 1,
				bumpMap: clothMaps.bump,
				bumpScale: 0.0012,
				sheen: 0.27,
				sheenColor: new THREE.Color(foil),
				...extra
			})
		);
	}

	/** Cover/spine/back art: the per-book canvas as `map`, cloth maps underneath (§5.1). */
	function artMaterial(
		map: THREE.Texture,
		extra: Partial<THREE.MeshPhysicalMaterialParameters> = {}
	): THREE.MeshPhysicalMaterial {
		return clothMaterial(0xffffff, { map, roughness: 0.58, sheen: 0.12, ...extra });
	}

	/** Foil: metalness .9, roughness .21, clearcoat .14, alpha from the foil artwork, emboss bump from the same texture. */
	function foilMaterial(alphaTexture: THREE.CanvasTexture, embossName: string): THREE.MeshPhysicalMaterial {
		const emboss = makeEmbossFrom(alphaTexture, embossName);
		embossTextures.push(emboss);
		return registerMaterial(
			new THREE.MeshPhysicalMaterial({
				color: foil,
				metalness: 0.9,
				roughness: 0.21,
				clearcoat: 0.14,
				alphaMap: alphaTexture,
				bumpMap: emboss,
				bumpScale: 0.0018,
				depthWrite: false,
				polygonOffset: true,
				polygonOffsetFactor: -2,
				polygonOffsetUnits: -1
			})
		);
	}

	/** Paper: shared paper face texture as map + bump, roughness .95, faint sheen. */
	function paperMaterial(extra: Partial<THREE.MeshPhysicalMaterialParameters> = {}): THREE.MeshPhysicalMaterial {
		return registerMaterial(
			new THREE.MeshPhysicalMaterial({
				map: sharedPaperFaceTexture(),
				bumpMap: sharedPaperFaceTexture(),
				bumpScale: 0.0006,
				roughness: 0.95,
				sheen: 0.12,
				...extra
			})
		);
	}

	// ============================================================
	// Step 1 — page block
	// ============================================================

	const pageGeometry = track(new RoundedBoxGeometry(pageWidth, pageHeight, pageDepth, 4, PAGE_RADIUS));
	const pageBlock = new THREE.Mesh(pageGeometry, paperMaterial());
	pageBlock.position.set(0.018, 0, 0);
	motion.add(pageBlock);

	// ============================================================
	// Steps 2 & 3 — board pivots (back + front are mirror images: `sign` flips every
	// z-offset, `outward`/`inward` rotations flip which local face points which way).
	// ============================================================

	function buildBoardPivot(
		sign: 1 | -1,
		artTexture: THREE.CanvasTexture,
		foilTexture: THREE.CanvasTexture,
		embossName: string
	): { pivot: THREE.Group; artMaterial: THREE.MeshPhysicalMaterial; foilMesh: THREE.Mesh } {
		const pivot = new THREE.Group();
		pivot.position.set(-w / 2, 0, sign * (d / 2 + BOARD / 2));
		motion.add(pivot);

		const outward = sign > 0 ? 0 : Math.PI;
		const inward = sign > 0 ? Math.PI : 0;

		const coverGeometry = track(new RoundedBoxGeometry(w, h, BOARD, 2, COVER_RADIUS));
		const coverMesh = new THREE.Mesh(coverGeometry, clothMaterial(cloth));
		coverMesh.position.set(w / 2, 0, 0);
		pivot.add(coverMesh);

		const artGeometry = track(roundedPlaneGeometry(w - 0.007, h - 0.007, 0.012));
		const artMat = artMaterial(artTexture);
		const artMesh = new THREE.Mesh(artGeometry, artMat);
		artMesh.position.set(w / 2, 0, sign * BOARD * 0.55);
		artMesh.rotation.y = outward;
		pivot.add(artMesh);

		const foilGeometry = track(roundedPlaneGeometry(w - 0.007, h - 0.007, 0.012));
		const foilMat = foilMaterial(foilTexture, embossName);
		const foilMesh = new THREE.Mesh(foilGeometry, foilMat);
		foilMesh.position.set(w / 2, 0, sign * BOARD * 0.605);
		foilMesh.rotation.y = outward;
		pivot.add(foilMesh);

		const endpaperGeometry = track(roundedPlaneGeometry(w - 0.045, h - 0.045, 0.01));
		const endpaperMesh = new THREE.Mesh(endpaperGeometry, artMaterial(art.endpaper, { roughness: 0.82, sheen: 0.14 }));
		endpaperMesh.position.set(w / 2, 0, -sign * BOARD * 0.515);
		endpaperMesh.rotation.y = inward;
		pivot.add(endpaperMesh);

		const grooveGeometry = track(roundedPlaneGeometry(0.012, h * 0.94, 0.004));
		const grooveMesh = new THREE.Mesh(grooveGeometry, clothMaterial(new THREE.Color(cloth).multiplyScalar(0.42)));
		grooveMesh.position.set(0.038, 0, -sign * BOARD * 0.53);
		grooveMesh.rotation.y = inward;
		pivot.add(grooveMesh);

		return { pivot, artMaterial: artMat, foilMesh };
	}

	const back = buildBoardPivot(-1, art.back, art.back, `book-${identity.id}-back-foil-emboss`);
	// makeArtwork always populates `foil` at construction time (it only ever
	// goes null later, once a real cover is applied) — the `?? art.cover`
	// fallback exists purely to satisfy CoverArtSet's nullable type, not
	// because this branch is expected to run.
	const front = buildBoardPivot(1, art.cover, art.foil ?? art.cover, `book-${identity.id}-front-foil-emboss`);

	// ============================================================
	// Step 4 — 6 flexible page-leaf pivots (present + closed in Phase 1)
	// ============================================================

	const pagePivots: THREE.Group[] = [];
	const pageSurfaces: THREE.Mesh[] = [];
	const leafGeometry = track(new THREE.PlaneGeometry(1, 1, 22, 6));
	const leafWidth = pageWidth - SPINE_WIDTH * 0.42;
	const leafHeight = pageHeight - 0.014;

	for (let i = 0; i < LEAF_COUNT; i++) {
		const pivot = new THREE.Group();
		const restZ = pageDepth / 2 + 0.0015 + i * 0.0015;
		pivot.position.set(-w / 2 + SPINE_WIDTH * 0.65, 0, restZ);
		pivot.userData.restZ = restZ;
		pivot.userData.turnedZ = d / 2 + BOARD + 0.004 + i * 0.0015;
		motion.add(pivot);
		pagePivots.push(pivot);

		// Sheets hinge from x=0 (the pivot, at the spine) outward — offset by half their
		// own width so they extend forward instead of straddling the hinge line.
		const frontSheet = new THREE.Mesh(leafGeometry, paperMaterial());
		frontSheet.scale.set(leafWidth, leafHeight, 1);
		frontSheet.position.x = leafWidth / 2;
		pivot.add(frontSheet);
		pageSurfaces.push(frontSheet);

		const backSheet = new THREE.Mesh(leafGeometry, paperMaterial());
		backSheet.scale.set(leafWidth, leafHeight, 1);
		backSheet.position.x = leafWidth / 2;
		backSheet.rotation.y = Math.PI;
		pivot.add(backSheet);
		pageSurfaces.push(backSheet);
	}

	// ============================================================
	// Step 5 — flat spine (board + art foil + lining)
	// ============================================================

	const spineX = -w / 2 - 0.0049;
	const spineDepth = d + BOARD * 1.88;

	const spineGeometry = track(new RoundedBoxGeometry(SPINE_BOARD_THICKNESS, h - 0.012, spineDepth, 1, 0.0015));
	const spineMesh = new THREE.Mesh(spineGeometry, artMaterial(art.spine, { roughness: 0.6 }));
	spineMesh.position.set(spineX, 0, 0);
	motion.add(spineMesh);

	const spineFoilGeometry = track(roundedPlaneGeometry(spineDepth * 0.92, (h - 0.012) * 0.96, 0.01));
	const spineFoilMesh = new THREE.Mesh(
		spineFoilGeometry,
		foilMaterial(art.spineFoil, `book-${identity.id}-spine-foil-emboss`)
	);
	spineFoilMesh.position.set(spineX - SPINE_BOARD_THICKNESS / 2 - 0.0009, 0, 0);
	spineFoilMesh.rotation.y = -Math.PI / 2;
	motion.add(spineFoilMesh);

	const liningGeometry = track(
		new RoundedBoxGeometry(SPINE_BOARD_THICKNESS * 0.5, (h - 0.012) * 0.9, spineDepth * 0.9, 1, 0.001)
	);
	const liningMesh = new THREE.Mesh(liningGeometry, paperMaterial({ color: new THREE.Color(paperPale) }));
	liningMesh.position.set(spineX + SPINE_BOARD_THICKNESS * 0.28, 0, 0);
	motion.add(liningMesh);

	// ============================================================
	// Step 6 — page furniture
	// ============================================================

	const foreGeometry = track(new THREE.PlaneGeometry(pageDepth * 0.97, pageHeight * 0.97));
	const foreMesh = new THREE.Mesh(
		foreGeometry,
		paperMaterial({ map: pageEdges.fore, bumpMap: pageEdges.fore, bumpScale: 0.0008, roughness: 0.7, sheen: 0.18 })
	);
	foreMesh.position.set(0.018 + pageWidth / 2 + 0.002, 0, 0);
	foreMesh.rotation.y = Math.PI / 2;
	motion.add(foreMesh);

	const headGeometry = track(new THREE.PlaneGeometry(pageWidth * 0.97, pageDepth * 0.97));
	const headMesh = new THREE.Mesh(
		headGeometry,
		paperMaterial({
			map: pageEdges.headTail,
			bumpMap: pageEdges.headTail,
			bumpScale: 0.0008,
			roughness: 0.7,
			sheen: 0.18
		})
	);
	headMesh.position.set(0.018, pageHeight / 2 + 0.001, 0);
	headMesh.rotation.x = -Math.PI / 2;
	motion.add(headMesh);

	const tailGeometry = track(new THREE.PlaneGeometry(pageWidth * 0.97, pageDepth * 0.97));
	const tailMesh = new THREE.Mesh(
		tailGeometry,
		paperMaterial({
			map: pageEdges.headTail,
			bumpMap: pageEdges.headTail,
			bumpScale: 0.0008,
			roughness: 0.7,
			sheen: 0.18
		})
	);
	tailMesh.position.set(0.018, -pageHeight / 2 - 0.001, 0);
	tailMesh.rotation.x = Math.PI / 2;
	motion.add(tailMesh);

	// Headband cylinders — capped corners where the page block meets the spine, top + tail.
	const headbandGeometry = track(new THREE.CylinderGeometry(0.012, 0.012, pageDepth, 12));
	const headbandMaterial = registerMaterial(
		new THREE.MeshPhysicalMaterial({ color: foil, roughness: 0.55, sheen: 0.35, sheenColor: new THREE.Color(foil) })
	);
	const headbandX = 0.018 - pageWidth / 2 + 0.01;
	const headbandTop = new THREE.Mesh(headbandGeometry, headbandMaterial);
	headbandTop.rotation.x = Math.PI / 2;
	headbandTop.position.set(headbandX, pageHeight / 2 - 0.004, 0);
	motion.add(headbandTop);
	const headbandBottom = new THREE.Mesh(headbandGeometry, headbandMaterial);
	headbandBottom.rotation.x = Math.PI / 2;
	headbandBottom.position.set(headbandX, -pageHeight / 2 + 0.004, 0);
	motion.add(headbandBottom);

	// Ribbon bookmark — seeded x-jitter across the page block width, sitting proud of its front face.
	const ribbonRandom = seededRandom(identity.seed ^ 0x52a1b3c7);
	const ribbonRange = Math.max(pageWidth - 0.12, 0.02);
	const ribbonX = 0.018 + (ribbonRandom() - 0.5) * ribbonRange;
	const ribbonGeometry = track(roundedPlaneGeometry(0.034, pageHeight * 0.76, 0.01));
	const ribbonMesh = new THREE.Mesh(
		ribbonGeometry,
		registerMaterial(
			new THREE.MeshPhysicalMaterial({ color: foil, roughness: 0.32, sheen: 0.5, sheenColor: new THREE.Color(foil) })
		)
	);
	ribbonMesh.position.set(ribbonX, 0, pageDepth / 2 + 0.0015);
	motion.add(ribbonMesh);

	// Signature boxes — 6 thin gathers along the fore edge.
	const signatureGeometry = track(new THREE.BoxGeometry(0.0035, pageHeight * 0.145, pageDepth * 0.9));
	const signatureX = 0.018 + pageWidth / 2 + 0.0006;
	for (let i = 0; i < 6; i++) {
		const t = (i + 0.5) / 6 - 0.5;
		const signatureMesh = new THREE.Mesh(signatureGeometry, paperMaterial());
		signatureMesh.position.set(signatureX, t * pageHeight * 0.94, 0);
		motion.add(signatureMesh);
	}

	// ============================================================
	// Step 7 — hit target
	// ============================================================

	const hitGeometry = track(new THREE.BoxGeometry(w * 1.34, h * 1.2, Math.max(d * 4, 1)));
	const hitMaterial = registerMaterial(
		new THREE.MeshBasicMaterial({ opacity: 0, depthWrite: false, colorWrite: false })
	);
	const hit = new THREE.Mesh(hitGeometry, hitMaterial);
	hit.position.set(-SPINE_WIDTH * 0.18, 0, 0.12);
	hit.userData.bookId = identity.id;
	motion.add(hit);

	// ============================================================
	// Step 8 — contact shadow (child of root, not motion — stays grounded through hover/idle motion)
	// ============================================================

	const contactShadowGeometry = track(new THREE.PlaneGeometry(w * 1.22, d * 2.05));
	const contactShadowMaterial = registerMaterial(
		new THREE.MeshBasicMaterial({
			color: 0x000000,
			opacity: 0.24,
			alphaMap: sharedContactShadowTexture(),
			depthWrite: false
		}),
		{ fade: false }
	);
	const contactShadow = new THREE.Mesh(contactShadowGeometry, contactShadowMaterial);
	contactShadow.rotation.x = -Math.PI / 2;
	// The brief's "-h/2 - 0.022" reads as "a hair below the book's bottom" —
	// correct in intent (avoid a coplanar seam with the shelf surface) but
	// `room.ts`'s walnut board is a solid 0.28-thick box whose top face IS
	// SHELF_TOP, so any offset *below* -h/2 buries the decal inside opaque
	// wood (confirmed via self-verification screenshot: zero visible shadow).
	// Sit a hair *above* the surface instead — same seamless-contact intent,
	// actually visible against this room's geometry.
	contactShadow.position.set(0, -h / 2 + 0.0008, 0);
	root.add(contactShadow);

	// ============================================================
	// Handle
	// ============================================================

	function setOpacity(o: number): void {
		for (const material of fadeMaterials) {
			material.opacity = o;
		}
		contactShadowMaterial.opacity = o * CONTACT_SHADOW_FACTOR;
		hit.visible = o >= HIT_OPACITY_THRESHOLD;
	}

	function applyRealCover(tex: THREE.CanvasTexture): void {
		front.artMaterial.map = tex;
		front.artMaterial.needsUpdate = true;
		front.foilMesh.visible = false;
	}

	function dispose(): void {
		for (const geometry of geometries) geometry.dispose();
		for (const material of allMaterials) material.dispose();
		for (const texture of embossTextures) texture.dispose();
		art.dispose();
	}

	return {
		identity,
		root,
		motion,
		frontPivot: front.pivot,
		pagePivots,
		pageSurfaces,
		hit,
		contactShadow,
		fadeMaterials,
		setOpacity,
		applyRealCover,
		dispose
	};
}
