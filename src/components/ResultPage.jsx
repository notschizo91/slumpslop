import { useMemo, useState } from 'react';

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function ResultPage({ source, result, onBack }) {
  const [overlay, setOverlay] = useState(false);
  const { meta, svgText } = result;

  const svgUrl = useMemo(
    () => URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' })),
    [svgText]
  );

  const download = () => {
    const a = document.createElement('a');
    a.href = svgUrl;
    a.download = source.name.replace(/\.(png|jpe?g|bmp|svg)$/i, '') + '-cad.svg';
    a.click();
  };

  const validationOk = meta.selfIntersecting === 0;

  return (
    <main className="card card-result">
      <div className="compare">
        <div className="panel">
          <h2>Original</h2>
          <div className="canvas-box">
            <img src={source.url} alt={`Original: ${source.name}`} />
          </div>
          <dl className="info">
            <div>
              <dt>File</dt>
              <dd>{source.name}</dd>
            </div>
            <div>
              <dt>Dimensions</dt>
              <dd>
                {Math.round(source.width)} &times; {Math.round(source.height)}
                {source.type === 'raster' ? ' px' : ' units'}
              </dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(source.file.size)}</dd>
            </div>
          </dl>
        </div>

        <div className="panel">
          <h2>CAD-ready SVG</h2>
          <div className="canvas-box">
            {overlay && (
              <img className="ghost" src={source.url} alt="" aria-hidden="true" />
            )}
            <img src={svgUrl} alt="Vectorized SVG result" />
          </div>
          <dl className="info">
            <div>
              <dt>Output size</dt>
              <dd>
                {meta.targetWidth} &times; {meta.targetHeight} {meta.unit}
              </dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(meta.bytes)}</dd>
            </div>
            <div>
              <dt>Paths / nodes</dt>
              <dd>
                {meta.pathCount} / {meta.nodeCount}
              </dd>
            </div>
            <div>
              <dt>Validation</dt>
              <dd className={validationOk ? 'ok' : 'warn'}>
                {validationOk ? 'All paths closed, no self-intersections' : `${meta.selfIntersecting} self-intersecting path(s) flagged`}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      {(meta.autoClosed > 0 ||
        meta.duplicatesRemoved > 0 ||
        meta.degenerateRemoved > 0 ||
        meta.usedThreshold !== null ||
        meta.warnings.length > 0) && (
        <ul className="notes">
          {meta.usedThreshold !== null && (
            <li>Threshold used: {meta.usedThreshold}</li>
          )}
          {meta.autoClosed > 0 && <li>{meta.autoClosed} open subpath(s) auto-closed</li>}
          {meta.duplicatesRemoved > 0 && (
            <li>{meta.duplicatesRemoved} duplicate path(s) removed</li>
          )}
          {meta.degenerateRemoved > 0 && (
            <li>{meta.degenerateRemoved} degenerate path(s) removed</li>
          )}
          {meta.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <div className="result-actions">
        <label className="checkbox overlay-toggle">
          <input
            type="checkbox"
            checked={overlay}
            onChange={(e) => setOverlay(e.target.checked)}
          />
          Ghost original behind SVG
        </label>
        <div className="result-buttons">
          <button type="button" className="btn btn-secondary" onClick={onBack}>
            Adjust settings
          </button>
          <button type="button" className="btn btn-primary" onClick={download}>
            Download SVG
          </button>
        </div>
      </div>
    </main>
  );
}
