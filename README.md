# Blueprint Viewer

Browser-only 3D viewer for Valheim [PlanBuild](https://github.com/sirskunkalot/PlanBuild) `.blueprint` files. Drop or open a file to inspect the build. Live at https://blueprints.allani.ca.

Vite + TypeScript + three.js. No backend; files are parsed in the browser and never uploaded.

## Develop

```
npm install
npm run dev
npm test
```

## Game models (optional)

Pieces render with models extracted by [valheim-webmap](https://github.com/f00d4tehg0dz/valheim-webmap). Without them the viewer falls back to simple proxy shapes.

```
npm run import-models -- "<path to WebMap/map_data/models>"
```

This copies the GLBs and textures into `public/models/` (git-ignored, ~140 MB) and writes `manifest.json`. These are game assets; don't commit or redistribute them without checking the licence.

## Deploy (Cloudflare Pages)

- Build command: `npm run build`
- Output directory: `dist`

Because `public/models/` is git-ignored, a Git-connected Pages build ships proxy shapes only. To include the models, build locally and upload `dist`:

```
npm run build
npx wrangler pages deploy dist
```

Set the custom domain to `blueprints.allani.ca` in the Pages project settings.
