// Flatten an uploaded SVG document into plain path geometry:
// shape primitives are converted to path data, nested group transforms are
// baked into coordinates, and non-geometry containers are skipped.

import { normalizePath, parseTransform, multiply, transformSegments, IDENTITY } from './svgpath.js';

const SKIP_TAGS = new Set([
  'defs', 'clipPath', 'mask', 'marker', 'pattern', 'symbol', 'metadata',
  'title', 'desc', 'style', 'script', 'filter', 'linearGradient', 'radialGradient',
]);

function shapeToPathData(el) {
  const num = (name, fallback = 0) => {
    const v = parseFloat(el.getAttribute(name));
    return Number.isNaN(v) ? fallback : v;
  };
  switch (el.tagName.toLowerCase()) {
    case 'path':
      return el.getAttribute('d') || null;
    case 'rect': {
      const x = num('x');
      const y = num('y');
      const w = num('width');
      const h = num('height');
      if (w <= 0 || h <= 0) return null;
      let rx = el.hasAttribute('rx') ? num('rx') : NaN;
      let ry = el.hasAttribute('ry') ? num('ry') : NaN;
      if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
      if (Number.isNaN(ry)) ry = rx;
      rx = Math.min(Math.max(rx, 0), w / 2);
      ry = Math.min(Math.max(ry, 0), h / 2);
      if (rx === 0 || ry === 0) {
        return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      }
      return (
        `M${x + rx} ${y}` +
        `H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}` +
        `V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
        `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
        `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
      );
    }
    case 'circle': {
      const cx = num('cx');
      const cy = num('cy');
      const r = num('r');
      if (r <= 0) return null;
      return `M${cx + r} ${cy}A${r} ${r} 0 1 1 ${cx - r} ${cy}A${r} ${r} 0 1 1 ${cx + r} ${cy}Z`;
    }
    case 'ellipse': {
      const cx = num('cx');
      const cy = num('cy');
      const rx = num('rx');
      const ry = num('ry');
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}Z`;
    }
    case 'line':
      return `M${num('x1')} ${num('y1')}L${num('x2')} ${num('y2')}`;
    case 'polygon':
    case 'polyline': {
      const pts = (el.getAttribute('points') || '')
        .trim()
        .split(/[\s,]+/)
        .map(Number)
        .filter((v) => !Number.isNaN(v));
      if (pts.length < 4) return null;
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      if (el.tagName.toLowerCase() === 'polygon') d += 'Z';
      return d;
    }
    default:
      return null;
  }
}

// Resolve a presentation property with CSS-in-style-attribute taking
// precedence over the presentation attribute, falling back to the
// inherited value.
function resolveProp(el, prop, inherited) {
  const style = el.getAttribute('style');
  if (style) {
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(style);
    if (m) return m[1].trim();
  }
  const attr = el.getAttribute(prop);
  if (attr !== null && attr !== '' && attr !== 'inherit') return attr.trim();
  return inherited;
}

// Parse an SVG string and return { paths, viewBox, warnings } where `paths`
// is a list of { segments, fill, stroke, strokeWidth } objects with
// normalized, transform-flattened segments in viewBox units.
export function flattenSvg(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const errorNode = doc.querySelector('parsererror');
  if (errorNode) throw new Error('Could not parse SVG file');
  const root = doc.documentElement;
  if (root.tagName.toLowerCase() !== 'svg') throw new Error('File is not an SVG document');

  const paths = [];
  const warnings = [];
  let skippedUnsupported = 0;
  let unresolvableFills = 0;

  // SVG paint defaults: fill black, no stroke.
  const rootPaint = { fill: '#000000', stroke: 'none', strokeWidth: 1 };

  const walk = (el, matrix, paint) => {
    if (el.nodeType !== 1) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;

    let m = matrix;
    const tr = el.getAttribute('transform');
    if (tr) m = multiply(matrix, parseTransform(tr));

    let fill = resolveProp(el, 'fill', paint.fill);
    let stroke = resolveProp(el, 'stroke', paint.stroke);
    const strokeWidth =
      parseFloat(resolveProp(el, 'stroke-width', paint.strokeWidth)) || paint.strokeWidth;
    // Paint servers (gradients/patterns) can't survive flattening; fall back
    // to solid black and report it.
    if (/^url\(/i.test(fill) || fill === 'currentColor') {
      fill = '#000000';
      unresolvableFills++;
    }
    if (/^url\(/i.test(stroke) || stroke === 'currentColor') stroke = '#000000';
    const nextPaint = { fill, stroke, strokeWidth };

    if (tag === 'svg' || tag === 'g' || tag === 'a') {
      for (const child of el.children) walk(child, m, nextPaint);
      return;
    }
    if (tag === 'use' || tag === 'image' || tag === 'text') {
      skippedUnsupported++;
      return;
    }

    const d = shapeToPathData(el);
    if (!d) return;
    try {
      let segments = normalizePath(d);
      if (m !== IDENTITY) segments = transformSegments(segments, m);
      if (segments.length > 0) {
        // Invisible geometry still matters for CAD cleanup — make it visible.
        const effectiveFill =
          fill === 'none' && (!stroke || stroke === 'none') ? '#000000' : fill;
        paths.push({ segments, fill: effectiveFill, stroke, strokeWidth });
      }
    } catch {
      skippedUnsupported++;
    }
  };

  walk(root, IDENTITY, rootPaint);

  if (skippedUnsupported > 0) {
    warnings.push(
      `${skippedUnsupported} unsupported element(s) skipped (use/image/text or malformed geometry)`
    );
  }
  if (unresolvableFills > 0) {
    warnings.push(`${unresolvableFills} gradient/pattern fill(s) replaced with black`);
  }

  let viewBox = null;
  const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every((v) => !Number.isNaN(v)) && vb[2] > 0 && vb[3] > 0) {
    viewBox = { minX: vb[0], minY: vb[1], width: vb[2], height: vb[3] };
  }

  return { paths, viewBox, warnings };
}
