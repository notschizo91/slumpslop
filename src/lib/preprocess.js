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
