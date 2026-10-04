import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Blueprint, BlueprintPiece, Vec3 } from '../parser/blueprint';
import { resolveProxy, resolveTerrainProxy, type ProxySpec } from '../catalog/prefabs';
import { hasModel, modelUrl } from '../catalog/models';

export interface ViewFilter {
  yMin: number;
  yMax: number;
  /** Case-insensitive substring match on prefab name; empty matches all. */
  search: string;
  /** When set, only pieces with exactly this prefab are shown. */
  isolatedPrefab: string | null;
}

export interface BuildBounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
}

export interface ModelProgress {
  loaded: number;
  failed: number;
  total: number;
}

/** One group per piece carrying the stored position/rotation/scale; its child is a proxy mesh or a game model. */
type PiecePivot = THREE.Group;

interface Representation {
  proxy: THREE.Mesh;
  proxyBox: THREE.Box3;
  model?: THREE.Object3D;
  modelBox?: THREE.Box3;
}

interface ModelTemplate {
  root: THREE.Object3D;
  box: THREE.Box3;
}

/**
 * PlanBuild stores Unity-space values (left-handed, Y up). They are applied to objects unchanged
 * (position, quaternion x/y/z/w, localScale — the same TRS PlanBuild uses when it instantiates the ghost).
 * three.js is right-handed, so the whole build sits under one root that mirrors X; no per-piece conversion.
 */
const UNITY_TO_THREE_MIRROR_X = -1;

/**
 * WebMap writes prefab GLBs with Z negated ("already in glTF's right-handed frame", GlbWriter.cs).
 * Mirroring Z on the model node returns its vertices to Unity prefab space before the piece transform applies.
 */
const WEBMAP_GLB_MIRROR_Z = -1;

const MODEL_LOAD_CONCURRENCY = 6;

export class BlueprintViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
  private readonly controls: OrbitControls;
  private readonly unityRoot = new THREE.Group();
  private readonly piecesGroup = new THREE.Group();
  private readonly terrainGroup = new THREE.Group();
  private grid = new THREE.GridHelper(100, 100, 0x4a5568, 0x2d3748);
  private readonly raycaster = new THREE.Raycaster();
  private readonly geometryCache = new Map<string, THREE.BufferGeometry>();
  private readonly materialCache = new Map<number, THREE.MeshStandardMaterial>();
  private readonly gltfLoader = new GLTFLoader();
  private readonly templates = new Map<string, Promise<ModelTemplate | null>>();
  private readonly reps = new Map<PiecePivot, Representation>();
  private pivots: PiecePivot[] = [];
  private selected: PiecePivot | null = null;
  private selectionOutline: THREE.LineSegments | null = null;
  private useModels = true;
  private generation = 0;
  private fitCenter = new THREE.Vector3();
  private fitRadius = 10;
  private downPos: { x: number; y: number } | null = null;
  private selectHandler: (piece: BlueprintPiece | null) => void = () => undefined;
  private progressHandler: (p: ModelProgress) => void = () => undefined;
  private boundsHandler: (b: BuildBounds | null) => void = () => undefined;
  private readonly resizeObserver: ResizeObserver;
  private frame = 0;

  constructor(private readonly container: HTMLElement) {
    THREE.Cache.enabled = true;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x14171c);
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x303038, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(30, 60, 20);
    this.scene.add(sun);
    this.scene.add(this.grid);

    this.unityRoot.scale.x = UNITY_TO_THREE_MIRROR_X;
    this.unityRoot.add(this.piecesGroup, this.terrainGroup);
    this.scene.add(this.unityRoot);

    this.camera.position.set(20, 20, 20);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = true;

    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => (this.downPos = { x: e.clientX, y: e.clientY }));
    dom.addEventListener('pointerup', (e) => this.onPointerUp(e));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  onSelect(handler: (piece: BlueprintPiece | null) => void): void {
    this.selectHandler = handler;
  }

  onModelProgress(handler: (p: ModelProgress) => void): void {
    this.progressHandler = handler;
  }

  /** Fires when bounds change after load because game models replaced proxies. */
  onBoundsChange(handler: (b: BuildBounds | null) => void): void {
    this.boundsHandler = handler;
  }

  /** Rebuilds the scene and returns the bounds of all pieces in blueprint (Unity) space. */
  load(bp: Blueprint): BuildBounds | null {
    const gen = ++this.generation;
    this.select(null);
    this.piecesGroup.clear();
    this.disposeTerrain();
    this.reps.clear();
    this.pivots = [];

    const byPrefab = new Map<string, PiecePivot[]>();
    for (const piece of bp.pieces) {
      const pivot = this.createPiecePivot(piece);
      this.pivots.push(pivot);
      this.piecesGroup.add(pivot);
      const list = byPrefab.get(piece.prefab);
      if (list) list.push(pivot);
      else byPrefab.set(piece.prefab, [pivot]);
    }
    for (const op of bp.terrain) {
      this.terrainGroup.add(this.createTerrainMesh(op.shape, op.radius, op.position, op.rotation));
    }

    const target = this.pivots.length > 0 ? this.piecesGroup : this.terrainGroup;
    this.unityRoot.updateMatrixWorld(true);
    const bounds = this.computeBounds(target);
    this.fitToObject(target);
    this.positionGrid(bounds);
    void this.loadModels(gen, byPrefab);
    return bounds;
  }

  setFilter(filter: ViewFilter): number {
    const search = filter.search.trim().toLowerCase();
    let visible = 0;
    for (const pivot of this.pivots) {
      const p = pivot.userData.piece as BlueprintPiece;
      const y = p.position[1];
      const show =
        y >= filter.yMin &&
        y <= filter.yMax &&
        (filter.isolatedPrefab === null || p.prefab === filter.isolatedPrefab) &&
        (search === '' || p.prefab.toLowerCase().includes(search));
      pivot.visible = show;
      if (show) visible++;
    }
    if (this.selected && !this.selected.visible) this.select(null);
    return visible;
  }

  setUseModels(use: boolean): void {
    this.useModels = use;
    for (const pivot of this.pivots) this.applyRepresentation(pivot);
    this.refreshSelectionOutline();
    this.emitBounds();
  }

  setTerrainVisible(visible: boolean): void {
    this.terrainGroup.visible = visible;
  }

  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
  }

  resetCamera(): void {
    const dir = new THREE.Vector3(1, 0.8, 1).normalize();
    this.camera.position.copy(this.fitCenter).addScaledVector(dir, this.fitRadius * 2.4);
    this.controls.target.copy(this.fitCenter);
    this.camera.near = Math.max(this.fitRadius / 1000, 0.05);
    this.camera.far = this.fitRadius * 50;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  select(piece: BlueprintPiece | null): void {
    this.setSelected(piece ? (this.pivots[piece.index] ?? null) : null);
  }

  /** True if the piece currently shows a game model rather than a proxy. */
  isShowingModel(piece: BlueprintPiece): boolean {
    const rep = this.reps.get(this.pivots[piece.index]);
    return !!rep?.model && this.useModels;
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.generation++;
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.disposeTerrain();
    this.geometryCache.forEach((g) => g.dispose());
    this.materialCache.forEach((m) => m.dispose());
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private createPiecePivot(piece: BlueprintPiece): PiecePivot {
    const pivot = new THREE.Group();
    pivot.position.set(...piece.position);
    const q = new THREE.Quaternion(...piece.rotation);
    // Guards against a zero/denormalised quaternion; a stored unit quaternion is left as is.
    if (q.lengthSq() === 0) q.identity();
    else q.normalize();
    pivot.quaternion.copy(q);
    pivot.scale.set(...piece.scale);
    pivot.userData.piece = piece;

    const spec = resolveProxy(piece.prefab);
    const geometry = this.geometryFor(spec);
    geometry.boundingBox ??= new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
    const proxy = new THREE.Mesh(geometry, this.materialFor(spec));
    this.reps.set(pivot, { proxy, proxyBox: geometry.boundingBox });
    this.applyRepresentation(pivot);
    return pivot;
  }

  private applyRepresentation(pivot: PiecePivot): void {
    const rep = this.reps.get(pivot);
    if (!rep) return;
    const want = this.useModels && rep.model ? rep.model : rep.proxy;
    for (const o of [rep.proxy, rep.model]) if (o && o !== want && o.parent === pivot) pivot.remove(o);
    if (want.parent !== pivot) pivot.add(want);
  }

  private async loadModels(gen: number, byPrefab: Map<string, PiecePivot[]>): Promise<void> {
    const queue = [...byPrefab.keys()].filter(hasModel);
    const progress: ModelProgress = { loaded: 0, failed: 0, total: queue.length };
    this.progressHandler({ ...progress });
    if (queue.length === 0) return;

    const worker = async (): Promise<void> => {
      for (let prefab = queue.shift(); prefab !== undefined; prefab = queue.shift()) {
        if (gen !== this.generation) return;
        const template = await this.templateFor(prefab);
        if (gen !== this.generation) return;
        if (template) {
          for (const pivot of byPrefab.get(prefab) ?? []) {
            const rep = this.reps.get(pivot);
            if (!rep) continue;
            rep.model = template.root.clone(true);
            rep.modelBox = template.box;
            this.applyRepresentation(pivot);
          }
          progress.loaded++;
        } else {
          progress.failed++;
        }
        this.progressHandler({ ...progress });
      }
    };
    await Promise.all(Array.from({ length: MODEL_LOAD_CONCURRENCY }, worker));
    if (gen !== this.generation) return;
    this.refreshSelectionOutline();
    this.emitBounds();
  }

  private templateFor(prefab: string): Promise<ModelTemplate | null> {
    let p = this.templates.get(prefab);
    if (!p) {
      const url = modelUrl(prefab);
      p = url
        ? this.gltfLoader
            .loadAsync(url)
            .then((gltf) => {
              const root = new THREE.Group();
              root.scale.z = WEBMAP_GLB_MIRROR_Z;
              root.add(gltf.scene);
              root.updateMatrixWorld(true);
              return { root, box: new THREE.Box3().setFromObject(root) };
            })
            .catch((err: unknown) => {
              console.warn(`Model for ${prefab} failed to load`, err);
              return null;
            })
        : Promise.resolve(null);
      this.templates.set(prefab, p);
    }
    return p;
  }

  private emitBounds(): void {
    const target = this.pivots.length > 0 ? this.piecesGroup : this.terrainGroup;
    this.unityRoot.updateMatrixWorld(true);
    this.boundsHandler(this.computeBounds(target));
  }

  private createTerrainMesh(shape: string, radius: number, position: Vec3, yawDeg: number): THREE.Object3D {
    const proxy = resolveTerrainProxy(shape, radius);
    const thickness = 0.3;
    const geo =
      proxy.shape === 'box'
        ? new THREE.BoxGeometry(radius * 2, thickness, radius * 2)
        : new THREE.CylinderGeometry(radius, radius, thickness, 48);
    const mat = new THREE.MeshBasicMaterial({
      color: proxy.known ? 0x3fae6a : 0xe0a030,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: proxy.known ? 0x6be39a : 0xffc860 }));
    mesh.add(edges);
    mesh.position.set(...position);
    // Quaternion.Euler(0, rotation, 0) in PlanBuild's TerrainModEntry.GetRotation.
    mesh.rotation.y = THREE.MathUtils.degToRad(yawDeg);
    return mesh;
  }

  private geometryFor(spec: ProxySpec): THREE.BufferGeometry {
    const key = `${spec.shape}|${spec.size.join(',')}|${spec.offset.join(',')}`;
    let geo = this.geometryCache.get(key);
    if (!geo) {
      const [w, h, d] = spec.size;
      geo =
        spec.shape === 'box'
          ? new THREE.BoxGeometry(w, h, d)
          : spec.shape === 'cylinder'
            ? new THREE.CylinderGeometry(w / 2, w / 2, h, 16)
            : new THREE.SphereGeometry(w / 2, 12, 8);
      geo.translate(...spec.offset);
      geo.computeBoundingBox();
      this.geometryCache.set(key, geo);
    }
    return geo;
  }

  private materialFor(spec: ProxySpec): THREE.MeshStandardMaterial {
    let mat = this.materialCache.get(spec.color);
    if (!mat) {
      // DoubleSide keeps rendering and raycasting correct under the mirrored root.
      mat = new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide });
      this.materialCache.set(spec.color, mat);
    }
    return mat;
  }

  private setSelected(pivot: PiecePivot | null): void {
    if (this.selectionOutline) {
      this.selectionOutline.parent?.remove(this.selectionOutline);
      this.selectionOutline.geometry.dispose();
      (this.selectionOutline.material as THREE.Material).dispose();
      this.selectionOutline = null;
    }
    this.selected = pivot;
    if (!pivot) return;
    const rep = this.reps.get(pivot);
    if (!rep) return;
    const box = this.useModels && rep.modelBox ? rep.modelBox : rep.proxyBox;
    const size = box.getSize(new THREE.Vector3());
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z));
    geo.translate(...box.getCenter(new THREE.Vector3()).toArray());
    const outline = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false }));
    outline.renderOrder = 10;
    pivot.add(outline);
    this.selectionOutline = outline;
  }

  private refreshSelectionOutline(): void {
    if (this.selected) this.setSelected(this.selected);
  }

  private onPointerUp(e: PointerEvent): void {
    const down = this.downPos;
    this.downPos = null;
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const candidates = this.pivots.filter((m) => m.visible);
    // The outline is drawn without depth test; ignore it so it cannot swallow clicks.
    const hits = this.raycaster.intersectObjects(candidates, true).filter((h) => h.object !== this.selectionOutline);
    let pivot: PiecePivot | null = null;
    if (hits.length > 0) {
      let o: THREE.Object3D | null = hits[0].object;
      while (o && !o.userData.piece) o = o.parent;
      pivot = o as PiecePivot | null;
    }
    this.setSelected(pivot);
    this.selectHandler(pivot ? (pivot.userData.piece as BlueprintPiece) : null);
  }

  private computeBounds(obj: THREE.Object3D): BuildBounds | null {
    const box = new THREE.Box3().setFromObject(obj, true);
    if (box.isEmpty()) return null;
    // World X is mirrored relative to blueprint space; undo that so values match the file.
    const min: Vec3 = [-box.max.x, box.min.y, box.min.z];
    const max: Vec3 = [-box.min.x, box.max.y, box.max.z];
    return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
  }

  private fitToObject(obj: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(obj, true);
    if (box.isEmpty()) {
      this.fitCenter.set(0, 0, 0);
      this.fitRadius = 10;
    } else {
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      this.fitCenter.copy(sphere.center);
      this.fitRadius = Math.max(sphere.radius, 1);
    }
    this.resetCamera();
  }

  private positionGrid(bounds: BuildBounds | null): void {
    const extent = bounds ? Math.max(bounds.size[0], bounds.size[2], 10) * 2 : 100;
    const size = Math.ceil(extent / 10) * 10;
    const visible = this.grid.visible;
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    this.grid = new THREE.GridHelper(size, size, 0x4a5568, 0x2d3748);
    this.grid.visible = visible;
    this.grid.position.set(this.fitCenter.x, bounds ? bounds.min[1] : 0, this.fitCenter.z);
    this.scene.add(this.grid);
  }

  private disposeTerrain(): void {
    for (const child of [...this.terrainGroup.children]) {
      this.terrainGroup.remove(child);
      child.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
  }

  private resize(): void {
    const w = Math.max(this.container.clientWidth, 1);
    const h = Math.max(this.container.clientHeight, 1);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = (): void => {
    this.frame = requestAnimationFrame(this.loop);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
