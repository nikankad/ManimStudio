import { useEffect, useState } from 'react';
import { api } from './api';
import { Inspector } from './components/Inspector';
import { Library } from './components/Library';
import { SharedLists } from './components/ParamField';
import { Panels, Toolbar, useShortcuts } from './components/Panels';
import { Timeline } from './components/Timeline';
import { Viewport } from './components/Viewport';
import { CodeEditor } from './components/CodeEditor';
import { Tour, WelcomeCard } from './components/Help';
import { Home } from './components/Home';
import { getState, loadCatalog, loadDoc, setState, toast, useStore } from './store';
import { loadTemplates } from './templates';

const TL_KEY = 'mathengine.timelineHeight';

function savedHeight(): number {
  try {
    const v = Number(localStorage.getItem(TL_KEY));
    if (v > 120) return v;
  } catch {
    /* storage unavailable */
  }
  return Math.max(220, Math.round(window.innerHeight * 0.4)); // the window can be 0 tall while it opens
}

/** The window (or tab) is named after the open project; a dot marks unsaved changes. */
function useWindowTitle() {
  const home = useStore((s) => s.home);
  const hasProject = useStore((s) => s.hasProject);
  const path = useStore((s) => s.path);
  const dirty = useStore((s) => s.dirty);
  useEffect(() => {
    const name = path ? path.split(/[\\/]/).pop()!.replace(/\.(manimstudio|mathengine)$/, '') : 'Untitled';
    const title = home || !hasProject ? 'Manim Studio' : `${dirty ? '• ' : ''}${name} - Manim Studio`;
    document.title = title;
    api.setTitle(title).catch(() => undefined); // the native window isn't a page with a <title>
  }, [home, hasProject, path, dirty]);
}

export function App() {
  const message = useStore((s) => s.toast);
  const home = useStore((s) => s.home);
  const centerTab = useStore((s) => s.centerTab);
  const [tlHeight, setTlHeight] = useState(savedHeight);
  useShortcuts();
  useWindowTitle();
  useEffect(() => {
    api.initialProject()
      .then((r) => {
        if (r.missing) toast(`Couldn't find ${r.missing}: it may have been moved or renamed. Open it from here.`);
        if (r.home) return setState({ home: true });
        loadDoc(r.doc, r.path);
        if (r.recovery?.length) setState({ restore: r.recovery[0] });
        if (r.imported) setState({ centerTab: 'code', dirty: true });
      })
      .then(loadCatalog)
      .catch((e) => toast(String(e)));
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

  if (home)
    return (
      <>
        <Home />
        <Panels />
        {message && <div className="toast">{message}</div>}
      </>
    );

  return (
    <div className="app" style={{ gridTemplateRows: `44px minmax(220px, 1fr) 6px ${tlHeight}px` }}>
      <Toolbar />
      <Library />
      {centerTab === 'code' ? <CodeEditor /> : <Viewport />}
      <Inspector />
      <div className="splitter" onPointerDown={startResize} title="Drag to resize the timeline" />
      <Timeline />
      <Panels />
      <SharedLists />
      <Tour />
      <WelcomeCard />
      {message && <div className="toast">{message}</div>}
    </div>
  );
}
