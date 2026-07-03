// End-to-end conversion pipeline.
//
// Raster (keep colors):  decode → palette quantization (median cut, AA-safe
//   merge, background removal) → potrace once per color mask → validate →
//   scale to real-world units → final SVG with per-color fills.
// Raster (silhouette):   decode → binarize (Otsu/manual, invert) → potrace →
//   validate → scale → single-color SVG.
// SVG in:  parse → shapes-to-paths + flatten transforms (fills preserved) →
//   validate → scale → final SVG.
//
// Paths travel through the pipeline as { segments, fill, stroke?, strokeWidth? }.

import { init, potrace } from 'esm-potrace-wasm';
import {
  imageToImageData,
  binarize,
  quantizeColors,
  paletteMask,
} from './preprocess.js';
import { flattenSvg } from './flatten.js';
import {
  normalizePath,
  parseTransform,
  multiply,
  transformSegments,
  serializeSegments,
  segmentsBBox,
  countNodes,
  IDENTITY,
} from './svgpath.js';
import { ensureClosed, selfIntersects, dedupePaths } from './validate.js';

let potraceReady = null;

async function traceToSegmentLists(binaryImageData, settings) {
  if (!potraceReady) potraceReady = init();
  await potraceReady;

  const svgString = await potrace(binaryImageData, {
    turdsize: settings.turdSize,
    turnpolicy: 4, // minority — potrace's default, best for mixed content
    alphamax: settings.alphaMax,
    opticurve: 1,
    opttolerance: settings.optTolerance,
    pathonly: false,
    extractcolors: false,
    posterizelevel: 1,
    posterizationalgorithm: 0,
  });

  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('Tracer returned invalid SVG');
  const lists = [];
  for (const el of doc.querySelectorAll('path')) {
    const d = el.getAttribute('d');
    if (!d) continue;
    // Potrace nests paths in groups carrying a scale/flip transform
    // (e.g. translate(0,H) scale(0.1,-0.1)); bake it into the coordinates.
    let m = IDENTITY;
    for (let node = el; node && node.tagName !== 'svg'; node = node.parentElement) {
      const tr = node.getAttribute('transform');
      if (tr) m = multiply(parseTransform(tr), m);
    }
    let segments = normalizePath(d);
    if (m !== IDENTITY) segments = transformSegments(segments, m);
    lists.push(segments);
  }
  return lists;
}

function buildOutputSvg(paths, { contentBox, targetWidth, targetHeight, unit }) {
  const sx = targetWidth / contentBox.width;
  const sy = targetHeight / contentBox.height;
  // Bake real-world units into coordinates: 1 user unit == 1 mm (or 1 in),
  // which is the least ambiguous form for CAD importers.
  const m = [sx, 0, 0, sy, -contentBox.minX * sx, -contentBox.minY * sy];

  const precision = unit === 'in' ? 5 : 4;
  const pathEls = paths.map((path) => {
    const d = serializeSegments(transformSegments(path.segments, m), precision);
    let attrs = `d="${d}" fill="${path.fill}"`;
    if (path.stroke && path.stroke !== 'none') {
      const w = (path.strokeWidth ?? 1) * ((sx + sy) / 2);
      attrs += ` stroke="${path.stroke}" stroke-width="${Number(w.toFixed(4))}"`;
    } else {
      attrs += ' stroke="none"';
    }
    return `  <path ${attrs}/>`;
  });

  const w = Number(targetWidth.toFixed(4));
  const h = Number(targetHeight.toFixed(4));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}${unit}" height="${h}${unit}" viewBox="0 0 ${w} ${h}">`,
    ...pathEls,
    '</svg>',
  ].join('\n');
}

function validateAndClean(rawPaths) {
  let autoClosed = 0;
  const closed = rawPaths.map((path) => {
    const r = ensureClosed(path.segments);
    autoClosed += r.autoClosed;
    return { ...path, segments: r.segments };
  });

  const { paths, duplicatesRemoved, degenerateRemoved } = dedupePaths(closed);

  let selfIntersecting = 0;
  for (const path of paths) {
    if (selfIntersects(path.segments)) selfIntersecting++;
  }

  return { paths, autoClosed, duplicatesRemoved, degenerateRemoved, selfIntersecting };
}

// `source`: { kind: 'raster', image } or { kind: 'svg', svgText }
// `settings`: { colorMode: 'color'|'mono', maxColors, removeBackground,
//               threshold, invert, colorsAsDark, turdSize, alphaMax,
//               optTolerance, targetWidth, targetHeight, unit }
export async function convert(source, settings) {
  const warnings = [];
  let rawPaths = [];
  let contentBox;
  let usedThreshold = null;
  let colors = null;
  let backgroundHex = null;

  if (source.kind === 'raster') {
    const { imageData, downscaled } = imageToImageData(source.image);
    if (downscaled) {
      warnings.push('Image was downscaled to 4096px max dimension before tracing');
    }
    contentBox = { minX: 0, minY: 0, width: imageData.width, height: imageData.height };

    if (settings.colorMode === 'color') {
      const q = quantizeColors(imageData, {
        maxColors: settings.maxColors,
        removeBackground: settings.removeBackground,
      });
      backgroundHex = q.backgroundHex;
      colors = [];
      for (let i = 0; i < q.palette.length; i++) {
        const mask = paletteMask(q.assign, i, imageData.width, imageData.height);
        const lists = await traceToSegmentLists(mask, settings);
        if (lists.length === 0) continue;
        colors.push(q.palette[i].hex);
        for (const segments of lists) {
          rawPaths.push({ segments, fill: q.palette[i].hex });
        }
      }
    } else {
      const bin = binarize(imageData, {
        threshold: settings.threshold,
        invert: settings.invert,
        colorsAsDark: settings.colorsAsDark,
      });
      usedThreshold = bin.threshold;
      const lists = await traceToSegmentLists(bin.imageData, settings);
      rawPaths = lists.map((segments) => ({ segments, fill: '#000000' }));
    }
  } else {
    const flat = flattenSvg(source.svgText);
    warnings.push(...flat.warnings);
    rawPaths =
      settings.colorMode === 'color'
        ? flat.paths
        : flat.paths.map((p) => ({ segments: p.segments, fill: '#000000' }));
    if (settings.colorMode === 'color') {
      colors = [...new Set(rawPaths.map((p) => p.fill))];
    }
    if (flat.viewBox) {
      contentBox = flat.viewBox;
    } else {
      // No viewBox: fit the output to the geometry itself.
      let box = null;
      for (const path of rawPaths) {
        const b = segmentsBBox(path.segments);
        if (!b) continue;
        box = box
          ? {
              minX: Math.min(box.minX, b.minX),
              minY: Math.min(box.minY, b.minY),
              maxX: Math.max(box.maxX, b.maxX),
              maxY: Math.max(box.maxY, b.maxY),
            }
          : { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
      }
      if (!box) throw new Error('No usable geometry found in the SVG');
      contentBox = {
        minX: box.minX,
        minY: box.minY,
        width: box.maxX - box.minX,
        height: box.maxY - box.minY,
      };
    }
  }

  if (rawPaths.length === 0) {
    throw new Error(
      'No paths were produced. Try adjusting the threshold or the invert toggle.'
    );
  }

  const cleaned = validateAndClean(rawPaths);
  const svgText = buildOutputSvg(cleaned.paths, {
    contentBox,
    targetWidth: settings.targetWidth,
    targetHeight: settings.targetHeight,
    unit: settings.unit,
  });

  const nodeCount = cleaned.paths.reduce((sum, p) => sum + countNodes(p.segments), 0);

  return {
    svgText,
    meta: {
      pathCount: cleaned.paths.length,
      nodeCount,
      autoClosed: cleaned.autoClosed,
      duplicatesRemoved: cleaned.duplicatesRemoved,
      degenerateRemoved: cleaned.degenerateRemoved,
      selfIntersecting: cleaned.selfIntersecting,
      usedThreshold,
      colors,
      backgroundHex,
      warnings,
      bytes: new Blob([svgText]).size,
      targetWidth: settings.targetWidth,
      targetHeight: settings.targetHeight,
      unit: settings.unit,
    },
  };
}
