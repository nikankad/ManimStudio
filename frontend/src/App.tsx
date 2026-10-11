import { useEffect, useState } from 'react';
import { api } from './api';
import { Inspector } from './components/Inspector';
import { Library } from './components/Library';
import { SharedLists } from './components/ParamField';
import { Panels, Toolbar, useShortcuts } from './components/Panels';
import { Timeline } from './components/Timeline';
import { Viewport } from './components/Viewport';
import { getState, loadCatalog, loadDoc, toast, useStore } from './store';
import { loadTemplates } from './templates';

const TL_KEY = 'mathengine.timelineHeight';

function savedHeight(): number {
  try {
    const v = Number(localStorage.getItem(TL_KEY));
    if (v > 120) return v;
  } catch {
    /* storage unavailable */
  }
  return Math.round(window.innerHeight * 0.4);
}

export function App() {
  const message = useStore((s) => s.toast);
  const [tlHeight, setTlHeight] = useState(savedHeight);
  useShortcuts();
  useEffect(() => {
    api.initialProject().then((r) => loadDoc(r.doc, r.path)).then(loadCatalog).catch((e) => toast(String(e)));
    void loadTemplates();
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (getState().dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  const startResize = (e: React.PointerEvent) => {
    const y0 = e.clientY, h0 = tlHeight;
    let h = h0;
    const move = (ev: PointerEvent) => {
      h = Math.max(140, Math.min(window.innerHeight - 260, h0 - (ev.clientY - y0)));
      setTlHeight(h);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => {
      window.removeEventListener('pointermove', move);
      try {
        localStorage.setItem(TL_KEY, String(Math.round(h)));
      } catch {
        /* storage unavailable */
      }
    }, { once: true });
  };

  return (
    <div className="app" style={{ gridTemplateRows: `44px minmax(220px, 1fr) 6px ${tlHeight}px` }}>
      <Toolbar />
      <Library />
      <Viewport />
      <Inspector />
      <div className="splitter" onPointerDown={startResize} title="Drag to resize the timeline" />
      <Timeline />
      <Panels />
      <SharedLists />
      {message && <div className="toast">{message}</div>}
    </div>
  );
}
