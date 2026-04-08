<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import type { GraphData, GraphNode, GraphEdge } from '$lib/api/commands';

	export let centerId: number | null = null;
	export let depth: number = 2;
	export let maxNodes: number = 50;
	export let onNodeClick: ((nodeId: number) => void) | null = null;

	let container: HTMLDivElement;
	let sigma: any = null;
	let graph: any = null;
	let loading = true;
	let error: string | null = null;
	let hoveredNode: string | null = null;
	let Graph: any = null;
	let SigmaClass: any = null;
	let loadingCenterId: number | null = null;
	let isDark = false;

	// Obsidian-inspired palette — luminous, muted tones that glow on dark canvas
	const nodeColorsLight = {
		center: '#d94f72',
		rated: '#c08a3e',
		default: '#6366a0'
	};

	const nodeColorsDark = {
		center: '#f0799a',
		rated: '#e8b86d',
		default: '#9b9ed8'
	};

	const edgeColorsLight: Record<string, string> = {
		content: '#6898c4',
		author: '#5aab88',
		series: '#c49a4a',
		tag: '#8a72b8',
		user: '#c46a6a'
	};

	const edgeColorsDark: Record<string, string> = {
		content: '#5b9bd5',
		author: '#6bc5a0',
		series: '#d4a65a',
		tag: '#a78bdb',
		user: '#db7b7b'
	};

	$: nodeColors = isDark ? nodeColorsDark : nodeColorsLight;
	$: edgeColors = isDark ? edgeColorsDark : edgeColorsLight;

	function detectTheme() {
		if (!browser) return;
		isDark =
			document.documentElement.classList.contains('dark') ||
			document.documentElement.getAttribute('data-theme') === 'dark';
	}

	async function loadGraphData() {
		if (!browser || centerId === null) {
			loading = false;
			return;
		}

		loading = true;
		error = null;
		pendingData = null;
		const requestedCenterId = centerId;
		loadingCenterId = requestedCenterId;

		try {
			const { invoke } = await import('@tauri-apps/api/core');
			const data: GraphData = await invoke('get_book_graph', {
				centerId: requestedCenterId,
				depth,
				maxNodes
			});

			if (loadingCenterId !== requestedCenterId) {
				return;
			}

			if (data.nodes.length === 0) {
				error = 'No graph data available for this book. Try rebuilding the book graph in Settings.';
			} else {
				renderGraph(data);
			}
		} catch (e) {
			if (loadingCenterId !== requestedCenterId) {
				return;
			}
			error = e instanceof Error ? e.message : String(e);
			console.error('Failed to load graph:', e);
		} finally {
			if (loadingCenterId === requestedCenterId) {
				loading = false;
			}
		}
	}

	let pendingData: GraphData | null = null;

	function renderGraph(data: GraphData) {
		if (sigma) {
			sigma.kill();
			sigma = null;
		}

		if (data.nodes.length === 0 || !Graph || !SigmaClass) {
			return;
		}

		if (!container) {
			pendingData = data;
			return;
		}

		detectTheme();

		const currentNodeColors = isDark ? nodeColorsDark : nodeColorsLight;
		const currentEdgeColors = isDark ? edgeColorsDark : edgeColorsLight;

		graph = new Graph();

		const nodeCount = data.nodes.length;
		data.nodes.forEach((node, index) => {
			const angle = (2 * Math.PI * index) / nodeCount;
			const radius = node.id === centerId ? 0 : 5 + Math.random() * 5;

			const isCenter = node.id === centerId;
			const color = isCenter
				? currentNodeColors.center
				: node.rating
					? currentNodeColors.rated
					: currentNodeColors.default;

			graph!.addNode(String(node.id), {
				label: truncateTitle(node.title, 30),
				x: radius * Math.cos(angle),
				y: radius * Math.sin(angle),
				size: isCenter ? 18 : 8 + (node.rating || 0) * 1.5,
				color,
				originalData: node
			});
		});

		data.edges.forEach((edge, index) => {
			const sourceStr = String(edge.source);
			const targetStr = String(edge.target);

			if (graph!.hasNode(sourceStr) && graph!.hasNode(targetStr)) {
				graph!.addEdge(sourceStr, targetStr, {
					size: 0.5 + edge.weight * 1.5,
					color: currentEdgeColors[edge.edgeType] || '#94a3b8',
					type: 'arrow',
					label: edge.edgeType,
					weight: edge.weight
				});
			}
		});

		applyForceLayout();

		const labelColor = isDark ? '#c8c8cd' : '#3a3a3c';
		const hoverBg = isDark ? '#1c1c1e' : '#ffffff';
		const hoverShadow = isDark ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.15)';
		const fadedColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';

		// Custom hover renderer — theme-aware background color
		function drawNodeHover(
			context: CanvasRenderingContext2D,
			data: Record<string, any>,
			settings: Record<string, any>
		) {
			const size = settings.labelSize;
			const font = settings.labelFont;
			const weight = settings.labelWeight;
			context.font = `${weight} ${size}px ${font}`;

			context.fillStyle = hoverBg;
			context.shadowOffsetX = 0;
			context.shadowOffsetY = 0;
			context.shadowBlur = 8;
			context.shadowColor = hoverShadow;

			const PADDING = 2;
			if (typeof data.label === 'string') {
				const textWidth = context.measureText(data.label).width;
				const boxWidth = Math.round(textWidth + 5);
				const boxHeight = Math.round(size + 2 * PADDING);
				const radius = Math.max(data.size, size / 2) + PADDING;
				const angleRadian = Math.asin(boxHeight / 2 / radius);
				const xDeltaCoord = Math.sqrt(Math.abs(radius * radius - (boxHeight / 2) * (boxHeight / 2)));

				context.beginPath();
				context.moveTo(data.x + xDeltaCoord, data.y + boxHeight / 2);
				context.lineTo(data.x + radius + boxWidth, data.y + boxHeight / 2);
				context.lineTo(data.x + radius + boxWidth, data.y - boxHeight / 2);
				context.lineTo(data.x + xDeltaCoord, data.y - boxHeight / 2);
				context.arc(data.x, data.y, radius, angleRadian, -angleRadian);
				context.closePath();
				context.fill();
			} else {
				context.beginPath();
				context.arc(data.x, data.y, data.size + PADDING, 0, Math.PI * 2);
				context.closePath();
				context.fill();
			}

			context.shadowBlur = 0;

			// Draw label text
			if (data.label) {
				const color = settings.labelColor.color || labelColor;
				context.fillStyle = color;
				context.font = `${weight} ${size}px ${font}`;
				context.fillText(data.label, data.x + data.size + 3, data.y + size / 3);
			}
		}

		sigma = new SigmaClass(graph, container, {
			renderEdgeLabels: false,
			defaultNodeColor: currentNodeColors.default,
			defaultEdgeColor: '#94a3b8',
			labelFont: "'SF Pro Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
			labelSize: 11,
			labelWeight: '400',
			labelColor: { color: labelColor },
			stagePadding: 60,
			zIndex: true,
			defaultDrawNodeHover: drawNodeHover,
			nodeReducer: (node: string, data: Record<string, any>) => {
				const res = { ...data };
				if (hoveredNode) {
					if (
						node === hoveredNode ||
						graph?.hasEdge(node, hoveredNode) ||
						graph?.hasEdge(hoveredNode, node)
					) {
						res.highlighted = true;
						res.zIndex = 1;
					} else {
						res.color = fadedColor;
						res.label = '';
						res.zIndex = 0;
					}
				}
				return res;
			},
			edgeReducer: (edge: string, data: Record<string, any>) => {
				const res = { ...data };
				if (hoveredNode) {
					const [source, target] = graph!.extremities(edge);
					if (source !== hoveredNode && target !== hoveredNode) {
						res.hidden = true;
					} else {
						res.size = (data.size || 1) * 2;
					}
				}
				return res;
			}
		});

		sigma.on('enterNode', ({ node }: { node: string }) => {
			hoveredNode = node;
			if (container) container.style.cursor = 'pointer';
			sigma?.refresh();
		});

		sigma.on('leaveNode', () => {
			hoveredNode = null;
			if (container) container.style.cursor = 'grab';
			sigma?.refresh();
		});

		sigma.on('clickNode', ({ node }: { node: string }) => {
			const nodeData = graph?.getNodeAttributes(node);
			if (nodeData?.originalData && onNodeClick) {
				onNodeClick(nodeData.originalData.id);
			}
		});
	}

	function hexToRgba(hex: string, alpha: number): string {
		if (hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	}

	function applyForceLayout() {
		if (!graph) return;

		const iterations = 100;
		const k = 1;
		const gravity = 0.1;
		const speed = 0.1;

		for (let iter = 0; iter < iterations; iter++) {
			const forces: Map<string, { x: number; y: number }> = new Map();

			graph.forEachNode((node: string) => {
				forces.set(node, { x: 0, y: 0 });
			});

			graph.forEachNode((nodeA: string) => {
				const posA = {
					x: graph!.getNodeAttribute(nodeA, 'x'),
					y: graph!.getNodeAttribute(nodeA, 'y')
				};

				graph!.forEachNode((nodeB: string) => {
					if (nodeA === nodeB) return;

					const posB = {
						x: graph!.getNodeAttribute(nodeB, 'x'),
						y: graph!.getNodeAttribute(nodeB, 'y')
					};
					const dx = posA.x - posB.x;
					const dy = posA.y - posB.y;
					const distance = Math.sqrt(dx * dx + dy * dy) || 0.1;
					const force = (k * k) / distance;

					const forceA = forces.get(nodeA)!;
					forceA.x += (dx / distance) * force;
					forceA.y += (dy / distance) * force;
				});
			});

			graph.forEachEdge(
				(edge: string, attrs: Record<string, any>, source: string, target: string) => {
					const posA = {
						x: graph!.getNodeAttribute(source, 'x'),
						y: graph!.getNodeAttribute(source, 'y')
					};
					const posB = {
						x: graph!.getNodeAttribute(target, 'x'),
						y: graph!.getNodeAttribute(target, 'y')
					};

					const dx = posB.x - posA.x;
					const dy = posB.y - posA.y;
					const distance = Math.sqrt(dx * dx + dy * dy) || 0.1;
					const force = (distance * distance) / k;

					const forceA = forces.get(source)!;
					const forceB = forces.get(target)!;

					forceA.x += (dx / distance) * force * 0.5;
					forceA.y += (dy / distance) * force * 0.5;
					forceB.x -= (dx / distance) * force * 0.5;
					forceB.y -= (dy / distance) * force * 0.5;
				}
			);

			graph.forEachNode((node: string) => {
				const pos = {
					x: graph!.getNodeAttribute(node, 'x'),
					y: graph!.getNodeAttribute(node, 'y')
				};
				const forceN = forces.get(node)!;
				forceN.x -= pos.x * gravity;
				forceN.y -= pos.y * gravity;
			});

			graph.forEachNode((node: string) => {
				if (node === String(centerId)) return;

				const pos = {
					x: graph!.getNodeAttribute(node, 'x'),
					y: graph!.getNodeAttribute(node, 'y')
				};
				const force = forces.get(node)!;

				const displacement = Math.sqrt(force.x * force.x + force.y * force.y);
				const maxDisplacement = 10;

				if (displacement > 0) {
					const limitedDisp = Math.min(displacement, maxDisplacement);
					graph!.setNodeAttribute(
						node,
						'x',
						pos.x + (force.x / displacement) * limitedDisp * speed
					);
					graph!.setNodeAttribute(
						node,
						'y',
						pos.y + (force.y / displacement) * limitedDisp * speed
					);
				}
			});
		}
	}

	function truncateTitle(title: string, maxLength: number): string {
		if (title.length <= maxLength) return title;
		return title.substring(0, maxLength - 3) + '...';
	}

	function zoomIn() {
		if (sigma) {
			const camera = sigma.getCamera();
			camera.animatedZoom({ duration: 200 });
		}
	}

	function zoomOut() {
		if (sigma) {
			const camera = sigma.getCamera();
			camera.animatedUnzoom({ duration: 200 });
		}
	}

	function resetView() {
		if (sigma) {
			const camera = sigma.getCamera();
			camera.animatedReset({ duration: 300 });
		}
	}

	// Watch for theme changes
	let themeObserver: MutationObserver | null = null;

	onMount(async () => {
		if (!browser) return;

		detectTheme();

		// Observe theme changes on <html>
		themeObserver = new MutationObserver(() => {
			const wasDark = isDark;
			detectTheme();
			if (wasDark !== isDark && graph && centerId !== null) {
				// Re-render with new colors
				const data = extractGraphData();
				if (data) renderGraph(data);
			}
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class', 'data-theme']
		});

		try {
			const [graphologyModule, sigmaModule] = await Promise.all([
				import('graphology'),
				import('sigma')
			]);
			Graph = graphologyModule.default;
			SigmaClass = sigmaModule.default;

			loadGraphData();
		} catch (e) {
			console.error('Failed to load graph libraries:', e);
			error = 'Failed to load graph visualization';
			loading = false;
		}
	});

	function extractGraphData(): GraphData | null {
		if (!graph) return null;
		const nodes: GraphNode[] = [];
		const edges: GraphEdge[] = [];
		graph.forEachNode((node: string, attrs: Record<string, any>) => {
			if (attrs.originalData) nodes.push(attrs.originalData);
		});
		graph.forEachEdge(
			(edge: string, attrs: Record<string, any>, source: string, target: string) => {
				edges.push({
					source: parseInt(source),
					target: parseInt(target),
					weight: attrs.weight || 0,
					edgeType: attrs.label || 'content'
				});
			}
		);
		return { nodes, edges };
	}

	onDestroy(() => {
		if (sigma) {
			sigma.kill();
		}
		if (themeObserver) {
			themeObserver.disconnect();
		}
	});

	$: if (browser && centerId !== null && Graph && SigmaClass && depth && maxNodes) {
		loadGraphData();
	}

	$: if (container && pendingData) {
		const data = pendingData;
		pendingData = null;
		renderGraph(data);
	}
</script>

<div class="graph-canvas" class:is-dark={isDark}>
	<!-- Ambient glow overlay -->
	<div class="graph-ambient"></div>

	{#if loading}
		<div class="graph-state-overlay">
			<div class="graph-state-content">
				<div class="graph-spinner"></div>
				<p class="graph-state-text">Loading graph...</p>
			</div>
		</div>
	{:else if error}
		<div class="graph-state-overlay">
			<div class="graph-state-content">
				<svg class="graph-error-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="1.5"
						d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
					/>
				</svg>
				<p class="graph-state-text" style="color: var(--gw-error)">{error}</p>
			</div>
		</div>
	{:else if centerId === null}
		<div class="graph-state-overlay">
			<div class="graph-state-content">
				<svg class="graph-empty-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="1.5"
						d="M7.5 3.75H6A2.25 2.25 0 003.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0120.25 6v1.5m0 9V18A2.25 2.25 0 0118 20.25h-1.5m-9 0H6A2.25 2.25 0 013.75 18v-1.5M15 12a3 3 0 11-6 0 3 3 0 016 0z"
					/>
				</svg>
				<p class="graph-state-text">Select a book to explore its connections</p>
			</div>
		</div>
	{:else}
		<div bind:this={container} class="graph-renderer"></div>

		<!-- Floating glass controls -->
		<div class="graph-controls">
			<button on:click={zoomIn} class="graph-control-btn" title="Zoom in">
				<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v12m6-6H6" />
				</svg>
			</button>
			<div class="graph-control-divider"></div>
			<button on:click={zoomOut} class="graph-control-btn" title="Zoom out">
				<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 12H6" />
				</svg>
			</button>
			<div class="graph-control-divider"></div>
			<button on:click={resetView} class="graph-control-btn" title="Reset view">
				<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
					/>
				</svg>
			</button>
		</div>

		<!-- Floating glass legend -->
		<div class="graph-legend">
			<p class="graph-legend-title">Connections</p>
			<div class="graph-legend-items">
				<div class="graph-legend-item">
					<span class="graph-legend-line" style="background: {edgeColors.content}"></span>
					<span class="graph-legend-label">Content</span>
				</div>
				<div class="graph-legend-item">
					<span class="graph-legend-line" style="background: {edgeColors.author}"></span>
					<span class="graph-legend-label">Author</span>
				</div>
				<div class="graph-legend-item">
					<span class="graph-legend-line" style="background: {edgeColors.series}"></span>
					<span class="graph-legend-label">Series</span>
				</div>
				<div class="graph-legend-item">
					<span class="graph-legend-line" style="background: {edgeColors.tag}"></span>
					<span class="graph-legend-label">Tags</span>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	/* ---- Canvas ---- */
	.graph-canvas {
		position: relative;
		width: 100%;
		height: 100%;
		border-radius: 12px;
		overflow: hidden;
		background: #e8e8ec;
	}

	.graph-canvas.is-dark {
		background: #0d0d0f;
	}

	/* Subtle radial ambient glow — gives depth like Obsidian */
	.graph-ambient {
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 1;
		background: radial-gradient(
			ellipse 60% 50% at 50% 50%,
			rgba(99, 102, 241, 0.03) 0%,
			transparent 70%
		);
	}

	.graph-canvas.is-dark .graph-ambient {
		background: radial-gradient(
			ellipse 60% 50% at 50% 50%,
			rgba(139, 143, 216, 0.04) 0%,
			transparent 70%
		);
	}

	/* ---- Sigma renderer container ---- */
	.graph-renderer {
		width: 100%;
		height: 100%;
		cursor: grab;
	}

	.graph-renderer:active {
		cursor: grabbing;
	}

	/* ---- State overlays ---- */
	.graph-state-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 2;
	}

	.graph-state-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
	}

	.graph-state-text {
		font-size: 13px;
		color: var(--gw-fg-muted);
		letter-spacing: -0.01em;
	}

	.graph-spinner {
		width: 28px;
		height: 28px;
		border: 2px solid var(--gw-separator);
		border-top-color: var(--gw-accent);
		border-radius: 50%;
		animation: graph-spin 0.8s linear infinite;
	}

	@keyframes graph-spin {
		to {
			transform: rotate(360deg);
		}
	}

	.graph-error-icon {
		width: 28px;
		height: 28px;
		color: var(--gw-error);
		opacity: 0.7;
	}

	.graph-empty-icon {
		width: 28px;
		height: 28px;
		color: var(--gw-fg-muted);
		opacity: 0.5;
	}

	/* ---- Glass controls ---- */
	.graph-controls {
		position: absolute;
		top: 16px;
		right: 16px;
		z-index: 10;
		display: flex;
		flex-direction: column;
		align-items: center;
		background: var(--gw-surface);
		backdrop-filter: blur(var(--gw-blur)) saturate(180%);
		-webkit-backdrop-filter: blur(var(--gw-blur)) saturate(180%);
		border: 0.5px solid var(--gw-border);
		border-radius: 10px;
		box-shadow: var(--gw-shadow-glass);
		overflow: hidden;
	}

	.graph-control-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		color: var(--gw-fg-secondary);
		transition: background 0.12s ease, color 0.12s ease;
		cursor: pointer;
		border: none;
		background: transparent;
	}

	.graph-control-btn:hover {
		background: var(--gw-surface-tint);
		color: var(--gw-fg);
	}

	.graph-control-btn:active {
		background: var(--gw-surface-elevated);
	}

	.graph-control-divider {
		width: 18px;
		height: 0.5px;
		background: var(--gw-separator);
	}

	/* ---- Glass legend ---- */
	.graph-legend {
		position: absolute;
		bottom: 16px;
		left: 16px;
		z-index: 10;
		background: var(--gw-surface);
		backdrop-filter: blur(var(--gw-blur)) saturate(180%);
		-webkit-backdrop-filter: blur(var(--gw-blur)) saturate(180%);
		border: 0.5px solid var(--gw-border);
		border-radius: 10px;
		box-shadow: var(--gw-shadow-glass);
		padding: 10px 14px;
	}

	.graph-legend-title {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--gw-fg-muted);
		margin-bottom: 8px;
	}

	.graph-legend-items {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.graph-legend-item {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.graph-legend-line {
		width: 14px;
		height: 2px;
		border-radius: 1px;
	}

	.graph-legend-label {
		font-size: 11px;
		color: var(--gw-fg-secondary);
		letter-spacing: -0.01em;
	}
</style>
