// Parser for PlanBuild `.blueprint` text files.
// Format verified against PlanBuild/Blueprints/{Blueprint,PieceEntry,TerrainModEntry,SnapPointEntry}.cs:
//   #Name:/#Creator:/#Description:/#Category:  header lines (Description is a JSON string)
//   #SnapPoints  -> x;y;z
//   #Terrain     -> shape;x;y;z;radius;rotation(int, degrees yaw);smooth;paint
//   #Pieces      -> name;category;x;y;z;qx;qy;qz;qw;"additionalInfo";sx;sy;sz
// Values are Unity-space (left-handed, Y up, quaternion x,y,z,w), relative to the blueprint origin.
// This module performs no coordinate conversion and has no rendering dependencies.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface BlueprintPiece {
  prefab: string;
  table: string;
  position: Vec3;
  rotation: Quat;
  data: string;
  scale: Vec3;
  /** Zero-based index within the pieces list. */
  index: number;
  /** One-based line number in the source file. */
  line: number;
  /** Original, unmodified source line. */
  raw: string;
  /** Fields beyond the 13 PlanBuild knows about. */
  extra: string[];
}

export interface TerrainOp {
  shape: string;
  position: Vec3;
  radius: number;
  /** Yaw in degrees, as stored. */
  rotation: number;
  smooth: number;
  paint: string;
  index: number;
  line: number;
  raw: string;
  extra: string[];
}

export interface SnapPoint {
  position: Vec3;
  index: number;
  line: number;
  raw: string;
}

export interface UnknownSection {
  /** Header line including the leading '#'. */
  header: string;
  line: number;
  lines: { line: number; text: string }[];
}

export interface BlueprintMetadata {
  name: string;
  creator: string;
  description: string;
  category: string;
  /** Header values exactly as written, keyed by header name (e.g. "Name"). */
  raw: Record<string, string>;
}

export interface Blueprint {
  metadata: BlueprintMetadata;
  /** Unrecognised `#Key:value` header lines, in file order. */
  extraHeaders: { key: string; value: string; line: number }[];
  pieces: BlueprintPiece[];
  terrain: TerrainOp[];
  snapPoints: SnapPoint[];
  unknownSections: UnknownSection[];
  /** Non-fatal issues; malformed lines are kept in `rejected` rather than aborting the parse. */
  warnings: string[];
  rejected: { section: string; line: number; text: string; reason: string }[];
}

type Section = 'pieces' | 'terrain' | 'snap' | 'skip';

const HEADER_FIELDS = ['Name', 'Creator', 'Description', 'Category'] as const;
const DEFAULT_CATEGORY = 'Blueprints';

/** Mirrors PieceEntry.InvariantFloat: empty -> 0, '.' decimal; ',' is accepted as a legacy decimal separator. */
function parseFloatField(s: string | undefined, onBad: () => void): number {
  if (s === undefined) return 0;
  const t = s.trim();
  if (t === '') return 0;
  const n = Number(t.replace(',', '.'));
  if (Number.isNaN(n)) {
    onBad();
    return 0;
  }
  return n;
}

function parseData(field: string): string {
  const t = field.trim();
  if (t === '' || t === '""') return '';
  try {
    const v: unknown = JSON.parse(t);
    return typeof v === 'string' ? v : field;
  } catch {
    // PlanBuild falls back to the raw field when it is not valid JSON.
    return field;
  }
}

function parseDescription(value: string): string {
  if (value.startsWith('"')) {
    try {
      const v: unknown = JSON.parse(value);
      if (typeof v === 'string') return v;
    } catch {
      /* keep raw */
    }
  }
  return value;
}

export function parseBlueprint(text: string): Blueprint {
  const bp: Blueprint = {
    metadata: { name: '', creator: '', description: '', category: DEFAULT_CATEGORY, raw: {} },
    extraHeaders: [],
    pieces: [],
    terrain: [],
    snapPoints: [],
    unknownSections: [],
    warnings: [],
    rejected: [],
  };

  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  // Like PlanBuild, lines before any section header are treated as pieces.
  let section: Section = 'pieces';
  let currentUnknown: UnknownSection | null = null;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const lineNo = i + 1;
    if (text === '') continue;

    if (text.startsWith('#')) {
      const field = HEADER_FIELDS.find((f) => text.startsWith(`#${f}:`));
      if (field) {
        const value = text.slice(field.length + 2);
        bp.metadata.raw[field] = value;
        if (field === 'Name') bp.metadata.name = value;
        else if (field === 'Creator') bp.metadata.creator = value;
        else if (field === 'Description') bp.metadata.description = parseDescription(value);
        else bp.metadata.category = value === '' ? DEFAULT_CATEGORY : value;
        continue;
      }
      if (text === '#Pieces') { section = 'pieces'; currentUnknown = null; continue; }
      if (text === '#Terrain') { section = 'terrain'; currentUnknown = null; continue; }
      if (text === '#SnapPoints') { section = 'snap'; currentUnknown = null; continue; }

      const colon = text.indexOf(':');
      if (colon > 0) {
        // Unknown `#Key:value` header: keep it, and leave the current section unchanged.
        bp.extraHeaders.push({ key: text.slice(1, colon), value: text.slice(colon + 1), line: lineNo });
        continue;
      }
      // Unknown section (e.g. InfinityHammer's #TerrainHeight): PlanBuild skips its lines; we keep them raw.
      section = 'skip';
      currentUnknown = { header: text, line: lineNo, lines: [] };
      bp.unknownSections.push(currentUnknown);
      continue;
    }

    switch (section) {
      case 'skip':
        currentUnknown?.lines.push({ line: lineNo, text });
        break;
      case 'snap':
        parseSnap(bp, text, lineNo);
        break;
      case 'terrain':
        parseTerrain(bp, text, lineNo);
        break;
      case 'pieces':
        parsePiece(bp, text, lineNo);
        break;
    }
  }

  if (bp.pieces.length === 0 && bp.rejected.length === 0) bp.warnings.push('No pieces found.');
  return bp;
}

function reject(bp: Blueprint, section: string, line: number, text: string, reason: string): void {
  bp.rejected.push({ section, line, text, reason });
  bp.warnings.push(`${section} line ${line}: ${reason}`);
}

function parsePiece(bp: Blueprint, raw: string, line: number): void {
  const p = raw.split(';');
  if (p.length < 10) {
    reject(bp, 'Pieces', line, raw, `expected at least 10 fields, found ${p.length}`);
    return;
  }
  let bad = false;
  const f = (s: string | undefined): number => parseFloatField(s, () => (bad = true));

  const hasScale = p.length > 10;
  const piece: BlueprintPiece = {
    // PieceEntry strips anything from '(' on, e.g. "(Clone)".
    prefab: p[0].split('(')[0],
    table: p[1],
    position: [f(p[2]), f(p[3]), f(p[4])],
    rotation: [f(p[5]), f(p[6]), f(p[7]), f(p[8])],
    data: parseData(p[9]),
    scale: hasScale ? [f(p[10]), f(p[11]), f(p[12])] : [1, 1, 1],
    index: bp.pieces.length,
    line,
    raw,
    extra: p.slice(13),
  };
  if (bad) bp.warnings.push(`Pieces line ${line}: non-numeric value(s) read as 0`);
  bp.pieces.push(piece);
}

function parseTerrain(bp: Blueprint, raw: string, line: number): void {
  const p = raw.split(';');
  if (p.length < 7) {
    reject(bp, 'Terrain', line, raw, `expected at least 7 fields, found ${p.length}`);
    return;
  }
  let bad = false;
  const f = (s: string | undefined): number => parseFloatField(s, () => (bad = true));
  bp.terrain.push({
    shape: p[0],
    position: [f(p[1]), f(p[2]), f(p[3])],
    radius: f(p[4]),
    rotation: f(p[5]),
    smooth: f(p[6]),
    paint: p[7] ?? '',
    index: bp.terrain.length,
    line,
    raw,
    extra: p.slice(8),
  });
  if (bad) bp.warnings.push(`Terrain line ${line}: non-numeric value(s) read as 0`);
}

function parseSnap(bp: Blueprint, raw: string, line: number): void {
  const p = raw.split(';');
  if (p.length < 3) {
    reject(bp, 'SnapPoints', line, raw, `expected at least 3 fields, found ${p.length}`);
    return;
  }
  const f = (s: string | undefined): number => parseFloatField(s, () => undefined);
  bp.snapPoints.push({ position: [f(p[0]), f(p[1]), f(p[2])], index: bp.snapPoints.length, line, raw });
}
