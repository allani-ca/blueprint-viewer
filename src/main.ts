import './style.css';
import { parseBlueprint, type Blueprint, type BlueprintPiece, type Vec3 } from './parser/blueprint';
import { resolveProxy } from './catalog/prefabs';
import { hasModel, loadModelManifest, modelCount } from './catalog/models';
import { BlueprintViewer, type BuildBounds, type ViewFilter } from './render/viewer';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const fmt = (n: number, digits = 2): string => (Number.isFinite(n) ? n.toFixed(digits) : String(n));
const fmtVec = (v: readonly number[], digits = 4): string => v.map((n) => fmt(n, digits)).join(', ');

const viewer = new BlueprintViewer($('viewer'));

// A prefab is "known" if it has a game model or a proxy rule; otherwise it is a generic placeholder.
const isKnown = (prefab: string): boolean => hasModel(prefab) || resolveProxy(prefab).known;

let blueprint: Blueprint | null = null;
let selectedPiece: BlueprintPiece | null = null;
let yRange: [number, number] = [0, 0];
const filter: ViewFilter = { yMin: 0, yMax: 0, search: '', isolatedPrefab: null };

function applyFilter(): void {
  const visible = viewer.setFilter(filter);
  $('visible-count').textContent = blueprint ? `${visible} / ${blueprint.pieces.length} shown` : '';
}

function minMax(values: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

function renderMetadata(bp: Blueprint, bounds: BuildBounds | null): void {
  const meta = $('meta');
  meta.replaceChildren();
  const add = (k: string, v: string): void => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    meta.append(dt, dd);
  };
  const m = bp.metadata;
  add('Name', m.name || '—');
  add('Creator', m.creator || '—');
  add('Category', m.category);
  if (m.description) add('Description', m.description);
  for (const h of bp.extraHeaders) add(`#${h.key}`, h.value);
  const prefabs = new Set(bp.pieces.map((p) => p.prefab));
  const unknown = [...prefabs].filter((p) => !isKnown(p)).length;
  add('Pieces', String(bp.pieces.length));
  add('Prefabs', `${prefabs.size}${unknown ? ` (${unknown} unknown)` : ''}`);
  add('Terrain ops', String(bp.terrain.length));
  if (bp.snapPoints.length) add('Snap points', String(bp.snapPoints.length));
  for (const s of bp.unknownSections) add(s.header, `${s.lines.length} lines (kept raw)`);
  if (bp.pieces.length) {
    const [x0, x1] = minMax(bp.pieces.map((p) => p.position[0]));
    const [y0, y1] = minMax(bp.pieces.map((p) => p.position[1]));
    const [z0, z1] = minMax(bp.pieces.map((p) => p.position[2]));
    add('Origins span', `${fmt(x1 - x0)} × ${fmt(y1 - y0)} × ${fmt(z1 - z0)} m (X × Y × Z)`);
  }
  if (bounds) {
    add('Bounds', `${fmt(bounds.size[0])} × ${fmt(bounds.size[1])} × ${fmt(bounds.size[2])} m`);
    add('Min', fmtVec(bounds.min, 2));
    add('Max', fmtVec(bounds.max, 2));
  }

  const warnings = $('warnings') as HTMLDetailsElement;
  const list = warnings.querySelector('ul')!;
  list.replaceChildren();
  if (bp.warnings.length) {
    warnings.hidden = false;
    warnings.querySelector('summary')!.textContent = `${bp.warnings.length} warning(s)`;
    for (const w of bp.warnings.slice(0, 200)) {
      const li = document.createElement('li');
      li.textContent = w;
      list.append(li);
    }
  } else {
    warnings.hidden = true;
  }
}

function setupYSliders(bp: Blueprint): void {
  const ys = bp.pieces.map((p) => p.position[1]);
  yRange = ys.length ? minMax(ys) : [0, 0];
  const lo = $('y-min') as HTMLInputElement;
  const hi = $('y-max') as HTMLInputElement;
  for (const s of [lo, hi]) {
    s.min = String(yRange[0]);
    s.max = String(yRange[1]);
  }
  resetY();
}

function resetY(): void {
  const lo = $('y-min') as HTMLInputElement;
  const hi = $('y-max') as HTMLInputElement;
  lo.value = String(yRange[0]);
  hi.value = String(yRange[1]);
  readY();
}

function readY(changed?: 'min' | 'max'): void {
  const lo = $('y-min') as HTMLInputElement;
  const hi = $('y-max') as HTMLInputElement;
  if (Number(lo.value) > Number(hi.value)) {
    if (changed === 'min') hi.value = lo.value;
    else lo.value = hi.value;
  }
  // Tiny epsilon so pieces exactly at the slider ends are not lost to float formatting.
  filter.yMin = Number(lo.value) - 1e-6;
  filter.yMax = Number(hi.value) + 1e-6;
  $('y-min-out').textContent = fmt(Number(lo.value));
  $('y-max-out').textContent = fmt(Number(hi.value));
  applyFilter();
}

function renderPrefabList(): void {
  const ul = $('prefab-list');
  ul.replaceChildren();
  if (!blueprint) return;
  const counts = new Map<string, number>();
  for (const p of blueprint.pieces) counts.set(p.prefab, (counts.get(p.prefab) ?? 0) + 1);
  const q = filter.search.trim().toLowerCase();
  const rows = [...counts.entries()]
    .filter(([name]) => q === '' || name.toLowerCase().includes(q))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [name, count] of rows) {
    const spec = resolveProxy(name);
    const li = document.createElement('li');
    if (!isKnown(name)) li.classList.add('unknown');
    if (filter.isolatedPrefab === name) li.classList.add('active');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = `#${spec.color.toString(16).padStart(6, '0')}`;
    const nm = document.createElement('span');
    nm.className = 'name';
    nm.textContent = name;
    const ct = document.createElement('span');
    ct.className = 'count';
    ct.textContent = String(count);
    li.append(sw, nm, ct);
    li.title = 'Click to isolate this prefab';
    li.addEventListener('click', () => {
      filter.isolatedPrefab = filter.isolatedPrefab === name ? null : name;
      renderPrefabList();
      applyFilter();
    });
    ul.append(li);
  }
}

function showDetails(piece: BlueprintPiece | null): void {
  const body = $('details-body');
  body.replaceChildren();
  if (!piece) {
    body.className = 'muted';
    body.textContent = 'Click a piece in the viewer.';
    return;
  }
  body.className = '';
  const dl = document.createElement('dl');
  const add = (k: string, v: string): void => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  };
  add('Prefab', `${piece.prefab}${isKnown(piece.prefab) ? '' : '  (generic placeholder)'}`);
  add('Representation', viewer.isShowingModel(piece) ? 'game model' : resolveProxy(piece.prefab).known ? 'proxy shape' : 'generic placeholder');
  add('Table', piece.table);
  add('Position', fmtVec(piece.position as Vec3, 4));
  add('Rotation (xyzw)', fmtVec(piece.rotation, 6));
  add('Scale', fmtVec(piece.scale, 4));
  add('Data', piece.data === '' ? '—' : piece.data.length > 160 ? `${piece.data.slice(0, 160)}… (${piece.data.length} chars)` : piece.data);
  add('Source', `piece #${piece.index}, line ${piece.line}`);
  if (piece.extra.length) add('Extra fields', piece.extra.join(';'));
  body.append(dl);
  const raw = document.createElement('div');
  raw.className = 'raw';
  raw.textContent = piece.raw.length > 400 ? `${piece.raw.slice(0, 400)}…` : piece.raw;
  body.append(raw);
}

function loadText(text: string, label: string): void {
  const bp = parseBlueprint(text);
  blueprint = bp;
  filter.search = '';
  filter.isolatedPrefab = null;
  ($('search') as HTMLInputElement).value = '';

  const bounds = viewer.load(bp);
  setupYSliders(bp);
  renderMetadata(bp, bounds);
  renderPrefabList();
  selectedPiece = null;
  showDetails(null);

  for (const id of ['meta-section', 'view-section', 'pieces-section']) $(id).hidden = false;
  $('drop-hint').hidden = bp.pieces.length > 0 || bp.terrain.length > 0 ? true : false;
  document.title = `${bp.metadata.name || label} — Blueprint Viewer`;
}

async function loadFile(file: File): Promise<void> {
  try {
    await loadModelManifest();
    loadText(await file.text(), file.name.replace(/\.[^.]+$/, ''));
  } catch (err) {
    alert(`Could not load ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function loadSample(): Promise<void> {
  await loadModelManifest();
  const res = await fetch(`${import.meta.env.BASE_URL}samples/sheepshank-chickencoop.blueprint`);
  if (!res.ok) {
    alert('Sample could not be loaded.');
    return;
  }
  loadText(await res.text(), 'sample');
}

// --- wiring ---
const fileInput = $('file-input') as HTMLInputElement;
$('open-btn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void loadFile(f);
  fileInput.value = '';
});
$('sample-btn').addEventListener('click', () => void loadSample());
$('reset-camera').addEventListener('click', () => viewer.resetCamera());
$('models-toggle').addEventListener('change', (e) => {
  viewer.setUseModels((e.target as HTMLInputElement).checked);
  showDetails(selectedPiece);
});
viewer.onModelProgress((p) => {
  $('model-status').textContent =
    modelCount() === 0
      ? 'No game models installed (run npm run import-models); using proxies.'
      : p.total === 0
        ? 'No game models for this blueprint.'
        : `Models: ${p.loaded}/${p.total} prefabs${p.failed ? `, ${p.failed} failed` : ''}`;
  if (p.loaded + p.failed === p.total) showDetails(selectedPiece);
});
viewer.onBoundsChange((b) => {
  if (blueprint) renderMetadata(blueprint, b);
});
$('terrain-toggle').addEventListener('change', (e) => viewer.setTerrainVisible((e.target as HTMLInputElement).checked));
$('grid-toggle').addEventListener('change', (e) => viewer.setGridVisible((e.target as HTMLInputElement).checked));
$('y-min').addEventListener('input', () => readY('min'));
$('y-max').addEventListener('input', () => readY('max'));
$('y-reset').addEventListener('click', resetY);
$('search').addEventListener('input', (e) => {
  filter.search = (e.target as HTMLInputElement).value;
  renderPrefabList();
  applyFilter();
});
viewer.onSelect((p) => {
  selectedPiece = p;
  showDetails(p);
});

let dragDepth = 0;
const dropOverlay = $('drop-overlay');
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const f = e.dataTransfer?.files[0];
  if (f) void loadFile(f);
});
