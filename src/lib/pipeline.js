// End-to-end conversion pipeline.
//
// Raster:  decode → binarize (Otsu/manual, invert) → potrace → validate →
//          scale to real-world units → final SVG.
// SVG in:  parse → shapes-to-paths + flatten transforms → validate →
//          scale to real-world units → final SVG.

import { init, potrace } from 'esm-potrace-wasm';
import { imageToImageData, binarize } from './preprocess.js';
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

async function traceToPathSegments(binaryImageData, settings) {
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
  const paths = [];
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
    paths.push(segments);
  }
  return paths;
}

function buildOutputSvg(pathSegmentLists, { contentBox, targetWidth, targetHeight, unit }) {
  const sx = targetWidth / contentBox.width;
  const sy = targetHeight / contentBox.height;
  // Bake real-world units into coordinates: 1 user unit == 1 mm (or 1 in),
  // which is the least ambiguous form for CAD importers.
  const m = [sx, 0, 0, sy, -contentBox.minX * sx, -contentBox.minY * sy];

  const precision = unit === 'in' ? 5 : 4;
  const pathEls = pathSegmentLists.map((segments) => {
    const d = serializeSegments(transformSegments(segments, m), precision);
    return `  <path d="${d}" fill="#000000" stroke="none"/>`;
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
  const closed = rawPaths.map((segments) => {
    const r = ensureClosed(segments);
    autoClosed += r.autoClosed;
    return r.segments;
  });

  const { paths, duplicatesRemoved, degenerateRemoved } = dedupePaths(closed);

  let selfIntersecting = 0;
  for (const segments of paths) {
    if (selfIntersects(segments)) selfIntersecting++;
  }

  return { paths, autoClosed, duplicatesRemoved, degenerateRemoved, selfIntersecting };
}

// `source`: { kind: 'raster', image } or { kind: 'svg', svgText }
// `settings`: { threshold, invert, turdSize, alphaMax, optTolerance,
//               targetWidth, targetHeight, unit }
export async function convert(source, settings) {
  const warnings = [];
  let rawPaths;
  let contentBox;
  let usedThreshold = null;

  if (source.kind === 'raster') {
    const { imageData, downscaled } = imageToImageData(source.image);
    if (downscaled) {
      warnings.push('Image was downscaled to 4096px max dimension before tracing');
    }
    const bin = binarize(imageData, {
      threshold: settings.threshold,
      invert: settings.invert,
    });
    usedThreshold = bin.threshold;
    rawPaths = await traceToPathSegments(bin.imageData, settings);
    contentBox = {
      minX: 0,
      minY: 0,
      width: bin.imageData.width,
      height: bin.imageData.height,
    };
  } else {
    const flat = flattenSvg(source.svgText);
    warnings.push(...flat.warnings);
    rawPaths = flat.paths;
    if (flat.viewBox) {
      contentBox = flat.viewBox;
    } else {
      // No viewBox: fit the output to the geometry itself.
      let box = null;
      for (const segments of rawPaths) {
        const b = segmentsBBox(segments);
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

  const nodeCount = cleaned.paths.reduce((sum, segments) => sum + countNodes(segments), 0);

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
      warnings,
      bytes: new Blob([svgText]).size,
      targetWidth: settings.targetWidth,
      targetHeight: settings.targetHeight,
      unit: settings.unit,
    },
  };
}
