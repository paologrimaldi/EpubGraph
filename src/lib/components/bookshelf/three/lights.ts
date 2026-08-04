import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';

export interface LightRig {
	key: THREE.DirectionalLight;
	fill: THREE.DirectionalLight;
	hemisphere: THREE.HemisphereLight;
}

// Common aim point for the rect-area rig — same neighborhood as the shelf camera target.
const RIG_AIM = new THREE.Vector3(0, 1.4, 0);

export function addLights(scene: THREE.Scene): LightRig {
	RectAreaLightUniformsLib.init();

	const hemisphere = new THREE.HemisphereLight(0xfff8e8, 0x5b4030, 0.56);
	scene.add(hemisphere);

	const key = new THREE.DirectionalLight(0xffe8c2, 1.42);
	key.position.set(-4.6, 7.4, 5.8);
	key.castShadow = true;
	key.shadow.mapSize.set(2048, 2048);
	key.shadow.camera.left = -6;
	key.shadow.camera.right = 6;
	key.shadow.camera.top = 6;
	key.shadow.camera.bottom = -1.5;
	key.shadow.camera.near = 1;
	key.shadow.camera.far = 18;
	key.shadow.bias = -0.00018;
	key.shadow.normalBias = 0.018;
	key.shadow.radius = 3.5;
	scene.add(key);

	const fill = new THREE.DirectionalLight(0xd8e3e7, 0.3);
	fill.position.set(5.5, 3.6, 4.2);
	scene.add(fill);

	// RectAreaLight — cloth softbox (key fill from camera-left).
	const softKey = new THREE.RectAreaLight(0xffe8c2, 5.4, 4.8, 5.6);
	softKey.position.set(-3.2, 5.5, 4.6);
	softKey.lookAt(0, 1.45, 0);
	scene.add(softKey);

	// RectAreaLight — foil rake, makes foil accents glint.
	const foilRake = new THREE.RectAreaLight(0xd5a45e, 3.45, 1.6, 4.8);
	foilRake.position.set(3.8, 3.6, -2.1);
	foilRake.lookAt(-0.2, 1.5, 0);
	scene.add(foilRake);

	// RectAreaLight — back softbox. Brief gives no explicit lookAt; aimed at the shelf area.
	const backSoftbox = new THREE.RectAreaLight(0xd8e3e7, 2.7, 3.8, 4.8);
	backSoftbox.position.set(-1.8, 2.9, -4.5);
	backSoftbox.lookAt(RIG_AIM);
	scene.add(backSoftbox);

	// RectAreaLight — page-edge rake. Brief gives no explicit lookAt; aimed at the shelf area.
	const pageRake = new THREE.RectAreaLight(0xfff7e7, 2.15, 1.15, 3.8);
	pageRake.position.set(4.2, 4.8, 3.1);
	pageRake.lookAt(RIG_AIM);
	scene.add(pageRake);

	return { key, fill, hemisphere };
}
