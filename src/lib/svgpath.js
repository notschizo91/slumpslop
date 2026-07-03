// SVG path data utilities: parsing, normalization to absolute M/L/C/Z,
// affine transforms, sampling, bounding boxes and serialization.
//
// Normalized segment shapes:
//   ['M', x, y]
//   ['L', x, y]
//   ['C', x1, y1, x2, y2, x, y]
//   ['Z']

const PARAM_COUNTS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

const TOKEN_RE = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

export function parsePathData(d) {
  const tokens = d.match(TOKEN_RE) || [];
  const commands = [];
  let cmd = null;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t;
      i++;
      if (cmd.toUpperCase() === 'Z') {
        commands.push({ cmd, args: [] });
        cmd = null;
        continue;
      }
      continue;
    }
    if (!cmd) throw new Error('Path data has coordinates before any command');
    const n = PARAM_COUNTS[cmd.toUpperCase()];
    const args = tokens.slice(i, i + n).map(Number);
    if (args.length < n || args.some(Number.isNaN)) {
      throw new Error(`Malformed path data near "${tokens.slice(i, i + n).join(' ')}"`);
    }
    i += n;
    commands.push({ cmd, args });
    // Extra coordinate pairs after M/m are implicit linetos.
    if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
  }
  return commands;
}

// Convert an elliptical arc to one or more cubic bezier segments.
// Endpoint parameterization per the SVG spec implementation notes.
function arcToCubics(x0, y0, rx, ry, xAxisRotationDeg, largeArc, sweep, x, y) {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) return [['L', x, y]];

  const phi = (xAxisRotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = largeArc !== sweep ? 1 : -1;
  let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  if (num < 0) num = 0;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coeff = den === 0 ? 0 : sign * Math.sqrt(num / den);
  const cxp = (coeff * rx * y1p) / ry;
  const cyp = (-coeff * ry * x1p) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry
  );
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / segments;
  const t = (4 / 3) * Math.tan(delta / 4);

  const out = [];
  let theta = theta1;
  let px = x0;
  let py = y0;
  for (let s = 0; s < segments; s++) {
    const theta2 = theta + delta;
    const c1 = Math.cos(theta);
    const s1 = Math.sin(theta);
    const c2 = Math.cos(theta2);
    const s2 = Math.sin(theta2);
    const endX = cx + rx * cosPhi * c2 - ry * sinPhi * s2;
    const endY = cy + rx * sinPhi * c2 + ry * cosPhi * s2;
    const d1x = -rx * cosPhi * s1 - ry * sinPhi * c1;
    const d1y = -rx * sinPhi * s1 + ry * cosPhi * c1;
    const d2x = -rx * cosPhi * s2 - ry * sinPhi * c2;
    const d2y = -rx * sinPhi * s2 + ry * cosPhi * c2;
    out.push(['C', px + t * d1x, py + t * d1y, endX - t * d2x, endY - t * d2y, endX, endY]);
    px = endX;
    py = endY;
    theta = theta2;
  }
  // Pin the final endpoint exactly.
  const last = out[out.length - 1];
  last[5] = x;
  last[6] = y;
  return out;
}

// Parse and normalize a path `d` string into absolute M/L/C/Z segments.
export function normalizePath(d) {
  const commands = parsePathData(d);
  const out = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let pcx = null; // previous control point (for S/T reflection)
  let pcy = null;
  let prev = '';

  for (const { cmd, args } of commands) {
    const abs = cmd === cmd.toUpperCase();
    const C = cmd.toUpperCase();
    switch (C) {
      case 'M': {
        let [x, y] = args;
        if (!abs) { x += cx; y += cy; }
        out.push(['M', x, y]);
        cx = x; cy = y; sx = x; sy = y;
        break;
      }
      case 'L': {
        let [x, y] = args;
        if (!abs) { x += cx; y += cy; }
        out.push(['L', x, y]);
        cx = x; cy = y;
        break;
      }
      case 'H': {
        let [x] = args;
        if (!abs) x += cx;
        out.push(['L', x, cy]);
        cx = x;
        break;
      }
      case 'V': {
        let [y] = args;
        if (!abs) y += cy;
        out.push(['L', cx, y]);
        cy = y;
        break;
      }
      case 'C': {
        let [x1, y1, x2, y2, x, y] = args;
        if (!abs) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
        out.push(['C', x1, y1, x2, y2, x, y]);
        pcx = x2; pcy = y2;
        cx = x; cy = y;
        break;
      }
      case 'S': {
        let [x2, y2, x, y] = args;
        if (!abs) { x2 += cx; y2 += cy; x += cx; y += cy; }
        let x1 = cx;
        let y1 = cy;
        if (prev === 'C' || prev === 'S') { x1 = 2 * cx - pcx; y1 = 2 * cy - pcy; }
        out.push(['C', x1, y1, x2, y2, x, y]);
        pcx = x2; pcy = y2;
        cx = x; cy = y;
        break;
      }
      case 'Q': {
        let [qx, qy, x, y] = args;
        if (!abs) { qx += cx; qy += cy; x += cx; y += cy; }
        out.push(quadToCubic(cx, cy, qx, qy, x, y));
        pcx = qx; pcy = qy;
        cx = x; cy = y;
        break;
      }
      case 'T': {
        let [x, y] = args;
        if (!abs) { x += cx; y += cy; }
        let qx = cx;
        let qy = cy;
        if (prev === 'Q' || prev === 'T') { qx = 2 * cx - pcx; qy = 2 * cy - pcy; }
        out.push(quadToCubic(cx, cy, qx, qy, x, y));
        pcx = qx; pcy = qy;
        cx = x; cy = y;
        break;
      }
      case 'A': {
        let [rx, ry, rot, laf, sf, x, y] = args;
        if (!abs) { x += cx; y += cy; }
        for (const seg of arcToCubics(cx, cy, rx, ry, rot, !!laf, !!sf, x, y)) out.push(seg);
        cx = x; cy = y;
        break;
      }
      case 'Z': {
        out.push(['Z']);
        cx = sx; cy = sy;
        break;
      }
    }
    prev = C;
  }
  return out;
}

function quadToCubic(x0, y0, qx, qy, x, y) {
  return [
    'C',
    x0 + (2 / 3) * (qx - x0),
    y0 + (2 / 3) * (qy - y0),
    x + (2 / 3) * (qx - x),
    y + (2 / 3) * (qy - y),
    x,
    y,
  ];
}

// --- Affine matrices, represented as [a, b, c, d, e, f] ---

export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function applyToPoint(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// Parse an SVG `transform` attribute into a single matrix.
export function parseTransform(str) {
  let m = IDENTITY;
  if (!str) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(str))) {
    const name = match[1];
    const args = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let t = IDENTITY;
    switch (name) {
      case 'matrix':
        if (args.length === 6) t = args;
        break;
      case 'translate':
        t = [1, 0, 0, 1, args[0] || 0, args.length > 1 ? args[1] : 0];
        break;
      case 'scale':
        t = [args[0] ?? 1, 0, 0, args.length > 1 ? args[1] : (args[0] ?? 1), 0, 0];
        break;
      case 'rotate': {
        const a = ((args[0] || 0) * Math.PI) / 180;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        t = [cos, sin, -sin, cos, 0, 0];
        if (args.length > 2) {
          const [, cx, cy] = args;
          t = multiply(multiply([1, 0, 0, 1, cx, cy], t), [1, 0, 0, 1, -cx, -cy]);
        }
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan(((args[0] || 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        t = [1, Math.tan(((args[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = multiply(m, t);
  }
  return m;
}

export function transformSegments(segments, m) {
  return segments.map((seg) => {
    switch (seg[0]) {
      case 'M':
      case 'L': {
        const [x, y] = applyToPoint(m, seg[1], seg[2]);
        return [seg[0], x, y];
      }
      case 'C': {
        const [x1, y1] = applyToPoint(m, seg[1], seg[2]);
        const [x2, y2] = applyToPoint(m, seg[3], seg[4]);
        const [x, y] = applyToPoint(m, seg[5], seg[6]);
        return ['C', x1, y1, x2, y2, x, y];
      }
      default:
        return ['Z'];
    }
  });
}

export function serializeSegments(segments, precision = 3) {
  const f = (v) => {
    const r = Number(v.toFixed(precision));
    return Object.is(r, -0) ? '0' : String(r);
  };
  return segments
    .map((seg) => {
      switch (seg[0]) {
        case 'M':
        case 'L':
          return `${seg[0]}${f(seg[1])} ${f(seg[2])}`;
        case 'C':
          return `C${f(seg[1])} ${f(seg[2])} ${f(seg[3])} ${f(seg[4])} ${f(seg[5])} ${f(seg[6])}`;
        default:
          return 'Z';
      }
    })
    .join('');
}

// Split normalized segments into subpaths: { start:[x,y], points:[[x,y]...], closed }
// Curves are flattened with `samplesPerCurve` interior samples.
export function sampleSubpaths(segments, samplesPerCurve = 12) {
  const subpaths = [];
  let current = null;
  let cx = 0;
  let cy = 0;

  for (const seg of segments) {
    switch (seg[0]) {
      case 'M':
        if (current && current.points.length > 1) subpaths.push(current);
        current = { points: [[seg[1], seg[2]]], closed: false };
        cx = seg[1];
        cy = seg[2];
        break;
      case 'L':
        if (!current) break;
        current.points.push([seg[1], seg[2]]);
        cx = seg[1];
        cy = seg[2];
        break;
      case 'C': {
        if (!current) break;
        const [, x1, y1, x2, y2, x, y] = seg;
        for (let i = 1; i <= samplesPerCurve; i++) {
          const t = i / samplesPerCurve;
          const mt = 1 - t;
          const px =
            mt * mt * mt * cx + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x;
          const py =
            mt * mt * mt * cy + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y;
          current.points.push([px, py]);
        }
        cx = x;
        cy = y;
        break;
      }
      case 'Z':
        if (current) {
          current.closed = true;
          subpaths.push(current);
          cx = current.points[0][0];
          cy = current.points[0][1];
          current = null;
        }
        break;
    }
  }
  if (current && current.points.length > 1) subpaths.push(current);
  return subpaths;
}

export function segmentsBBox(segments) {
  const subpaths = sampleSubpaths(segments, 8);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sp of subpaths) {
    for (const [x, y] of sp.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// Count anchor nodes (on-curve points) in a normalized segment list.
export function countNodes(segments) {
  return segments.filter((s) => s[0] === 'M' || s[0] === 'L' || s[0] === 'C').length;
}
