/**
 * STLBlade — Shared Support Geometry Primitives
 *
 * Pure geometry builders — no materials, no colors, no scene graph.
 * Returns BufferGeometry only. Consumers handle materials and presentation.
 *
 * Quality presets control tessellation across all primitives:
 *   LOW    — fast preview (6-8 segments)
 *   MEDIUM — default viewport (10-12 segments)
 *   HIGH   — export / final quality (16-24 segments)
 */

import * as THREE from 'three';

// ─── Quality Presets ────────────────────────────────────────────────────────

export const QUALITY_PRESETS = {
    low: {
        tubeRadialSegs:     6,
        cylinderRadialSegs: 6,
        sphereWidthSegs:    6,
        sphereHeightSegs:   4,
        latheSegs:          6,
        hemiSubdivisions:   4,
    },
    medium: {
        tubeRadialSegs:     12,
        cylinderRadialSegs: 12,
        sphereWidthSegs:    10,
        sphereHeightSegs:   8,
        latheSegs:          10,
        hemiSubdivisions:   6,
    },
    high: {
        tubeRadialSegs:     24,
        cylinderRadialSegs: 24,
        sphereWidthSegs:    16,
        sphereHeightSegs:   12,
        latheSegs:          16,
        hemiSubdivisions:   8,
    },
};

/** Resolve quality preset by name or pass-through object. */
export function resolveQuality(q) {
    if (typeof q === 'string') return QUALITY_PRESETS[q] || QUALITY_PRESETS.medium;
    return q || QUALITY_PRESETS.medium;
}

// ─── Coordinate Conversion ──────────────────────────────────────────────────

/** Convert backend Z-up (x, y, z) to Three.js Y-up Vector3 */
export function zu(x, y, z) {
    return new THREE.Vector3(x, z, -y);
}

// ─── Tube / Cylinder ────────────────────────────────────────────────────────

/**
 * Build a smooth tube mesh along a polyline with variable radius.
 * Always generates end caps for watertight geometry.
 *
 * @param {THREE.Vector3[]} pts - path points (Y-up)
 * @param {function(number):number} radiusFn - radius at parameter t ∈ [0,1]
 * @param {string|object} [quality='medium'] - quality preset name or object
 * @returns {THREE.BufferGeometry|null} - null if degenerate
 */
export function buildTaperedTubeGeo(pts, radiusFn, quality = 'medium') {
    if (pts.length < 2) return null;

    const q = resolveQuality(quality);
    const radialSegs = q.tubeRadialSegs;

    // Compute cumulative lengths
    const cumLen = [0];
    for (let i = 1; i < pts.length; i++) {
        cumLen.push(cumLen[i - 1] + pts[i - 1].distanceTo(pts[i]));
    }
    const totalLen = cumLen[cumLen.length - 1];
    if (totalLen < 0.01) return null;

    const positions = [];
    const indices = [];
    const normals = [];

    let lastU = null;

    for (let i = 0; i < pts.length; i++) {
        const t = cumLen[i] / totalLen;
        const r = radiusFn(t);

        // Tangent: averaged at interior points to handle sharp corners
        let tangent;
        if (i === 0) {
            tangent = new THREE.Vector3().subVectors(pts[1], pts[0]).normalize();
        } else if (i === pts.length - 1) {
            tangent = new THREE.Vector3().subVectors(pts[i], pts[i - 1]).normalize();
        } else {
            const t1 = new THREE.Vector3().subVectors(pts[i], pts[i - 1]).normalize();
            const t2 = new THREE.Vector3().subVectors(pts[i + 1], pts[i]).normalize();
            tangent = new THREE.Vector3().addVectors(t1, t2).normalize();
            if (tangent.length() < 0.001) tangent.copy(t2);
        }

        // Build perpendicular frame (consistent with previous ring to avoid twisting)
        let u, v;
        if (lastU === null) {
            const arbitrary = Math.abs(tangent.y) < 0.9
                ? new THREE.Vector3(0, 1, 0)
                : new THREE.Vector3(1, 0, 0);
            u = new THREE.Vector3().crossVectors(tangent, arbitrary).normalize();
        } else {
            u = lastU.clone().sub(tangent.clone().multiplyScalar(lastU.dot(tangent)));
            if (u.length() < 0.001) {
                const arbitrary = Math.abs(tangent.y) < 0.9
                    ? new THREE.Vector3(0, 1, 0)
                    : new THREE.Vector3(1, 0, 0);
                u = new THREE.Vector3().crossVectors(tangent, arbitrary);
            }
            u.normalize();
        }
        v = new THREE.Vector3().crossVectors(tangent, u).normalize();
        lastU = u.clone();

        // Generate ring vertices
        for (let j = 0; j <= radialSegs; j++) {
            const angle = (j / radialSegs) * Math.PI * 2;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);

            const nx = u.x * cos + v.x * sin;
            const ny = u.y * cos + v.y * sin;
            const nz = u.z * cos + v.z * sin;

            positions.push(
                pts[i].x + r * nx,
                pts[i].y + r * ny,
                pts[i].z + r * nz,
            );
            normals.push(nx, ny, nz);
        }
    }

    // Build triangle indices connecting consecutive rings
    const ringVerts = radialSegs + 1;
    for (let i = 0; i < pts.length - 1; i++) {
        for (let j = 0; j < radialSegs; j++) {
            const a = i * ringVerts + j;
            const b = i * ringVerts + j + 1;
            const c = (i + 1) * ringVerts + j;
            const d = (i + 1) * ringVerts + j + 1;
            indices.push(a, b, c);
            indices.push(b, d, c);
        }
    }

    // ── End caps (watertight) ──
    // Bottom cap
    const bottomCenter = positions.length / 3;
    positions.push(pts[0].x, pts[0].y, pts[0].z);
    const firstTangent = new THREE.Vector3().subVectors(pts[1], pts[0]).normalize();
    normals.push(-firstTangent.x, -firstTangent.y, -firstTangent.z);
    for (let j = 0; j < radialSegs; j++) {
        indices.push(bottomCenter, j + 1, j);
    }

    // Top cap
    const topCenter = positions.length / 3;
    const lastPt = pts[pts.length - 1];
    positions.push(lastPt.x, lastPt.y, lastPt.z);
    const lastTangent = new THREE.Vector3()
        .subVectors(pts[pts.length - 1], pts[pts.length - 2]).normalize();
    normals.push(lastTangent.x, lastTangent.y, lastTangent.z);
    const lastRingStart = (pts.length - 1) * ringVerts;
    for (let j = 0; j < radialSegs; j++) {
        indices.push(topCenter, lastRingStart + j, lastRingStart + j + 1);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setIndex(indices);
    return geo;
}

/**
 * Build a cylinder geometry between two points.
 *
 * @param {THREE.Vector3} start
 * @param {THREE.Vector3} end
 * @param {number} radius
 * @param {string|object} [quality='medium']
 * @returns {{ geometry: THREE.BufferGeometry, position: THREE.Vector3, quaternion: THREE.Quaternion }}
 */
export function buildCylinderGeo(start, end, radius, quality = 'medium') {
    const q = resolveQuality(quality);
    const r = Math.max(radius, 0.08);
    const height = start.distanceTo(end);

    const geo = new THREE.CylinderGeometry(r, r, height, q.cylinderRadialSegs);
    const position = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);

    const dir = new THREE.Vector3().subVectors(end, start).normalize();
    const cylUp = new THREE.Vector3(0, 1, 0);
    let quaternion = new THREE.Quaternion();
    if (Math.abs(dir.dot(cylUp)) < 0.9999) {
        quaternion = new THREE.Quaternion().setFromUnitVectors(cylUp, dir);
    }

    return { geometry: geo, position, quaternion };
}

// ─── Sphere ─────────────────────────────────────────────────────────────────

/**
 * Build a sphere geometry.
 *
 * @param {number} radius
 * @param {string|object} [quality='medium']
 * @returns {THREE.BufferGeometry}
 */
export function buildSphereGeo(radius, quality = 'medium') {
    const q = resolveQuality(quality);
    return new THREE.SphereGeometry(radius, q.sphereWidthSegs, q.sphereHeightSegs);
}

// ─── Tip Capsule ────────────────────────────────────────────────────────────

/**
 * Build a capsule tip geometry (hemispherical ends + tapered body) using LatheGeometry.
 * Profile: bottom hemisphere (shaftR) → taper → top hemisphere (tipR)
 *
 * @param {number} shaftR - shaft radius (bottom)
 * @param {number} tipR - tip radius (top, contacts model)
 * @param {number} capsuleH - distance from column end to contact point
 * @param {string|object} [quality='medium']
 * @returns {THREE.BufferGeometry}
 */
export function buildTipCapsuleGeo(shaftR, tipR, capsuleH, quality = 'medium') {
    const q = resolveQuality(quality);
    const hemiSegments = q.hemiSubdivisions;
    const latheSegments = q.latheSegs;

    const totalH = capsuleH + shaftR;
    const profile = [];

    // 1) Bottom hemisphere (radius = shaftR), center at Y=shaftR
    for (let i = 0; i <= hemiSegments; i++) {
        const a = Math.PI * 0.5 * (i / hemiSegments);
        const x = shaftR * Math.sin(a);
        const y = shaftR * (1 - Math.cos(a));
        profile.push(new THREE.Vector2(x, y));
    }

    // 2) Taper from shaftR to tipR
    const bodyTop = totalH - tipR;
    if (bodyTop > shaftR) {
        profile.push(new THREE.Vector2(tipR, bodyTop));
    }

    // 3) Top hemisphere (radius = tipR), center at Y=totalH-tipR
    for (let i = 0; i <= hemiSegments; i++) {
        const a = Math.PI * 0.5 * (i / hemiSegments);
        const x = tipR * Math.cos(a);
        const y = (totalH - tipR) + tipR * Math.sin(a);
        profile.push(new THREE.Vector2(x, y));
    }

    return new THREE.LatheGeometry(profile, latheSegments);
}

// ─── Base Foot (pad + taper) ────────────────────────────────────────────────

/**
 * Build base foot geometry: cylindrical pad + conical taper.
 *
 * @param {number} colRadius - column shaft radius
 * @param {string|object} [quality='medium']
 * @returns {{ padGeo: THREE.BufferGeometry, padHeight: number, taperGeo: THREE.BufferGeometry, taperHeight: number }}
 */
export function buildBaseFootGeo(colRadius, quality = 'medium') {
    const q = resolveQuality(quality);
    const padRadius = Math.min(2.0, Math.max(0.8, colRadius * 1.5));
    const padHeight = 0.8;
    const taperHeight = Math.max(0.5, colRadius * 1.0);

    const padGeo = new THREE.CylinderGeometry(padRadius, padRadius, padHeight, q.cylinderRadialSegs);
    const taperGeo = new THREE.CylinderGeometry(colRadius, padRadius, taperHeight, q.cylinderRadialSegs);

    return { padGeo, padHeight, taperGeo, taperHeight };
}

// ─── Raft Beam ──────────────────────────────────────────────────────────────

/**
 * Build a raft beam (box) between two XZ positions.
 *
 * @param {THREE.Vector3} p1 - first base position (Y-up)
 * @param {THREE.Vector3} p2 - second base position (Y-up)
 * @param {number} [beamW=1.2] - beam width
 * @param {number} [beamH=0.8] - beam height
 * @returns {{ geometry: THREE.BufferGeometry, position: THREE.Vector3, rotationY: number }|null}
 */
export function buildRaftBeamGeo(p1, p2, beamW = 1.2, beamH = 0.8) {
    const dx = p2.x - p1.x;
    const dz = p2.z - p1.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) return null;

    const geometry = new THREE.BoxGeometry(beamW, beamH, dist);
    const position = new THREE.Vector3(
        (p1.x + p2.x) * 0.5,
        beamH / 2,
        (p1.z + p2.z) * 0.5,
    );
    const rotationY = Math.atan2(dx, dz);

    return { geometry, position, rotationY };
}

// ─── Brace Cylinder ─────────────────────────────────────────────────────────

/**
 * Build a brace cylinder between two points.
 *
 * @param {THREE.Vector3} start
 * @param {THREE.Vector3} end
 * @param {number} radius
 * @param {string|object} [quality='medium']
 * @returns {{ geometry: THREE.BufferGeometry, position: THREE.Vector3, quaternion: THREE.Quaternion }|null}
 */
export function buildBraceGeo(start, end, radius, quality = 'medium') {
    const dist = start.distanceTo(end);
    if (dist < 0.01) return null;

    const q = resolveQuality(quality);
    const r = Math.max(0.15, radius);
    const geometry = new THREE.CylinderGeometry(r, r, dist, q.cylinderRadialSegs);

    const position = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const dir = new THREE.Vector3().subVectors(end, start).normalize();
    const cylUp = new THREE.Vector3(0, 1, 0);
    let quaternion = new THREE.Quaternion();
    if (Math.abs(dir.dot(cylUp)) < 0.9999) {
        quaternion = new THREE.Quaternion().setFromUnitVectors(cylUp, dir);
    }

    return { geometry, position, quaternion };
}
