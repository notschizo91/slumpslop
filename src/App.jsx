import { useCallback, useState } from 'react';
import ImportPage from './components/ImportPage.jsx';
import ResultPage from './components/ResultPage.jsx';
import { convert } from './lib/pipeline.js';

const DEFAULT_SETTINGS = {
  colorMode: 'color',
  maxColors: 8,
  removeBackground: true,
  autoThreshold: true,
  threshold: 128,
  invert: false,
  colorsAsDark: true,
  turdSize: 2,
  alphaMax: 1.0,
  optTolerance: 0.2,
  targetWidth: 100,
  targetHeight: 100,
  unit: 'mm',
  lockAspect: true,
};

export default function App() {
  const [view, setView] = useState('import');
  const [source, setSource] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const handleConvert = useCallback(async () => {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const input =
        source.type === 'svg'
          ? { kind: 'svg', svgText: source.svgText }
          : { kind: 'raster', image: source.image };
      const res = await convert(input, {
        colorMode: settings.colorMode,
        maxColors: settings.maxColors,
        removeBackground: settings.removeBackground,
        threshold: settings.autoThreshold ? 'auto' : settings.threshold,
        invert: settings.invert,
        colorsAsDark: settings.colorsAsDark,
        turdSize: settings.turdSize,
        alphaMax: settings.alphaMax,
        optTolerance: settings.optTolerance,
        targetWidth: settings.targetWidth,
        targetHeight: settings.targetHeight,
        unit: settings.unit,
      });
      setResult(res);
      setView('result');
    } catch (e) {
      setError(e.message || 'Conversion failed');
    } finally {
      setBusy(false);
    }
  }, [source, settings]);

  return (
    <div className="page">
      <header className="app-header">
        <div className="logo-tile" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#fff" strokeWidth="1.8">
            <path d="M4 18 C 8 6, 16 6, 20 18" />
            <rect x="2" y="16" width="4" height="4" fill="#fff" stroke="none" rx="1" />
            <rect x="18" y="16" width="4" height="4" fill="#fff" stroke="none" rx="1" />
            <circle cx="12" cy="9" r="2" fill="#2ee88f" stroke="none" />
          </svg>
        </div>
        <div className="header-text">
          <h1>Image &rarr; SVG Vectorizer</h1>
          <span className="badge">FREE</span>
        </div>
      </header>

      {view === 'import' ? (
        <ImportPage
          source={source}
          setSource={setSource}
          settings={settings}
          setSettings={setSettings}
          onConvert={handleConvert}
          busy={busy}
          error={error}
        />
      ) : (
        <ResultPage
          source={source}
          result={result}
          onBack={() => setView('import')}
        />
      )}

      <footer className="app-footer">
        CAD-ready output &middot; closed paths &middot; real-world scale &middot; Fusion 360 friendly
      </footer>
    </div>
  );
}
