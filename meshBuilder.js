/**
 * STLBlade Engine — Client-Side STL Export
 * Exports STL directly from the Three.js scene graph.
 * Viewport = Download — zero geometry duplication.
 */

import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
    const supportGeos = collectGeometries(supportGroup);
    const all = [...modelGeos, ...supportGeos];
    if (all.length === 0) {
        throw new Error('No geometry to export');
    }
    const merged = mergeAndApplyUpAxis(all, upAxis);
    const buffer = geometryToSTL(merged);
    merged.dispose();
    return buffer;
}
