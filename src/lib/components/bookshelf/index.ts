export { default as Library3D } from './Library3D.svelte';
export * from './types/book';
// Final review fix (Important 2): this barrel used to also `export * from
// './three'` — three/index.ts's own barrel, which re-exports experience.ts
// (a top-level `import * as THREE from 'three'`, among other three.js-
// touching modules). Since a barrel re-export is a static import under the
// hood, that one line pulled the entire three.js runtime into whatever chunk
// bundles THIS file — statically, at module-graph-build time — regardless of
// whether anything actually imported a three/-scoped name through it.
// Library3D.svelte otherwise keeps every three.js-touching module behind a
// single `await Promise.all([import('three'), ...])` inside its own
// initScene() specifically so the /up-next route's initial chunk stays free
// of three.js until a book shelf actually mounts client-side — that dynamic-
// import boundary was being silently defeated one level up, at the component
// barrel, before Library3D.svelte's own guard ever ran. Nothing outside this
// directory needs the three/ barrel's exports: every consumer (grepped
// across src/routes) imports either `Library3D` (this barrel) or reaches
// directly into `./three/<module>` / `./types/experience` for a specific
// type or dynamic import of its own — see up-next/+page.svelte, dev/shelf/
// +page.svelte, dev/textures/+page.svelte.
