/**
 * STLBlade Renderer — Node-side entry point.
 *
 * Replicates the STL output that the STLBlade web viewer produces when the
 * user clicks "Download Supported STL". Same renderer code, same geometry,
 * driven from Node instead of the browser DOM.
 *
 * Flow (matches viewer.loadSTLOriented() in the STLBlade frontend):
 *   1. Caller passes the original (un-oriented) mesh as Float32/Uint32 arrays
 *      plus the placement schema returned by /support + /support/optimize.
 *   2. We build a BufferGeometry and apply the same Z-up transforms the viewer
 *      does: rotateX(rx) → rotateY(ry) → translateZ(zLift) → rotateX(-90°)
 *      to land in Three.js Y-up space.
 *   3. We call renderSupports() — the exact function the viewer uses — into a
 *      throwaway THREE.Group. zu() inside supportRenderer converts each
 *      backend Z-up coord into the same Y-up space, so model + supports
 *      share one frame at export time.
 *   4. We merge model + support geometry and emit a binary STL ArrayBuffer,
 *      then wrap it as a Node Buffer for fs.writeFile.
 */

import * as THREE from 'three';
import { renderSupports, setQuality } from './supportRenderer.js';
import { buildMergedSTLBuffer } from './meshBuilder.js';

// Re-export the renderer API so consumers configure theme/quality via the
// package entry point.
export {
    renderSupports,
    clearSupports,
    setQuality,
    getQuality,
    setTheme,
    setMergeSupports,
    zu,
} from './supportRenderer.js';
export { parseStlToArrays } from './parseStl.mjs';

/**
 * Render a placement schema into a watertight STL.
 *
 * @param {Float32Array} vertices  Original mesh vertices (flat XYZ, Z-up, pre-orientation).
 * @param {Uint32Array} faces      Original mesh faces (flat triangle indices).
 * @param {object} schema          Schema returned by STLBlade /support + /support/optimize.
 * @param {object} [opts]          Render quality knobs.
 * @param {'low'|'medium'|'high'} [opts.quality='medium']
 * @param {'y'|'z'} [opts.upAxis='y']
 *   Coordinate convention for the EXPORTED STL.
 *   - 'y' (default): Y-up. Matches the STLBlade browser viewer's
 *     "Download Supported STL" output AND the existing ZBrush-side
 *     STL the artist ships — both load head-up in our Three.js
 *     ModelViewer with no extra rotation needed.
 *   - 'z': Z-up. Applies a +90° X rotation at export time so the file
 *     opens upright in slicers that interpret +Z as up
 *     (Cura, PrusaSlicer, Chitubox, Lychee).
 * @returns {Buffer}               Binary STL ready to write to disk.
 */
export function renderSchemaToSTL(vertices, faces, schema, opts = {}) {
  if (!vertices || vertices.length === 0) {
    throw new Error('renderSchemaToSTL: vertices array is empty');
  }
  if (!faces || faces.length === 0) {
    throw new Error('renderSchemaToSTL: faces array is empty');
  }

  setQuality(opts.quality ?? 'medium');

  // ── 1. Build geometry in Z-up (STL native frame) ──
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(new THREE.BufferAttribute(faces, 1));

  // ── 2. Apply orientation in Z-up (matches viewer.loadSTLOriented) ──
  const rxRad = THREE.MathUtils.degToRad(schema.orientation.rx);
  const ryRad = THREE.MathUtils.degToRad(schema.orientation.ry);
  geometry.applyMatrix4(new THREE.Matrix4().makeRotationX(rxRad));
  geometry.applyMatrix4(new THREE.Matrix4().makeRotationY(ryRad));

  // ── 3. Z-lift in Z-up. Phase-2 responses include z_lift_mm; older Phase-1
  //     responses don't — fall back to the same "lift to plate + 10mm"
  //     default the viewer uses on first load.
  let zLift = schema.orientation.z_lift_mm;
  if (zLift == null) {
    geometry.computeBoundingBox();
    const minZ = geometry.boundingBox?.min.z ?? 0;
    zLift = -minZ + 10.0;
  }
  geometry.translate(0, 0, zLift);

  // ── 4. Z-up → Y-up final swap (matches viewer line 297) ──
  geometry.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));

  geometry.computeVertexNormals();

  // ── 5. Wrap geometry in a Mesh + Group (collectGeometries traverses Groups) ──
  const modelMesh = new THREE.Mesh(
    geometry,
    new THREE.MeshPhongMaterial({ color: 0xc0c0c0 }),
  );
  const modelGroup = new THREE.Group();
  modelGroup.add(modelMesh);

  // ── 6. Render supports into a throwaway group ──
  const supportGroup = new THREE.Group();
  renderSupports(
    supportGroup,
    schema.supports ?? [],
    schema.columns ?? [],
    schema.braces ?? [],
    schema.raft ?? null,
    schema.phase ?? 'coverage',
  );

  // ── 7. Merge model + supports and emit STL binary ──
  // Both model + supports are in Y-up at this point (step 4 swap +
  // zu() inside supportRenderer). buildMergedSTLBuffer applies the
  // Y→Z rotation when caller asks for 'z'; the default 'y' leaves the
  // export untransformed, matching the viewer's "Download Supported
  // STL" byte-for-byte AND the ZBrush-side unsupported STL.
  const upAxis = opts.upAxis ?? 'y';
  if (upAxis !== 'y' && upAxis !== 'z') {
    throw new Error(`renderSchemaToSTL: invalid upAxis "${upAxis}" (use 'y' or 'z')`);
  }
  const arrayBuffer = buildMergedSTLBuffer(modelGroup, supportGroup, upAxis);
  return Buffer.from(arrayBuffer);
}
