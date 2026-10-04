// Copies WebMap-exported prefab GLBs/textures into public/models and writes manifest.json (prefab name -> file).
// File names come from WebMap's ModelStore.FileName: unchecked((uint)hash).ToString("x8") + ".glb", where
// `hash` is the signed key of each entry in index.json (entry "n" is the prefab name, "m" = has a model).
// Usage: node scripts/import-models.mjs [path to WebMap map_data/models]
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_SRC =
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Valheim dedicated server\\BepInEx\\plugins\\WebMap\\map_data\\models';
const src = resolve(process.argv[2] ?? DEFAULT_SRC);
const dest = resolve('public/models');

const index = JSON.parse(readFileSync(join(src, 'index.json'), 'utf8').replace(/^\uFEFF/, ''));
if (index.format !== 5) console.warn(`index.json format is ${index.format}, expected 5; continuing`);

mkdirSync(dest, { recursive: true });

const sameFile = (a, b) => existsSync(b) && statSync(a).size === statSync(b).size;
let copied = 0;
for (const f of readdirSync(src)) {
  if (!f.endsWith('.glb') && !f.endsWith('.png')) continue;
  const from = join(src, f);
  const to = join(dest, f);
  if (sameFile(from, to)) continue;
  copyFileSync(from, to);
  copied++;
}

const models = {};
for (const [hashKey, info] of Object.entries(index.prefabs)) {
  if (!info.m) continue;
  const file = `${(Number(hashKey) >>> 0).toString(16).padStart(8, '0')}.glb`;
  if (!existsSync(join(dest, file))) continue;
  if (!(info.n in models)) models[info.n] = file;
}

writeFileSync(join(dest, 'manifest.json'), JSON.stringify({ format: 1, models }));
console.log(`copied ${copied} files; manifest has ${Object.keys(models).length} prefabs`);
