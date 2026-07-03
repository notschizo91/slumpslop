// Validation & cleanup pass for normalized paths:
//  - ensure every subpath is explicitly closed (Z), auto-closing when needed
//  - detect self-intersecting paths (flattened segment sweep)
//  - drop exact-duplicate and degenerate paths

import { sampleSubpaths, serializeSegments } from './svgpath.js';

// Ensure every subpath ends with Z. Subpaths whose endpoint doesn't already
// coincide with their start get a closing line segment. Returns
// { segments, autoClosed } where autoClosed counts subpaths that needed help.
export function ensureClosed(segments, epsilon = 1e-6) {
  const out = [];
  let autoClosed = 0;
  let start = null;
  let cx = 0;
  let cy = 0;
  let open = false;

  const closeCurrent = () => {
    if (!open) return;
    const coincident =
      start && Math.abs(cx - start[0]) < epsilon && Math.abs(cy - start[1]) < epsilon;
    if (!coincident) autoClosed++;
    out.push(['Z']);
    open = false;
  };

  for (const seg of segments) {
    switch (seg[0]) {
      case 'M':
        closeCurrent();
        start = [seg[1], seg[2]];
        cx = seg[1];
        cy = seg[2];
        open = true;
        out.push(seg);
        break;
      case 'L':
        cx = seg[1];
        cy = seg[2];
        open = true;
        out.push(seg);
        break;
      case 'C':
        cx = seg[5];
        cy = seg[6];
        open = true;
        out.push(seg);
        break;
      case 'Z':
        out.push(seg);
        if (start) {
          cx = start[0];
          cy = start[1];
        }
        open = false;
        break;
    }
  }
  closeCurrent();
  return { segments: out, autoClosed };
}

function properIntersection(p1, p2, p3, p4) {
  const d1x = p2[0] - p1[0];
  const d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0];
  const d2y = p4[1] - p3[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return false;
  const ex = p3[0] - p1[0];
  const ey = p3[1] - p1[1];
  const t = (ex * d2y - ey * d2x) / denom;
  const u = (ex * d1y - ey * d1x) / denom;
  const eps = 1e-6;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

// Detect whether a path (possibly multiple subpaths) intersects itself.
// Curves are flattened to polylines; a sort-by-minX sweep keeps the
// pairwise test tractable for dense traces.
export function selfIntersects(segments) {
  const totalCurves = segments.length;
  const samples = totalCurves > 2000 ? 4 : totalCurves > 500 ? 8 : 12;
  const subpaths = sampleSubpaths(segments, samples);

  const edges = [];
  subpaths.forEach((sp, spIndex) => {
    const pts = sp.points;
    const n = pts.length;
    const count = sp.closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      edges.push({
        a,
        b,
        sp: spIndex,
        idx: i,
        len: count,
        minX: Math.min(a[0], b[0]),
        maxX: Math.max(a[0], b[0]),
        minY: Math.min(a[1], b[1]),
        maxY: Math.max(a[1], b[1]),
      });
    }
  });

  edges.sort((e1, e2) => e1.minX - e2.minX);

  for (let i = 0; i < edges.length; i++) {
    const e1 = edges[i];
    for (let j = i + 1; j < edges.length; j++) {
      const e2 = edges[j];
      if (e2.minX > e1.maxX) break;
      if (e2.minY > e1.maxY || e2.maxY < e1.minY) continue;
      // Skip edges adjacent along the same subpath (shared endpoints).
      if (e1.sp === e2.sp) {
        const diff = Math.abs(e1.idx - e2.idx);
        if (diff <= 1 || diff === e1.len - 1) continue;
      }
      if (properIntersection(e1.a, e1.b, e2.a, e2.b)) return true;
    }
  }
  return false;
}

// Remove exact duplicates (same serialized geometry AND same paint) and
// degenerate paths (fewer than 3 anchor points). Takes and returns path
// objects ({ segments, fill, ... }).
export function dedupePaths(pathObjects) {
  const seen = new Set();
  const paths = [];
  let duplicatesRemoved = 0;
  let degenerateRemoved = 0;
  for (const path of pathObjects) {
    const anchors = path.segments.filter((s) => s[0] !== 'Z').length;
    if (anchors < 3) {
      degenerateRemoved++;
      continue;
    }
    const key = `${path.fill}|${path.stroke ?? ''}|${serializeSegments(path.segments, 3)}`;
    if (seen.has(key)) {
      duplicatesRemoved++;
      continue;
    }
    seen.add(key);
    paths.push(path);
  }
  return { paths, duplicatesRemoved, degenerateRemoved };
}
