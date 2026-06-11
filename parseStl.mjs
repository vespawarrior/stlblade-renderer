/**
 * Parse a binary or ASCII STL into the flat arrays renderSchemaToSTL expects.
 *
 * Uses Three.js STLLoader so the parse semantics match what the viewer does
 * when it loads the same file in the browser. STLLoader produces a
 * non-indexed BufferGeometry (3 unique vertices per triangle), so we
 * generate a trivial 0..N index. That's wasteful in memory but byte-stable,
 * and the STL output ends up the same size the viewer would emit — the
 * frontend's exportMergedSTL also runs through STLExporter on non-indexed
 * geometry, so we stay byte-comparable.
 */
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

/**
 * @param {Buffer|Uint8Array} buffer - raw STL bytes (binary or ASCII)
 * @returns {{ vertices: Float32Array, faces: Uint32Array }}
 */
export function parseStlToArrays(buffer) {
    // STLLoader.parse() accepts an ArrayBuffer. Node Buffer is a view over a
    // larger ArrayBuffer (allocator slab), so slice out exactly our bytes.
    const ab = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
    );
    const geometry = new STLLoader().parse(ab);
    const positionAttr = geometry.getAttribute('position');
    if (!positionAttr) {
        throw new Error('parseStlToArrays: STL parsed without a position attribute');
    }
    const positions = new Float32Array(positionAttr.array);

    const indexAttr = geometry.getIndex();
    let faces;
    if (indexAttr) {
        faces = new Uint32Array(indexAttr.array);
    } else {
        // Non-indexed: triangles are flat in position order — 0,1,2,3,4,5,...
        const vertCount = positions.length / 3;
        faces = new Uint32Array(vertCount);
        for (let i = 0; i < vertCount; i++) faces[i] = i;
    }

    // Free the temporary geometry — its data has been copied into our arrays.
    geometry.dispose();
    void THREE; // keep import side-effect explicit for tree-shakers

    return { vertices: positions, faces };
}
