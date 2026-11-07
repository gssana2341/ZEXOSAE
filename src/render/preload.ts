import * as THREE from 'three';

interface RenderScene {
  scene: THREE.Scene;
  camera: THREE.Camera;
}

/** Upload even off-screen geometry and textures before the first playable frame. */
export async function preloadScenes(renderer: THREE.WebGLRenderer, scenes: RenderScene[]): Promise<void> {
  const hidden: THREE.Object3D[] = [];
  const culled: THREE.Object3D[] = [];
  const target = new THREE.WebGLRenderTarget(1, 1);
  const previousTarget = renderer.getRenderTarget();
  const previousShadowUpdate = renderer.shadowMap.needsUpdate;
  let completed = false;

  const restore = () => {
    for (const object of hidden) object.visible = false;
    for (const object of culled) object.frustumCulled = true;
  };

  try {
    for (const { scene } of scenes) {
      scene.traverse((object) => {
        if (!object.visible) { hidden.push(object); object.visible = true; }
        if (object instanceof THREE.Mesh && object.frustumCulled) {
          culled.push(object);
          object.frustumCulled = false;
        }
      });
    }

    await Promise.all(scenes.map(({ scene, camera }) => renderer.compileAsync(scene, camera)));
    renderer.shadowMap.needsUpdate = false;
    renderer.setRenderTarget(target);
    for (const { scene, camera } of scenes) renderer.render(scene, camera);

    // Bake the real shadow map with the actual visibility, not the temporary warm-up state.
    restore();
    renderer.shadowMap.needsUpdate = previousShadowUpdate;
    if (scenes[0]) renderer.render(scenes[0].scene, scenes[0].camera);
    renderer.getContext().finish();
    completed = true;
  } finally {
    restore();
    if (!completed) renderer.shadowMap.needsUpdate = previousShadowUpdate;
    renderer.setRenderTarget(previousTarget);
    target.dispose();
  }
}
