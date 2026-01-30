export interface LibraryConfig {
	maxBooksPerShelf: number;
	minShelfWidth: number;
	shelfSpacing: number;
	shelfHeight: number;
	shelfDepth: number;
	shelfThickness: number;
	bookGap: number;
	animationSpeed: number;
	textureQuality: 'low' | 'medium' | 'high';
	enableKeyboardNav: boolean;
	enableTooltips: boolean;
}

export const DEFAULT_CONFIG: LibraryConfig = {
	maxBooksPerShelf: 12,
	minShelfWidth: 800,
	shelfSpacing: 2.8,
	shelfHeight: 2.2,
	shelfDepth: 1.2,
	shelfThickness: 0.12,
	bookGap: 0.08,
	animationSpeed: 0.15,
	textureQuality: 'medium',
	enableKeyboardNav: true,
	enableTooltips: true
};

export interface BookDimensions {
	width: number;
	height: number;
	depth: number;
}

export function calculateBookDimensions(pageCount?: number): BookDimensions {
	const minThickness = 0.3;
	const maxThickness = 1.1;
	const pages = pageCount ?? 250;
	const normalizedPages = Math.min(Math.max(pages, 50), 1000);
	const thickness = minThickness + ((normalizedPages - 50) / 950) * (maxThickness - minThickness);

	return {
		width: thickness,
		height: 3.5,
		depth: 1.75
	};
}
