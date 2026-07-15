/**
 * STLBlade Engine — Client-Side STL Export
 * Exports STL directly from the Three.js scene graph.
 * Viewport = Download — zero geometry duplication.
 */

import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// ── Support-geometry cleanup (Lychee repair-flag fix, 2026-07) ─────────
// THREE primitives duplicate vertices along seams/caps so the viewer gets
// sharp normals; exported raw they become unwelded triangle soup, and the
// capsule lathe additionally emits zero-area quads at its poles. Lychee
// welds on import and then reports the leftovers ("geometry needs repair":
// thousands of sliver triangles + open edges on a perfectly printable
// file). Weld each support primitive and drop degenerate triangles at
// export time. The MODEL geometry is never touched — it ships repaired.
const WELD_EPS = 1e-4;

function cleanSupportGeometry(geo) {
    // Normals force mergeVertices to keep seam duplicates apart (attributes
    // must match to weld) — drop them; the STL exporter re-derives face
    // normals and the viewer never sees this geometry.
    geo.deleteAttribute('normal');
    let g = mergeVertices(geo, WELD_EPS);
    const idx = g.index;
    if (!idx) return g;
    const pos = g.attributes.position;
    const keep = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cr = new THREE.Vector3();
    for (let t = 0; t < idx.count; t += 3) {
        const i0 = idx.getX(t), i1 = idx.getX(t + 1), i2 = idx.getX(t + 2);
        if (i0 === i1 || i1 === i2 || i0 === i2) continue;      // collapsed
        a.fromBufferAttribute(pos, i0);
        b.fromBufferAttribute(pos, i1);
        c.fromBufferAttribute(pos, i2);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        cr.crossVectors(ab, ac);
        // area < ~5e-5 mm² — far below a resin printer pixel (~0.0025 mm²)
        if (cr.lengthSq() < 1e-8) continue;                     // zero-area sliver
        keep.push(i0, i1, i2);
    }

    // Orphan-islet filter: weld leftovers at sphere/lathe poles survive as
    // 1-3 disconnected micro-triangles floating at the primitive's surface.
    // A legitimate cap fan is CONNECTED to its body (same component), so
    // dropping tiny disconnected components is safe.
    const parent = new Map();
    const find = (x) => {
        let r = x;
        while (parent.get(r) !== r) r = parent.get(r);
        while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
        return r;
    };
    const union = (x, y) => {
        if (!parent.has(x)) parent.set(x, x);
        if (!parent.has(y)) parent.set(y, y);
        parent.set(find(x), find(y));
    };
    for (let t = 0; t < keep.length; t += 3) {
        union(keep[t], keep[t + 1]);
        union(keep[t], keep[t + 2]);
    }
    const triCount = new Map();
    for (let t = 0; t < keep.length; t += 3) {
        const r = find(keep[t]);
        triCount.set(r, (triCount.get(r) ?? 0) + 1);
    }
    const filtered = [];
    for (let t = 0; t < keep.length; t += 3) {
        if (triCount.get(find(keep[t])) >= 8) {
            filtered.push(keep[t], keep[t + 1], keep[t + 2]);
        }
    }

    if (filtered.length !== idx.count) g.setIndex(filtered);
    // mergeGeometries requires every input to carry the SAME attribute
    // set — the model geos have normals, so re-derive them post-weld
    // (STLExporter recomputes face normals anyway; these are inert).
    g.computeVertexNormals();
    return g;
}

// Y-up (Three.js) → Z-up (STL): rotate +90° around X (inverse of viewer's _zu which is -90°)
const Y_UP_TO_Z_UP = new THREE.Matrix4().makeRotationX(Math.PI / 2);

/**
 * Collect all visible mesh geometries from a THREE.Group,
 * baking each mesh's world transform into the geometry.
 * @param {THREE.Group} group
 * @returns {THREE.BufferGeometry[]}
 */
function collectGeometries(group) {
    const geometries = [];

    group.traverse((child) => {
        if (!child.isMesh) return;
        if (!child.visible) return;

        // Clone geometry so we don't mutate the scene
        const geo = child.geometry.clone();

        // Bake world transform
        child.updateWorldMatrix(true, false);
        geo.applyMatrix4(child.matrixWorld);

        // Strip non-position/normal attributes so mergeGeometries doesn't choke
        const keep = new Set(['position', 'normal']);
        for (const name of Object.keys(geo.attributes)) {
            if (!keep.has(name)) geo.deleteAttribute(name);
        }

        // InstancedMesh: expand instances into individual geometries
        if (child.isInstancedMesh) {
            const base = child.geometry.clone();
            for (const attrName of Object.keys(base.attributes)) {
                if (!keep.has(attrName)) base.deleteAttribute(attrName);
            }
            const mat4 = new THREE.Matrix4();
            for (let i = 0; i < child.count; i++) {
                child.getMatrixAt(i, mat4);
                const instance = base.clone();
                instance.applyMatrix4(mat4);
                instance.applyMatrix4(child.matrixWorld);
                geometries.push(instance);
            }
            geo.dispose();
            return;
        }

        geometries.push(geo);
    });

    return geometries;
}

/**
 * Merge an array of geometries and optionally convert from Y-up to Z-up.
 * The renderer assembles everything in Three.js Y-up coords; this is the
 * single place where the export-time axis convention is decided.
 *
 * @param {THREE.BufferGeometry[]} geometries
 * @param {'y'|'z'} upAxis 'y' = keep Y-up (default, matches viewer +
 *   ZBrush-side workflow). 'z' = apply +90° X to land in Z-up for
 *   slicers that want it.
 * @returns {THREE.BufferGeometry}
 */
function mergeAndApplyUpAxis(geometries, upAxis) {
    if (geometries.length === 0) return null;

    // Ensure all geometries are non-indexed for safe merge
    const prepared = geometries.map(g => g.index ? g.toNonIndexed() : g);

    const merged = geometries.length === 1
        ? prepared[0]
        : mergeGeometries(prepared, false);

    if (!merged) return null;

    if (upAxis === 'z') {
        merged.applyMatrix4(Y_UP_TO_Z_UP);
    }
    merged.computeVertexNormals();
    return merged;
}

/**
 * Export a BufferGeometry to binary STL ArrayBuffer.
 * @param {THREE.BufferGeometry} geometry
 * @returns {ArrayBuffer}
 */
function geometryToSTL(geometry) {
    const exporter = new STLExporter();
    const mesh = new THREE.Mesh(geometry);
    const result = exporter.parse(mesh, { binary: true });
    // Three.js's STLExporter returns a DataView in binary mode. Normalise to
    // an ArrayBuffer so Node-side callers (Buffer.from) and browser code
    // (Blob) both behave identically.
    if (result instanceof DataView) {
        return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
    }
    return result;
}

/**
 * Build merged STL binary from two THREE.Groups, without touching the DOM.
 * Works in Node.js and the browser.
 *
 * @param {THREE.Group} modelGroup - oriented model meshes
 * @param {THREE.Group} supportGroup - support meshes produced by renderSupports
 * @param {'y'|'z'} [upAxis='y'] Coordinate convention for the exported STL.
 * @returns {ArrayBuffer} STL binary
 */
export function buildMergedSTLBuffer(modelGroup, supportGroup, upAxis = 'y') {
    const modelGeos = collectGeometries(modelGroup);
    const supportGeos = collectGeometries(supportGroup)
        .map(cleanSupportGeometry)
        .filter((g) => {
            // Drop whole shells smaller than a resin pixel (~0.05mm): they
            // print as nothing and only feed the slicer's repair counter
            // (seen in the wild: 0.05mm joint micro-spheres).
            if (!g.index || g.index.count === 0) return false;
            g.computeBoundingBox();
            const s = new THREE.Vector3();
            g.boundingBox.getSize(s);
            return Math.max(s.x, s.y, s.z) >= 0.15;
        });
    const all = [...modelGeos, ...supportGeos];
    if (all.length === 0) {
        throw new Error('No geometry to export');
    }
    const merged = mergeAndApplyUpAxis(all, upAxis);
    const buffer = geometryToSTL(merged);
    merged.dispose();
    return buffer;
}
