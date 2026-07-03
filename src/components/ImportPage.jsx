import { useCallback, useRef, useState } from 'react';
import { loadImageFile } from '../lib/preprocess.js';

const ACCEPT = '.png,.jpg,.jpeg,.bmp,.svg,image/png,image/jpeg,image/bmp,image/svg+xml';

function svgDimensions(svgText, img) {
  const vb = /viewBox\s*=\s*["']([^"']+)["']/.exec(svgText);
  if (vb) {
    const parts = vb[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
    return { width: img.naturalWidth, height: img.naturalHeight };
  }
  return { width: 100, height: 100 };
}

export default function ImportPage({
  source,
  setSource,
  settings,
  setSettings,
  onConvert,
  busy,
  error,
}) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const set = (patch) => setSettings((s) => ({ ...s, ...patch }));

  const applyAspect = useCallback(
    (width, height) => {
      const aspect = height / width;
      setSettings((s) => ({
        ...s,
        targetHeight: Number((s.targetWidth * aspect).toFixed(2)),
      }));
    },
    [setSettings]
  );

  const handleFile = useCallback(
    async (file) => {
      if (!file) return;
      setLoadError(null);
      const name = file.name;
      const isSvg = /\.svg$/i.test(name) || file.type === 'image/svg+xml';
      const isRaster =
        /\.(png|jpe?g|bmp)$/i.test(name) ||
        ['image/png', 'image/jpeg', 'image/bmp'].includes(file.type);
      if (!isSvg && !isRaster) {
        setLoadError('Unsupported file type. Use PNG, JPG, BMP or SVG.');
        return;
      }
      try {
        if (isSvg) {
          const svgText = await file.text();
          const url = URL.createObjectURL(
            new Blob([svgText], { type: 'image/svg+xml' })
          );
          const img = await new Promise((resolve) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => resolve(null);
            el.src = url;
          });
          const dims = svgDimensions(svgText, img);
          if (source?.url) URL.revokeObjectURL(source.url);
          setSource({ file, name, type: 'svg', url, svgText, ...dims });
          applyAspect(dims.width, dims.height);
        } else {
          const { image, width, height } = await loadImageFile(file);
          const url = URL.createObjectURL(file);
          if (source?.url) URL.revokeObjectURL(source.url);
          setSource({ file, name, type: 'raster', url, image, width, height });
          applyAspect(width, height);
        }
      } catch (e) {
        setLoadError(e.message || 'Could not load file');
      }
    },
    [setSource, source, applyAspect]
  );

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files?.[0]);
  };

  const onWidthChange = (v) => {
    const w = Math.max(0.01, Number(v) || 0.01);
    if (settings.lockAspect && source) {
      const aspect = source.height / source.width;
      set({ targetWidth: w, targetHeight: Number((w * aspect).toFixed(2)) });
    } else {
      set({ targetWidth: w });
    }
  };

  const onHeightChange = (v) => {
    const h = Math.max(0.01, Number(v) || 0.01);
    if (settings.lockAspect && source) {
      const aspect = source.width / source.height;
      set({ targetHeight: h, targetWidth: Number((h * aspect).toFixed(2)) });
    } else {
      set({ targetHeight: h });
    }
  };

  return (
    <main className="card card-import">
      <div
        className={`dropzone${dragOver ? ' dropzone-active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
      >
        <svg className="dropzone-icon" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M12 16V4m0 0 4 4m-4-4L8 8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" strokeLinecap="round" />
        </svg>
        <p className="dropzone-title">Drop an image here</p>
        <p className="dropzone-hint">PNG, JPG, BMP &mdash; or an SVG to clean up &amp; validate</p>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={(e) => {
            e.stopPropagation();
            inputRef.current?.click();
          }}
        >
          Browse files
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            handleFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      {loadError && <p className="error-box">{loadError}</p>}

      {source && (
        <div className="file-preview">
          <img className="thumb" src={source.url} alt={`Preview of ${source.name}`} />
          <div className="file-meta">
            <span className="file-name">{source.name}</span>
            <span className="file-dims">
              {Math.round(source.width)} &times; {Math.round(source.height)}
              {source.type === 'raster' ? ' px' : ' units'}
              {' · '}
              {source.type === 'svg' ? 'SVG (cleanup mode)' : 'raster (trace mode)'}
            </span>
          </div>
        </div>
      )}

      <section className="settings">
        <h2>Trace settings</h2>

        <div className={`setting-group${source?.type === 'svg' ? ' setting-disabled' : ''}`}>
          <div className="setting-row">
            <label htmlFor="auto-threshold">
              Threshold
              <span className="setting-hint">auto = Otsu&rsquo;s method</span>
            </label>
            <div className="setting-controls">
              <label className="checkbox">
                <input
                  id="auto-threshold"
                  type="checkbox"
                  checked={settings.autoThreshold}
                  onChange={(e) => set({ autoThreshold: e.target.checked })}
                />
                Auto
              </label>
              <input
                type="range"
                min="0"
                max="255"
                value={settings.threshold}
                disabled={settings.autoThreshold}
                onChange={(e) => set({ threshold: Number(e.target.value) })}
              />
              <span className="setting-value">
                {settings.autoThreshold ? 'auto' : settings.threshold}
              </span>
            </div>
          </div>

          <div className="setting-row">
            <label htmlFor="turd-size">
              Turd size
              <span className="setting-hint">removes specks below this area (px)</span>
            </label>
            <div className="setting-controls">
              <input
                id="turd-size"
                type="range"
                min="0"
                max="50"
                value={settings.turdSize}
                onChange={(e) => set({ turdSize: Number(e.target.value) })}
              />
              <span className="setting-value">{settings.turdSize}</span>
            </div>
          </div>

          <div className="setting-row">
            <label htmlFor="alpha-max">
              Corner sensitivity
              <span className="setting-hint">alphamax &mdash; lower keeps more corners</span>
            </label>
            <div className="setting-controls">
              <input
                id="alpha-max"
                type="range"
                min="0"
                max="1.334"
                step="0.01"
                value={settings.alphaMax}
                onChange={(e) => set({ alphaMax: Number(e.target.value) })}
              />
              <span className="setting-value">{settings.alphaMax.toFixed(2)}</span>
            </div>
          </div>

          <div className="setting-row">
            <label htmlFor="opt-tolerance">
              Curve simplification
              <span className="setting-hint">opttolerance &mdash; higher = fewer nodes</span>
            </label>
            <div className="setting-controls">
              <input
                id="opt-tolerance"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={settings.optTolerance}
                onChange={(e) => set({ optTolerance: Number(e.target.value) })}
              />
              <span className="setting-value">{settings.optTolerance.toFixed(2)}</span>
            </div>
          </div>

          <div className="setting-row">
            <label htmlFor="colors-as-dark">
              Colored pixels
              <span className="setting-hint">count saturated colors as part of the shape</span>
            </label>
            <div className="setting-controls">
              <label className="checkbox">
                <input
                  id="colors-as-dark"
                  type="checkbox"
                  checked={settings.colorsAsDark}
                  onChange={(e) => set({ colorsAsDark: e.target.checked })}
                />
                Treat as solid
              </label>
            </div>
          </div>

          <div className="setting-row">
            <label htmlFor="invert">
              Invert colors
              <span className="setting-hint">for white shapes on dark backgrounds</span>
            </label>
            <div className="setting-controls">
              <label className="checkbox">
                <input
                  id="invert"
                  type="checkbox"
                  checked={settings.invert}
                  onChange={(e) => set({ invert: e.target.checked })}
                />
                Invert
              </label>
            </div>
          </div>

          {source?.type === 'svg' && (
            <p className="setting-note">
              Trace settings don&rsquo;t apply to SVG input &mdash; the file goes straight
              through cleanup &amp; validation.
            </p>
          )}
        </div>

        <h2>Output scale</h2>
        <div className="setting-row">
          <label>
            Real-world size
            <span className="setting-hint">sets viewBox scale for CAD import</span>
          </label>
          <div className="setting-controls size-controls">
            <input
              type="number"
              min="0.01"
              step="any"
              value={settings.targetWidth}
              onChange={(e) => onWidthChange(e.target.value)}
              aria-label="Target width"
            />
            <span className="size-x">&times;</span>
            <input
              type="number"
              min="0.01"
              step="any"
              value={settings.targetHeight}
              onChange={(e) => onHeightChange(e.target.value)}
              aria-label="Target height"
            />
            <select
              value={settings.unit}
              onChange={(e) => set({ unit: e.target.value })}
              aria-label="Units"
            >
              <option value="mm">mm</option>
              <option value="in">in</option>
            </select>
            <label className="checkbox" title="Keep width/height locked to the source aspect ratio">
              <input
                type="checkbox"
                checked={settings.lockAspect}
                onChange={(e) => set({ lockAspect: e.target.checked })}
              />
              Lock aspect
            </label>
          </div>
        </div>
      </section>

      {error && <p className="error-box">{error}</p>}

      <button
        type="button"
        className="btn btn-primary btn-cta"
        disabled={!source || busy}
        onClick={onConvert}
      >
        {busy ? (
          <>
            <span className="spinner" aria-hidden="true" /> Processing&hellip;
          </>
        ) : (
          'Convert'
        )}
      </button>
    </main>
  );
}
