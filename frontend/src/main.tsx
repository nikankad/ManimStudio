import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadPrefs } from './prefs';
import { applyPrefs } from './store';
import { loadWording } from './wording';
import './styles.css';

void loadPrefs().then(() => {
  applyPrefs();
  loadWording();
  createRoot(document.getElementById('root')!).render(<App />);
});
