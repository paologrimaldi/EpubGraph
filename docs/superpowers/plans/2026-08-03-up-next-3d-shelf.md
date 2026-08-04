# Up Next 3D Carousel Shelf Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Up Next grid of box-books with a complete-shelf-quality continuous carousel: full book anatomy, PBR materials, studio lighting, deterministic inspect transitions (Phase 1), and drag-driven page physics (Phase 2).

**Architecture:** New module family under `src/lib/components/bookshelf/` (pure math modules tested with vitest; scene modules verified visually in the Tauri app). The old grid internals (`three/book.ts`, `bookshelf.ts`, `shelf.ts`, `scroll.ts`, `scene.ts`, `interaction.ts`, `materials.ts`) are deleted in the final Phase 1 task after the new pipeline replaces them. `Library3D.svelte` keeps its load-bearing props/events so `up-next/+page.svelte` changes stay small.

**Tech Stack:** Svelte 4 (`export let`, `createEventDispatcher`, `$:`), TypeScript, Three.js r182 (`three/examples/jsm`: `RoundedBoxGeometry`, `RoomEnvironment`, `RectAreaLightUniformsLib`, `OrbitControls`), vitest (new devDependency), Tauri 2 (`getCoverImage(bookId)` → base64 data-URL string | null).

**Spec:** `docs/superpowers/specs/2026-08-03-up-next-3d-shelf-design.md` — section references (§) below point there.

## Global Constraints

- Svelte 4 syntax only (no runes). Client-only Three: `await import('three')` inside `onMount`-driven init, matching the existing `Library3D.svelte` pattern.
- No new runtime dependencies. Only new devDependency: `vitest@^2.1.0`.
- All Three example-module imports from `three/examples/jsm/...` (already shipped with three ^0.182.0).
- Renderer: `ACESFilmicToneMapping`, `toneMappingExposure 0.9`, `SRGBColorSpace`, PMREM `RoomEnvironment` intensity `0.72`, `FogExp2` density `0.027`, PCFSoftShadowMap, DPR `min(devicePixelRatio, 2)` (`1.5` when container < 820 px wide).
- Carousel constants (§4.2): spacing `1.18`; pose `y = shelfTop + h/2 + focus*0.15`, `z = 0.13 + focus*0.24 − min(|offset|,2.8)*0.07`, `rotY = −offset*0.105`, `rotZ = −offset*0.018`, `scale = 1 + focus*0.09`; fade band `|offset| ∈ [2.55, 3.25]`; hit target disabled below opacity `0.12`; wrap only when queue ≥ 5.
- Damping: `damp(x,t,λ,dt) = t + (x−t)·e^(−λ·dt)`; carousel position λ=9.5, rig pose λ=12, wheel idle snap after 0.14 s.
- Book sizes: height 1.46–1.58, width 0.92–1.10, depth 0.22–0.30, board 0.032, cover corner radius 0.0045 (sharp, never pill-shaped), seeded per book id — deterministic across sessions.
- Transitions are time-based with precomputed endpoints (`smootherstep`); first/final frames must equal captured endpoints exactly. Durations: open 0.9 s, close 0.9 s.
- Rendering is on-demand (`requestFrame` pattern): idle scene renders 0 fps.
- `prefers-reduced-motion`: damping instant, transitions jump via the same endpoint math, idle bob / hover tilt / dust / page flex disabled.
- Every material a rig owns is `transparent: true` and registered in that rig's `fadeMaterials` for distance fade.
- Type check gate for every task: `npm run check` must pass. Test gate: `npx vitest run` must pass.
- Commit after every task (commands given per task). Work happens on `feature/up-next-3d-shelf`; create an isolated worktree via superpowers:using-git-worktrees before execution.

## File Structure (end state)

```
src/lib/components/bookshelf/
  Library3D.svelte              // rewritten: canvas host + HUD overlay + lifecycle
  index.ts                      // re-export Library3D (unchanged path for +page.svelte)
  types/experience.ts           // Mode, BookPalette, BookIdentity, ScenePalette, Pose
  types/book.ts                 // existing re-export of app Book type (kept)
  three/state.ts                // mode machine + shared mutable session state
  three/carouselMath.ts         // PURE: wrap/offset/pose/damp/easings (vitest)
  three/bookIdentity.ts         // PURE: seed/size/palette/truncation (vitest)
  three/theme.ts                // PURE blend math (vitest) + scene color easing
  three/inspectMath.ts          // PURE: Pose capture/lerp helpers (vitest)
  three/pageFlex.ts             // PURE (Phase 2): spring + commit rules (vitest)
  three/experience.ts           // renderer/scene/camera/env/fog/frame-loop/resize
  three/room.ts                 // floor, backdrop, walnut shelf, rails, dust
  three/lights.ts               // hemisphere/key/fill + 4 RectAreaLights
  three/carousel.ts             // rigs on shelf: layout, inputs → position, hover
  three/bookRig.ts              // createBookRig(identity) → RigHandle; dispose
  three/inspect.ts              // opening/closing choreography + view offset
  three/coverPipeline.ts        // async cover fetch, palette extraction, lazy queue
  three/textures/shared.ts      // cloth weave maps, paper, page edges, contact shadow
  three/textures/artwork.ts     // cover/spine/back painters, motifs, endpaper
  three/textures/pages.ts       // Phase 2: title/about/colophon spread painters
*.test.ts colocated with each PURE module. vitest.config.ts at repo root.
```

`src/routes/up-next/+page.svelte` — sidebar becomes an absolute overlay (canvas never resizes; the inspect view-offset centers the book in the remaining width, §4.3).

---

### Task 0: Vitest bootstrap

**Files:**
- Modify: `package.json` (devDependency + script)
- Create: `vitest.config.ts`
- Create: `src/lib/components/bookshelf/three/carouselMath.test.ts` (smoke only, replaced in Task 2)

**Interfaces:**
- Produces: `npm test` / `npx vitest run` runs `src/**/*.test.ts` in node environment.

- [ ] **Step 1: Install vitest**

```bash
pnpm add -D vitest@^2.1.0
```

(Repo uses pnpm — `pnpm-lock.yaml` present.)

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
```

Add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 3: Smoke test**

```ts
// src/lib/components/bookshelf/three/carouselMath.test.ts
import { describe, it, expect } from 'vitest';
describe('vitest bootstrap', () => {
	it('runs', () => expect(1 + 1).toBe(2));
});
```

Run: `npx vitest run` → 1 passing.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts src/lib/components/bookshelf/three/carouselMath.test.ts
git commit -m "test: add vitest for bookshelf pure-logic modules"
```

---

### Task 1: Shared types + mode state machine

**Files:**
- Create: `src/lib/components/bookshelf/types/experience.ts`
- Create: `src/lib/components/bookshelf/three/state.ts`
- Test: `src/lib/components/bookshelf/three/state.test.ts`

**Interfaces:**
- Produces (types used by every later task):

```ts
// types/experience.ts
export type Mode = 'shelf' | 'opening' | 'inspect' | 'closing';

export interface BookPalette {
	cloth: string;      // '#rrggbb' board/cloth color
	foil: string;       // accent: foil, ribbon, headbands, theme accent
	paper: string;      // scene backdrop tone for this book
	paperPale: string;  // endpaper / page tint
	ink: string;        // readable text tone against cloth
	floor: string;
	light: string;      // key-light tint
	fill: string;       // fill-light tint
}

export interface BookSize { width: number; height: number; depth: number }

export interface BookIdentity {
	id: number;
	seed: number;
	size: BookSize;
	palette: BookPalette;
	motifIndex: number; // 0..5
	title: string;
	author: string | null;
	series: string | null;
	seriesIndex: number | null;
	description: string | null;
}

export interface ScenePalette {
	backdrop: string; floor: string; fog: string;
	key: string; fill: string; accent: string; shelf: string;
}

export interface Pose {
	position: [number, number, number];
	quaternion: [number, number, number, number];
	scale: number;
}
```

- Produces: `createModeMachine(): { mode: Mode; can(next: Mode): boolean; to(next: Mode): boolean }` — the ONLY way mode changes. Legal ring: `shelf→opening→inspect→closing→shelf`.

- [ ] **Step 1: Write failing tests**

```ts
// three/state.test.ts
import { describe, it, expect } from 'vitest';
import { createModeMachine } from './state';

describe('mode machine', () => {
	it('starts on shelf and walks the legal ring', () => {
		const m = createModeMachine();
		expect(m.mode).toBe('shelf');
		expect(m.to('opening')).toBe(true);
		expect(m.to('inspect')).toBe(true);
		expect(m.to('closing')).toBe(true);
		expect(m.to('shelf')).toBe(true);
	});
	it('rejects illegal jumps without changing mode', () => {
		const m = createModeMachine();
		expect(m.to('inspect')).toBe(false);
		expect(m.to('closing')).toBe(false);
		expect(m.mode).toBe('shelf');
		m.to('opening');
		expect(m.to('shelf')).toBe(false); // opening cannot abort backwards
		expect(m.mode).toBe('opening');
	});
	it('can() predicts to() without mutating', () => {
		const m = createModeMachine();
		expect(m.can('opening')).toBe(true);
		expect(m.can('inspect')).toBe(false);
		expect(m.mode).toBe('shelf');
	});
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/components/bookshelf/three/state.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

Write `types/experience.ts` exactly as in Interfaces above, then:

```ts
// three/state.ts
import type { Mode } from '../types/experience';

const NEXT: Record<Mode, Mode> = {
	shelf: 'opening',
	opening: 'inspect',
	inspect: 'closing',
	closing: 'shelf'
};

export function createModeMachine() {
	let mode: Mode = 'shelf';
	return {
		get mode(): Mode { return mode; },
		can(next: Mode): boolean { return NEXT[mode] === next; },
		to(next: Mode): boolean {
			if (NEXT[mode] !== next) return false;
			mode = next;
			return true;
		}
	};
}
```

- [ ] **Step 4: Verify pass** — `npx vitest run` → PASS. `npm run check` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/bookshelf/types/experience.ts src/lib/components/bookshelf/three/state.ts src/lib/components/bookshelf/three/state.test.ts
git commit -m "feat(shelf): mode state machine and shared experience types"
```

---

### Task 2: Carousel math (pure)

**Files:**
- Create: `src/lib/components/bookshelf/three/carouselMath.ts`
- Test: replace `src/lib/components/bookshelf/three/carouselMath.test.ts`

**Interfaces:**
- Produces:

```ts
export const SPACING = 1.18;
export const WRAP_MIN = 5;
export function shouldWrap(count: number): boolean;                 // count >= 5 (§4.2)
export function wrapOffset(index: number, position: number, count: number, wrap: boolean): number;
export function shortestDelta(from: number, to: number, count: number, wrap: boolean): number;
export function clampTarget(target: number, count: number, wrap: boolean): number;
export function damp(current: number, target: number, lambda: number, dt: number): number;
export function smoothstep(t: number): number;    // t*t*(3-2t), t pre-clamped 0..1
export function smootherstep(t: number): number;  // 6t^5-15t^4+10t^3, t pre-clamped
export interface ShelfPose { x: number; y: number; z: number; rotY: number; rotZ: number; scale: number; opacity: number; focus: number }
export function shelfPose(offset: number, bookHeight: number, shelfTop: number): ShelfPose;
```

- [ ] **Step 1: Write failing tests**

```ts
// three/carouselMath.test.ts  (replaces smoke test)
import { describe, it, expect } from 'vitest';
import {
	SPACING, shouldWrap, wrapOffset, shortestDelta, clampTarget,
	damp, smoothstep, smootherstep, shelfPose
} from './carouselMath';

describe('wrapping', () => {
	it('wraps only at 5+', () => {
		expect(shouldWrap(4)).toBe(false);
		expect(shouldWrap(5)).toBe(true);
	});
	it('wrapOffset picks the near copy across the seam', () => {
		// 12 books, position at 11: book 0 is +1 away, not -11
		expect(wrapOffset(0, 11, 12, true)).toBe(1);
		expect(wrapOffset(11, 0, 12, true)).toBe(-1);
		expect(wrapOffset(6, 0, 12, true)).toBe(6 - 12); // ties round toward -count/2 side
	});
	it('non-wrap mode is plain subtraction', () => {
		expect(wrapOffset(0, 3, 4, false)).toBe(-3);
	});
	it('shortestDelta goes through the seam when closer', () => {
		expect(shortestDelta(11, 1, 12, true)).toBe(2);
		expect(shortestDelta(1, 11, 12, true)).toBe(-2);
		expect(shortestDelta(1, 3, 12, false)).toBe(2);
	});
	it('clampTarget clamps only when not wrapping', () => {
		expect(clampTarget(-2, 4, false)).toBe(0);
		expect(clampTarget(9, 4, false)).toBe(3);
		expect(clampTarget(-2, 12, true)).toBe(-2);
	});
});

describe('damp/easing', () => {
	it('damp is frame-rate independent', () => {
		// one 0.1s step == two 0.05s steps
		const one = damp(0, 1, 9.5, 0.1);
		const two = damp(damp(0, 1, 9.5, 0.05), 1, 9.5, 0.05);
		expect(one).toBeCloseTo(two, 10);
	});
	it('easings hit exact endpoints', () => {
		expect(smoothstep(0)).toBe(0); expect(smoothstep(1)).toBe(1);
		expect(smootherstep(0)).toBe(0); expect(smootherstep(1)).toBe(1);
		expect(smootherstep(0.5)).toBeCloseTo(0.5, 10);
	});
});

describe('shelfPose (§4.2 recipe)', () => {
	const shelfTop = 0.47, h = 1.5;
	it('focused book: lifted, forward, upscaled, opaque', () => {
		const p = shelfPose(0, h, shelfTop);
		expect(p.x).toBe(0);
		expect(p.y).toBeCloseTo(shelfTop + h / 2 + 0.15, 10);
		expect(p.z).toBeCloseTo(0.37, 10);
		expect(p.rotY).toBe(0);
		expect(p.scale).toBeCloseTo(1.09, 10);
		expect(p.opacity).toBe(1);
		expect(p.focus).toBe(1);
	});
	it('offset 2: arced away, no lift, full opacity', () => {
		const p = shelfPose(2, h, shelfTop);
		expect(p.x).toBeCloseTo(2 * SPACING, 10);
		expect(p.rotY).toBeCloseTo(-0.21, 10);
		expect(p.rotZ).toBeCloseTo(-0.036, 10);
		expect(p.focus).toBe(0);
		expect(p.opacity).toBe(1);
	});
	it('fade band: opacity 1 at 2.55, 0 at 3.25, monotone between', () => {
		expect(shelfPose(2.55, h, shelfTop).opacity).toBeCloseTo(1, 10);
		expect(shelfPose(3.25, h, shelfTop).opacity).toBeCloseTo(0, 10);
		const mid = shelfPose(2.9, h, shelfTop).opacity;
		expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(1);
	});
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run` → FAIL.

- [ ] **Step 3: Implement**

```ts
// three/carouselMath.ts
export const SPACING = 1.18;
export const WRAP_MIN = 5;

export const shouldWrap = (count: number) => count >= WRAP_MIN;

export function wrapOffset(index: number, position: number, count: number, wrap: boolean): number {
	let o = index - position;
	if (wrap && count > 0) o -= Math.round(o / count) * count;
	return o;
}

export function shortestDelta(from: number, to: number, count: number, wrap: boolean): number {
	let d = to - from;
	if (wrap && count > 0) d -= Math.round(d / count) * count;
	return d;
}

export function clampTarget(target: number, count: number, wrap: boolean): number {
	return wrap ? target : Math.min(Math.max(target, 0), Math.max(count - 1, 0));
}

export function damp(current: number, target: number, lambda: number, dt: number): number {
	return target + (current - target) * Math.exp(-lambda * dt);
}

const clamp01 = (t: number) => Math.min(Math.max(t, 0), 1);
export const smoothstep = (t: number) => { const c = clamp01(t); return c * c * (3 - 2 * c); };
export const smootherstep = (t: number) => { const c = clamp01(t); return c * c * c * (c * (c * 6 - 15) + 10); };

export interface ShelfPose {
	x: number; y: number; z: number;
	rotY: number; rotZ: number;
	scale: number; opacity: number; focus: number;
}

export function shelfPose(offset: number, bookHeight: number, shelfTop: number): ShelfPose {
	const distance = Math.abs(offset);
	const focus = 1 - clamp01(distance);
	return {
		x: offset * SPACING,
		y: shelfTop + bookHeight * 0.5 + focus * 0.15,
		z: 0.13 + focus * 0.24 - Math.min(distance, 2.8) * 0.07,
		rotY: -offset * 0.105,
		rotZ: -offset * 0.018,
		scale: 1 + focus * 0.09,
		opacity: 1 - smoothstep((distance - 2.55) / 0.7),
		focus
	};
}
```

Note the `wrapOffset(6, 0, 12)` test: `Math.round(0.5) === 1` in JS, so a book exactly opposite resolves to `-6`. That's the assertion's expectation — don't "fix" it.

- [ ] **Step 4: Verify pass** — `npx vitest run` → PASS. `npm run check` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/bookshelf/three/carouselMath.ts src/lib/components/bookshelf/three/carouselMath.test.ts
git commit -m "feat(shelf): carousel wrap/pose/damping math"
```

---

### Task 3: Book identity (pure)

**Files:**
- Create: `src/lib/components/bookshelf/three/bookIdentity.ts`
- Test: `src/lib/components/bookshelf/three/bookIdentity.test.ts`

**Interfaces:**
- Consumes: `BookIdentity`, `BookPalette`, `BookSize` from `types/experience.ts`; app `Book` type from `$lib/api/commands` (fields used: `id`, `title`, `author`, `series`, `seriesIndex`, `description`).
- Produces:

```ts
export function hashSeed(id: number): number;                 // FNV-1a, stable
export function seededRandom(seed: number): () => number;     // mulberry32, [0,1)
export function deriveSize(seed: number): BookSize;           // w .92–1.10, h 1.46–1.58, d .22–.30
export function paletteFromSeed(seed: number): BookPalette;   // 10-color editorial ramp
export function truncateLabel(text: string, max?: number): string; // default 40, adds '…'
export function buildIdentity(book: Book): BookIdentity;      // deterministic per id
export function mixHex(a: string, b: string, t: number): string;  // '#rrggbb' lerp
export function luminance(hex: string): number;               // 0..1 relative
```

- [ ] **Step 1: Write failing tests**

```ts
// three/bookIdentity.test.ts
import { describe, it, expect } from 'vitest';
import {
	hashSeed, seededRandom, deriveSize, paletteFromSeed,
	truncateLabel, buildIdentity, mixHex, luminance
} from './bookIdentity';
import type { Book } from '$lib/api/commands';

const fakeBook = (id: number): Book => ({
	id, path: '/x.epub', coverPath: null, title: 'Project Hail Mary',
	sortTitle: null, author: 'Andy Weir', authorSort: null, series: null,
	seriesIndex: null, description: 'A lone astronaut.', language: null,
	publisher: null, publishDate: null, isbn: null, fileSize: 1, fileHash: null,
	calibreId: null, source: 'local', dateAdded: 0, dateModified: 0,
	dateIndexed: null, embeddingStatus: 'complete', embeddingModel: null,
	hidden: false, rating: null, readStatus: 'want'
});

describe('determinism', () => {
	it('same id → identical identity, different ids differ', () => {
		const a1 = buildIdentity(fakeBook(7)), a2 = buildIdentity(fakeBook(7));
		expect(a1).toEqual(a2);
		expect(buildIdentity(fakeBook(8)).seed).not.toBe(a1.seed);
	});
	it('seededRandom repeats per seed and stays in [0,1)', () => {
		const r1 = seededRandom(123), r2 = seededRandom(123);
		for (let i = 0; i < 100; i++) {
			const v = r1();
			expect(v).toBe(r2());
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});
});

describe('size bounds (§5.1)', () => {
	it('every seed lands in spec ranges', () => {
		for (let id = 0; id < 200; id++) {
			const s = deriveSize(hashSeed(id));
			expect(s.width).toBeGreaterThanOrEqual(0.92); expect(s.width).toBeLessThanOrEqual(1.10);
			expect(s.height).toBeGreaterThanOrEqual(1.46); expect(s.height).toBeLessThanOrEqual(1.58);
			expect(s.depth).toBeGreaterThanOrEqual(0.22); expect(s.depth).toBeLessThanOrEqual(0.30);
		}
	});
});

describe('palette', () => {
	it('valid hex everywhere, ink readable against cloth', () => {
		for (let id = 0; id < 20; id++) {
			const p = paletteFromSeed(hashSeed(id));
			for (const v of Object.values(p)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
			expect(Math.abs(luminance(p.ink) - luminance(p.cloth))).toBeGreaterThan(0.3);
		}
	});
});

describe('helpers', () => {
	it('truncateLabel', () => {
		expect(truncateLabel('short')).toBe('short');
		const long = 'x'.repeat(60);
		expect(truncateLabel(long)).toHaveLength(41); // 40 + '…'
		expect(truncateLabel(long).endsWith('…')).toBe(true);
	});
	it('mixHex endpoints and midpoint', () => {
		expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
		expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
		expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
	});
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run` → FAIL. (If vitest can't resolve `$lib`, add `resolve: { alias: { $lib: new URL('./src/lib', import.meta.url).pathname } }` to `vitest.config.ts` — type-only import, no runtime cost.)

- [ ] **Step 3: Implement**

```ts
// three/bookIdentity.ts
import type { Book } from '$lib/api/commands';
import type { BookIdentity, BookPalette, BookSize } from '../types/experience';

export function hashSeed(id: number): number {
	let h = 2166136261 >>> 0;
	const s = `book-${id}`;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h >>> 0;
}

export function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function deriveSize(seed: number): BookSize {
	const r = seededRandom(seed);
	return {
		width: 0.92 + r() * 0.18,
		height: 1.46 + r() * 0.12,
		depth: 0.22 + r() * 0.08
	};
}

const hexToRgb = (hex: string): [number, number, number] => [
	parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)
];
const rgbToHex = (r: number, g: number, b: number) =>
	'#' + [r, g, b].map((v) => Math.round(Math.min(Math.max(v, 0), 255)).toString(16).padStart(2, '0')).join('');

export function mixHex(a: string, b: string, t: number): string {
	const [ar, ag, ab] = hexToRgb(a), [br, bg, bb] = hexToRgb(b);
	return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

export function luminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// 10-color editorial cloth ramp with paired foils (reference-derived, §5.2)
const CLOTHS = ['#182a43', '#c24d24', '#5f2a1e', '#1537a1', '#2f4a3e',
	'#7a1f2b', '#3c3a63', '#8a6d3b', '#233138', '#4a1f3d'];
const FOILS = ['#c87046', '#efc16d', '#e0b487', '#dbe8f1', '#cfd8c2',
	'#e3b587', '#c9c3e8', '#f1e3c0', '#9fb3c9', '#e8c9d8'];

export function paletteFromSeed(seed: number): BookPalette {
	const i = seed % CLOTHS.length;
	return buildPalette(CLOTHS[i], FOILS[i]);
}

export function buildPalette(cloth: string, foil: string): BookPalette {
	const dark = luminance(cloth) < 0.35;
	return {
		cloth,
		foil,
		paper: mixHex(cloth, '#171a20', 0.45),
		paperPale: '#f1eadf',
		ink: dark ? '#f4eee6' : '#171914',
		floor: mixHex(cloth, '#d8c8aa', 0.72),
		light: mixHex(foil, '#f4d7b9', 0.6),
		fill: mixHex(cloth, '#d8e3e7', 0.75)
	};
}

export function truncateLabel(text: string, max = 40): string {
	return text.length <= max ? text : text.slice(0, max) + '…';
}

export function buildIdentity(book: Book): BookIdentity {
	const seed = hashSeed(book.id);
	return {
		id: book.id,
		seed,
		size: deriveSize(seed),
		palette: paletteFromSeed(seed),
		motifIndex: seed % 6,
		title: book.title,
		author: book.author,
		series: book.series,
		seriesIndex: book.seriesIndex,
		description: book.description
	};
}
```

If the ink-contrast test fails for any ramp entry, adjust that CLOTH value darker/lighter until it passes — the ramp is curated, the test is the gate.

- [ ] **Step 4: Verify pass** — `npx vitest run` → PASS. `npm run check` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/bookshelf/three/bookIdentity.ts src/lib/components/bookshelf/three/bookIdentity.test.ts vitest.config.ts
git commit -m "feat(shelf): deterministic per-book identity (seed, size, palette)"
```

---

### Task 4: Cover palette extraction + theme blend math (pure)

**Files:**
- Create: `src/lib/components/bookshelf/three/theme.ts` (pure part)
- Modify: `src/lib/components/bookshelf/three/bookIdentity.ts` (add `paletteFromCover`)
- Test: `src/lib/components/bookshelf/three/theme.test.ts`, extend `bookIdentity.test.ts`

**Interfaces:**
- Consumes: `buildPalette`, `mixHex`, `luminance` (Task 3), `BookPalette`, `ScenePalette`.
- Produces:

```ts
// bookIdentity.ts additions
export function paletteFromCover(pixels: Uint8ClampedArray): BookPalette | null;
// coarse HSL histogram (12 hue × 4 sat × 4 light bins, §5.2); null if too few usable pixels

// theme.ts
export function blendPaletteWithMode(p: BookPalette, dark: boolean): ScenePalette;
export function easeSceneColor(current: string, target: string, lambda: number, dt: number): string;
// damped hex lerp used by the scene-side theming; returns target when within 1/255 per channel
```

- [ ] **Step 1: Write failing tests**

```ts
// three/theme.test.ts
import { describe, it, expect } from 'vitest';
import { blendPaletteWithMode, easeSceneColor } from './theme';
import { paletteFromSeed, luminance, paletteFromCover } from './bookIdentity';

const p = paletteFromSeed(42);

describe('blendPaletteWithMode (§4.1)', () => {
	it('dark mode pulls backdrop/floor darker than light mode', () => {
		const d = blendPaletteWithMode(p, true), l = blendPaletteWithMode(p, false);
		expect(luminance(d.backdrop)).toBeLessThan(luminance(l.backdrop));
		expect(luminance(d.floor)).toBeLessThan(luminance(l.floor));
	});
	it('accent passes through as the book foil', () => {
		expect(blendPaletteWithMode(p, true).accent).toBe(p.foil);
	});
	it('fog matches backdrop', () => {
		const d = blendPaletteWithMode(p, true);
		expect(d.fog).toBe(d.backdrop);
	});
});

describe('easeSceneColor', () => {
	it('converges and snaps exactly to target', () => {
		let c = '#000000';
		for (let i = 0; i < 400; i++) c = easeSceneColor(c, '#a05020', 6, 1 / 60);
		expect(c).toBe('#a05020');
	});
	it('is a no-op at target', () => {
		expect(easeSceneColor('#a05020', '#a05020', 6, 1 / 60)).toBe('#a05020');
	});
});

describe('paletteFromCover', () => {
	const px = (rgb: [number, number, number], n: number) => {
		const a = new Uint8ClampedArray(n * 4);
		for (let i = 0; i < n; i++) { a[i * 4] = rgb[0]; a[i * 4 + 1] = rgb[1]; a[i * 4 + 2] = rgb[2]; a[i * 4 + 3] = 255; }
		return a;
	};
	it('dominant color becomes cloth', () => {
		const cover = paletteFromCover(px([180, 40, 30], 1024))!;
		// dominant red family → cloth in red family
		const [r, g, b] = [cover.cloth.slice(1, 3), cover.cloth.slice(3, 5), cover.cloth.slice(5, 7)]
			.map((h) => parseInt(h, 16));
		expect(r).toBeGreaterThan(g); expect(r).toBeGreaterThan(b);
	});
	it('near-white/near-black covers yield null (fallback to seed palette)', () => {
		expect(paletteFromCover(px([250, 250, 250], 1024))).toBeNull();
		expect(paletteFromCover(px([5, 5, 5], 1024))).toBeNull();
	});
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run` → FAIL.

- [ ] **Step 3: Implement**

```ts
// bookIdentity.ts — append
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
	r /= 255; g /= 255; b /= 255;
	const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h = 0;
	if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
	else if (max === g) h = ((b - r) / d + 2) / 6;
	else h = ((r - g) / d + 4) / 6;
	return [h, s, l];
}

export function paletteFromCover(pixels: Uint8ClampedArray): BookPalette | null {
	// 12 hue × 4 sat × 4 light coarse histogram; skip near-white/black/transparent
	const bins = new Map<number, { n: number; r: number; g: number; b: number; s: number }>();
	let usable = 0;
	for (let i = 0; i < pixels.length; i += 4) {
		if (pixels[i + 3] < 200) continue;
		const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
		const [h, s, l] = rgbToHsl(r, g, b);
		if (l > 0.92 || l < 0.08) continue;
		usable++;
		const key = Math.floor(h * 12) * 16 + Math.floor(s * 3.999) * 4 + Math.floor(l * 3.999);
		const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0, s: 0 };
		bin.n++; bin.r += r; bin.g += g; bin.b += b; bin.s += s;
		bins.set(key, bin);
	}
	if (usable < pixels.length / 4 * 0.2) return null;
	const sorted = [...bins.entries()].sort((a, b) => b[1].n - a[1].n);
	const toHex = (bin: { n: number; r: number; g: number; b: number }) =>
		'#' + [bin.r, bin.g, bin.b].map((v) => Math.round(v / bin.n).toString(16).padStart(2, '0')).join('');
	const dominant = sorted[0][1];
	const domHue = Math.floor(sorted[0][0] / 16);
	// accent: most populous bin ≥ 2 hue-bins away, else most saturated remaining, else foil from mix
	const away = sorted.slice(1).find(([k]) => {
		const hue = Math.floor(k / 16);
		const dist = Math.min(Math.abs(hue - domHue), 12 - Math.abs(hue - domHue));
		return dist >= 2;
	});
	const accentBin = away?.[1] ?? sorted.slice(1).sort((a, b) => b[1].s / b[1].n - a[1].s / a[1].n)[0]?.[1];
	const cloth = toHex(dominant);
	const foil = accentBin ? mixHex(toHex(accentBin), '#f1e3c0', 0.25) : mixHex(cloth, '#f1e3c0', 0.6);
	return buildPalette(cloth, foil);
}
```

```ts
// three/theme.ts
import type { BookPalette, ScenePalette } from '../types/experience';
import { mixHex } from './bookIdentity';

const DARK_ANCHOR = '#14141e';   // app dark chrome family
const LIGHT_ANCHOR = '#efe7d8';  // warm paper

export function blendPaletteWithMode(p: BookPalette, dark: boolean): ScenePalette {
	const backdrop = dark ? mixHex(p.paper, DARK_ANCHOR, 0.6) : mixHex(p.paper, LIGHT_ANCHOR, 0.55);
	return {
		backdrop,
		fog: backdrop,
		floor: dark ? mixHex(p.floor, DARK_ANCHOR, 0.65) : mixHex(p.floor, LIGHT_ANCHOR, 0.35),
		key: p.light,
		fill: p.fill,
		accent: p.foil,
		shelf: dark ? '#241610' : '#3a2118'
	};
}

export function easeSceneColor(current: string, target: string, lambda: number, dt: number): string {
	if (current === target) return target;
	const t = 1 - Math.exp(-lambda * dt);
	const next = mixHex(current, target, t);
	// snap when every channel is within 1/255
	const close = [1, 3, 5].every((i) =>
		Math.abs(parseInt(next.slice(i, i + 2), 16) - parseInt(target.slice(i, i + 2), 16)) <= 1);
	return close ? target : next;
}
```

- [ ] **Step 4: Verify pass** — `npx vitest run` → PASS. `npm run check` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/bookshelf/three/theme.ts src/lib/components/bookshelf/three/theme.test.ts src/lib/components/bookshelf/three/bookIdentity.ts src/lib/components/bookshelf/three/bookIdentity.test.ts
git commit -m "feat(shelf): cover palette extraction and mode-aware theme blending"
```

---

### Task 5: Experience shell + room + lights (empty studio on screen)

**Files:**
- Create: `src/lib/components/bookshelf/three/experience.ts`
- Create: `src/lib/components/bookshelf/three/room.ts`
- Create: `src/lib/components/bookshelf/three/lights.ts`
- Create: `src/lib/components/bookshelf/three/textures/shared.ts` (contact-shadow + wood-grain painters only; cloth/paper/edges arrive in Task 6)
- Modify: `src/lib/components/bookshelf/Library3D.svelte` (full rewrite — hosts the new experience; renders the studio with NO books yet; old grid path dead but files untouched until Task 11)

**Interfaces:**
- Consumes: `blendPaletteWithMode`, `easeSceneColor` (Task 4); `damp` (Task 2).
- Produces:

```ts
// experience.ts
export interface Experience {
	scene: THREE.Scene;
	camera: THREE.PerspectiveCamera;
	renderer: THREE.WebGLRenderer;
	shelfStage: THREE.Group;                 // carousel parent; retreats during inspect
	requestFrame(): void;                    // schedules exactly one rAF if none pending
	onFrame(cb: (dt: number, elapsed: number) => boolean): void;
	// cb returns true → another frame is needed (on-demand loop, §4.5)
	setViewOffsetX(px: number): void;        // camera.setViewOffset horizontal shift
	resize(): void;
	dispose(): void;
}
export function createExperience(container: HTMLElement): Experience;
// camera: fov 32, near 0.1, far 60; shelf cam pos (0,1.9,6.1) target (0,1.25,0)
// (retuned at the Task 5 visual checkpoint — the original (0,1.72,4.6)/(0,1.32,0)
// framed the shelf furniture as full-width bands and clipped the book fade band)
export const SHELF_CAMERA_POSITION: [number, number, number]; // exported for inspect.ts
export const SHELF_CAMERA_TARGET: [number, number, number];
export const SHELF_TOP = 0.47;              // walnut board top Y — carousel ground truth

// room.ts
export interface Room { themeTargets: { backdrop: THREE.Material & { color: THREE.Color }; floor: ...; shadow: THREE.Material }; dust: THREE.Points | null }
export function addRoom(scene: THREE.Scene, shelfStage: THREE.Group, reducedMotion: boolean): Room;

// lights.ts
export interface LightRig { key: THREE.DirectionalLight; fill: THREE.DirectionalLight; hemisphere: THREE.HemisphereLight }
export function addLights(scene: THREE.Scene): LightRig; // call RectAreaLightUniformsLib.init() inside
```

- [ ] **Step 1: Implement `experience.ts`**

Renderer per Global Constraints (`antialias: true`, `alpha: true`, `powerPreference: 'high-performance'`, PCFSoftShadowMap, ACES 0.9, PMREM RoomEnvironment 0.72, `FogExp2(backdrop, 0.027)`). On-demand loop:

```ts
let rafId = 0; let last = performance.now(); let cb: FrameCb | null = null;
function requestFrame() { if (!rafId) rafId = requestAnimationFrame(frame); }
function frame(time: number) {
	rafId = 0;
	const dt = Math.min((time - last) / 1000, 0.05); last = time;
	const again = cb?.(dt, time / 1000) ?? false;
	renderer.render(scene, camera);
	if (again) requestFrame();
}
```

`setViewOffsetX(px)`: `camera.setViewOffset(w, h, px, 0, w, h)` with current drawing-buffer CSS size; `px === 0` → `camera.clearViewOffset()`. `resize()` re-applies size, DPR rule, aspect, and re-asserts the current view offset. `dispose()` disposes renderer, PMREM target, and removes the canvas.

- [ ] **Step 2: Implement `room.ts` + shared painters**

Room per §4.1/reference: floor plane 30×20 at y −0.02; backdrop plane 28×14 at (0, 5.5, −3.3); in `shelfStage`: walnut board `17×0.28×1.08` at (0, 0.33, −0.03) (top = 0.47 = `SHELF_TOP`), lip `17.05×0.075×1.14` at (0, 0.205, 0.02), back rail `17×0.17×0.2` at (0, 0.68, −0.52), two uprights `0.2×3.8×0.72` at x ±7.65, contact-shadow strip (radial-gradient alpha canvas from `textures/shared.ts`, opacity 0.22) at (0, 0.49, 0.06). Walnut = `MeshStandardMaterial({ color: '#3a2118', roughness .82 })` with procedural wood-grain bump canvas (256², horizontal noise streaks — `sharedWoodGrainTexture()` in `textures/shared.ts`). Dust: 110 seeded points (`seededRandom(20260803)`), size 0.014, opacity 0.3, skipped when `reducedMotion`.

```ts
// textures/shared.ts (this task's slice)
export function sharedContactShadowTexture(): THREE.CanvasTexture; // 128², radial white→black alpha
export function sharedWoodGrainTexture(): THREE.CanvasTexture;     // 256², seeded horizontal streaks
```

Both memoized in module-level `let` singletons with a `disposeSharedTextures()` export.

- [ ] **Step 3: Implement `lights.ts`**

Exact reference rig (positions valid at our scale, §4.1): hemisphere `(0xfff8e8, 0x5b4030, 0.56)`; key directional `0xffe8c2` 1.42 at (−4.6, 7.4, 5.8), castShadow, mapSize 2048, camera box L−6 R6 T6 B−1.5 near 1 far 18, bias −0.00018, normalBias 0.018, radius 3.5; fill directional `0xd8e3e7` 0.3 at (5.5, 3.6, 4.2); RectArea softKey `0xffe8c2` 5.4 (4.8×5.6) at (−3.2, 5.5, 4.6) lookAt (0, 1.45, 0); RectArea foil-rake `0xd5a45e` 3.45 (1.6×4.8) at (3.8, 3.6, −2.1) lookAt (−0.2, 1.5, 0); RectArea back-softbox `0xd8e3e7` 2.7 (3.8×4.8) at (−1.8, 2.9, −4.5); RectArea page-rake `0xfff7e7` 2.15 (1.15×3.8) at (4.2, 4.8, 3.1). `RectAreaLightUniformsLib.init()` first.

- [ ] **Step 4: Rewrite `Library3D.svelte` to host the studio**

Keep: props `books`, `selectedBookId`; dispatched events (`bookSelected`, `selectedBookIdChange`, `bookHover`); dark-mode MutationObserver; ResizeObserver; dispose-on-destroy. Drop: `maxBooksPerShelf`, `minShelfWidth`, `shelfSpacing`, `animationSpeed`, `enableKeyboardNav`, `enableTooltips`, tooltip markup, scroll indicator (spec §10.3 — `textureQuality` prop is kept). Body for this task: `createExperience(container)` + `addRoom` + `addLights` + theme applied via `blendPaletteWithMode(paletteFromSeed(0), isDarkMode())` as a placeholder until Task 8 wires selection. Remove `on:mousemove`, keep `role="application"` and `aria-label="Up Next 3D shelf"`. `up-next/+page.svelte`: delete the three dropped-prop usages (`maxBooksPerShelf={8}` line).

- [ ] **Step 5: Manual verification (CHECKPOINT — user approves the studio)**

Run: `npm run tauri dev` → navigate to Up Next.
Expected: warm studio — paper backdrop with fog, walnut shelf with lip/rail/uprights, soft shadow strip, dust motes drifting only while a frame is being driven, NO books, no console errors. Toggle app dark mode → backdrop/floor re-tint without rebuild. Idle scene renders 0 fps (DevTools → Performance).

- [ ] **Step 6: Type check + commit**

```bash
npm run check
git add src/lib/components/bookshelf/three/experience.ts src/lib/components/bookshelf/three/room.ts src/lib/components/bookshelf/three/lights.ts src/lib/components/bookshelf/three/textures/shared.ts src/lib/components/bookshelf/Library3D.svelte src/routes/up-next/+page.svelte
git commit -m "feat(shelf): studio experience shell — renderer, room, lighting rig, on-demand loop"
```

---

### Task 6: Shared + artwork textures

**Files:**
- Modify: `src/lib/components/bookshelf/three/textures/shared.ts` (add cloth/paper/edges)
- Create: `src/lib/components/bookshelf/three/textures/artwork.ts`
- Create: `src/routes/dev/textures/+page.svelte` (temporary visual-approval harness; deleted in Task 11)

**Interfaces:**
- Consumes: `BookIdentity`, `seededRandom`, `truncateLabel`.
- Produces:

```ts
// shared.ts additions — all memoized singletons, tint via material color
export function sharedClothMaps(): { normal: THREE.CanvasTexture; roughness: THREE.CanvasTexture; bump: THREE.CanvasTexture };
export function sharedPaperFaceTexture(): THREE.CanvasTexture;   // 256² grain
export function sharedPageEdgeTextures(): { fore: THREE.CanvasTexture; headTail: THREE.CanvasTexture }; // fine line stacks
export function disposeSharedTextures(): void;

// artwork.ts — per-identity canvases (512–1024 px long edge by textureQuality)
export interface CoverArtSet {
	cover: THREE.CanvasTexture;        // procedural typography cover (used until/unless real cover)
	foil: THREE.CanvasTexture | null;  // alpha motif layer (null once a real cover is applied)
	spine: THREE.CanvasTexture;
	spineFoil: THREE.CanvasTexture;
	back: THREE.CanvasTexture;
	endpaper: THREE.CanvasTexture;
	dispose(): void;
}
export function makeArtwork(identity: BookIdentity, quality: 'low' | 'medium' | 'high'): CoverArtSet;
export function makeRealCoverTexture(identity: BookIdentity, image: HTMLImageElement, quality: 'low' | 'medium' | 'high'): THREE.CanvasTexture;
// draws cloth ground + image inset ~3% (tipped-on print look, §5.2)
export function makeEmbossFrom(texture: THREE.CanvasTexture, name: string): THREE.CanvasTexture;
```

- [ ] **Step 1: Implement shared maps**

Cloth weave (reference technique §5.1): 256² height field of `sin(x·τ·48)+sin(y·τ·48)` plus seeded noise → derive normal map (finite differences) and roughness map (height → 0.85–1.0 range). Bump: 256² per-pixel noise ±10. Paper face: 240-ish light-gray fibers on `#f5efdf`. Page edges: `fore` = vertical 1-px lines alternating `#efe6d2/#d9cdb4` on 256×512; `headTail` = same rotated horizontal on 512×256. All `CanvasTexture` with `SRGBColorSpace` for color maps, `NoColorSpace` for data maps, `RepeatWrapping` on weave/paper.

- [ ] **Step 2: Implement artwork painters**

Canvas long-edge: low 512, medium 768, high 1024 (`textureQuality`).

- **Procedural cover:** cloth ground `identity.palette.cloth` + noise grain; motif (below) stroked in `foil` at 0.35 alpha upper third; title serif (`Iowan Old Style, Baskerville, Georgia, serif`) wrapped ≤ 3 lines centered at 42% height in `ink`; author small-caps at 78%; thin double foil rule between. Foil layer canvas: black ground, motif + title re-stroked in white (used as alphaMap+map).
- **Motifs (6, drawn by `motifIndex` with seeded jitter):** 0 nested brackets, 1 interlaced arcs, 2 directional caret column, 3 suspended orbit circles, 4 stacked horizon lines, 5 concentric rounded frames. Each ≤ 20 lines of canvas path code, stroke-only, no fills.
- **Spine (always procedural, §5.2):** cloth ground, foil rules top/bottom, rotated (`ctx.rotate(Math.PI/2)`) title `truncateLabel(title, 40)` centered, author surname below, `seriesIndex` roman-ish numeral badge when present. SpineFoil: white-on-black duplicate of rules+title for the metallic layer.
- **Back:** cloth ground, blurb from `description` wrapped ≤ 6 lines in `ink` at 0.8 alpha over a subtle inset frame; skip text when description null.
- **Endpaper:** `paperPale` ground + seeded marbled swirls in `mixHex(cloth, paperPale, 0.7)`.
- `makeRealCoverTexture`: cloth ground, `drawImage` inset 3% each side with 2% corner shadow line.
- `makeEmbossFrom`: clone canvas → grayscale → `CanvasTexture` for bumpMap use.

- [ ] **Step 3: Dev harness page**

`/dev/textures/+page.svelte`: for 3 fake identities (seeds 7, 8, 9 via `buildIdentity`-shaped literals) render every canvas from `makeArtwork` + shared maps into the DOM (`appendChild(texture.image)`), labeled. Client-only (`onMount`).

- [ ] **Step 4: Manual verification (CHECKPOINT — user approves the artwork direction)**

Run: `npm run tauri dev` → `/dev/textures`. Expected: three distinct editorial cover/spine/back/endpaper sets, readable typography, no clipped text, motifs distinct per seed. `npm run check` passes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/bookshelf/three/textures/shared.ts src/lib/components/bookshelf/three/textures/artwork.ts src/routes/dev/textures/+page.svelte
git commit -m "feat(shelf): procedural cloth/paper/edge maps and per-book artwork painters"
```

---

### Task 7: Book rig

**Files:**
- Create: `src/lib/components/bookshelf/three/bookRig.ts`
- Modify: `src/lib/components/bookshelf/Library3D.svelte` (mount static rigs for visual check)

**Interfaces:**
- Consumes: `BookIdentity`; `makeArtwork`, `makeEmbossFrom`, shared textures (Task 6).
- Produces:

```ts
export interface RigHandle {
	identity: BookIdentity;
	root: THREE.Group;            // carousel slot pose target
	motion: THREE.Group;          // idle/hover offsets live here
	frontPivot: THREE.Group;      // cover crack/open hinge (rotation.y ∈ [-π+0.2, 0])
	pagePivots: THREE.Group[];    // 6 leaves, hinge groups (Phase 2 animates)
	pageSurfaces: THREE.Mesh[];   // raycast targets for page drag (Phase 2)
	hit: THREE.Mesh;              // oversized invisible click target, userData.bookId
	contactShadow: THREE.Mesh;
	fadeMaterials: THREE.Material[];   // opacity-driven set
	setOpacity(o: number): void;       // writes fadeMaterials + hit.visible (< 0.12 rule)
	applyRealCover(tex: THREE.CanvasTexture): void; // swaps cover map, hides foil plane
	dispose(): void;                   // geometries + materials + textures
}
export function createBookRig(identity: BookIdentity, quality: 'low' | 'medium' | 'high'): RigHandle;
```

- [ ] **Step 1: Implement rig construction (§5.1 anatomy, reference dimensions)**

Constants: `board 0.032`, `coverRadius 0.0045`, `pageRadius 0.0025`, `spineBoardThickness 0.014`, `spineWidth 0.082`, `pageWidth = w−0.074`, `pageHeight = h−0.068`, `pageDepth = d−0.026`.

Build order (all inside `motion`, which sits inside `root`):
1. **Page block**: `RoundedBoxGeometry(pageWidth, pageHeight, pageDepth, 4, pageRadius)` at x 0.018, paper material (shared paper map, bump, roughness .95).
2. **Back board pivot** at `(−w/2, 0, −d/2 − board/2)`: cover `RoundedBoxGeometry(w, h, board, 2, coverRadius)` cloth material offset x +w/2; back-art inset plane (rounded-plane `ShapeGeometry`, w−0.007) rotated π at z −board·0.55; back foil plane at −board·0.605 (`polygonOffsetFactor −2`, `depthWrite false`, metalness .9, roughness .21, clearcoat .14, emboss bump); endpaper plane (w−0.045) inside at +board·0.515; hinge-groove strip (0.012 × h·0.94, cloth darkened ×0.42) at x 0.038.
3. **Front board pivot** at `(−w/2, 0, d/2 + board/2)`: mirror of back — cover art plane at +board·0.55 (procedural cover initially), foil plane at +board·0.605, endpaper inside, groove.
4. **6 page-leaf pivots** at `(−w/2 + spineWidth·0.65, 0, pageDepth/2 + 0.0015 + i·0.0015)`: each holds front/back `PlaneGeometry(1,1,22,6)` sheets scaled to `(pageWidth − spineWidth·0.42, pageHeight − 0.014)`, blank paper material both sides (Phase 2 retextures/animates). Store `userData.restZ` and `userData.turnedZ = d/2 + board + 0.004 + leafOrder·0.0015`.
5. **Flat spine**: `RoundedBoxGeometry(0.014, h−0.012, d + board·1.88, 1, 0.0015)` at x `−w/2 − 0.0049`; spine-art material; spine-foil plane rotated −π/2 hugging its outer face; spine lining rounded box inside.
6. **Page furniture**: fore-edge plane (edge texture) at x `0.018 + pageWidth/2 + 0.002` rotY π/2; head/tail edge planes rotX ∓π/2; two headband cylinders r 0.012 at page corners by the spine; ribbon rounded-plane `0.034 × pageHeight·0.76` at seeded x-jitter, z front of page block; 6 thin signature boxes on the fore edge.
7. **Hit target**: invisible box `(w·1.34, h·1.2, max(d·4, 1))` at `(−spineWidth·0.18, 0, 0.12)`, `userData.bookId = identity.id`.
8. **Contact shadow**: shared radial texture, `(w·1.22 × d·2.05)` at y `−h/2 − 0.022` (child of `root`, not `motion`).

Materials: `MeshPhysicalMaterial` throughout with shared cloth maps (normalScale 0.3, sheen 0.27 tinted `foil`) per §5.1; every one `transparent: true` and pushed to `fadeMaterials`. `setOpacity` also scales contact-shadow opacity `o·0.24`. `applyRealCover` sets the front art plane's map, sets front foil plane `.visible = false`.

- [ ] **Step 2: Static mount for review**

In `Library3D.svelte`: `$: identities = books.map(buildIdentity)`; on init and whenever identities' id-list changes, build rigs and place statically: `rig.root.position.set(i * 1.18 − mid, SHELF_TOP + h/2, 0.2)`. No motion yet. Dispose replaced rigs.

- [ ] **Step 3: Manual verification (CHECKPOINT — user approves the book craft)**

`npm run tauri dev` → Up Next. Expected: real queue rendered as clothbound hardcovers — visible boards with sharp silhouettes, flat spine with rotated title, foil glinting under the rake light, page-edge lines, headbands, ribbon, contact shadows. Orbit not available yet; judge from the fixed camera. Zero console errors; `npm run check` clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/bookshelf/three/bookRig.ts src/lib/components/bookshelf/Library3D.svelte
git commit -m "feat(shelf): full book rig — boards, spine, page block, foil layers, furniture"
```

---

### Task 8: Carousel behavior + HUD + selection theming

**Files:**
- Create: `src/lib/components/bookshelf/three/carousel.ts`
- Modify: `src/lib/components/bookshelf/three/theme.ts` (scene-side `createThemeDriver`)
- Modify: `src/lib/components/bookshelf/Library3D.svelte` (inputs + HUD overlay)

**Interfaces:**
- Consumes: `carouselMath` (Task 2), `RigHandle` (Task 7), `Experience` (Task 5), `blendPaletteWithMode`/`easeSceneColor` (Task 4), `Room.themeTargets`, `LightRig`.
- Produces:

```ts
// carousel.ts
export interface Carousel {
	readonly selectedIndex: number;
	readonly position: number;
	setRigs(rigs: RigHandle[]): void;
	navigate(delta: number): void;                  // buttons/keys — snaps target to integer
	navigateTo(index: number): void;                // markers — shortestDelta route
	nudge(wheelDelta: number): void;                // clamped ±0.72 impulse, 0.14s idle snap
	setHovered(bookId: number | null, pointerNdc: { x: number; y: number }): void;
	update(dt: number, elapsed: number): boolean;   // damps everything; true if still moving
	snapAll(): void;                                // reduced-motion / post-transition sync
	onSelectionChange(cb: (index: number) => void): void;
}
export function createCarousel(shelfStage: THREE.Group, opts: { shelfTop: number; reducedMotion: () => boolean }): Carousel;

// theme.ts addition
export function createThemeDriver(targets: { room: Room; lights: LightRig; scene: THREE.Scene }): {
	setPalette(p: BookPalette, dark: boolean): void;  // sets targets
	update(dt: number): boolean;                       // eases, true while moving
};
```

- [ ] **Step 1: Implement carousel update (reference recipe §4.2)**

Per `update`: damp `position → targetPosition` (λ 9.5; snap < 0.0005); wheel-idle countdown then `targetPosition = Math.round(...)` (clamped via `clampTarget`); `selectedIndex = mod(Math.round(position), count)` (wrap) with `onSelectionChange` fire; per rig — `wrapOffset`, `shelfPose`, damp each channel λ 12, seam detection (`|offset − lastOffset| > count/2` → snap x + opacity 0), `setOpacity`, hover: `frontPivot.rotation.y` damped to −0.085 when hovered else 0, motion bob `sin(elapsed·0.72 + i·0.8)·0.012·focus`, hover lift +0.035 and pointer tilt ±0.035. Returns whether any damp is unsettled (drives on-demand loop).

- [ ] **Step 2: Wire inputs + HUD in `Library3D.svelte`**

Canvas listeners: `wheel` (preventDefault, dominant axis → `nudge`), `pointermove` → raycast `hit` targets → `setHovered` + `dispatch('bookHover', book)`, `click` → hit book: if `index === selectedIndex` → (Task 9 opens inspect; until then no-op) else `navigateTo(index)`; keyboard on wrapper (`tabindex=0`): ←/→ `navigate(∓1)`, Home/End first/last (non-wrap semantics: `navigateTo(0 | count−1)`), Enter/Space reserved for inspect (Task 9).

HUD overlay (absolute, pointer-events per element, app tokens `var(--gw-*)`): bottom-center block with selected title (serif, ~20px), author line, "n of N" + rating stars when set; prev/next round buttons; "Inspect" text button (disabled until Task 9); marker strip `role="tablist"`, one `button[role=tab]` per book (`aria-selected`, `aria-label` "Select book n: title"), horizontally scrollable when > 14 markers. `aria-live="polite"` visually-hidden region announcing "Title, n of N" on selection change.

Theme: `onSelectionChange` → `themeDriver.setPalette(identities[i].palette, isDarkMode())`; dark-mode observer re-calls with current palette. `update(dt)` chained into the experience frame callback: `carousel.update(...) || themeDriver.update(...)` (bitwise-or of booleans via `|` is fine — both must run; use `const a = carousel.update(...); const b = themeDriver.update(...); return a || b`).

- [ ] **Step 3: Manual verification (CHECKPOINT — user approves browsing feel)**

`npm run tauri dev`: wheel scrolls with inertia and integer snap; arrows/buttons/markers navigate (markers take the short way around the seam); focused book lifts/scales/comes forward, neighbors arc away; far books fade; seam wrap shows no teleport; hover cracks the cover and tilts toward pointer; scene re-tints per selected book in both app modes; queue of 3 books clamps (no wrap, ends stop); idle → 0 fps.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/bookshelf/three/carousel.ts src/lib/components/bookshelf/three/theme.ts src/lib/components/bookshelf/Library3D.svelte
git commit -m "feat(shelf): continuous carousel with inputs, HUD, and per-book scene theming"
```

---

### Task 9: Inspect open/close

**Files:**
- Create: `src/lib/components/bookshelf/three/inspectMath.ts`
- Create: `src/lib/components/bookshelf/three/inspect.ts`
- Modify: `src/lib/components/bookshelf/Library3D.svelte`
- Modify: `src/routes/up-next/+page.svelte` (sidebar becomes absolute overlay)
- Test: `src/lib/components/bookshelf/three/inspectMath.test.ts`

**Interfaces:**
- Consumes: mode machine (Task 1), `smootherstep` (Task 2), `Experience.setViewOffsetX`, `Carousel.snapAll`, `RigHandle`.
- Produces:

```ts
// inspectMath.ts (PURE — three math classes only, no WebGL)
export interface PoseTargets { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }
export function capturePose(object: THREE.Object3D): Pose;              // world-decomposed
export function lerpPose(a: Pose, b: Pose, t: number, out: PoseTargets): void; // t already eased
export function inspectScale(bookWidth: number, safeWidthPx: number, viewportWidthPx: number): number;
// scale so book ≈ 72% of safe width (§4.3): (safeWidth/viewport) * 0.72 * (frustumWidthAtBook / bookWidth)

// inspect.ts
export interface InspectController {
	open(rig: RigHandle, origin: HTMLElement | null): void;   // shelf→opening
	close(): void;                                            // inspect→closing
	update(dt: number): boolean;                              // advances transitions, true while active
	resetView(): void;
	readonly activeRig: RigHandle | null;
}
export function createInspect(deps: { experience: Experience; carousel: Carousel; machine: ModeMachine; controls: OrbitControls; sidebarWidthPx: () => number; reducedMotion: () => boolean; announce: (msg: string) => void }): InspectController;
```

- [ ] **Step 1: Write failing endpoint-determinism tests**

```ts
// three/inspectMath.test.ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { capturePose, lerpPose } from './inspectMath';
import { smootherstep } from './carouselMath';

describe('deterministic transitions (§4.3)', () => {
	const obj = new THREE.Object3D();
	obj.position.set(1.3, 0.9, 0.4); obj.rotation.set(0, -0.3, 0.05); obj.scale.setScalar(1.09);
	obj.updateMatrixWorld(true);
	const start = capturePose(obj);
	const end = { position: [0, 1.45, 0] as [number,number,number], quaternion: [0, 0, 0, 1] as [number,number,number,number], scale: 1.6 };
	const out = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3() };

	it('t=0 equals captured start exactly', () => {
		lerpPose(start, end, smootherstep(0), out);
		expect(out.position.x).toBeCloseTo(1.3, 12);
		expect(out.scale.x).toBeCloseTo(1.09, 12);
	});
	it('t=1 equals end exactly', () => {
		lerpPose(start, end, smootherstep(1), out);
		expect(out.position.y).toBeCloseTo(1.45, 12);
		expect(out.quaternion.w).toBeCloseTo(1, 12);
		expect(out.scale.x).toBeCloseTo(1.6, 12);
	});
	it('midpoints are monotone in t for position', () => {
		lerpPose(start, end, 0.25, out); const x25 = out.position.x;
		lerpPose(start, end, 0.75, out); const x75 = out.position.x;
		expect(Math.abs(end.position[0] - x75)).toBeLessThan(Math.abs(end.position[0] - x25));
	});
});
```

- [ ] **Step 2: Verify failure, then implement `inspectMath.ts`**

`capturePose`: `updateWorldMatrix(true,true)` + `matrixWorld.decompose` into scratch vectors → plain-array `Pose`. `lerpPose`: `Vector3.lerpVectors`, `Quaternion.slerpQuaternions`, scalar scale lerp. Run: `npx vitest run` → PASS.

- [ ] **Step 3: Implement `inspect.ts` choreography (reference `openDetail`/`closeDetail`)**

**open:** machine.to('opening') guard; capture rig world pose; reparent `scene.add(rig.root)` restoring captured pose; capture camera pos/target, shelfStage pos, motion pose; targets — book `(0, 1.45, 0)` upright quaternion, scale from `inspectScale`; camera `(0, 1.5, 3.1)` → target `(0, 1.45, 0)`; shelfStage → `(0, −4.2, −3)` (shelf-clear eased on `t/0.68`); view offset 0 → `−sidebarWidth/2`; contact shadow hidden; `announce("Inspecting <title>")`. Transition: `transitionTime += dt/0.9`, eased `smootherstep`, all channels `lerpPose`/lerpVectors from captured → target; at 1 → machine.to('inspect'), enable OrbitControls (damped, minDistance 2.8, maxDistance 7.2, polar 0.24π–0.76π, target = inspect target).
**close:** machine.to('closing'); disable controls; capture current camera/book/shelf/viewOffset as closing starts; carousel `snapAll` non-active rigs; book target = its shelf-slot pose (recompute `shelfPose(0 offset …)` for `selectedIndex` — book returns to the *focused* slot), camera → shelf camera constants, shelf return eased on `(t−0.24)/0.76`, view offset → 0; at 1 → `shelfStage.attach(rig.root)`, snap slot, contact shadow visible, machine.to('shelf'), `announce("<title> returned to the shelf")`, restore focus to origin element.
**Reduced motion:** both paths call the pose applier with `t=1` immediately.

- [ ] **Step 4: Wire UI**

`Library3D.svelte`: click focused book / Enter / Space / "Inspect" button → `inspect.open(rigs[selectedIndex], originEl)` + `dispatch('bookSelected', book)` + `dispatch('selectedBookIdChange', id)`; Escape or click on empty canvas during `inspect` → `inspect.close()` + dispatch `selectedBookIdChange(null)`; external `selectedBookId` prop null-ing (sidebar close button) also triggers close (reactive `$:` guard, only in `inspect` mode). Browse HUD gets `inert` + fade-out CSS class during non-shelf modes; "Reset view" button visible in inspect. `+page.svelte`: `<aside>` becomes `absolute right-0 top-0 bottom-0 w-[22rem] z-10` over the canvas (canvas keeps full width — the view offset does the layout work); keep `BookDetail` + its `on:close`.

- [ ] **Step 5: Manual verification (CHECKPOINT — user approves the inspect feel)**

Single click on focused book: shelf drops away, book flies to inspect pose beside the sidebar with zero first/last-frame jumps; orbit/pan/zoom around the book; cover hover-cracks; Reset view restores; close (button, Escape, empty-canvas click) returns it pixel-exact to its slot; focus returns to the invoking control; announcements fire; reduced-motion jumps instantly; window resize during inspect keeps book centered in remaining width (≥ 900 px).

- [ ] **Step 6: Commit**

```bash
git add src/lib/components/bookshelf/three/inspectMath.ts src/lib/components/bookshelf/three/inspectMath.test.ts src/lib/components/bookshelf/three/inspect.ts src/lib/components/bookshelf/Library3D.svelte src/routes/up-next/+page.svelte
git commit -m "feat(shelf): deterministic inspect open/close with view offset and orbit"
```

---

### Task 10: Cover pipeline — real covers, palettes, lazy hydration

**Files:**
- Create: `src/lib/components/bookshelf/three/coverPipeline.ts`
- Modify: `src/lib/components/bookshelf/Library3D.svelte`

**Interfaces:**
- Consumes: `getCoverImage(bookId): Promise<string | null>` from `$lib/api/commands`; `paletteFromCover`, `makeRealCoverTexture`, `RigHandle.applyRealCover`, `createThemeDriver.setPalette`.
- Produces:

```ts
export interface CoverPipeline {
	hydrate(rigs: RigHandle[], selectedIndex: () => number): void;
	// eager: selected ±4 (§5.3); rest queued nearest-first on requestIdleCallback
	onPalette(cb: (bookId: number, palette: BookPalette) => void): void; // re-theme hook
	dispose(): void; // cancels pending idle work
}
export function createCoverPipeline(quality: 'low' | 'medium' | 'high'): CoverPipeline;
```

- [ ] **Step 1: Implement**

Per book: `getCoverImage(id)` → data URL → `new Image()` decode → (a) `makeRealCoverTexture` → `rig.applyRealCover(tex)`; (b) draw to 32×32 canvas → `getImageData` → `paletteFromCover` → non-null: mutate `identity.palette`, fire `onPalette`. Failures (null cover, decode error, null palette) leave the procedural identity — log `console.debug` only (§7). In-memory caches keyed by book id for both texture-source image and palette; a simple serial idle queue (process one book per idle slice, re-sorted by distance to `selectedIndex()` each pop). Rigs beyond ±30 slots: not queued until selection moves them inside the window (§5.3).

- [ ] **Step 2: Wire + re-theme**

`Library3D.svelte`: after rig build, `pipeline.hydrate(rigs, () => carousel.selectedIndex)`. `onPalette`: if that book is currently selected → `themeDriver.setPalette(newPalette, isDarkMode())` (eases in, §5.2). Queue changes (add/remove from sidebar): diff by id — build only new rigs, dispose removed, keep survivors (no full rebuild, §6); keep `position` anchored on the selected book when it survives, else nearest index.

- [ ] **Step 3: Manual verification (CHECKPOINT)**

Real covers appear on front boards (cloth border visible around the print) within ~1 s for the visible window, later for far books (imperceptible — they're faded/small); scene theme follows real cover colors; books without covers keep the editorial procedural look; removing the inspected book's neighbor from the queue via sidebar does not rebuild the shelf (no flash); cover-less + white-cover books still get sane themes.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/bookshelf/three/coverPipeline.ts src/lib/components/bookshelf/Library3D.svelte
git commit -m "feat(shelf): async real-cover hydration with palette-driven retheming"
```

---

### Task 11: Phase 1 hardening — fallback, cleanup, checklist

**Files:**
- Modify: `src/lib/components/bookshelf/Library3D.svelte` (WebGL fallback)
- Delete: `src/lib/components/bookshelf/three/book.ts`, `bookshelf.ts`, `shelf.ts`, `scroll.ts`, `scene.ts`, `interaction.ts`, `materials.ts`, `types/config.ts` (grid-only parts — keep `textureQuality` type inline in `Library3D.svelte`), `src/routes/dev/textures/+page.svelte`
- Modify: `src/lib/components/bookshelf/three/index.ts` (re-export new modules)

**Interfaces:** none new.

- [ ] **Step 1: WebGL fallback (§4.5, §7)**

`createExperience` throwing, or `webglcontextlost` event → dispose scene, render an HTML fallback inside the wrapper: plain list of queue books (title, author, cover `<img>` via `getCoverImage`) + "Retry 3D" button that re-runs init. `books` emptied during inspect → instant close (reduced-motion path) then the page's existing empty state shows.

- [ ] **Step 2: Delete dead modules; fix imports; `npm run check` + `npx vitest run` clean.**

- [ ] **Step 3: Run the full Phase 1 manual checklist (spec §8 items 1–8) (CHECKPOINT — user signs off Phase 1)**

Also: remount leak check — open Up Next, navigate away, return ×3; `renderer.info.memory` geometries/textures return to baseline.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(shelf): Phase 1 complete — fallback path, legacy grid removal"
```

---

## Phase 2 — Page physics & reading

### Task 12: Open/close cover interaction (openAmount)

**Files:**
- Create: `src/lib/components/bookshelf/three/pageFlex.ts` (openAmount slice)
- Modify: `src/lib/components/bookshelf/three/inspect.ts`, `Library3D.svelte`
- Test: `src/lib/components/bookshelf/three/pageFlex.test.ts`

**Interfaces:**
- Produces:

```ts
// pageFlex.ts (pure slice)
export interface CoverDrag { active: boolean; kind: 'cover-open' | 'cover-close' | null; progress: number }
export function coverOpenAmount(readingOpen: boolean, drag: CoverDrag): number;
// reference getDetailOpenAmount: drag-open → smoothstep(progress); closed → 0;
// drag-close → 1 − smoothstep(progress); open → 1
export function coverAngle(openAmount: number): number; // 0 → −0.0 closed … −(π − 0.22) open
export const HOVER_CRACK = -0.085;

// inspect.ts additions
setReadingOpen(open: boolean): void;   // animates frontPivot + page fan via damp to coverAngle
onCoverPointer(down/move/up): ...      // raycast front cover surface; drag maps px → progress
```

- [ ] **Step 1: Failing tests**

```ts
// pageFlex.test.ts
import { describe, it, expect } from 'vitest';
import { coverOpenAmount, coverAngle } from './pageFlex';

describe('coverOpenAmount', () => {
	it('closed book, no drag → 0; open book → 1', () => {
		expect(coverOpenAmount(false, { active: false, kind: null, progress: 0 })).toBe(0);
		expect(coverOpenAmount(true, { active: false, kind: null, progress: 0 })).toBe(1);
	});
	it('drag-open eases progress; endpoints exact', () => {
		expect(coverOpenAmount(false, { active: true, kind: 'cover-open', progress: 0 })).toBe(0);
		expect(coverOpenAmount(false, { active: true, kind: 'cover-open', progress: 1 })).toBe(1);
	});
	it('drag-close inverts from open', () => {
		expect(coverOpenAmount(true, { active: true, kind: 'cover-close', progress: 1 })).toBe(0);
	});
});
describe('coverAngle', () => {
	it('0 → 0, 1 → open angle, monotone', () => {
		expect(coverAngle(0)).toBe(0);
		expect(coverAngle(1)).toBeCloseTo(-(Math.PI - 0.22), 10);
		expect(coverAngle(0.5)).toBeLessThan(0);
	});
});
```

- [ ] **Step 2: Verify fail → implement pure slice → tests pass.**

- [ ] **Step 3: Wire interactions (inspect mode only, §4.4)**

Cover hover (raycast front cover mesh) → damp `frontPivot.rotation.y` to `HOVER_CRACK`; click on cover OR drag ≥ threshold → `setReadingOpen(true)` (drag maps horizontal px to progress, release past 0.5 commits, else springs back); "Open book" HUD toggle (`aria-pressed`) mirrors; drag-close available from open state on the cover. Announce open/close via live region. Reduced motion: cover snaps.

- [ ] **Step 4: Manual verification (CHECKPOINT)** — hover cracks; click opens smoothly to title-page angle (blank pages for now); drag opens/closes with commit/spring-back; toggle button matches gestures; close-to-shelf settles cover first.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/bookshelf/three/pageFlex.ts src/lib/components/bookshelf/three/pageFlex.test.ts src/lib/components/bookshelf/three/inspect.ts src/lib/components/bookshelf/Library3D.svelte
git commit -m "feat(shelf): cover open/close via click, drag, and HUD toggle"
```

---

### Task 13: Flexible page spring + deformation

**Files:**
- Modify: `src/lib/components/bookshelf/three/pageFlex.ts`
- Modify: `src/lib/components/bookshelf/three/inspect.ts` (per-frame leaf update)
- Test: extend `pageFlex.test.ts`

**Interfaces:**
- Produces:

```ts
export interface FlexState { curve: number; curveVelocity: number; twist: number; twistVelocity: number }
export function stepFlex(s: FlexState, targetCurve: number, targetTwist: number, dt: number): FlexState;
// spring: v += (target−x)·140·dt; v ·= e^(−16·dt); x += v·dt  (both channels)
export function deformSheet(base: Float32Array, out: THREE.BufferAttribute, curve: number, twist: number, direction: 1 | -1): void;
// x-normalized bend: z += sin(u·π)·curve·dir; twist adds v-linear z ramp — reference updateFlexiblePage shape
export function leafTargets(leafIndex: number, currentSpread: number, openAmount: number): { angle: number; z: number };
// turned leaves → −(π − 0.14) · openAmount toward turnedZ; resting leaves → 0 at restZ
```

- [ ] **Step 1: Failing tests**

```ts
describe('stepFlex', () => {
	it('converges to target and stays finite', () => {
		let s = { curve: 0, curveVelocity: 0, twist: 0, twistVelocity: 0 };
		for (let i = 0; i < 600; i++) s = stepFlex(s, 0.4, -0.1, 1 / 120);
		expect(s.curve).toBeCloseTo(0.4, 2);
		expect(s.twist).toBeCloseTo(-0.1, 2);
		expect(Number.isFinite(s.curveVelocity)).toBe(true);
	});
	it('large dt does not explode', () => {
		let s = { curve: 0, curveVelocity: 0, twist: 0, twistVelocity: 0 };
		for (let i = 0; i < 60; i++) s = stepFlex(s, 0.4, 0, 0.05);
		expect(Math.abs(s.curve)).toBeLessThan(2);
	});
});
describe('leafTargets', () => {
	it('leaves before currentSpread are turned, after are resting', () => {
		expect(leafTargets(0, 2, 1).angle).toBeLessThan(-2);
		expect(leafTargets(4, 2, 1).angle).toBe(0);
	});
	it('closed book (openAmount 0) keeps all leaves at rest', () => {
		expect(leafTargets(0, 2, 0).angle).toBe(0);
	});
});
```

- [ ] **Step 2: Verify fail → implement → pass.** `deformSheet` writes `base` positions with z displacement, then `needsUpdate + computeVertexNormals()` caller-side per animated leaf only.

- [ ] **Step 3: Per-frame integration** — in inspect update: for each leaf, damp pivot rotation.y toward `leafTargets(...).angle` (λ 13) and position.z toward target z, `stepFlex` toward drag-derived curve/twist (0 when idle), `deformSheet` only while `|curve|+|twist| > 0.001` or velocities non-zero. Reduced motion: angles snap, flex forced 0.

- [ ] **Step 4: Manual check (CHECKPOINT)** — opening the cover fans the top leaves naturally; no z-fighting between stacked leaves; idle book costs no frames.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/bookshelf/three/pageFlex.ts src/lib/components/bookshelf/three/pageFlex.test.ts src/lib/components/bookshelf/three/inspect.ts
git commit -m "feat(shelf): spring-damped flexible page deformation"
```

---

### Task 14: Page-turn gestures + commit rules

**Files:**
- Modify: `src/lib/components/bookshelf/three/pageFlex.ts` (commit rules), `inspect.ts` (gesture wiring), `Library3D.svelte` (page HUD buttons)
- Test: extend `pageFlex.test.ts`

**Interfaces:**
- Produces:

```ts
export function shouldCommitTurn(progress: number, velocity: number): boolean;
// progress ≥ 0.5, or progress ≥ 0.18 with velocity ≥ 1.6 (flick)
export function nextSpread(current: number, direction: 1 | -1, spreadCount: number): number; // clamped
// inspect.ts: turnPage(direction), onPagePointerDown/Move/Up (raycast pageSurfaces, px→progress,
// active leaf gets curve from drag speed, release → commit or spring back)
```

- [ ] **Step 1: Failing tests**

```ts
describe('shouldCommitTurn (§4.4: committed page never springs back)', () => {
	it('past midpoint commits regardless of velocity', () => {
		expect(shouldCommitTurn(0.51, 0)).toBe(true);
	});
	it('flick commits early', () => {
		expect(shouldCommitTurn(0.2, 2.0)).toBe(true);
		expect(shouldCommitTurn(0.2, 0.5)).toBe(false);
	});
	it('small drags spring back', () => {
		expect(shouldCommitTurn(0.1, 5)).toBe(false);
	});
});
describe('nextSpread', () => {
	it('clamps at both ends', () => {
		expect(nextSpread(0, -1, 4)).toBe(0);
		expect(nextSpread(3, 1, 4)).toBe(3);
		expect(nextSpread(1, 1, 4)).toBe(2);
	});
});
```

- [ ] **Step 2: Verify fail → implement → pass.**

- [ ] **Step 3: Wire gestures + HUD** — pointer capture on page surfaces; drag progress = horizontal px / (bookWidth px on screen); during drag the turning leaf's angle follows progress directly with flex curve from instantaneous velocity; release → `shouldCommitTurn` → animate to committed spread or back (spring). Prev/next page buttons in inspect HUD (`disabled` at ends), live-region announces spread label ("Title page", "About", "Details"). Escape/close settles pages before closing transition (Task 9's close already waits on `readingOpen === false`; extend: auto-run `setReadingOpen(false)` then start closing when settled — max 0.35 s).

- [ ] **Step 4: Manual check (CHECKPOINT — spec §8 items 9–10)** — drag both directions across several spreads; committed pages never spring back; drag cover closed from first page; return to shelf from open and closed states.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/bookshelf/three/pageFlex.ts src/lib/components/bookshelf/three/pageFlex.test.ts src/lib/components/bookshelf/three/inspect.ts src/lib/components/bookshelf/Library3D.svelte
git commit -m "feat(shelf): page-turn gestures with commit/spring-back physics"
```

---

### Task 15: Interior page content + Phase 2 verification

**Files:**
- Create: `src/lib/components/bookshelf/three/textures/pages.ts`
- Modify: `src/lib/components/bookshelf/three/bookRig.ts` (leaf material hookup), `coverPipeline.ts` (page textures generated lazily on first open)

**Interfaces:**
- Consumes: `BookIdentity`, shared paper texture.
- Produces:

```ts
export interface SpreadSet { textures: THREE.CanvasTexture[]; labels: string[]; dispose(): void }
export function makeSpreads(identity: BookIdentity, quality: 'low' | 'medium' | 'high'): SpreadSet;
// [0] title page (title, author, series, publisher/year rule) — always
// [1..] "About" pages from description (serif ~34ch/line, ≤ 26 lines/page, up to 2 pages) — when description
// [last] colophon (ISBN, language, file size, added date) — always
// labels drive live-region announcements ("Title page", "About (1 of 2)", "Details")
export function applySpreads(rig: RigHandle, set: SpreadSet): void; // maps textures onto leaf front/back materials, blanks beyond
```

- [ ] **Step 1: Implement painters** — cream paper ground (shared grain), ink `#211b16` blended toward palette cloth 0.38 for headings (reference interior style); title page centered with foil-tone rule; body pages left-aligned with drawWrappedText helper (word-wrap, no mid-word breaks, ellipsis past capacity); colophon as small-caps label/value rows from the identity + `Book` fields passed through (extend `BookIdentity` with `publisher`, `publishDate`, `isbn`, `language`, `fileSize`, `dateAdded` — update `buildIdentity` and its test in the same commit).

- [ ] **Step 2: Lazy generation** — `coverPipeline` (or inspect open hook) builds `SpreadSet` on first `setReadingOpen(true)` per book, caches by id, disposes with rig.

- [ ] **Step 3: Manual check** — real description text typeset on pages; no-description books show title + colophon only; text never clipped mid-word.

- [ ] **Step 4: Run full Phase 2 checklist (spec §8 items 9–11) + full Phase 1 regression (items 1–8) (CHECKPOINT — user signs off Phase 2)**

`npx vitest run` + `npm run check` clean; zero console errors through a full browse → inspect → read → close → browse loop.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/bookshelf/three/textures/pages.ts src/lib/components/bookshelf/three/bookRig.ts src/lib/components/bookshelf/three/coverPipeline.ts src/lib/components/bookshelf/three/bookIdentity.ts src/lib/components/bookshelf/three/bookIdentity.test.ts
git commit -m "feat(shelf): generated interior pages — title, about, colophon"
```

---

## Self-review notes (already applied)

- **Spec coverage:** §4.1 → Tasks 5/8; §4.2 → Tasks 2/7/8; §4.3 → Task 9; §4.4 → Tasks 12–15; §4.5 → Tasks 1/5/9/11; §5.1 → Task 7; §5.2 → Tasks 3/4/6/10; §5.3 → Task 10; §6 → file structure + Task 11 cleanup; §7 → Tasks 10/11; §8 → distributed + Tasks 11/15; §9 → task ordering; §10.3 → Task 5 Step 4.
- **Naming consistency:** `RigHandle`, `BookIdentity`, `BookPalette`, `ScenePalette`, `shelfPose`, `wrapOffset`, `shortestDelta`, `damp`, `smootherstep`, `coverOpenAmount`, `stepFlex`, `shouldCommitTurn` are the canonical names; later tasks reference them exactly as defined in their producing task.
- **Sequencing:** Tasks 0–4 are parallel-safe (pure modules, disjoint files) if dispatching concurrent subagents; Tasks 5→11 are sequential (each builds on the scene of the previous); Tasks 12→15 are sequential. Checkpoint gates: Tasks 5, 6, 7, 8, 9, 10, 11 (Phase 1 sign-off), 12, 13, 14, 15 (Phase 2 sign-off).
