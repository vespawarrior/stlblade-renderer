/**
 * Type declarations for index.mjs — keeps TS callers honest while the
 * implementation stays plain ESM so Node can run it directly.
 */

/** Placement schema returned by STLBlade — kept loose for forward-compat. */
export interface StlBladeSchema {
  orientation: {
    rx: number;
    ry: number;
    z_lift_mm?: number;
    score?: number;
    subscores?: Record<string, number>;
  };
  supports: Array<Record<string, unknown>>;
  columns: Array<Record<string, unknown>>;
  braces: Array<Record<string, unknown>>;
  raft?: Record<string, unknown> | null;
  /** "coverage" | "optimized" | "easy_remove" | "easy_remove_optimized". */
  phase?: string;
  /**
   * Auto-upright correction from the engine's /analyze (UprightInfo.matrix):
   * 4x4 row-major, Z-up frame. Applied to the source vertices BEFORE the
   * orientation — the supports were computed on the corrected mesh.
   */
  upright_matrix?: number[][] | null;
}

export interface RenderSchemaOptions {
  /** Tessellation preset: 'low' | 'medium' (default) | 'high'. */
  quality?: 'low' | 'medium' | 'high';
  /**
   * Coordinate convention for the exported STL.
   *  - 'y' (default): Y-up. Matches the STLBlade viewer's downloaded
   *    STL AND the ZBrush-side unsupported STL the artist already has.
   *  - 'z': Z-up. Applied at export time for slicers that need it
   *    (Cura, PrusaSlicer, Chitubox, Lychee).
   */
  upAxis?: 'y' | 'z';
}

/**
 * Render a placement schema into a watertight binary STL.
 *
 * @param vertices Original mesh vertices (Float32, flat XYZ, Z-up).
 * @param faces    Original mesh face indices (Uint32, flat triangles).
 * @param schema   Schema returned by /support + /support/optimize.
 * @param opts     Optional render quality.
 * @returns        Buffer with binary STL bytes ready for fs.writeFile.
 */
export function renderSchemaToSTL(
  vertices: Float32Array,
  faces: Uint32Array,
  schema: StlBladeSchema,
  opts?: RenderSchemaOptions,
): Buffer;
