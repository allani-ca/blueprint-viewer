// Prefab name -> extracted GLB, from public/models/manifest.json (written by scripts/import-models.mjs).
// Missing manifest or missing prefab means "no model": callers fall back to proxy geometry.

let models: Record<string, string> = {};
let loading: Promise<void> | null = null;

export function loadModelManifest(): Promise<void> {
  loading ??= fetch(`${import.meta.env.BASE_URL}models/manifest.json`)
    .then((r) => (r.ok ? (r.json() as Promise<{ models?: Record<string, string> }>) : null))
    .then((m) => {
      models = m?.models ?? {};
    })
    .catch(() => {
      models = {};
    });
  return loading;
}

export function hasModel(prefab: string): boolean {
  return Object.prototype.hasOwnProperty.call(models, prefab);
}

export function modelUrl(prefab: string): string | null {
  return hasModel(prefab) ? `${import.meta.env.BASE_URL}models/${models[prefab]}` : null;
}

export function modelCount(): number {
  return Object.keys(models).length;
}
