import { useEffect } from 'react';
import { api } from './api';
import { Inspector } from './components/Inspector';
import { Library } from './components/Library';
import { SharedLists } from './components/ParamField';
import { Panels, Toolbar, useShortcuts } from './components/Panels';
import { Timeline } from './components/Timeline';
import { Viewport } from './components/Viewport';
import { getState, loadCatalog, loadDoc, toast, useStore } from './store';

export function App() {
  const message = useStore((s) => s.toast);
  useShortcuts();
  useEffect(() => {
    api.initialProject().then((r) => loadDoc(r.doc, r.path)).then(loadCatalog).catch((e) => toast(String(e)));
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (getState().dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  return (
    <div className="app">
      <Toolbar />
      <Library />
      <Viewport />
      <Inspector />
      <Timeline />
      <Panels />
      <SharedLists />
      {message && <div className="toast">{message}</div>}
    </div>
  );
}
