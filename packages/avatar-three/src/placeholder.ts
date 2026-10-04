import * as THREE from "three";

/**
 * A procedural placeholder avatar (no assets, nothing to license): a rounded body with two
 * eyes, driven by the creature preset. Real roster art arrives in M8.
 */
export const createPlaceholder = (color = 0x7ec8a9): THREE.Group => {
  const root = new THREE.Group();
  root.name = "chalito-placeholder";
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 32, 24),
    new THREE.MeshStandardMaterial({ color, roughness: 0.6 }),
  );
  body.name = "body";
  body.scale.set(1, 0.9, 0.85);
  body.position.y = 0.45;
  root.add(body);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x1d1d1f, roughness: 0.3 });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), eyeMat);
    eye.name = side < 0 ? "eyeL" : "eyeR";
    eye.position.set(0.16 * side, 0.55, 0.42);
    root.add(eye);
  }
  return root;
};
