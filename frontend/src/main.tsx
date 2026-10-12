import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadPrefs } from './prefs';
import './styles.css';

void loadPrefs().then(() => createRoot(document.getElementById('root')!).render(<App />));
