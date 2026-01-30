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
	let loadingCenterId: number | null = null; // Track which book we're loading

	// Color scheme for different edge types
	const edgeColors: Record<string, string> = {
		content: '#3b82f6', // blue
		author: '#10b981', // green
		series: '#f59e0b', // amber
		tag: '#8b5cf6', // purple
		user: '#ef4444' // red
	};

	const nodeColors = {
		center: '#ef4444', // red for center node
		rated: '#f59e0b', // amber for rated books
		default: '#6366f1' // indigo for others
	};

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

			// Ignore stale responses if user switched to different book
			if (loadingCenterId !== requestedCenterId) {
				console.log('Ignoring stale graph response for', requestedCenterId);
				return;
			}

			console.log('Graph data received:', { nodes: data.nodes.length, edges: data.edges.length, centerId: requestedCenterId });

			if (data.nodes.length === 0) {
				error = 'No graph data available for this book. Try rebuilding the book graph in Settings.';
			} else {
				renderGraph(data);
			}
		} catch (e) {
			// Ignore errors for stale requests
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
		// Clean up existing graph
		if (sigma) {
			sigma.kill();
			sigma = null;
		}

		if (data.nodes.length === 0 || !Graph || !SigmaClass) {
			console.log('renderGraph: missing libraries or no nodes', { nodes: data.nodes.length, Graph: !!Graph, SigmaClass: !!SigmaClass });
			return;
		}

		// If container isn't ready yet, store data and retry
		if (!container) {
			console.log('renderGraph: container not ready, will retry');
			pendingData = data;
			return;
		}

		// Create new graph
		graph = new Graph();

		// Add nodes with positions (force layout will be applied)
		const nodeCount = data.nodes.length;
		data.nodes.forEach((node, index) => {
			const angle = (2 * Math.PI * index) / nodeCount;
			const radius = node.id === centerId ? 0 : 5 + Math.random() * 5;

			graph!.addNode(String(node.id), {
				label: truncateTitle(node.title, 30),
				x: radius * Math.cos(angle),
				y: radius * Math.sin(angle),
				size: node.id === centerId ? 20 : 10 + (node.rating || 0) * 2,
				color:
					node.id === centerId
						? nodeColors.center
						: node.rating
							? nodeColors.rated
							: nodeColors.default,
				// Store original data
				originalData: node
			});
		});

		// Add edges
		data.edges.forEach((edge, index) => {
			const sourceStr = String(edge.source);
			const targetStr = String(edge.target);

			if (graph!.hasNode(sourceStr) && graph!.hasNode(targetStr)) {
				graph!.addEdge(sourceStr, targetStr, {
					size: 1 + edge.weight * 3,
					color: edgeColors[edge.edgeType] || '#94a3b8',
					type: 'arrow',
					label: edge.edgeType,
					weight: edge.weight
				});
			}
		});

		// Apply force-directed layout
		applyForceLayout();

		// Create Sigma renderer
		sigma = new SigmaClass(graph, container, {
			renderEdgeLabels: false,
			defaultNodeColor: nodeColors.default,
			defaultEdgeColor: '#94a3b8',
			labelFont: 'Inter, system-ui, sans-serif',
			labelSize: 12,
			labelWeight: '500',
			labelColor: { color: '#1f2937' },
			stagePadding: 50,
			nodeReducer: (node, data) => {
				const res = { ...data };
				if (hoveredNode) {
					if (node === hoveredNode || graph?.hasEdge(node, hoveredNode) || graph?.hasEdge(hoveredNode, node)) {
						res.highlighted = true;
					} else {
						res.color = '#d1d5db';
						res.label = '';
					}
				}
				return res;
			},
			edgeReducer: (edge, data) => {
				const res = { ...data };
				if (hoveredNode) {
					const [source, target] = graph!.extremities(edge);
					if (source !== hoveredNode && target !== hoveredNode) {
						res.hidden = true;
					}
				}
				return res;
			}
		});

		// Event handlers
		sigma.on('enterNode', ({ node }) => {
			hoveredNode = node;
			sigma?.refresh();
		});

		sigma.on('leaveNode', () => {
			hoveredNode = null;
			sigma?.refresh();
		});

		sigma.on('clickNode', ({ node }) => {
			const nodeData = graph?.getNodeAttributes(node);
			if (nodeData?.originalData && onNodeClick) {
				onNodeClick(nodeData.originalData.id);
			}
		});
	}

	function applyForceLayout() {
		if (!graph) return;

		// Simple force-directed layout
		const iterations = 100;
		const k = 1; // Optimal distance
		const gravity = 0.1;
		const speed = 0.1;

		for (let iter = 0; iter < iterations; iter++) {
			const forces: Map<string, { x: number; y: number }> = new Map();

			// Initialize forces
			graph.forEachNode((node) => {
				forces.set(node, { x: 0, y: 0 });
			});

			// Repulsive forces between all nodes
			graph.forEachNode((nodeA) => {
				const posA = { x: graph!.getNodeAttribute(nodeA, 'x'), y: graph!.getNodeAttribute(nodeA, 'y') };

				graph!.forEachNode((nodeB) => {
					if (nodeA === nodeB) return;

					const posB = { x: graph!.getNodeAttribute(nodeB, 'x'), y: graph!.getNodeAttribute(nodeB, 'y') };
					const dx = posA.x - posB.x;
					const dy = posA.y - posB.y;
					const distance = Math.sqrt(dx * dx + dy * dy) || 0.1;
					const force = (k * k) / distance;

					const forceA = forces.get(nodeA)!;
					forceA.x += (dx / distance) * force;
					forceA.y += (dy / distance) * force;
				});
			});

			// Attractive forces along edges
			graph.forEachEdge((edge, attrs, source, target) => {
				const posA = { x: graph!.getNodeAttribute(source, 'x'), y: graph!.getNodeAttribute(source, 'y') };
				const posB = { x: graph!.getNodeAttribute(target, 'x'), y: graph!.getNodeAttribute(target, 'y') };

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
			});

			// Apply gravity towards center
			graph.forEachNode((node) => {
				const pos = { x: graph!.getNodeAttribute(node, 'x'), y: graph!.getNodeAttribute(node, 'y') };
				const forceN = forces.get(node)!;
				forceN.x -= pos.x * gravity;
				forceN.y -= pos.y * gravity;
			});

			// Update positions
			graph.forEachNode((node) => {
				// Don't move center node
				if (node === String(centerId)) return;

				const pos = { x: graph!.getNodeAttribute(node, 'x'), y: graph!.getNodeAttribute(node, 'y') };
				const force = forces.get(node)!;

				const displacement = Math.sqrt(force.x * force.x + force.y * force.y);
				const maxDisplacement = 10;

				if (displacement > 0) {
					const limitedDisp = Math.min(displacement, maxDisplacement);
					graph!.setNodeAttribute(node, 'x', pos.x + (force.x / displacement) * limitedDisp * speed);
					graph!.setNodeAttribute(node, 'y', pos.y + (force.y / displacement) * limitedDisp * speed);
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

	onMount(async () => {
		if (!browser) return;

		try {
			// Dynamically import Sigma and Graphology (WebGL libraries)
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

	onDestroy(() => {
		if (sigma) {
			sigma.kill();
		}
	});

	// Reload when centerId changes (only if libraries are loaded)
	$: if (browser && centerId !== null && Graph && SigmaClass) {
		loadGraphData();
	}

	// Retry rendering when container becomes available
	$: if (container && pendingData) {
		console.log('Container now available, rendering pending graph data');
		const data = pendingData;
		pendingData = null;
		renderGraph(data);
	}
</script>

<div class="relative w-full h-full bg-surface-50 dark:bg-surface-900 rounded-lg overflow-hidden">
	{#if loading}
		<div class="absolute inset-0 flex items-center justify-center">
			<div class="text-center">
				<div
					class="animate-spin rounded-full h-8 w-8 border-2 border-primary-500 border-t-transparent mx-auto mb-2"
				></div>
				<p class="text-surface-500 text-sm">Loading graph...</p>
			</div>
		</div>
	{:else if error}
		<div class="absolute inset-0 flex items-center justify-center">
			<div class="text-center text-red-500">
				<p class="font-medium">Failed to load graph</p>
				<p class="text-sm">{error}</p>
			</div>
		</div>
	{:else if centerId === null}
		<div class="absolute inset-0 flex items-center justify-center">
			<div class="text-center text-surface-500">
				<p>Select a book to view its relationship graph</p>
			</div>
		</div>
	{:else}
		<!-- Graph container -->
		<div bind:this={container} class="w-full h-full"></div>

		<!-- Controls -->
		<div class="absolute top-4 right-4 flex flex-col gap-2">
			<button
				on:click={zoomIn}
				class="p-2 bg-white dark:bg-surface-800 rounded-lg shadow-md hover:bg-surface-50 dark:hover:bg-surface-700"
				title="Zoom in"
			>
				<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v12m6-6H6" />
				</svg>
			</button>
			<button
				on:click={zoomOut}
				class="p-2 bg-white dark:bg-surface-800 rounded-lg shadow-md hover:bg-surface-50 dark:hover:bg-surface-700"
				title="Zoom out"
			>
				<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 12H6" />
				</svg>
			</button>
			<button
				on:click={resetView}
				class="p-2 bg-white dark:bg-surface-800 rounded-lg shadow-md hover:bg-surface-50 dark:hover:bg-surface-700"
				title="Reset view"
			>
				<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
					/>
				</svg>
			</button>
		</div>

		<!-- Legend -->
		<div
			class="absolute bottom-4 left-4 bg-white dark:bg-surface-800 rounded-lg shadow-md p-3 text-sm"
		>
			<p class="font-medium mb-2 text-surface-700 dark:text-surface-300">Edge Types</p>
			<div class="space-y-1">
				<div class="flex items-center gap-2">
					<div class="w-4 h-0.5" style="background-color: {edgeColors.content}"></div>
					<span class="text-surface-600 dark:text-surface-400">Similar Content</span>
				</div>
				<div class="flex items-center gap-2">
					<div class="w-4 h-0.5" style="background-color: {edgeColors.author}"></div>
					<span class="text-surface-600 dark:text-surface-400">Same Author</span>
				</div>
				<div class="flex items-center gap-2">
					<div class="w-4 h-0.5" style="background-color: {edgeColors.series}"></div>
					<span class="text-surface-600 dark:text-surface-400">Same Series</span>
				</div>
				<div class="flex items-center gap-2">
					<div class="w-4 h-0.5" style="background-color: {edgeColors.tag}"></div>
					<span class="text-surface-600 dark:text-surface-400">Shared Tags</span>
				</div>
			</div>
		</div>
	{/if}
</div>
