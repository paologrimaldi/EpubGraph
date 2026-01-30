import * as THREE from 'three';
import { createWallMaterial } from './materials';

export interface SceneSetup {
	scene: THREE.Scene;
	camera: THREE.PerspectiveCamera;
	renderer: THREE.WebGLRenderer;
	wallMesh: THREE.Mesh;
}

export function createScene(container: HTMLElement, darkMode: boolean = false): SceneSetup {
	const scene = new THREE.Scene();
	// Background color: off-white for light mode, dark blue-gray for dark mode
	scene.background = new THREE.Color(darkMode ? 0x1a1a2e : 0xf0f0ec);

	// Perspective camera for depth perception
	const aspect = container.clientWidth / container.clientHeight;
	const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 100);

	// Position camera in front but slightly above and angled down for depth
	camera.position.set(0, 2, 18);
	camera.lookAt(0, 0, 0);

	// Renderer
	const renderer = new THREE.WebGLRenderer({
		antialias: true,
		alpha: false,
		powerPreference: 'high-performance'
	});
	renderer.setSize(container.clientWidth, container.clientHeight);
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.VSMShadowMap; // Supports blur radius for soft shadows
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.0;
	container.appendChild(renderer.domElement);

	// Create textured wall behind bookshelf - close to books for subtle shadows
	const wallGeometry = new THREE.PlaneGeometry(40, 30);
	const wallMaterial = createWallMaterial(darkMode);
	const wallMesh = new THREE.Mesh(wallGeometry, wallMaterial);
	wallMesh.position.set(0, 0, -0.6);
	wallMesh.receiveShadow = true;
	scene.add(wallMesh);

	return { scene, camera, renderer, wallMesh };
}

export function createLighting(scene: THREE.Scene): void {
	// Higher ambient light for softer overall shadows
	const ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
	scene.add(ambientLight);

	// Main light from top-left - subtle soft shadows
	const mainLight = new THREE.DirectionalLight(0xfff8f0, 0.6);
	mainLight.position.set(-8, 12, 10);
	mainLight.castShadow = true;

	// Shadow map settings
	mainLight.shadow.mapSize.width = 2048;
	mainLight.shadow.mapSize.height = 2048;

	// Shadow camera frustum
	mainLight.shadow.camera.left = -20;
	mainLight.shadow.camera.right = 20;
	mainLight.shadow.camera.top = 20;
	mainLight.shadow.camera.bottom = -20;
	mainLight.shadow.camera.near = 0.5;
	mainLight.shadow.camera.far = 50;

	// Soft shadow blur
	mainLight.shadow.radius = 3;
	mainLight.shadow.blurSamples = 12;

	// Reduce shadow intensity (0 = fully dark, 1 = invisible)
	mainLight.shadow.intensity = 0.35;

	// Prevent shadow acne
	mainLight.shadow.bias = -0.0003;
	mainLight.shadow.normalBias = 0.01;

	scene.add(mainLight);

	// Fill light from the right
	const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
	fillLight.position.set(8, 6, 12);
	scene.add(fillLight);

	// Hemisphere light for natural ambient
	const hemiLight = new THREE.HemisphereLight(0xffffff, 0xf0ebe0, 0.25);
	scene.add(hemiLight);
}

export function updateCameraSize(
	camera: THREE.PerspectiveCamera,
	renderer: THREE.WebGLRenderer,
	container: HTMLElement
): void {
	camera.aspect = container.clientWidth / container.clientHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(container.clientWidth, container.clientHeight);
}

export function updateSceneColors(
	scene: THREE.Scene,
	wallMesh: THREE.Mesh,
	darkMode: boolean
): void {
	// Update scene background
	scene.background = new THREE.Color(darkMode ? 0x1a1a2e : 0xf0f0ec);

	// Update wall material
	const oldMaterial = wallMesh.material as THREE.MeshStandardMaterial;
	oldMaterial.dispose();
	wallMesh.material = createWallMaterial(darkMode);
}
