# Image → SVG Vectorizer (CAD-Ready)

A two-page web app that converts raster images (PNG, JPG, BMP) — and cleans up
existing SVGs — into CAD-ready SVG paths: closed, non-self-intersecting,
real-world-scaled, suitable for direct import into Fusion 360.

Everything runs client-side in the browser (Potrace compiled to WASM); no
server, no accounts, no uploads leave the machine.

## Pages

1. **Import** — drag & drop or browse for a file, tune trace settings
   (threshold with Otsu auto mode, turd size, corner sensitivity/alphamax,
   curve simplification/opttolerance, invert), and set the real-world output
   size in mm or inches.
2. **Result** — side-by-side comparison of the original and the finished SVG,
   with path/node counts, validation status, an optional ghost overlay of the
   original, and a download button. "Adjust settings" returns to page 1 with
   the file and settings retained.

## Processing pipeline

1. **Preprocess** — grayscale (alpha composited over white), threshold via
   Otsu's method or a manual slider, optional invert. Saturated colors (green,
   red, yellow, …) count as part of the shape by default — plain luminance
   thresholding would punch bright colors out as holes; a "Colored pixels"
   toggle restores luminance-only behavior.
2. **Trace** — [Potrace](https://potrace.sourceforge.net/) via
   [`esm-potrace-wasm`](https://github.com/tomayac/esm-potrace-wasm), with the
   group transform in its output baked into the path coordinates.
3. **Validate & clean** — every subpath is explicitly closed (open subpaths
   are auto-closed and reported), self-intersecting paths are detected via a
   flattened segment sweep and flagged, exact duplicates and degenerate paths
   are removed, and nested groups/transforms (including shape primitives like
   `rect`/`circle`/`polygon` in uploaded SVGs) are flattened into plain
   absolute path data.
4. **Scale** — path coordinates are rescaled so 1 SVG user unit equals 1 mm
   (or 1 inch), and `width`/`height`/`viewBox` are set to the requested
   real-world size, so CAD importers need no manual rescaling.

SVG uploads skip steps 1–2 and go straight through cleanup and validation.

## Development

```bash
npm install
npm run dev      # local dev server
npm test         # geometry/validation unit tests (Node built-in test runner)
npm run lint     # oxlint
npm run build    # production build to dist/
```

## Out of scope (v1)

- Multi-color tracing — single-color/silhouette CAD profiles only
- Accounts, history, cloud storage
- Batch processing
- `<use>`, `<image>` and `<text>` elements in uploaded SVGs (skipped with a warning)
