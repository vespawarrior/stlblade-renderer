import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
    zu,
    resolveQuality,
    buildTaperedTubeGeo,
    buildCylinderGeo,
    buildSphereGeo,
    buildTipCapsuleGeo,
    buildBaseFootGeo,
    buildRaftBeamGeo,
    buildBraceGeo,
} from './supportGeometry.js';

// ── Theme (per-app config via setTheme) ──────────────────────────────────
// Colors + tip-reserve are per-app: STLCreator uses a pink theme, the engine
// and runciter use the typed palette below. Geometry/logic is shared. These
// are `let` so setTheme() can override them; references read them at call time.
let SUPPORT_TYPE_COLORS = {
    stub:   0xaa88dd,  // purple — Phase 2 only
    mini:   0xddaa44,  // yellow — Phase 2 only
    light:  0x00ccaa,  // teal
    medium: 0x0088ff,  // blue
    heavy:  0xff6644,  // orange-red
};

let BRACE_COLOR = 0x4488ff;
let RAFT_COLOR = 0x6c63ff;
let TIP_COLOR = 0xffffff;
let ANCHOR_COLOR = 0xff8800;  // orange — model-to-model anchors
let INTERSECT_COLOR = 0xff0000;  // red — last-resort columns that intersect mesh
let PILLAR_MERGE_COLOR = 0x44dd88;  // lime green — pillar merge strategy
let OVERHANG_COLOR = 0xff8800;  // orange — overhang columns (themeable)
let STEEP_COLOR = 0xff00ff;     // magenta — steep-approach columns (themeable)
let BRANCH_COLOR = 0xff00ff;    // magenta — Phase 2 tree branches (themeable)
let TIP_WARNING_COLOR = 0xffaa00;  // amber — tip-near-surface warning (themeable)

// Phase 2 tree palette (10 colors): trunk gets bright variant, branches get dim
let TREE_PALETTE = [
    0x44bbff, 0xff7744, 0x44dd88, 0xdd44aa, 0xaadd44,
    0xff44dd, 0x44ffdd, 0xddaa44, 0x8844ff, 0xff4488,
];
const TREE_TRUNK_BRIGHTNESS = 1.0;
const TREE_BRANCH_BRIGHTNESS = 0.65;

// Preset shaft/tip dimensions (must match presets.py) — geometry, NOT theme.
const PRESET_SHAFT_D = { stub: 0.25, mini: 0.40, light: 1.00, medium: 1.30, heavy: 2.50 };
const PRESET_TIP_D = { stub: 0.10, mini: 0.12, light: 0.20, medium: 0.40, heavy: 0.60 };
let TIP_RESERVE_MM = 3.0;  // Tip zone height — themeable (default 3.0; engine may set 4.5)

// Easy Remove: much thinner supports (must match easy_remove/config.py) — geometry.
const ER_SHAFT_D = { light: 0.30, medium: 0.45 };
const ER_TIP_D = { light: 0.15, medium: 0.20 };
let ER_TIP_RESERVE_MM = 1.5;

// zu() is imported from supportGeometry.js and re-exported
export { zu, QUALITY_PRESETS } from './supportGeometry.js';

// Active quality preset — consumers can change before calling renderSupports
let _quality = 'medium';
let _isER = false;  // Set per render call — Easy Remove mode

export function clearSupports(group) {
    while (group.children.length > 0) {
        const child = group.children[0];
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
            if (Array.isArray(child.material)) {
                child.material.forEach(m => m.dispose());
            } else {
                child.material.dispose();
            }
        }
        group.remove(child);
    }
}

// When true, supports render opaque (no transparency). Transparent materials
// force per-frame depth sorting + overdraw, which is slow for dense support
// sets (e.g. STLCreator on high-res prints). Default keeps the semi-transparent
// look (engine + runciter) so you can see the model through the supports.
let _opaqueSupports = false;

// When true (default), all individual support meshes are merged by material at
// the end of renderSupports → a handful of draw calls instead of hundreds (a
// scene can have hundreds of supports). Set to false for the STLBlade desktop
// DEBUG viewer, which raycasts individual meshes (userData.supportId) to select
// supports — merging would collapse them and break selection.
let _mergeSupports = true;

/** Set the quality preset for all subsequent render calls. */
export function setQuality(q) { _quality = q; }
export function getQuality() { return _quality; }

/**
 * Toggle draw-call merging. true (default) = merge meshes by material (fast,
 * not individually selectable). false = keep individual meshes with userData
 * for click-to-select (STLBlade desktop debug).
 */
export function setMergeSupports(v) { _mergeSupports = !!v; }

/**
 * Per-app theming. Geometry/logic is shared; colors + tip length are per-app.
 * Call once at startup (e.g. STLCreator passes its pink theme). Any field
 * omitted keeps the default (typed palette / 3.0mm tip).
 *
 * @param {object} t
 * @param {object} [t.supportTypeColors]  partial { stub, mini, light, medium, heavy }
 * @param {number} [t.braceColor] [t.raftColor] [t.tipColor] [t.anchorColor]
 * @param {number} [t.intersectColor] [t.pillarMergeColor]
 * @param {number} [t.overhangColor] [t.steepColor] [t.branchColor]
 * @param {number[]} [t.treePalette]
 * @param {number} [t.tipReserveMm]   tip zone height (default 3.0)
 * @param {number} [t.erTipReserveMm] easy-remove tip zone (default 1.5)
 * @param {boolean} [t.opaque] render supports opaque (no transparency) — faster
 *   viewport for dense support sets. Default false (semi-transparent).
 */
export function setTheme(t = {}) {
    if (t.supportTypeColors) {
        SUPPORT_TYPE_COLORS = { ...SUPPORT_TYPE_COLORS, ...t.supportTypeColors };
    }
    if (t.braceColor != null) BRACE_COLOR = t.braceColor;
    if (t.raftColor != null) RAFT_COLOR = t.raftColor;
    if (t.tipColor != null) TIP_COLOR = t.tipColor;
    if (t.anchorColor != null) ANCHOR_COLOR = t.anchorColor;
    if (t.intersectColor != null) INTERSECT_COLOR = t.intersectColor;
    if (t.pillarMergeColor != null) PILLAR_MERGE_COLOR = t.pillarMergeColor;
    if (t.overhangColor != null) OVERHANG_COLOR = t.overhangColor;
    if (t.steepColor != null) STEEP_COLOR = t.steepColor;
    if (t.branchColor != null) BRANCH_COLOR = t.branchColor;
    if (t.tipWarningColor != null) TIP_WARNING_COLOR = t.tipWarningColor;
    if (t.treePalette) TREE_PALETTE = t.treePalette;
    if (t.tipReserveMm != null) TIP_RESERVE_MM = t.tipReserveMm;
    if (t.erTipReserveMm != null) ER_TIP_RESERVE_MM = t.erTipReserveMm;
    if (t.opaque != null) _opaqueSupports = t.opaque;
}

export function renderSupports(group, supports, columns, braces, raft, phase = 'coverage') {
    clearSupports(group);

    const isER = phase === 'easy_remove' || phase === 'easy_remove_optimized';
    _isER = isER;  // Store for renderBraces and other helpers

    // Build support type lookup (used by multiple render functions)
    const typeById = {};
    if (supports) supports.forEach(sp => { typeById[sp.id] = sp.support_type || 'medium'; });

    const basePositions = [];

    if (columns && columns.length > 0) {
        renderColumns(group, columns, supports, isER);
        renderBaseFeet(group, columns, typeById, isER);
        renderAnchorTips(group, columns);
        renderJointSpheres(group, columns, typeById);
    }

    if (supports && supports.length > 0) {
        renderTips(group, supports, columns, isER);
        supports.forEach(s => {
            if (s.base) basePositions.push(s.base);
        });
    }

    if (braces && braces.length > 0) {
        renderBraces(group, braces, supports, columns);
    }

    if (columns && columns.length > 0) {
        renderRaftLattice(group, columns);
    } else if (raft && basePositions.length > 0) {
        renderRaftLattice(group, null, basePositions);
    }

    // Opaque mode (setTheme({opaque:true})): strip transparency from every
    // support material so the GPU skips per-frame depth sorting + overdraw.
    if (_opaqueSupports) {
        group.traverse((o) => {
            const m = o.material;
            if (!m) return;
            (Array.isArray(m) ? m : [m]).forEach((mm) => {
                mm.transparent = false;
                mm.opacity = 1;
            });
        });
    }

    // Merge by material → few draw calls (default). Skipped in debug mode so
    // individual meshes stay selectable. Must run AFTER opaque so the merged
    // meshes inherit the (mutated) material refs.
    if (_mergeSupports) {
        _mergeSupportMeshes(group);
    }
}

/**
 * Merge all individual support meshes by material into one mesh per material
 * (fewer draw calls). Skips InstancedMesh / multi-material meshes. Bakes each
 * mesh's transform into a cloned geometry, strips to position+normal so every
 * geometry in a bucket shares the same attribute set (mergeGeometries requires
 * that), and groups by material reference. Falls back to keeping the originals
 * if a bucket fails to merge.
 */
function _mergeSupportMeshes(group) {
    // Group by material *appearance* (not instance ref) so meshes that look
    // identical but come from separate render calls collapse into one draw call.
    const byKey = new Map(); // key -> { mat, meshes: [], geos: [] }
    const matKey = (m) =>
        `${m.color?.getHex?.() ?? 0}|${m.opacity}|${m.transparent}|` +
        `${m.emissive?.getHex?.() ?? 0}|${m.type}`;
    for (const child of group.children) {
        if (!child.isMesh || child.isInstancedMesh) continue;
        if (!child.geometry || !child.material || Array.isArray(child.material)) continue;
        const key = matKey(child.material);
        let entry = byKey.get(key);
        if (!entry) { entry = { mat: child.material, meshes: [], geos: [] }; byKey.set(key, entry); }
        child.updateMatrix();
        let g = child.geometry.clone();
        g.applyMatrix4(child.matrix);
        if (g.index) g = g.toNonIndexed();
        for (const name of Object.keys(g.attributes)) {
            if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
        }
        if (!g.attributes.normal) g.computeVertexNormals();
        entry.meshes.push(child);
        entry.geos.push(g);
    }
    for (const entry of byKey.values()) {
        if (entry.meshes.length < 2) { entry.geos.forEach(g => g.dispose()); continue; }
        let merged = null;
        try { merged = mergeGeometries(entry.geos, false); } catch { merged = null; }
        entry.geos.forEach(g => g.dispose());
        if (!merged) continue; // merge failed → keep originals
        for (const m of entry.meshes) { group.remove(m); m.geometry.dispose(); }
        const mesh = new THREE.Mesh(merged, entry.mat);
        mesh.userData.type = 'merged-supports';
        group.add(mesh);
    }
}

/** Dim a hex color by a brightness factor (0-1). */
function dimColor(hex, factor) {
    const r = Math.round(((hex >> 16) & 0xff) * factor);
    const g = Math.round(((hex >> 8) & 0xff) * factor);
    const b = Math.round((hex & 0xff) * factor);
    return (r << 16) | (g << 8) | b;
}

function renderColumnsInstanced(group, cols, color) {
    const q = resolveQuality(_quality);
    const tempGeo = new THREE.CylinderGeometry(0.15, 0.3, 1, q.cylinderRadialSegs);
    const mat = new THREE.MeshPhongMaterial({ color, transparent: true, opacity: 0.85 });
    const instancedMesh = new THREE.InstancedMesh(tempGeo, mat, cols.length);
    const dummy = new THREE.Object3D();

    cols.forEach((col, i) => {
        const path = col.path;
        if (!path || path.length < 2) return;

        const start = zu(path[0][0], path[0][1], path[0][2]);
        const end = zu(
            path[path.length - 1][0],
            path[path.length - 1][1],
            path[path.length - 1][2]
        );

        const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
        const height = start.distanceTo(end);

        dummy.position.copy(mid);
        dummy.scale.set(1, Math.max(height, 0.1), 1);

        const dir = new THREE.Vector3().subVectors(end, start).normalize();
        const up = new THREE.Vector3(0, 1, 0);
        const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
        dummy.quaternion.copy(quat);

        dummy.updateMatrix();
        instancedMesh.setMatrixAt(i, dummy.matrix);
    });

    instancedMesh.instanceMatrix.needsUpdate = true;
    instancedMesh.userData.type = 'columns';
    group.add(instancedMesh);
}

function renderColumnsIndividual(group, cols, color, stype, isER = false, hostIndex = null) {
    const mat = new THREE.MeshPhongMaterial({ color, transparent: true, opacity: 0.85 });

    // ── Host segments for anchor snapping. `hostIndex` (built once in
    //    renderColumns from ALL columns) carries {all, byId}: the anchor
    //    branch snaps each merge's pillar-side endpoint onto its host
    //    column's SURFACE — measured against the actual centerline
    //    polyline, not just the discrete waypoints. Falling back to
    //    group-local segments (legacy) is WRONG for cross-type merges: a
    //    'light' merge whose host pillar is 'medium' didn't even have its
    //    true host in the candidate set, so the nearest-hit heuristic
    //    teleported it onto an unrelated pillar (0008 75mm: 6mm struts
    //    drawn as long threads crossing the bow).
    const hostShaftLookup = isER ? ER_SHAFT_D : PRESET_SHAFT_D;
    let hostSegments;
    let hostSegmentsById;
    if (hostIndex) {
        hostSegments = hostIndex.all;
        hostSegmentsById = hostIndex.byId;
    } else {
        hostSegments = [];
        hostSegmentsById = new Map();
        for (const col of cols) {
            if (col.is_anchor) continue;
            const path = col.path;
            if (!path || path.length < 2) continue;
            const r =
                (hostShaftLookup[stype] || col.base_diameter_mm ||
                    (isER ? 0.45 : 1.0)) * 0.5;
            const pts = path.map(p => zu(p[0], p[1], p[2]));
            const segs = [];
            for (let i = 0; i < pts.length - 1; i++) {
                const seg = { a: pts[i], b: pts[i + 1], radius: r };
                hostSegments.push(seg);
                segs.push(seg);
            }
            hostSegmentsById.set(col.support_id, segs);
        }
    }

    /**
     * Find the closest point on any non-anchor column segment to `p`,
     * plus the host column's radius. Returns null when no segments
     * exist. Used both to pick which end of an anchor is the
     * column-side and to compute the surface snap.
     */
    function nearestHostHit(p, segments = hostSegments) {
        if (segments.length === 0) return null;
        let bestPt = null;
        let bestRadius = 0;
        let bestDist2 = Infinity;
        for (const seg of segments) {
            const ab = new THREE.Vector3().subVectors(seg.b, seg.a);
            const ap = new THREE.Vector3().subVectors(p, seg.a);
            const denom = ab.lengthSq();
            if (denom < 1e-12) continue;
            const t = Math.max(0, Math.min(1, ap.dot(ab) / denom));
            const closest = new THREE.Vector3()
                .copy(seg.a)
                .addScaledVector(ab, t);
            const d2 = p.distanceToSquared(closest);
            if (d2 < bestDist2) {
                bestDist2 = d2;
                bestPt = closest;
                bestRadius = seg.radius;
            }
        }
        if (!bestPt) return null;
        return { point: bestPt, radius: bestRadius, dist2: bestDist2 };
    }

    /**
     * Snap an anchor endpoint outward onto the host column's surface.
     * Uses `nearestHostHit` for the centerline projection, then
     * projects `endpoint` outward by `host.radius` along the direction
     * `towards - hostPoint` so the snapped position sits on the
     * rendered tube surface where the anchor naturally exits.
     *
     * Slop check uses `max(R * 15, 25 mm)`. STLBlade's column-side
     * endpoint offset grows with print scale: 32 mm characters have
     * it bounded around 5 mm, 75 mm prints (every coordinate scaled
     * ~2.3×) push it past 18 mm. Tighter bounds left anchors dangling
     * on the 75 mm rebake.
     */
    function snapToHostSurface(endpoint, towards, segments = hostSegments) {
        const hit = nearestHostHit(endpoint, segments);
        if (!hit) return endpoint;
        const slop = Math.max(hit.radius * 15, 25);
        if (Math.sqrt(hit.dist2) > slop) return endpoint;
        const dir = new THREE.Vector3().subVectors(towards, hit.point);
        if (dir.lengthSq() < 1e-8) return endpoint;
        dir.normalize();
        return new THREE.Vector3()
            .copy(hit.point)
            .addScaledVector(dir, hit.radius);
    }

    cols.forEach((col) => {
        const path = col.path;
        if (!path || path.length < 2) return;

        // Metadata for click-to-select debug
        const colMeta = {
            supportId: col.support_id,
            strategy: col.strategy || '?',
            treeId: col.tree_id,
            isTrunk: col.is_trunk,
            isBranch: col.is_branch,
            intersects: col.intersects_mesh,
            source: col.source,
            supportType: stype,
        };

        // Anchored columns: tapered frustum (thick at base, thin at contact)
        // path[0]=base (pillar/support end) → thick
        // path[-1]=contact (model surface) → thin
        // Strategy/target beat the is_anchor flag — but ONLY for hanging
        // merges. pillar_merge_extended columns legitimately reach the
        // plate (path from z=0) with is_anchor=false: those are grounded
        // pillars that also touch a host and must render as normal
        // columns WITH a foot. A hanging merge (lowest point above the
        // plate) missing its flag is Phase 2's flag-stripping; render it
        // as the merge cone it really is.
        let _lowestZ = Infinity;
        for (const p of path) { if (p[2] < _lowestZ) _lowestZ = p[2]; }
        const _mergeish = col.strategy === 'pillar_merge'
            || col.target_pillar_id != null;
        if (col.is_anchor || (_mergeish && _lowestZ > 1.5)) {
            const pts = path.map(p => zu(p[0], p[1], p[2]));
            // Host-snapping applies ONLY to pillar_merge anchors — they
            // exit a host column and the snap glues the exit point onto
            // the rendered tube. Model-to-model anchors ('anchor' /
            // 'anchor_bezier') have BOTH endpoints on the model surface:
            // snapping one of them teleported it up to 25 mm (the slop)
            // onto an unrelated pillar, drawing long cones that end in
            // mid-air or cross geometry the real strut never touches.
            const isPillarMerge = col.strategy === 'pillar_merge'
                || col.target_pillar_id != null;
            // STLBlade's documented convention is path[0]=column-side,
            // path[-1]=model-contact, but ~16% of anchors come out
            // flipped (model end at index 0). Pick whichever endpoint
            // sits closer to a host segment and snap THAT one — the
            // other end stays put (it's the model contact).
            // TARGETED: when the schema names the host
            // (target_pillar_id) the search runs over THAT pillar's
            // segments only — the global nearest-hit picked unrelated
            // pillars within the 25mm slop. GUARDED: a snap is a glue
            // correction; if it would displace the endpoint further
            // than the strut's own length, it's a teleport — revert.
            if (isPillarMerge && pts.length >= 2) {
                const targetSegs = col.target_pillar_id != null
                    ? hostSegmentsById.get(col.target_pillar_id)
                    : null;
                const searchSegs = (targetSegs && targetSegs.length)
                    ? targetSegs
                    : hostSegments;
                let strutLen = 0;
                for (let j = 0; j < pts.length - 1; j++) {
                    strutLen += pts[j].distanceTo(pts[j + 1]);
                }
                const hitStart = nearestHostHit(pts[0], searchSegs);
                const hitEnd = nearestHostHit(pts[pts.length - 1], searchSegs);
                const dStart = hitStart ? hitStart.dist2 : Infinity;
                const dEnd = hitEnd ? hitEnd.dist2 : Infinity;
                const snapIdx = dStart <= dEnd ? 0 : pts.length - 1;
                const towards = snapIdx === 0 ? pts[1] : pts[pts.length - 2];
                const before = pts[snapIdx].clone();
                const snapped = snapToHostSurface(pts[snapIdx], towards, searchSegs);
                if (snapped.distanceTo(before) <= Math.max(strutLen, 2.0)) {
                    pts[snapIdx] = snapped;
                }
            }
            let totalLen = 0;
            for (let j = 0; j < pts.length - 1; j++) totalLen += pts[j].distanceTo(pts[j + 1]);
            if (totalLen < 0.01) return;

            // Base radius (pillar end): adaptive, scales with length
            const shaftLU = isER ? ER_SHAFT_D : PRESET_SHAFT_D;
            const shaftR = (shaftLU[stype] || (isER ? 0.45 : 1.0)) * 0.5;
            const minBaseR = isER ? 0.08 : 0.15;
            const maxBaseR = shaftR * 0.5;
            const t = Math.max(0, Math.min(1, (totalLen - 2.0) / 8.0));
            let baseR = minBaseR + t * (maxBaseR - minBaseR);
            baseR = Math.min(baseR, totalLen / 8.0); // aspect ratio: diameter ≤ 1/4 of length

            // Tip radius (contact end): small for clean surface contact,
            // FLOORED at 0.06 — sub-pixel cone tips crumble into open
            // micro-rings after slicer-import welding (Lychee holes).
            const anchorTipR = Math.max(0.06, Math.min(0.08, baseR * 0.5));

            const anchorMat = new THREE.MeshPhongMaterial({
                color: ANCHOR_COLOR, transparent: true, opacity: 0.85,
            });

            // Smooth tapered tube for anchor paths
            if (pts.length >= 3) {
                const tube = buildTaperedTube(pts, (t) => {
                    return baseR + (anchorTipR - baseR) * t;
                }, anchorMat);
                if (tube) {
                    tube.userData.type = 'columns';
                    if (colMeta) Object.assign(tube.userData, colMeta);
                    group.add(tube);
                }
            } else {
                for (let si = 0; si < pts.length - 1; si++) {
                    const h = pts[si].distanceTo(pts[si + 1]);
                    if (h > 0.01) {
                        const t0 = si / (pts.length - 1);
                        const t1 = (si + 1) / (pts.length - 1);
                        const r0 = baseR + (anchorTipR - baseR) * t0;
                        const r1 = baseR + (anchorTipR - baseR) * t1;
                        renderOneCylinder(
                            group,
                            pts[si], pts[si + 1], h,
                            r0, r1, 0, 1, anchorMat, colMeta,
                        );
                    }
                }
            }

            // Sphere cap at base (pillar connection end)
            const baseSphere = new THREE.Mesh(buildSphereGeo(baseR, _quality), anchorMat);
            baseSphere.position.copy(pts[0]);
            baseSphere.userData.type = 'columns';
            Object.assign(baseSphere.userData, colMeta);
            group.add(baseSphere);

            // Sphere cap at tip (contact end) — only when it prints
            // (sub-pixel micro-spheres just feed the slicer's repair
            // counter; the cone is closed on its own).
            if (anchorTipR >= 0.1) {
                const tipSphere = new THREE.Mesh(buildSphereGeo(anchorTipR, _quality), anchorMat);
                tipSphere.position.copy(pts[pts.length - 1]);
                tipSphere.userData.type = 'columns';
                Object.assign(tipSphere.userData, colMeta);
                group.add(tipSphere);
            }

            return;
        }

        // Use preset shaft/tip diameters — Easy Remove uses thinner values
        const shaftLookup = isER ? ER_SHAFT_D : PRESET_SHAFT_D;
        const tipLookup = isER ? ER_TIP_D : PRESET_TIP_D;
        const baseR = (shaftLookup[stype] || col.base_diameter_mm || (isER ? 0.45 : 1.0)) * 0.5;
        const tipR = (tipLookup[stype] || col.tip_diameter_mm || (isER ? 0.20 : 0.4)) * 0.5;
        const tipReserveMM = isER ? ER_TIP_RESERVE_MM : TIP_RESERVE_MM;

        // Path convention: path[0]=base (Z≈0), path[-1]=contact (on model)
        // Reserve space at the contact end for the tip.
        // For short branches, cap tip zone to 30% of total path length
        // so the shaft stays visible and connects to the trunk.
        // Trunks: NO tip reserve (path[-1] is junction, not contact)
        let totalPathLen = 0;
        for (let j = 0; j < path.length - 1; j++) {
            const dx = path[j+1][0]-path[j][0], dy = path[j+1][1]-path[j][1], dz = path[j+1][2]-path[j][2];
            totalPathLen += Math.sqrt(dx*dx + dy*dy + dz*dz);
        }
        const tipReserve = (col.is_trunk && col.tree_id != null)
            ? 0
            : Math.min(tipReserveMM, totalPathLen * 0.3);

        // Convert all path points to Y-up coordinates
        const pts = path.map(p => zu(p[0], p[1], p[2]));

        // Build trimmed point list: remove points inside tip reserve zone
        // Walk backwards from contact end (pts[-1]) to find cut point
        const trimmedPts = [];
        let distFromContact = 0;
        for (let j = pts.length - 1; j >= 1; j--) {
            const segLen = pts[j - 1].distanceTo(pts[j]);
            if (distFromContact + segLen > tipReserve) {
                // This segment crosses the tip boundary — add cut point + rest
                if (distFromContact < tipReserve) {
                    const overshoot = tipReserve - distFromContact;
                    const ratio = 1.0 - overshoot / segLen;
                    trimmedPts.unshift(pts[j - 1].clone().lerp(pts[j], ratio));
                } else {
                    trimmedPts.unshift(pts[j]);
                }
            }
            distFromContact += segLen;
        }
        trimmedPts.unshift(pts[0]);

        // Smooth tube for multi-point paths, per-segment cylinders for
        // 2-point AND for Phase 2 trunks. Phase 2 branches anchor their
        // path[0] to the exact junction point on the parent trunk; if the
        // trunk renders as a Catmull-Rom spline that centre line drifts
        // away from those waypoints, the branches end up dangling in
        // mid-air. Per-segment cylinders pass through every waypoint by
        // construction, so the branches stay attached.
        const isPhase2Trunk = col.is_trunk && col.tree_id != null;
        if (trimmedPts.length >= 3 && !isPhase2Trunk) {
            const tube = buildTaperedTube(trimmedPts, () => baseR, mat);
            if (tube) {
                tube.userData.type = 'columns';
                if (colMeta) Object.assign(tube.userData, colMeta);
                group.add(tube);
            }
        } else {
            for (let si = 0; si < trimmedPts.length - 1; si++) {
                let segEnd = trimmedPts[si + 1];
                // Interior joints: extend 0.06mm into the next segment.
                // Butt-joined segments share an EXACT cap disc; slicer
                // imports weld those into open rings ("holes" in Lychee).
                // A real overlap keeps each shell independently closed.
                if (si < trimmedPts.length - 2) {
                    const d = new THREE.Vector3()
                        .subVectors(trimmedPts[si + 1], trimmedPts[si]);
                    if (d.lengthSq() > 1e-12) {
                        segEnd = trimmedPts[si + 1].clone()
                            .add(d.normalize().multiplyScalar(0.06));
                    }
                }
                const height = trimmedPts[si].distanceTo(segEnd);
                if (height > 0.01) {
                    renderOneCylinder(
                        group,
                        trimmedPts[si], segEnd, height,
                        baseR, baseR, 0, 1, mat, colMeta,
                    );
                }
            }
        }
    });
}

/** Thin wrapper: build tube geometry from shared module, attach material. */
function buildTaperedTube(pts, radiusFn, mat) {
    const geo = buildTaperedTubeGeo(pts, radiusFn, _quality);
    if (!geo) return null;
    return new THREE.Mesh(geo, mat);
}

/** Render a single cylinder/frustum segment of a column. */
function renderOneCylinder(group, start, end, height, baseR, tipR, segIdx, nSeg, mat, colMeta) {
    const q = resolveQuality(_quality);
    const rBot = Math.max(baseR, 0.04);
    const rTop = Math.max(tipR, 0.04);
    // CylinderGeometry(radiusTop, radiusBottom, height) — top=end, bottom=start
    const geo = new THREE.CylinderGeometry(rTop, rBot, height, q.cylinderRadialSegs);
    const position = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const dir = new THREE.Vector3().subVectors(end, start).normalize();
    const cylUp = new THREE.Vector3(0, 1, 0);
    let quaternion = new THREE.Quaternion();
    if (Math.abs(dir.dot(cylUp)) < 0.9999) {
        quaternion = new THREE.Quaternion().setFromUnitVectors(cylUp, dir);
    }
    const cyl = new THREE.Mesh(geo, mat);
    cyl.position.copy(position);
    cyl.quaternion.copy(quaternion);
    cyl.userData.type = 'columns';
    if (colMeta) Object.assign(cyl.userData, colMeta);
    group.add(cyl);
}

/** Render a sphere at the junction point (top of trunk) where branches originate. */
function renderJunctionSpheres(group, trunks, color) {
    const mat = new THREE.MeshPhongMaterial({
        color,
        emissive: Math.floor(color * 0.2) & 0xfefefe,
    });
    const SHAFT_D = { stub: 0.25, mini: 0.40, light: 1.00, medium: 1.30, heavy: 2.50 };

    trunks.forEach(col => {
        const path = col.path;
        if (!path || path.length < 2) return;
        // Junction = last point of trunk path
        const junc = path[path.length - 1];
        const pos = zu(junc[0], junc[1], junc[2]);
        // Sphere radius = actual trunk diameter (exact match with cylinder),
        // CLAMPED to the junction height: a low junction (seen at z=0.57 on
        // a d=3.0 trunk) otherwise pokes ~1mm BELOW the build plate — the
        // slicer then rests the print on the ball instead of the raft.
        const sphereR = Math.min(
            Math.max((col.base_diameter_mm || 1.0) * 0.5, 0.08),
            Math.max(pos.y, 0.08),
        );
        const geo = buildSphereGeo(sphereR, _quality);
        const sphere = new THREE.Mesh(geo, mat);
        sphere.position.copy(pos);
        sphere.userData.type = 'columns';
        group.add(sphere);
    });
}

/** Render spheres at every joint between two cylinder segments in branches.
 *  Always placed — the tip capsule renders on top and hides it if needed. */
function renderKneeSpheres(group, branches, color) {
    // Branches with 3+ points are now rendered as smooth tubes — no knee spheres needed
}

function renderColumns(group, columns, supports, isER = false) {
    // Build support_type lookup from supports by id
    const typeById = {};
    const sourceById = {};
    if (supports) {
        supports.forEach(sp => {
            typeById[sp.id] = sp.support_type || 'medium';
            sourceById[sp.id] = sp.source || 'overhang';
        });
    }

    // Separate Phase 2 tree columns (must have tree_id) from legacy columns
    const treeColumns = columns.filter(c => c.tree_id != null && (c.is_trunk || c.is_branch));
    const legacyColumns = columns.filter(c => c.tree_id == null || (!c.is_trunk && !c.is_branch));

    // ── Global host-segment index for anchor snapping ────────────────
    // Built ONCE over ALL non-anchor columns (with per-column radius from
    // its real type) and passed to every renderColumnsIndividual group.
    // The old group-local collection meant a merge could only snap onto
    // hosts of ITS OWN type — a 'light' merge with a 'medium' host pillar
    // didn't even see it, and the nearest-hit heuristic teleported the
    // endpoint onto an unrelated pillar within the 25mm slop.
    const hostShaftLU = isER ? ER_SHAFT_D : PRESET_SHAFT_D;
    const hostIndex = { all: [], byId: new Map() };
    for (const col of columns) {
        if (col.is_anchor) continue;
        const path = col.path;
        if (!path || path.length < 2) continue;
        const st = typeById[col.support_id] || 'medium';
        const r = (hostShaftLU[st] || col.base_diameter_mm || (isER ? 0.45 : 1.0)) * 0.5;
        const pts = path.map(p => zu(p[0], p[1], p[2]));
        const segs = [];
        for (let i = 0; i < pts.length - 1; i++) {
            const seg = { a: pts[i], b: pts[i + 1], radius: r };
            hostIndex.all.push(seg);
            segs.push(seg);
        }
        hostIndex.byId.set(col.support_id, segs);
    }

    // Separate steep-approach columns (render in bright magenta — impossible to miss)
    const steepApproach = legacyColumns.filter(c => c.steep_approach);
    if (steepApproach.length > 0) {
        console.log(`[STLBlade] Steep-approach columns: ${steepApproach.length}`);
        // Group by real support type so shaft diameter matches
        const steepByType = {};
        steepApproach.forEach(col => {
            const st = typeById[col.support_id] || 'medium';
            if (!steepByType[st]) steepByType[st] = [];
            steepByType[st].push(col);
        });
        for (const [st, cols] of Object.entries(steepByType)) {
            renderColumnsIndividual(group, cols, STEEP_COLOR, st, isER, hostIndex);
        }
    }
    const nonSteep = legacyColumns.filter(c => !c.steep_approach);

    // Separate intersecting columns (render in red)
    const intersecting = nonSteep.filter(c => c.intersects_mesh);
    const normal = nonSteep.filter(c => !c.intersects_mesh);

    // Separate pillar_merge columns (render in lime green)
    const pillarMerge = normal.filter(c => c.strategy === 'pillar_merge');
    const nonMerge = normal.filter(c => c.strategy !== 'pillar_merge');

    if (pillarMerge.length > 0) {
        const mergeByType = {};
        pillarMerge.forEach(col => {
            const st = typeById[col.support_id] || 'medium';
            if (!mergeByType[st]) mergeByType[st] = [];
            mergeByType[st].push(col);
        });
        for (const [st, cols] of Object.entries(mergeByType)) {
            renderColumnsIndividual(group, cols, PILLAR_MERGE_COLOR, st, isER, hostIndex);
        }
    }

    // Separate overhang columns from island columns (OVERHANG_COLOR is themeable)
    const overhangCols = nonMerge.filter(c => sourceById[c.support_id] === 'overhang');
    const islandCols = nonMerge.filter(c => sourceById[c.support_id] !== 'overhang');
    if (overhangCols.length > 0) {
        console.log(`[STLBlade] Overhang columns: ${overhangCols.length} (orange)`);
        const ohByType = {};
        overhangCols.forEach(col => {
            const st = typeById[col.support_id] || 'medium';
            if (!ohByType[st]) ohByType[st] = [];
            ohByType[st].push(col);
        });
        for (const [st, cols] of Object.entries(ohByType)) {
            renderColumnsIndividual(group, cols, OVERHANG_COLOR, st, isER, hostIndex);
        }
    }

    // Group island columns by support type (light/medium/heavy)
    const byType = {};
    let missingCount = 0;
    islandCols.forEach(col => {
        const stype = typeById[col.support_id] || 'medium';
        if (!typeById[col.support_id]) missingCount++;
        if (!byType[stype]) byType[stype] = [];
        byType[stype].push(col);
    });
    if (missingCount > 0) {
        console.warn(`[STLBlade] ${missingCount}/${normal.length} columns have support_id not in supports list — defaulting to 'medium'`);
        // Log first few missing
        const missing = normal.filter(c => !typeById[c.support_id]).slice(0, 5);
        missing.forEach(c => console.warn(`  col.support_id=${c.support_id}, base_d=${c.base_diameter_mm}, tip_d=${c.tip_diameter_mm}`));
    }
    console.log('[STLBlade] Column type distribution:', Object.fromEntries(Object.entries(byType).map(([k,v]) => [k, v.length])));

    for (const [stype, cols] of Object.entries(byType)) {
        const color = SUPPORT_TYPE_COLORS[stype] || 0x0088ff;
        renderColumnsIndividual(group, cols, color, stype, isER, hostIndex);
    }

    // Render intersecting columns in red, grouped by type for correct thickness
    if (intersecting.length > 0) {
        const intByType = {};
        intersecting.forEach(col => {
            const st = typeById[col.support_id] || 'medium';
            if (!intByType[st]) intByType[st] = [];
            intByType[st].push(col);
        });
        for (const [st, cols] of Object.entries(intByType)) {
            renderColumnsIndividual(group, cols, INTERSECT_COLOR, st, isER, hostIndex);
        }
    }

    // Render Phase 2 tree columns grouped by tree_id with palette colors
    if (treeColumns.length > 0) {
        const byTree = {};
        treeColumns.forEach(col => {
            const tid = col.tree_id ?? 0;
            if (!byTree[tid]) byTree[tid] = [];
            byTree[tid].push(col);
        });
        for (const [tid, cols] of Object.entries(byTree)) {
            const baseColor = TREE_PALETTE[tid % TREE_PALETTE.length];
            // Trunks: full brightness; Branches: dimmed
            const trunks = cols.filter(c => c.is_trunk);
            const branches = cols.filter(c => c.is_branch);
            if (trunks.length > 0) {
                // Trunk uses the type of its owning branch (heaviest member)
                const trunkType = (trunks[0].trunk_owner_id != null && typeById[trunks[0].trunk_owner_id])
                    ? typeById[trunks[0].trunk_owner_id] : 'medium';
                renderColumnsIndividual(group, trunks, baseColor, trunkType, isER);
                renderJunctionSpheres(group, trunks, baseColor);
            }
            if (branches.length > 0) {
                // Render each branch at its actual support type for correct thickness
                const branchesByType = {};
                branches.forEach(br => {
                    const st = typeById[br.support_id] || 'medium';
                    if (!branchesByType[st]) branchesByType[st] = [];
                    branchesByType[st].push(br);
                });
                for (const [st, brs] of Object.entries(branchesByType)) {
                    renderColumnsIndividual(group, brs, BRANCH_COLOR, st, isER);
                }
                // Knee spheres at intermediate waypoints of tiered branches
                renderKneeSpheres(group, branches, baseColor);
            }
        }
    }
}

function renderBaseFeet(group, columns, typeById, isER = false) {
    const footMat = new THREE.MeshPhongMaterial({
        color: RAFT_COLOR,
        transparent: true,
        opacity: 0.8,
    });

    columns.forEach((col) => {
        if (col.is_anchor) return;  // Anchored columns have no base foot
        if (col.is_branch) return;  // Phase 2 branches start at junction, no foot
        const path = col.path;
        if (!path || path.length < 1) return;
        // Find lowest-Z point in path (base = build plate side)
        let bp = path[0];
        for (let i = 1; i < path.length; i++) {
            if (path[i][2] < bp[2]) bp = path[i];
        }
        // Feet exist to weld the column to the RAFT — a "base" that isn't
        // at plate level means the column hangs from something else
        // (or from nothing: an engine bug upstream). Either way a
        // floating foot is always wrong: skip it.
        if (bp[2] > 1.5) return;
        const base = zu(bp[0], bp[1], bp[2]);

        // Use preset shaft diameter for consistent sizing per type
        const stype = (typeById && typeById[col.support_id]) || 'medium';
        const shaftLU = isER ? ER_SHAFT_D : PRESET_SHAFT_D;
        const colRadius = (shaftLU[stype] || col.base_diameter_mm || (isER ? 0.45 : 1.0)) * 0.5;
        const foot = buildBaseFootGeo(colRadius, _quality);

        const pad = new THREE.Mesh(foot.padGeo, footMat);
        pad.position.copy(base);
        pad.position.y += foot.padHeight / 2;
        pad.userData.type = 'raft';
        group.add(pad);

        const taper = new THREE.Mesh(foot.taperGeo, footMat);
        taper.position.copy(base);
        // Sink the taper 0.1mm INTO the pad: butt-joining them leaves two
        // coincident coplanar cap discs that slicer imports weld into
        // non-manifold junk (Lychee repair flag). Overlap is invisible
        // (0.1mm) and each shell stays independently closed.
        taper.position.y += foot.padHeight + foot.taperHeight / 2 - 0.1;
        taper.userData.type = 'raft';
        group.add(taper);
    });
}

/** Anchor tips — anchored columns render as plain cylinders, no special tips. */
function renderAnchorTips(group, columns) {
    // Intentionally empty: anchored columns are rendered as simple thin
    // cylinders in _renderColumnsIndividual, no extra geometry needed.
}

/** Render spheres at ALL intermediate waypoints in column paths.
 *  Covers seams between cylinder segments to prevent island geometry in exports.
 *  Skipped for columns with 3+ points (rendered as smooth tubes). */
function renderJointSpheres(group, columns, typeById) {
    if (!columns || columns.length === 0) return;

    const jointMat = new THREE.MeshPhongMaterial({
        color: 0xcccccc,
        emissive: 0x222222,
    });

    // Collect joint points: every intermediate waypoint outside tip/base zones
    const joints = new Map(); // "x,y,z" -> maxRadius

    columns.forEach(col => {
        if (col.is_anchor) return;
        if (col.is_branch) return;  // Tiered branches handled by _renderKneeSpheres
        const path = col.path;
        if (!path || path.length < 3) return;
        // Columns with 3+ points are now rendered as smooth tubes — no seam spheres needed
        return;

        // Use preset shaft diameter (same as cylinder rendering) instead of col.base_diameter_mm
        const stype = (typeById && typeById[col.support_id]) || 'medium';
        const colR = (PRESET_SHAFT_D[stype] || col.base_diameter_mm || 1.0) * 0.5;
        const tipReserve = TIP_RESERVE_MM;

        const pts = path.map(p => zu(p[0], p[1], p[2]));

        // Walk backwards from contact to compute cumulative distance
        const distFromContact = new Array(path.length).fill(0);
        for (let j = path.length - 2; j >= 0; j--) {
            distFromContact[j] = distFromContact[j + 1] + pts[j].distanceTo(pts[j + 1]);
        }

        const baseFoot = Math.max(1.5, colR * 1.5);

        // Sphere at EVERY intermediate waypoint (covers cylinder seams)
        for (let i = 1; i < path.length - 1; i++) {
            if (distFromContact[i] < tipReserve) continue;
            if (distFromContact[i] > distFromContact[0] - baseFoot) continue;

            const curr = path[i];
            const key = curr.map(v => v.toFixed(1)).join(',');

            // Use constant shaft radius (matches cylinder rendering)
            const existing = joints.get(key);
            const r = Math.max(colR, existing || 0);
            joints.set(key, r);
        }
    });

    // Render spheres scaled to match column thickness at that height
    const JOINT_SCALE = 1.0;
    joints.forEach((radius, key) => {
        const [x, y, z] = key.split(',').map(Number);
        const geo = buildSphereGeo(radius * JOINT_SCALE, _quality);
        const sphere = new THREE.Mesh(geo, jointMat);
        sphere.position.copy(zu(x, y, z));
        sphere.userData.type = 'columns';
        group.add(sphere);
    });
}

function renderTips(group, supports, columns, isER = false) {
    const tipMatNormal = new THREE.MeshPhongMaterial({
        color: TIP_COLOR,
        emissive: 0x333333,
    });
    const tipMatIntersect = new THREE.MeshPhongMaterial({
        color: INTERSECT_COLOR,
        emissive: 0x330000,
    });
    const tipMatWarning = new THREE.MeshPhongMaterial({
        color: TIP_WARNING_COLOR,
        emissive: 0x332200,
    });

    // Build column lookup by support_id
    const colById = {};
    if (columns) {
        columns.forEach(col => { colById[col.support_id] = col; });
    }

    supports.forEach((sp) => {
        if (!sp.contact) return;

        const col = colById[sp.id];
        // Skip anchored columns — they render as plain thin cylinders, no tip
        if (col && col.is_anchor) return;
        // Skip Phase 2 trunks — they terminate at junction, no contact tip
        if (col && col.is_trunk && col.tree_id != null) return;

        // Red = column penetrates mesh, Orange = only tip intersects (warning)
        const isIntersecting = col && col.intersects_mesh;
        const isTipWarning = col && !col.intersects_mesh && col.tip_intersects_mesh;
        const tipMat = isIntersecting ? tipMatIntersect : (isTipWarning ? tipMatWarning : tipMatNormal);

        // Use preset shaft diameter for consistent sizing per type
        const stype = sp.support_type || 'medium';
        const shaftLU = isER ? ER_SHAFT_D : PRESET_SHAFT_D;
        const tipLU = isER ? ER_TIP_D : PRESET_TIP_D;
        const shaftR = (shaftLU[stype] || (isER ? 0.45 : 1.0)) * 0.5;
        const tipR = (tipLU[stype] || (isER ? 0.20 : 0.2)) * 0.5;
        const contactPos = zu(sp.contact[0], sp.contact[1], sp.contact[2]);

        // tipReserve must match _renderColumnsIndividual.
        // Cap to 30% of path length for short branches.
        let tipPathLen = 0;
        if (col && col.path) {
            for (let k = 0; k < col.path.length - 1; k++) {
                const dx = col.path[k+1][0]-col.path[k][0], dy = col.path[k+1][1]-col.path[k][1], dz = col.path[k+1][2]-col.path[k][2];
                tipPathLen += Math.sqrt(dx*dx + dy*dy + dz*dz);
            }
        }
        const tipReserveMM = isER ? ER_TIP_RESERVE_MM : TIP_RESERVE_MM;
        const tipReserve = Math.min(tipReserveMM, tipPathLen > 0 ? tipPathLen * 0.3 : tipReserveMM);

        // Find where the column was cut (tipReserve distance from contact along path).
        // Walk backwards along the column path from contact end.
        let columnEndPos = null;

        if (col && col.path && col.path.length >= 2) {
            const pts = col.path.map(p => zu(p[0], p[1], p[2]));
            let distFromContact = 0;
            for (let j = pts.length - 1; j >= 1; j--) {
                const segLen = pts[j].distanceTo(pts[j - 1]);
                if (distFromContact + segLen >= tipReserve) {
                    const remaining = tipReserve - distFromContact;
                    const t = remaining / segLen;
                    columnEndPos = pts[j].clone().lerp(pts[j - 1], t);
                    break;
                }
                distFromContact += segLen;
            }
            // If entire path < tipReserve, use base (first point)
            if (!columnEndPos) {
                columnEndPos = pts[0].clone();
            }
        }

        // Fallback: straight down from contact
        if (!columnEndPos) {
            columnEndPos = contactPos.clone();
            columnEndPos.y -= tipReserve;
        }

        // Direction from column end → contact point (must be exact)
        const approachDir = new THREE.Vector3().subVectors(contactPos, columnEndPos);
        const capsuleH = approachDir.length();
        if (capsuleH < 0.01) return;
        approachDir.normalize();

        // Bite into the model: lengthen the capsule so the apex lands
        // tip_penetration_mm PAST the contact point along the tip axis
        // (per-support value from the engine presets; absent/0 = the old
        // kiss-the-surface geometry, which peeled off under print load).
        const penMM = Number(sp.tip_penetration_mm) || 0;

        const geo = buildTipCapsuleGeo(shaftR, tipR, capsuleH + penMM, _quality);
        const capsule = new THREE.Mesh(geo, tipMat);

        // Position so bottom hemisphere is inside the column shaft.
        // The profile's equator (full shaftR) is at Y=shaftR, so shift
        // back by shaftR along approach direction to align equator with columnEndPos.
        capsule.position.copy(
            columnEndPos.clone().add(approachDir.clone().multiplyScalar(-shaftR))
        );
        const cylUp = new THREE.Vector3(0, 1, 0);
        if (Math.abs(approachDir.dot(cylUp)) < 0.9999) {
            capsule.quaternion.copy(
                new THREE.Quaternion().setFromUnitVectors(cylUp, approachDir)
            );
        }

        capsule.userData.type = 'tips';
        // Identity for the debug tooltip — orphan-looking tip stubs were
        // untraceable without this (defect: orange cones with no ID).
        capsule.userData.supportId = sp.id;
        capsule.userData.source = sp.source;
        capsule.userData.supportType = sp.support_type;
        if (col) {
            capsule.userData.strategy = col.strategy;
            capsule.userData.tipWarning = !!isTipWarning;
            capsule.userData.intersects = !!isIntersecting;
        } else {
            capsule.userData.noColumn = true;
        }
        group.add(capsule);
    });
}

function renderBraces(group, braces, supports, columns) {
    const braceMat = new THREE.MeshPhongMaterial({
        color: BRACE_COLOR,
        transparent: true,
        opacity: 0.7,
    });

    // Build column lookup by support_id for path interpolation
    const colById = {};
    if (columns) {
        columns.forEach(col => { colById[col.support_id] = col; });
    }

    // Fallback: support base positions
    const posById = {};
    if (supports) {
        supports.forEach(s => {
            if (s.base) posById[s.id] = s.base;
        });
    }

    braces.forEach((brace) => {
        const zFrom = brace.z;
        const zTo = (brace.z_to != null) ? brace.z_to : brace.z;

        // Interpolate XY from column path at brace Z (not base position)
        let fromXY = _interpolateColumnAtZ(colById[brace.from_support], zFrom);
        let toXY = _interpolateColumnAtZ(colById[brace.to_support], zTo);

        // Fallback to base position XY if interpolation fails
        if (!fromXY) {
            const bp = posById[brace.from_support];
            if (!bp) return;
            fromXY = [bp[0], bp[1]];
        }
        if (!toXY) {
            const bp = posById[brace.to_support];
            if (!bp) return;
            toXY = [bp[0], bp[1]];
        }

        const start = zu(fromXY[0], fromXY[1], zFrom);
        const end = zu(toXY[0], toXY[1], zTo);

        // Brace diameter — Easy Remove: thinner than the thinnest pillar (light=0.30mm)
        const braceR = _isER ? 0.07 : (brace.diameter_mm || 0.5) * 0.5;
        const result = buildBraceGeo(start, end, braceR, _quality);
        if (!result) return;
        const cyl = new THREE.Mesh(result.geometry, braceMat);
        cyl.position.copy(result.position);
        cyl.quaternion.copy(result.quaternion);
        cyl.userData.type = 'braces';
        group.add(cyl);
    });
}

/** Render raft as a lattice framework connecting base pads (Lychee-style). */
function renderRaftLattice(group, columns, fallbackBasePositions) {
    const raftMat = new THREE.MeshPhongMaterial({
        color: RAFT_COLOR,
        transparent: true,
        opacity: 0.6,
    });

    // Collect base positions in Y-up from columns or fallback
    // Also build support_id → base index map for server-provided edges
    const bases = [];
    const basesSid = [];  // parallel array of support_ids for debug
    if (columns) {
        columns.forEach(col => {
            if (col.is_anchor) return;
            if (col.is_branch) return;
            if (!col.path || col.path.length < 1) return;
            let bp = col.path[0];
            for (let i = 1; i < col.path.length; i++) {
                if (col.path[i][2] < bp[2]) bp = col.path[i];
            }
            bases.push(zu(bp[0], bp[1], bp[2]));
            basesSid.push(col.support_id);
        });
    } else if (fallbackBasePositions) {
        fallbackBasePositions.forEach(p => bases.push(zu(p[0], p[1], p[2])));
    }

    if (bases.length < 2) return;

    const beamW = 1.2;
    const beamH = 0.8;

    // Compute nearest-neighbor edges (each node connects to 3 nearest)
    const edges = new Set();
    for (let i = 0; i < bases.length; i++) {
        const dists = [];
        for (let j = 0; j < bases.length; j++) {
            if (i === j) continue;
            const dx = bases[j].x - bases[i].x;
            const dz = bases[j].z - bases[i].z;
            dists.push({ idx: j, dist: Math.sqrt(dx * dx + dz * dz) });
        }
        dists.sort((a, b) => a.dist - b.dist);

        const maxNeighbors = Math.min(3, dists.length);
        for (let k = 0; k < maxNeighbors; k++) {
            const key = Math.min(i, dists[k].idx) + ',' + Math.max(i, dists[k].idx);
            edges.add(key);
        }
    }

    // MST guarantee (Prim's)
    const inMST = new Array(bases.length).fill(false);
    inMST[0] = true;
    let mstCount = 1;
    while (mstCount < bases.length) {
        let bestDist = Infinity, bestI = -1, bestJ = -1;
        for (let i = 0; i < bases.length; i++) {
            if (!inMST[i]) continue;
            for (let j = 0; j < bases.length; j++) {
                if (inMST[j]) continue;
                const dx = bases[j].x - bases[i].x;
                const dz = bases[j].z - bases[i].z;
                const d = Math.sqrt(dx * dx + dz * dz);
                if (d < bestDist) { bestDist = d; bestI = i; bestJ = j; }
            }
        }
        if (bestJ < 0) break;
        inMST[bestJ] = true; mstCount++;
        edges.add(Math.min(bestI, bestJ) + ',' + Math.max(bestI, bestJ));
    }

    // Convex hull perimeter (Jarvis march / gift wrapping on XZ plane)
    if (bases.length >= 3) {
        let start = 0;
        for (let i = 1; i < bases.length; i++) {
            if (bases[i].x < bases[start].x ||
                (bases[i].x === bases[start].x && bases[i].z < bases[start].z)) {
                start = i;
            }
        }
        const hull = [start];
        let current = start;
        do {
            let next = 0;
            for (let i = 1; i < bases.length; i++) {
                if (i === current) continue;
                if (next === current) { next = i; continue; }
                const ax = bases[next].x - bases[current].x;
                const az = bases[next].z - bases[current].z;
                const bx = bases[i].x - bases[current].x;
                const bz = bases[i].z - bases[current].z;
                const cross = ax * bz - az * bx;
                if (cross < 0 || (cross === 0 &&
                    (bx * bx + bz * bz) > (ax * ax + az * az))) {
                    next = i;
                }
            }
            current = next;
            if (current === start) break;
            hull.push(current);
        } while (hull.length <= bases.length);

        for (let h = 0; h < hull.length; h++) {
            const a = hull[h];
            const b = hull[(h + 1) % hull.length];
            edges.add(Math.min(a, b) + ',' + Math.max(a, b));
        }
    }

    // DEBUG: log raft bases and edges for comparison with Python bracing
    console.log('[RAFT-JS] bases:', bases.length, 'edges:', edges.size);
    bases.forEach((b, idx) => {
        console.log(`  raft[${idx}] sid=${basesSid[idx]} (x=${b.x.toFixed(2)} z=${b.z.toFixed(2)})`);
    });
    edges.forEach(key => {
        const [a, b] = key.split(',').map(Number);
        console.log(`  edge ${a}-${b} (sid ${basesSid[a]}-${basesSid[b]})`);
    });

    // Render box beams between connected bases (flat on build plate)
    edges.forEach(key => {
        const [i, j] = key.split(',').map(Number);
        const result = buildRaftBeamGeo(bases[i], bases[j], beamW, beamH);
        if (!result) return;

        const beam = new THREE.Mesh(result.geometry, raftMat);
        beam.position.copy(result.position);
        beam.rotation.y = result.rotationY;
        beam.userData.type = 'raft';
        group.add(beam);
    });
}

/** Interpolate XY position along a column path at a given Z height (Z-up coords).
 *  Returns [x, y] or null if Z is outside the column's range. */
function _interpolateColumnAtZ(column, z) {
    if (!column || !column.path || column.path.length < 2) return null;

    const path = column.path;
    const eps = 0.01;

    for (let i = 0; i < path.length - 1; i++) {
        const z0 = path[i][2];
        const z1 = path[i + 1][2];
        const segMin = Math.min(z0, z1);
        const segMax = Math.max(z0, z1);

        if (z >= segMin - eps && z <= segMax + eps) {
            const dz = z1 - z0;
            if (Math.abs(dz) < 1e-12) {
                return [(path[i][0] + path[i + 1][0]) / 2,
                        (path[i][1] + path[i + 1][1]) / 2];
            }
            const t = Math.max(0, Math.min(1, (z - z0) / dz));
            const x = path[i][0] + t * (path[i + 1][0] - path[i][0]);
            const y = path[i][1] + t * (path[i + 1][1] - path[i][1]);
            return [x, y];
        }
    }
    return null;
}
