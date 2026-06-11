# stlblade-renderer

Canonical Three.js support-geometry renderer — the **single source of truth** for
the printed support STL across:

- **STLBlade engine** (`frontend/` + `deploy/` viewer)
- **STLCreator** (`ui-next/src/lib/stlblade`)
- **RUNCITER pipeline** (`runciter-app/lib/stlblade-renderer`)

It turns the placement schema returned by STLBlade `/support` + `/support/optimize`
(supports / columns / braces) into Three.js geometry, identical in the browser
viewer and in headless STL export (`renderSchemaToSTL`).

## Consumed as a git submodule
Each app pins this repo by commit SHA (controlled rollout). `three` is a **peer
dependency** — resolved from the consuming app's `node_modules`.

## Per-app theming
Geometry/logic is shared; **colors and tip length are per-app config**. Call
`setTheme({ colors, tipReserveMm })` before `renderSupports` (e.g. STLCreator
uses a pink theme, the engine/runciter use the typed palette).

## API
- `renderSupports(group, supports, columns, braces, raft, phase)` — build into a THREE.Group.
- `renderSchemaToSTL(vertices, faces, schema, opts)` — headless STL (Node).
- `setQuality(q)` / `getQuality()` — render quality.
- `setTheme(partial)` — colors + tip overrides.
- `parseStlToArrays(buffer)` — STL → flat arrays for renderSchemaToSTL.

## History
Extracted 2026-06-11 from `runciter-app/lib/stlblade-renderer` (the newest,
production copy). Previously duplicated/diverged across the 3 apps — see
stlblade-engine `documentation/Dev/13_MeshExport_Unification_Plan.md`.
