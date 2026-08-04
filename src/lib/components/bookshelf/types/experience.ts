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
	// Task 15 (§4.4): passed straight through from the app `Book` type — consumed
	// by textures/pages.ts's title page (publisher/year rule) and colophon
	// (ISBN, language, file size, added date). Not used anywhere pre-Task-15.
	publisher: string | null;
	publishDate: string | null;
	isbn: string | null;
	language: string | null;
	fileSize: number;
	dateAdded: number;
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
