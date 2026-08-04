# Up Next 3D Shelf — Design Spec

**Date:** 2026-08-03
**Status:** Draft for review — spec only, no implementation yet
**Quality bar:** [mengto/complete-shelf](https://github.com/mengto/complete-shelf) ("The Complete Shelf" — warm editorial Three.js library)

---

## 1. Purpose

Replace the current Up Next 3D view (flat `BoxGeometry` books on a static multi-row
shelf grid) with a premium single-row **continuous carousel shelf** where the user
browses their reading queue one centered book at a time and pulls the selected book
out for inspection. The interaction question the view answers is *"what do I read
next?"* — a queue with one focused candidate — which maps exactly to the reference's
center-selected carousel, not to a wall of shelves.

The reference implementation was analyzed in full (5,931-line single-file Three.js
app). This spec adapts its craft — book anatomy, physically based materials, studio
lighting, deterministic transitions — to EpubGraph's real data (SQLite-backed queue,
real cover images, live metadata) inside the existing Svelte 4 + Tauri app.

### Non-goals

- No changes to the Up Next queue data model, Rust commands, or `upnext.ts` store.
- No EPUB content rendering inside the 3D book (pages show generated content only).
- No changes to other views (library grid, graph, discover).
- Mobile/touch layouts beyond basic pointer support (Tauri desktop app).

---

## 2. Current state (what gets replaced)

| Area | Today | Problem |
|---|---|---|
| Book model | Single `BoxGeometry` with 6 canvas-texture materials (`three/book.ts`) | Reads as a painted brick; no boards, spine, or page block |
| Layout | Static grid, up to 8 books/shelf across N rows (`three/bookshelf.ts`) | No focus; camera zooms out to fit everything; small books |
| Selection | Book slides forward +2.5 z and yaws 0.6 rad (`three/interaction.ts`) | No camera choreography, no transition into a real inspect pose |
| Materials | `MeshStandardMaterial`, procedural "leather + gold" canvas art | Generic; ignores real cover art palette; no PBR response |
| Lighting | Ambient 0.75 + 2 directionals + hemisphere (`three/scene.ts`) | Flat; no environment map, no rim/rake lights, washed shadows |
| Scroll | Vertical/horizontal pan of the whole grid (`three/scroll.ts`) | Replaced by carousel position |

Kept as-is: the route shell (`src/routes/up-next/+page.svelte` header/empty/loading
states), the `BookDetail.svelte` sidebar and its `context="upnext"` actions, the
`upNextBooksWithWant` store, cover loading via `getCoverImage(bookId)` (base64 data
URL from Tauri), and dark-mode detection via the `dark` class MutationObserver.

---

## 3. Approaches considered

1. **Incremental upgrade of the grid** — better materials/lighting on the existing
   multi-shelf layout. Rejected: the reference's quality comes as much from focus
   choreography (one centered book, arcing neighbors, camera language) as from
   materials; a prettier wall still reads as a wall.
2. **Continuous carousel shelf + inspect mode (chosen)** — port the reference's
   scene architecture (carousel, book rig, inspect transition) and bind it to real
   queue data. Highest fidelity to the quality bar; the queue semantics fit it.
3. **Port the reference verbatim as an embedded page** — fastest, but its fixed
   7-book dataset, full-window layout, own HTML panel, and single-file structure
   fight the app shell, the variable queue size, and the existing `BookDetail`
   sidebar. Rejected.

---

## 4. Experience design

### 4.1 Scene & art direction

A warm editorial studio replacing the current flat wall:

- **Room:** paper-toned floor plane and backdrop, single walnut shelf board with a
  darker lip, back rail, and a soft baked contact-shadow strip under the books.
  Optional dust motes (~110 points, disabled under reduced motion).
- **Renderer:** `ACESFilmicToneMapping` at exposure ≈ 0.9, `SRGBColorSpace`,
  PMREM `RoomEnvironment` at intensity ≈ 0.7, `FogExp2` matched to backdrop color,
  PCF soft shadow map, DPR capped at 2 (1.5 below 820 px container width).
- **Lighting rig** (ported from reference, intensities re-tuned to our scene scale):
  warm hemisphere; one shadow-casting warm key `DirectionalLight`; cool directional
  fill; and four `RectAreaLight`s — cloth softbox, foil rake (makes foil glint),
  spine rake, page-edge rake. `RectAreaLightUniformsLib.init()` required.
- **Theming:** each book carries a palette (see §5.2). When selection changes, the
  floor, backdrop, fog, and light tints ease toward the selected book's palette
  (damped color lerp, ~700 ms feel). Palettes are blended toward the app's light or
  dark mode so the scene never fights the surrounding chrome: in dark mode
  backdrop/floor colors are darkened and desaturated toward the app background
  (`0x1a1a2e` family), in light mode toward warm paper. The existing dark-mode
  MutationObserver drives a re-blend, not a scene rebuild.

### 4.2 Shelf browsing (mode: `shelf`)

- Books stand spine-out-ish in a single row on the walnut shelf, laid out by a
  continuous scalar `position`; book *i* sits at `offset = i − position` (wrapped
  modulo N when N ≥ 5 for an endless shelf; small queues of 1–4 books use a clamped,
  non-wrapping row). Per-offset pose, exactly per the reference recipe:
  - `x = offset × spacing`, spacing ≈ 1.18 world units
  - `y = shelfTop + height/2 + focus × 0.15` (focused book lifts slightly)
  - `z = 0.13 + focus × 0.24 − min(|offset|, 2.8) × 0.07` (center comes forward)
  - `rotation.y = −offset × 0.105`, `rotation.z = −offset × 0.018` (gentle arc)
  - `scale = 1 + focus × 0.09`, where `focus = 1 − clamp(|offset|, 0, 1)`
  - Material opacity fades out over `|offset| ∈ [2.55, 3.25]`; hit targets disable
    below 0.12 opacity; wrap-seam jumps snap position and re-fade in (no visible
    teleport).
- All pose changes use frame-rate-independent exponential damping
  (`damp(current, target, λ≈12, dt)`); the scalar `position` damps toward
  `targetPosition` at λ ≈ 9.5 and snaps to the nearest integer after 140 ms of
  wheel idle. Nearest integer defines `selectedIndex`.
- **Inputs:** wheel (both axes, clamped impulse), ←/→ arrows, Home/End,
  previous/next buttons, and a marker strip (one dot per book, `role="tablist"`,
  scrollable when the queue is long) that navigates by shortest wrapped delta.
  Single **click on a book** = select it if unfocused, open inspect if already
  focused. No drag-to-scroll.
- **Hover (focused or near-focused book):** front cover cracks open −0.085 rad,
  book lifts 0.035, and the whole rig tilts subtly toward the pointer
  (±0.035 rad from pointer NDC). Cursor becomes pointer. Suppressed under reduced
  motion.
- **Idle life:** focused book bobs `sin(t × 0.72) × 0.012 × focus`.
- **HUD (HTML overlay, styled with existing app tokens):** selected title, author,
  series + index, queue position ("4 of 12"), rating stars if set; previous/next
  round buttons; an "Inspect" text button; the marker strip. Replaces the current
  floating tooltip entirely.

### 4.3 Inspect (modes: `opening` → `inspect` → `closing`)

The current behavior (book yaws in place, sidebar pops in) is replaced by the
reference's deterministic transition:

- **Opening:** capture the book's exact world transform (`matrixWorld.decompose`),
  reparent it from the shelf stage to the scene, then interpolate book pose, camera
  position/target, shelf-stage retreat (drops down/back out of frame), and a
  horizontal **view offset** over 0.9 s with `smootherstep`. Endpoints are computed
  once at transition start — first and final frames match exactly, per the
  reference's determinism rule. The `BookDetail` sidebar (22 rem) mounts at
  transition start; the view offset keeps the book centered in the *remaining*
  canvas width (reference's `applyDetailViewOffset` `setViewOffset` technique), so
  the book never hides behind the panel and no canvas resize occurs.
- **Inspect:** book floats front-facing beside the sidebar at a scale fitted to
  ~72% of the safe width. `OrbitControls` enabled (damped, distance 2.8–7.2, polar
  clamp) for orbit/pan/zoom around the book only. Cover hover cracks the board
  open slightly; a "Reset view" affordance restores the canonical pose.
- **Closing** (sidebar close button, Escape, or clicking empty canvas): pages/cover
  settle closed, then book, camera, shelf stage, and view offset interpolate back
  to exact shelf-slot endpoints; on completion the book reparents into the shelf
  stage and other rigs snap-sync to their slots. Selection stays on that book.
- Only one book inspects at a time; navigation inputs are inert during
  `opening`/`closing`/`inspect` (markers/prev/next disabled state).

### 4.4 Page turning — Phase 2 (committed scope)

Full reference-style reading ships as the second milestone of the same effort.
Phase 1 books already *have* the closed page block, edges, endpapers, flexible-leaf
geometry, and hover cover-crack — Phase 2 adds behavior, not geometry rework:

- **Opening the book (inspect mode only):** cover hover cracks the front board;
  click on the cover, or drag it, opens to the title page. `openAmount` is a single
  scalar driving cover pivot angle and page fan (reference's `getDetailOpenAmount`
  pattern: drag progress while dragging, 0/1 when settled).
- **Page drag:** pointer-drag on a page turns it; the active leaf's segmented
  planes bend and twist via spring-damped `curve`/`twist` values with velocity
  (reference's `updateFlexiblePage`), settling with a cloth-like curve. Release
  past the commit threshold (or with enough velocity) commits the turn; a
  committed page must not spring back. Drags work in both directions.
- **Closing:** from the first page, dragging the cover closed reverses
  `openAmount`; the sidebar's close action and Escape settle pages closed before
  the closing transition runs (§4.3). Page state (`currentSpread`, open flag)
  resets when returning to the shelf.
- **Controls & a11y:** Open book / prev page / next page buttons in the inspect
  HUD mirror every gesture (`aria-pressed` on the open toggle, disabled states at
  ends, live-region announcements per spread). Reduced motion: pages jump between
  spreads with no flex animation.
- **Content is generated, not EPUB-rendered:** title page (title, author, series,
  publisher, year), an "About" spread typeset from `book.description`, and a
  colophon-style metadata page (ISBN, language, file size, added date). Books with
  no description show the colophon spread only.

### 4.5 States, accessibility, degradation

- Existing loading and empty states in `+page.svelte` are unchanged. A 1-book queue
  renders the single book centered with markers hidden.
- **Interaction state machine:** `shelf → opening → inspect → closing → shelf`.
  All input handlers check mode first; transitions are time-based
  (`transitionTime += dt / duration`), never open-ended lerps.
- **Reduced motion** (`prefers-reduced-motion`): damping factors become effectively
  instant, transitions jump to their end pose via the same endpoint math, idle
  bob/hover tilt/dust disabled. State machine identical.
- **Keyboard:** arrows navigate, Enter/Space inspects, Escape closes, Tab reaches
  all HUD controls; focus returns to the invoking control after closing (reference's
  `focusReturnTarget` pattern). An `aria-live="polite"` region announces selection
  ("*Project Hail Mary*, 4 of 12") and inspect open/close.
- **Rendering is on-demand:** render frames only while damping targets are unsettled,
  a transition or theme lerp is active, or controls emit change — the reference's
  `requestFrame` pattern. An idle scene draws zero frames (matters for a
  battery-powered Tauri app; the current code renders every frame forever).
- **WebGL loss:** `webglcontextlost` → dispose and show a styled fallback list of
  the queue (titles/covers as plain HTML) with a retry button.

---

## 5. Book construction

### 5.1 Book rig (per book, ported anatomy)

A `root` group (shelf slot pose) containing a `motion` group (idle/hover offsets),
holding — exactly as the reference builds it, dimensions scaled to our world:

- **Boards:** front and back covers as `RoundedBoxGeometry` (board ≈ 0.032 thick,
  corner radius ≈ 0.0045 — sharp, not pill-shaped), each hung on a **pivot group at
  the spine edge** so covers can crack/open. Hinge groove strips and cloth turn-ins
  on the inner faces.
- **Spine:** separate flat spine board (`RoundedBoxGeometry`, ≈ 0.014 thick) plus a
  spine art layer and a metallic foil layer plane.
- **Cover art layering:** each visible board face carries an inset rounded-plane
  art layer plus a separate **foil plane** (`polygonOffset`, `depthWrite: false`)
  whose alpha map is the foil artwork and whose bump map is an emboss derived from
  the same texture. Back-cover art is oriented so text is never mirrored.
- **Page block:** rounded box with subtle gutter compression, plus fore-edge and
  head/tail edge planes textured with fine page lines, headband cylinders at head
  and tail, thin page-signature boxes on the fore edge, ribbon bookmark (position
  jittered by seed), and endpapers.
- **Flexible leaves:** 6 pivot groups each holding front/back `PlaneGeometry`
  sheets segmented for bending (present and closed in Phase 1; animated in
  Phase 2).
- **Hit target:** invisible oversized box (≈ 1.34× width, 1.2× height) for reliable
  single-click raycasts.
- **Contact shadow:** per-book radial-gradient alpha plane under the book, hidden
  while that book is inspected.
- Per-book size variation: height 1.46–1.58, width 0.92–1.10, depth 0.22–0.30
  world units, derived deterministically from a seed (below) so the shelf line has
  the reference's organic rhythm.

Everything above uses `MeshPhysicalMaterial`: cloth (normal + roughness + bump maps
from procedural weave, sheen tinted by accent color), cover/spine/back art (cloth
maps under the art), foil (metalness ≈ 0.9, low roughness, clearcoat, emboss bump),
paper (high roughness, faint sheen). All rig materials are `transparent: true` and
registered in a `fadeMaterials` list so carousel distance-fade can drive one opacity
value per rig.

### 5.2 Real data → book identity

This is the main departure from the reference (which hand-authors 7 books).
Each `Book` from `upNextBooksWithWant` is mapped to a **BookIdentity**:

- **Seed:** stable hash of `book.id` — drives size variation, ribbon jitter,
  texture noise. Deterministic across sessions.
- **Cover art:** `getCoverImage(book.id)` (base64 data URL, loaded async).
  - *With cover:* the front-board art layer displays the real cover image inset on
    the cloth board (the board's cloth border stays visible around it ≈ 3% —
    reads as a tipped-on printed cover on a clothbound book). No foil plane on the
    front when a real cover is shown.
  - *Palette extraction:* downsample the cover to a ≤ 32 px canvas and quantize
    (coarse HSL histogram — no new deps) to one dominant and one accent color;
    derive `{ cloth, foil, paper, wall, ink }`
    palette from them (accent doubles as foil/ribbon/headband tint and scene theme).
    Cache in-memory per book id. This is what makes the scene "theme to the
    selected book" with real libraries.
  - *Without cover (or while loading):* fully procedural identity in the
    reference's style — cloth color from a curated 10-color editorial ramp indexed
    by seed, title/author typeset on the front board in the serif stack with a
    foil motif (one of ~6 abstract motifs chosen by seed), replacing today's
    "leather + gold border" canvas.
- **Spine:** always procedural (real spines aren't available): cloth ground,
  rotated title in serif caps, author surname, series index numeral if present,
  foil rule accents. Text truncation with ellipsis beyond ~40 chars.
- **Back board:** procedural cloth + a short blurb block typeset from
  `book.description` (clamped ~6 lines) — visible when orbiting in inspect.
- Cover textures arriving after rig build swap the art layer's map in place
  (`needsUpdate`), matching today's async fallback behavior; the palette re-theme
  eases in when the swap happens for the selected book.

### 5.3 Texture budget

Per-rig canvas texture set (~13 canvases in the reference) is generated:

- **Eagerly** for the initial visible window (selected ± 4 books).
- **Lazily** (idle-callback queue, nearest-first) for the rest; un-hydrated books
  render with shared cloth material + tinted color until their textures arrive
  (they're ≥ 2.5 offsets away, i.e., faded/small, so the pop-in is invisible).
- Shared across rigs: paper face, page-edge, contact shadow, weave normal/roughness
  (tint via material `color`, not per-book canvases) — per-book canvases are only
  cover/spine/back art, foil, motif emboss, endpaper.
- Canvas sizes: art layers 512–1024 px on the long edge (existing
  `textureQuality` config maps to this), utility maps ≤ 256 px.
- Hard cap assumption: queues up to ~60 books stay smooth; beyond that the marker
  strip paginates and rigs beyond ±30 slots aren't instantiated until scrolled
  toward. (Queue sizes in practice: tens.)

---

## 6. Architecture & module plan

Replaces the internals of `src/lib/components/bookshelf/`; the load-bearing surface
of `Library3D.svelte` (props `books`, `selectedBookId`; events `bookSelected`,
`selectedBookIdChange`, `bookHover`) is preserved so `+page.svelte` changes stay
minimal (new HUD slots, removed tooltip). Grid-specific props are dropped (§10.3).

```
bookshelf/
  Library3D.svelte        // canvas host, HUD overlay, lifecycle, mode → UI state
  three/
    experience.ts         // renderer/scene/camera/PMREM/fog/resize/on-demand frame loop
    lights.ts             // hemisphere, key, fill, rect-area rig + theme tint targets
    room.ts               // floor, backdrop, walnut shelf, rails, contact strip, dust
    carousel.ts           // position/targetPosition, wrap math, per-offset pose, fades
    bookRig.ts            // createBookRig(identity) → rig object; dispose
    bookIdentity.ts       // Book → BookIdentity (seed, palette, cover/procedural plan)
    textures/
      cloth.ts, paper.ts, coverArt.ts, spineArt.ts, backArt.ts, motifs.ts, edges.ts
    inspect.ts            // opening/closing endpoint capture, pose lerps, view offset
    theme.ts              // palette ↔ app-mode blending, damped scene color lerp
    interaction.ts        // pointer/raycast/hover/click + keyboard, mode-aware
    state.ts              // mode machine + shared mutable state, reduced-motion flag
  types/                  // BookIdentity, RigHandle, config (extends existing)
```

- Svelte 4 component conventions as today (dynamic `import('three')` client-only,
  `createEventDispatcher`, ResizeObserver, dark-mode MutationObserver).
- Three r182 (already in `package.json`); needs `RoundedBoxGeometry`,
  `RoomEnvironment`, `RectAreaLightUniformsLib`, `OrbitControls` from
  `three/examples/jsm` (all present in the installed package, no new deps).
- **Queue changes while open:** additions/removals via `BookDetail` actions re-run
  identity mapping keyed by book id; existing rigs are kept (no full rebuild —
  today's tear-down-everything rebuild goes away), removed rigs dispose and the
  carousel re-indexes, keeping `position` anchored on the currently selected book
  when it survives, else nearest neighbor.
- **Disposal discipline:** every rig tracks its geometries/materials/textures;
  route unmount disposes all rigs, room, environment target, renderer (pattern
  already in `Library3D.svelte`, extended to the richer rig).

## 7. Error handling

- Cover decode failure → procedural identity fallback (never a blank board);
  logged at debug like today.
- Palette extraction failure → seed-ramp palette.
- WebGL context creation failure or context loss → HTML fallback list (see §4.5).
- `books` prop emptied while inspecting → close instantly (reduced-motion path),
  then show empty state.

## 8. Testing & verification

Unit-testable pure logic (vitest, no WebGL):

- Wrap/offset math: shortest-delta marker navigation, seam handling, clamped
  small-queue mode boundaries.
- `bookIdentity`: determinism per id, palette derivation fallbacks, truncation.
- State machine: legal transitions only; inputs ignored in non-interactive modes;
  reduced-motion path reaches identical end states.
- Endpoint determinism: `applyOpeningPose(0)` equals captured start,
  `applyOpeningPose(1)` equals inspect pose (vector equality within epsilon);
  same for closing.

Manual verification checklist (mirrors the reference's own):

1. Wheel, arrows, buttons, and markers all navigate; selection announcement fires.
2. Single click on focused book opens inspect; first/mid/final transition frames
   show no jump; book sits beside the sidebar at every window width ≥ 900 px.
3. Hover cracks the cover on shelf and in inspect; reduced-motion disables it.
4. Return to shelf from inspect lands pixel-exact in the shelf slot.
5. Dark/light toggle re-themes without rebuild; selected-book theming eases.
6. Queue add/remove from the sidebar updates the shelf without full rebuild.
7. Idle scene renders 0 fps (devtools performance); interaction resumes instantly.
8. Zero console errors/warnings; route unmount leaks no WebGL resources
   (`renderer.info` counts return to baseline on remount).

Phase 2 additions (mirrors the reference's own verification list):

9. Click and drag both open the cover; drag forward and backward through multiple
   spreads; a committed page never springs back.
10. Drag the cover closed from the first page; return to shelf from both a closed
    and an open book — pages settle before the closing transition.
11. HUD buttons reproduce every gesture; spread announcements fire; reduced-motion
    spread jumps are instant.

## 9. Implementation phasing

Both phases are committed scope of this spec and land on the same feature branch;
they are **sequential milestones, not parallel tracks** — Phase 2 animates the rig,
state machine, and inspect mode that Phase 1 builds (same `bookRig.ts`,
`inspect.ts`, `state.ts` files), so concurrent implementation would conflict on
every core module. Parallelism is available *within* a milestone (e.g., texture
modules, room/lights, and carousel math are independent workstreams inside
Phase 1).

- **Phase 1:** scene/room/lights, book rig (closed book, full anatomy including
  flexible-leaf geometry), carousel browsing + HUD, inspect open/close with
  sidebar integration, real covers + palette theming, a11y, reduced motion,
  on-demand rendering, disposal, tests above.
- **Phase 2:** flexible page physics, drag-open/close cover, generated interior
  page content, page navigation controls (§4.4).

## 10. Open questions (defaults chosen; flag if wrong)

1. **Sort/order:** carousel order = `upNextBooksWithWant` order (explicit queue
   first, then want-to-read). Assumed correct since it's the existing order.
2. **Click-away close:** clicking empty canvas in inspect closes it (matches
   sidebar close). Alternative: only explicit close. Default: close.
3. **The old grid config props** (`maxBooksPerShelf`, `minShelfWidth`,
   `shelfSpacing`) become meaningless; they'll be dropped from `Library3D`'s
   public props in the same change (only `up-next/+page.svelte` uses them).
4. **Click on an unfocused book:** spec says click focuses it, and a second click
   inspects (§4.2). The reference instead opens detail on any single click. The
   two-step feels right for a queue picker; switch to one-click-to-inspect if you
   prefer the reference behavior exactly.
