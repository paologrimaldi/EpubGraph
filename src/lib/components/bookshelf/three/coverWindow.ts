import { shortestDelta, shouldWrap } from './carouselMath';

// §5.3 eager/queue window radii — exported so coverPipeline.ts and its tests
// share one source of truth instead of duplicating magic numbers. Split out
// of coverPipeline.ts (rather than inlined there, matching the codebase's
// existing carouselMath.ts/carousel.ts and inspectMath.ts/inspect.ts split)
// specifically so this pure math stays importable from a plain `vitest run`
// — coverPipeline.ts itself pulls in `$lib/api/commands`, which resolves
// `$app/environment` only under the full SvelteKit vite plugin, not the
// bare `vitest.config.ts` this repo's other colocated tests already avoid.
export const EAGER_RADIUS = 4;
export const QUEUE_RADIUS = 30;

/** Wrap-aware slot distance between two carousel indices — same routing carousel.ts uses for navigation. */
export function coverDistance(selectedIndex: number, index: number, count: number): number {
	return Math.abs(shortestDelta(selectedIndex, index, count, shouldWrap(count)));
}

export function clampIndex(index: number, count: number): number {
	if (count <= 0) return 0;
	return Math.min(Math.max(index, 0), count - 1);
}
