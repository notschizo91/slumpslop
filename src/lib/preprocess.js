// Raster preprocessing: decode → grayscale (alpha composited over white)
// → threshold (manual or Otsu) → binary ImageData for the tracer.

export const MAX_TRACE_DIMENSION = 4096;

export async function loadImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Could not decode image "${file.name}"`));
      el.src = url;
    });
    return { image: img, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function imageToImageData(image) {
  let w = image.naturalWidth || image.width;
  let h = image.naturalHeight || image.height;
  let downscaled = false;
  const max = Math.max(w, h);
  if (max > MAX_TRACE_DIMENSION) {
    const s = MAX_TRACE_DIMENSION / max;
    w = Math.round(w * s);
    h = Math.round(h * s);
    downscaled = true;
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, w, h);
  return { imageData: ctx.getImageData(0, 0, w, h), downscaled };
}

// Chroma (max−min channel spread) above which a pixel counts as "colored".
const CHROMA_THRESHOLD = 40;

export function toGrayscale(imageData, { colorsAsDark = true } = {}) {
  const { data, width, height } = imageData;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const a = data[i + 3] / 255;
    // Composite over white so transparent areas read as background.
    const r = data[i] * a + 255 * (1 - a);
    const g = data[i + 1] * a + 255 * (1 - a);
    const b = data[i + 2] * a + 255 * (1 - a);
    // Saturated pixels (any hue) are part of the shape, not background —
    // plain luminance would drop bright colors like green or yellow.
    if (colorsAsDark && Math.max(r, g, b) - Math.min(r, g, b) >= CHROMA_THRESHOLD) {
      gray[p] = 0;
      continue;
    }
    gray[p] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return gray;
}

// Otsu's method: threshold maximizing between-class variance.
export function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

// --- Color quantization (for "keep colors" mode) ---

// Palette entries closer than this (RGB Euclidean) merge into one color, so
// anti-aliased edge blends don't become their own "colors".
const MERGE_DISTANCE = 32;
// A box must span at least this much on one channel to be worth splitting.
const MIN_SPLIT_RANGE = 16;

export function rgbToHex(r, g, b) {
  const h = (v) => Math.round(v).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Median-cut quantization over a 5-bit-binned histogram. Returns
//   palette: [{ r, g, b, count, hex }]  (largest area first)
//   assign:  Int16Array palette index per pixel, -1 = background
//   backgroundHex: removed opaque background color, or null
// Transparent pixels are always background. For fully opaque images the
// palette color dominating the image border is treated as background when
// `removeBackground` is set.
export function quantizeColors(imageData, { maxColors = 8, removeBackground = true } = {}) {
  const { data, width, height } = imageData;
  const n = width * height;
  const assign = new Int16Array(n).fill(-1);

  // Composited RGB per pixel; -1 in rgb[p*3] marks transparent.
  const rgb = new Float32Array(n * 3);
  let opaqueCount = 0;
  let hasTransparency = false;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = data[i + 3];
    if (a < 128) {
      hasTransparency = true;
      rgb[p * 3] = -1;
      continue;
    }
    const t = a / 255;
    rgb[p * 3] = data[i] * t + 255 * (1 - t);
    rgb[p * 3 + 1] = data[i + 1] * t + 255 * (1 - t);
    rgb[p * 3 + 2] = data[i + 2] * t + 255 * (1 - t);
    opaqueCount++;
  }
  if (opaqueCount === 0) throw new Error('Image is fully transparent');

  // Anti-aliased transition pixels sit between two real colors and must not
  // seed the palette. A pixel is an "edge" pixel when a 4-neighbor differs
  // sharply; edge pixels are excluded from the histogram but still assigned
  // to the nearest palette color afterwards.
  const EDGE_DIST_SQ = 48 * 48;
  const isEdge = (p) => {
    const x = p % width;
    const y = (p / width) | 0;
    const r = rgb[p * 3];
    const g = rgb[p * 3 + 1];
    const b = rgb[p * 3 + 2];
    for (const q of [
      x > 0 ? p - 1 : -1,
      x < width - 1 ? p + 1 : -1,
      y > 0 ? p - width : -1,
      y < height - 1 ? p + width : -1,
    ]) {
      if (q < 0 || rgb[q * 3] < 0) continue;
      const d =
        (r - rgb[q * 3]) ** 2 + (g - rgb[q * 3 + 1]) ** 2 + (b - rgb[q * 3 + 2]) ** 2;
      if (d > EDGE_DIST_SQ) return true;
    }
    return false;
  };

  const bins = new Map();
  const addToBins = (skipEdges) => {
    for (let p = 0; p < n; p++) {
      const r = rgb[p * 3];
      if (r < 0) continue;
      if (skipEdges && isEdge(p)) continue;
      const g = rgb[p * 3 + 1];
      const b = rgb[p * 3 + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let bin = bins.get(key);
      if (!bin) {
        bin = { r: 0, g: 0, b: 0, c: 0 };
        bins.set(key, bin);
      }
      bin.r += r;
      bin.g += g;
      bin.b += b;
      bin.c++;
    }
  };
  addToBins(true);
  // Degenerate case (e.g. tiny noisy image where everything is an edge).
  if (bins.size === 0) addToBins(false);

  // Bins as points (bin average color, weight = pixel count).
  const points = [];
  for (const bin of bins.values()) {
    points.push({ r: bin.r / bin.c, g: bin.g / bin.c, b: bin.b / bin.c, c: bin.c });
  }

  const boxRange = (box) => {
    let lo = [255, 255, 255];
    let hi = [0, 0, 0];
    for (const p of box) {
      for (const [ci, ch] of [p.r, p.g, p.b].entries()) {
        if (ch < lo[ci]) lo[ci] = ch;
        if (ch > hi[ci]) hi[ci] = ch;
      }
    }
    const ranges = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const axis = ranges.indexOf(Math.max(...ranges));
    return { axis, range: ranges[axis] };
  };
  const boxCount = (box) => box.reduce((s, p) => s + p.c, 0);

  // Only split boxes with a meaningful pixel share, so sparse anti-aliasing
  // blends never earn a palette slot of their own.
  const minSplitCount = Math.max(20, opaqueCount * 0.005);
  const boxes = [points];
  while (boxes.length < maxColors) {
    let best = -1;
    let bestCount = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const count = boxCount(boxes[i]);
      if (count < minSplitCount) continue;
      if (boxRange(boxes[i]).range <= MIN_SPLIT_RANGE) continue;
      if (count > bestCount) {
        bestCount = count;
        best = i;
      }
    }
    if (best === -1) break;
    const box = boxes[best];
    const { axis } = boxRange(box);
    const ch = ['r', 'g', 'b'][axis];
    box.sort((a, b) => a[ch] - b[ch]);
    const half = boxCount(box) / 2;
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i].c;
      if (acc >= half) {
        cut = i + 1;
        break;
      }
    }
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
  }

  let palette = boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let c = 0;
    for (const p of box) {
      r += p.r * p.c;
      g += p.g * p.c;
      b += p.b * p.c;
      c += p.c;
    }
    return { r: r / c, g: g / c, b: b / c, count: c };
  });

  // Merge palette entries that ended up nearly identical.
  let merged = true;
  while (merged && palette.length > 1) {
    merged = false;
    outer: for (let i = 0; i < palette.length; i++) {
      for (let j = i + 1; j < palette.length; j++) {
        const a = palette[i];
        const b = palette[j];
        const d = Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
        if (d < MERGE_DISTANCE) {
          const c = a.count + b.count;
          palette[i] = {
            r: (a.r * a.count + b.r * b.count) / c,
            g: (a.g * a.count + b.g * b.count) / c,
            b: (a.b * a.count + b.b * b.count) / c,
            count: c,
          };
          palette.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  palette.sort((a, b) => b.count - a.count);

  // Assign every opaque pixel (edges included) to its nearest palette color.
  for (let p = 0; p < n; p++) {
    const r = rgb[p * 3];
    if (r < 0) continue;
    const g = rgb[p * 3 + 1];
    const b = rgb[p * 3 + 2];
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let k = 0; k < palette.length; k++) {
      const q = palette[k];
      const d = (r - q.r) ** 2 + (g - q.g) ** 2 + (b - q.b) ** 2;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = k;
      }
    }
    assign[p] = bestIdx;
  }

  // Background removal for opaque images: the color owning most border pixels.
  let backgroundHex = null;
  if (removeBackground && !hasTransparency && palette.length > 1) {
    const borderCounts = new Array(palette.length).fill(0);
    let borderTotal = 0;
    const tally = (p) => {
      if (assign[p] >= 0) {
        borderCounts[assign[p]]++;
        borderTotal++;
      }
    };
    for (let x = 0; x < width; x++) {
      tally(x);
      tally((height - 1) * width + x);
    }
    for (let y = 1; y < height - 1; y++) {
      tally(y * width);
      tally(y * width + width - 1);
    }
    const bgIdx = borderCounts.indexOf(Math.max(...borderCounts));
    if (borderTotal > 0 && borderCounts[bgIdx] > borderTotal / 2) {
      const q = palette[bgIdx];
      backgroundHex = rgbToHex(q.r, q.g, q.b);
      for (let p = 0; p < n; p++) if (assign[p] === bgIdx) assign[p] = -1;
      palette = palette.filter((_, k) => k !== bgIdx);
      // Re-map assignment indexes after removal.
      for (let p = 0; p < n; p++) if (assign[p] > bgIdx) assign[p]--;
    }
  }

  return {
    palette: palette.map((q) => ({ ...q, hex: rgbToHex(q.r, q.g, q.b) })),
    assign,
    backgroundHex,
  };
}

// Binary mask ImageData for one palette index: its pixels black, rest white.
export function paletteMask(assign, index, width, height) {
  const out = new ImageData(width, height);
  const data = out.data;
  for (let p = 0, i = 0; p < assign.length; p++, i += 4) {
    const v = assign[p] === index ? 0 : 255;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return out;
}

// Produce a pure black-on-white binary ImageData ready for potrace
// (potrace traces the dark pixels). Returns the threshold actually used.
export function binarize(
  imageData,
  { threshold = 'auto', invert = false, colorsAsDark = true } = {}
) {
  const gray = toGrayscale(imageData, { colorsAsDark });
  const t = threshold === 'auto' ? otsuThreshold(gray) : Number(threshold);

  const { width, height } = imageData;
  const out = new ImageData(width, height);
  const data = out.data;
  for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
    // <= so a pure black/white source (Otsu returns t=0) still classifies
    // its black pixels as foreground.
    let dark = gray[p] <= t;
    if (invert) dark = !dark;
    const v = dark ? 0 : 255;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { imageData: out, threshold: t };
}
