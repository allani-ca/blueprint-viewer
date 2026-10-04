// Prefab -> proxy geometry catalog. Pure data/rules; knows nothing about the parser or three.js.
// Dimensions are rough Valheim-scale approximations (metres), not extracted game data.
// Phase 2 will map prefab names to GLB models first and fall back to these proxies.

export type ProxyShape = 'box' | 'cylinder' | 'sphere';

export interface ProxySpec {
  shape: ProxyShape;
  /** box: [w,h,d]; cylinder: [diameter,height,diameter]; sphere: [d,d,d]. */
  size: [number, number, number];
  /** Offset of the shape centre from the piece origin. */
  offset: [number, number, number];
  color: number;
  /** False for the generic placeholder used when no rule matches. */
  known: boolean;
}

const UNKNOWN: ProxySpec = {
  shape: 'box',
  size: [0.6, 0.6, 0.6],
  offset: [0, 0.3, 0],
  color: 0xd946ef,
  known: false,
};

const COLORS: [RegExp, number][] = [
  [/^darkwood/i, 0x5a3f2c],
  [/^ashwood/i, 0xb8a48a],
  [/^woodiron/i, 0x7a6450],
  [/^(wood|woodwall)/i, 0xa67c52],
  [/^stone/i, 0x8d8f91],
  [/^iron/i, 0x5f6772],
  [/^blackmarble/i, 0x2f3238],
  [/^crystal/i, 0x7cc4e0],
  [/^piece_dvergr/i, 0xb98a55],
  [/^(rug|piece_banner)/i, 0xa04545],
  [/^pickable/i, 0x6b8e3d],
];

function colorFor(prefab: string): number {
  for (const [re, c] of COLORS) if (re.test(prefab)) return c;
  return 0x9aa0a6;
}

function box(prefab: string, w: number, h: number, d: number, yCenter = h / 2): ProxySpec {
  return { shape: 'box', size: [w, h, d], offset: [0, yCenter, 0], color: colorFor(prefab), known: true };
}

function cyl(prefab: string, diameter: number, h: number, yCenter = h / 2): ProxySpec {
  return { shape: 'cylinder', size: [diameter, h, diameter], offset: [0, yCenter, 0], color: colorFor(prefab), known: true };
}

function num(s: string | undefined, fallback: number): number {
  const n = s === undefined ? NaN : Number(s);
  return Number.isFinite(n) ? n : fallback;
}

type Rule = (prefab: string) => ProxySpec | null;

const RULES: Rule[] = [
  // Walls with explicit size: stone_wall_2x1, iron_wall_1x1, piece_dvergr_metal_wall_2x2, ...
  (p) => {
    const m = /wall_(\d+)x(\d+)$/i.exec(p);
    return m ? box(p, num(m[1], 2), num(m[2], 2), 0.3) : null;
  },
  (p) => (/wall_half$/i.test(p) ? box(p, 2, 1, 0.2) : null),
  (p) => (/wall_quarter$/i.test(p) ? box(p, 2, 0.5, 0.2) : null),
  (p) => (/wall_roof/i.test(p) ? box(p, 2, 0.2, 2.6, 0.1) : null),
  (p) => (/^(wood|darkwood|ashwood)?wall$/i.test(p) ? box(p, 2, 2, 0.2) : null),
  (p) => (/decowall/i.test(p) ? box(p, 2, /divider/i.test(p) ? 1 : 2, 0.2) : null),
  (p) => (/wall_arch$/i.test(p) ? box(p, 2, 2, 0.2) : null),
  // Floors
  (p) => {
    const m = /floor_(\d+)x(\d+)$/i.exec(p);
    if (m) return box(p, num(m[1], 2), 0.2, num(m[2], 2), -0.1);
    return /floor$/i.test(p) ? box(p, 2, 0.2, 2, -0.1) : null;
  },
  // Poles and logs: trailing number is the length in metres
  (p) => {
    if (!/pole/i.test(p)) return null;
    const m = /(\d+)m?$/.exec(p);
    const len = m ? num(m[1], 1) : /pole_log$/i.test(p) ? 2 : 1;
    return cyl(p, 0.25, len);
  },
  // Beams: horizontal along local Z (approximation); suffix encodes length or slope
  (p) => {
    if (!/beam/i.test(p)) return null;
    let len = 2;
    let m: RegExpExecArray | null;
    if ((m = /beam_(\d+)m$/i.exec(p))) len = num(m[1], 2);
    else if (/beam_1$/i.test(p)) len = 1;
    else if (/beam_26$/i.test(p)) len = 2.2;
    else if (/beam_45$/i.test(p)) len = 2.8;
    else if ((m = /beam(\d+)x\d+$/i.exec(p))) len = num(m[1], 4);
    return box(p, 0.2, 0.2, len, 0);
  },
  (p) => (/stair/i.test(p) ? box(p, 1.5, 1, 2) : null),
  (p) => (/arch$/i.test(p) ? box(p, 2, 2, 0.5) : null),
  (p) => (/door/i.test(p) ? box(p, 1.5, 2.5, 0.15) : null),
  (p) => (/window/i.test(p) ? box(p, 1, 1, 0.15) : null),
  (p) => (/roof|ocorner|icorner/i.test(p) ? box(p, 2, 0.3, 2.5, 0.15) : null),
  (p) => (/^(stone|blackmarble)_/i.test(p) ? box(p, 1, 1, 1) : null),
  // Furniture and misc
  (p) => (/fence/i.test(p) ? box(p, 2, 1, 0.1) : null),
  (p) => (/^rug_/i.test(p) ? box(p, 1.5, 0.05, 2.2, 0.025) : null),
  (p) => (/chest/i.test(p) ? box(p, 1, 0.7, 0.6) : null),
  (p) => (/itemstand/i.test(p) ? box(p, 0.4, 0.1, 0.4) : null),
  (p) => (/^sign$/i.test(p) ? box(p, 1, 0.5, 0.1, 0.25) : null),
  (p) => (/armorstand/i.test(p) ? cyl(p, 0.5, 1.9) : null),
  (p) => (/workbench/i.test(p) ? box(p, 2, 1, 1) : null),
  (p) => (/table/i.test(p) ? box(p, 1.8, 0.8, 1) : null),
  (p) => (/bench/i.test(p) ? box(p, 1.6, 0.5, 0.5) : null),
  (p) => (/throne/i.test(p) ? box(p, 1, 1.4, 1) : null),
  (p) => (/torch|lantern|brazier/i.test(p) ? cyl(p, 0.2, 0.8) : null),
  (p) => (/fire_pit|firepit/i.test(p) ? cyl(p, 1, 0.4) : null),
  (p) => (/wood_stack/i.test(p) ? box(p, 1.2, 0.8, 1.2) : null),
  (p) => (/banner/i.test(p) ? box(p, 0.5, 2, 0.05) : null),
  (p) => (/^pickable_/i.test(p) ? { shape: 'sphere', size: [0.3, 0.3, 0.3], offset: [0, 0.15, 0], color: colorFor(p), known: true } : null),
];

const cache = new Map<string, ProxySpec>();

export function resolveProxy(prefab: string): ProxySpec {
  let spec = cache.get(prefab);
  if (spec) return spec;
  spec = UNKNOWN;
  for (const rule of RULES) {
    const r = rule(prefab);
    if (r) {
      spec = r;
      break;
    }
  }
  cache.set(prefab, spec);
  return spec;
}

export interface TerrainProxy {
  shape: 'box' | 'cylinder';
  /** Half-extent (square) or radius (circle) as stored, in metres. */
  radius: number;
  /** True when the shape name was not recognised and a cylinder is used as fallback. */
  known: boolean;
}

export function resolveTerrainProxy(shape: string, radius: number): TerrainProxy {
  const s = shape.toLowerCase();
  if (s === 'square') return { shape: 'box', radius, known: true };
  if (s === 'circle') return { shape: 'cylinder', radius, known: true };
  return { shape: 'cylinder', radius, known: false };
}
