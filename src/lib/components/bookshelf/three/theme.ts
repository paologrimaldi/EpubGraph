import type * as THREE from 'three';
import type { BookPalette, ScenePalette } from '../types/experience';
import type { Room } from './room';
import type { LightRig } from './lights';
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

const THEME_EASE_LAMBDA = 6;
// Contact-shadow strip stays near-black but picks up a whisper of the
// selected book's floor tone rather than reading as a flat, book-agnostic cutout.
const SHADOW_FLOOR_MIX = 0.4;

type SceneColorKey = keyof ScenePalette;
const SCENE_COLOR_KEYS: SceneColorKey[] = ['backdrop', 'floor', 'fog', 'key', 'fill', 'accent', 'shelf'];

/**
 * Scene-side driver: eases `Room`/`LightRig`/fog/contact-shadow colors toward
 * whatever book palette is currently selected. `accent`/`shelf` are carried in
 * the eased `ScenePalette` for forward use but have no `themeTargets` consumer
 * yet (Room only exposes backdrop/floor/shadow — see room.ts) so they're not
 * written anywhere; that's the existing scope boundary, not an oversight here.
 */
export function createThemeDriver(targets: { room: Room; lights: LightRig; scene: THREE.Scene }): {
	setPalette(p: BookPalette, dark: boolean): void;
	update(dt: number): boolean;
} {
	let current: ScenePalette | null = null;
	let target: ScenePalette | null = null;

	function hexOf(material: THREE.Material & { color: THREE.Color }): string {
		return `#${material.color.getHexString()}`;
	}

	/** Seeds `current` from whatever colors are actually painted on the scene right now
	 *  (e.g. the pre-selection placeholder) so the first `setPalette` eases in from there
	 *  instead of popping — there is no separate "instant init" entry point by design.
	 *  `accent`/`shelf` have no scene consumer to read back from (see class doc), so they
	 *  seed from the same neutral defaults the pre-selection placeholder uses. */
	function readCurrentFromScene(): ScenePalette {
		return {
			backdrop: hexOf(targets.room.themeTargets.backdrop),
			floor: hexOf(targets.room.themeTargets.floor),
			fog: targets.scene.fog ? `#${targets.scene.fog.color.getHexString()}` : hexOf(targets.room.themeTargets.backdrop),
			key: `#${targets.lights.key.color.getHexString()}`,
			fill: `#${targets.lights.fill.color.getHexString()}`,
			accent: '#c87046',
			shelf: '#3a2118'
		};
	}

	function applyImmediate(palette: ScenePalette): void {
		targets.room.themeTargets.backdrop.color.set(palette.backdrop);
		targets.room.themeTargets.floor.color.set(palette.floor);
		if (targets.scene.fog) targets.scene.fog.color.set(palette.fog);
		targets.lights.key.color.set(palette.key);
		targets.lights.fill.color.set(palette.fill);
		const shadow = targets.room.themeTargets.shadow as THREE.Material & { color: THREE.Color };
		shadow.color.set(mixHex('#000000', palette.floor, SHADOW_FLOOR_MIX));
	}

	function setPalette(p: BookPalette, dark: boolean): void {
		target = blendPaletteWithMode(p, dark);
		if (!current) current = readCurrentFromScene();
	}

	function update(dt: number): boolean {
		if (!current || !target) return false;
		let unsettled = false;
		const next = { ...current };
		for (const key of SCENE_COLOR_KEYS) {
			const eased = easeSceneColor(current[key], target[key], THEME_EASE_LAMBDA, dt);
			if (eased !== target[key]) unsettled = true;
			next[key] = eased;
		}
		current = next;
		applyImmediate(current);
		return unsettled;
	}

	return { setPalette, update };
}
