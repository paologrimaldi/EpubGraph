/**
 * Theme store with persistence
 */
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

export type Theme = 'light' | 'dark' | 'system';

function getInitialTheme(): Theme {
	if (!browser) return 'system';
	const stored = localStorage.getItem('theme') as Theme | null;
	return stored || 'system';
}

function getSystemTheme(): 'light' | 'dark' {
	if (!browser) return 'light';
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function createThemeStore() {
	const { subscribe, set, update } = writable<Theme>(getInitialTheme());

	return {
		subscribe,
		set: (value: Theme) => {
			if (browser) {
				localStorage.setItem('theme', value);
				applyTheme(value);
			}
			set(value);
		},
		initialize: () => {
			if (!browser) return;
			const theme = getInitialTheme();
			applyTheme(theme);

			// Listen for system theme changes
			window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
				const currentTheme = localStorage.getItem('theme') as Theme | null;
				if (currentTheme === 'system' || !currentTheme) {
					applyTheme('system');
				}
			});
		}
	};
}

function applyTheme(theme: Theme) {
	if (!browser) return;

	const root = document.documentElement;
	const effectiveTheme = theme === 'system' ? getSystemTheme() : theme;

	// Apply dark class for Tailwind
	if (effectiveTheme === 'dark') {
		root.classList.add('dark');
		root.setAttribute('data-theme', 'dark');
	} else {
		root.classList.remove('dark');
		root.setAttribute('data-theme', 'light');
	}
}

export const theme = createThemeStore();

// Derived store for the effective theme (resolved system preference)
export function getEffectiveTheme(t: Theme): 'light' | 'dark' {
	return t === 'system' ? getSystemTheme() : t;
}
