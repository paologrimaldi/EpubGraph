// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	// Tauri global window object
	interface Window {
		__TAURI__?: {
			shell?: {
				open: (path: string) => Promise<void>;
			};
		};
	}
}

export {};
