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
