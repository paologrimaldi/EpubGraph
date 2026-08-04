import type { BookPalette, ScenePalette } from '../types/experience';
import { mixHex } from './bookIdentity';

const DARK_ANCHOR = '#14141e';   // app dark chrome family
const LIGHT_ANCHOR = '#efe7d8';  // warm paper

// The scene is a dark editorial room regardless of app chrome mode — light app
// mode only pulls gently toward paper (backdrop) and stays dark-biased (floor),
// it never washes out to a light void the way LIGHT_ANCHOR-dominant mixes did.
export function blendPaletteWithMode(p: BookPalette, dark: boolean): ScenePalette {
	const backdrop = dark ? mixHex(p.paper, DARK_ANCHOR, 0.6) : mixHex(p.paper, LIGHT_ANCHOR, 0.15);
	return {
		backdrop,
		fog: backdrop,
		floor: dark ? mixHex(p.floor, DARK_ANCHOR, 0.65) : mixHex(p.floor, DARK_ANCHOR, 0.35),
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
	// snap when no rounding progress is possible (dt-agnostic, works across all refresh rates)
	if (next === current) return target;
	return next;
}
