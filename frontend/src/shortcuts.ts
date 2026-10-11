// One list for key matching, control hints and the in-app shortcut reference.
interface Binding {
  id: string;
  key: string;
  keys: string;
  label: string;
  group: string;
  mod?: boolean;
  shift?: boolean | 'any';
  alt?: boolean;
  repeat?: boolean;
  whileTyping?: boolean;
}

export const SHORTCUTS: Binding[] = [
  { id: 'new', key: 'n', mod: true, keys: 'Mod+N', label: 'New project', group: 'Project' },
  { id: 'open', key: 'o', mod: true, keys: 'Mod+O', label: 'Open project', group: 'Project' },
  { id: 'save', key: 's', mod: true, whileTyping: true, keys: 'Mod+S', label: 'Save project', group: 'Project' },
  { id: 'save-as', key: 's', mod: true, shift: true, whileTyping: true, keys: 'Mod+Shift+S', label: 'Save project as', group: 'Project' },
  { id: 'undo', key: 'z', mod: true, keys: 'Mod+Z', label: 'Undo', group: 'Editing' },
  { id: 'redo', key: 'z', mod: true, shift: true, keys: 'Mod+Shift+Z', label: 'Redo', group: 'Editing' },
  { id: 'redo', key: 'y', mod: true, keys: 'Ctrl+Y', label: 'Redo (alternative)', group: 'Editing' },
  { id: 'copy', key: 'c', mod: true, keys: 'Mod+C', label: 'Copy selected clips', group: 'Editing' },
  { id: 'paste', key: 'v', mod: true, keys: 'Mod+V', label: 'Paste clips at playhead', group: 'Editing' },
  { id: 'duplicate', key: 'd', mod: true, keys: 'Mod+D', label: 'Duplicate selected objects or clips', group: 'Editing' },
  { id: 'select-all', key: 'a', mod: true, keys: 'Mod+A', label: 'Select all objects; all unlocked clips in timeline', group: 'Editing' },
  ...['Delete', 'Backspace'].flatMap((key): Binding[] => [
    { id: 'delete', key, keys: key, label: 'Delete selection', group: 'Editing' },
    { id: 'ripple-delete', key, shift: true, keys: `Shift+${key}`, label: 'Ripple delete clips', group: 'Editing' },
  ]),
  { id: 'toggle-play', key: ' ', keys: 'Space', label: 'Play / pause', group: 'Playback' },
  { id: 'play', key: 'l', keys: 'L', label: 'Play forward', group: 'Playback' },
  { id: 'pause', key: 'k', keys: 'K', label: 'Pause', group: 'Playback' },
  { id: 'back', key: 'j', repeat: true, keys: 'J', label: 'Pause and step backward 5 frames', group: 'Playback' },
  ...['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map((key): Binding => ({
    id: key, key, shift: 'any', repeat: true, keys: `${key.replace('Arrow', '')} / Shift+${key.replace('Arrow', '')}`,
    label: key === 'ArrowLeft' || key === 'ArrowRight' ? 'Nudge objects; otherwise step 1 / 5 frames' : 'Nudge objects; otherwise previous / next edit point', group: 'Viewer and timeline',
  })),
  { id: 'start', key: 'Home', keys: 'Home', label: 'Sequence start', group: 'Playback' },
  { id: 'end', key: 'End', keys: 'End', label: 'Sequence end', group: 'Playback' },
  { id: 'marker', key: 'm', keys: 'M', label: 'Add timeline marker', group: 'Viewer and timeline' },
  { id: 'snap', key: 's', keys: 'S', label: 'Toggle timeline snapping', group: 'Viewer and timeline' },
  { id: 'canvas-snap', key: 's', shift: true, keys: 'Shift+S', label: 'Toggle viewer snapping', group: 'Viewer and timeline' },
  { id: 'record', key: 'r', keys: 'R', label: 'Toggle recording object transforms', group: 'Viewer and timeline' },
  { id: 'zoom-in', key: '=', repeat: true, keys: '= / +', label: 'Zoom focused viewer or timeline', group: 'Viewer and timeline' },
  { id: 'zoom-in', key: '+', shift: 'any', repeat: true, keys: '+', label: 'Zoom in (alternative)', group: 'Viewer and timeline' },
  { id: 'zoom-out', key: '-', repeat: true, keys: '-', label: 'Zoom out in focused viewer or timeline', group: 'Viewer and timeline' },
  { id: 'fit', key: '\\', keys: '\\', label: 'Fit focused viewer or timeline', group: 'Viewer and timeline' },
  { id: 'viewer-fit', key: '0', keys: '0', label: 'Fit entire viewer', group: 'Viewer and timeline' },
  { id: 'viewer-maximize', key: 'f', keys: 'F', label: 'Toggle larger viewer', group: 'Viewer and timeline' },
  { id: 'viewer-selection', key: 'f', shift: true, keys: 'Shift+F', label: 'Frame selected objects in viewer', group: 'Viewer and timeline' },
  { id: 'enable', key: 'e', shift: true, keys: 'Shift+E', label: 'Enable / disable selected unlocked clips', group: 'Viewer and timeline' },
  ...['select', 'point', 'line', 'arrow', 'circle', 'rect', 'polygon'].map((tool, i): Binding => ({
    id: `tool-${tool}`, key: String(i + 1), keys: String(i + 1), label: ['Select', 'Point', 'Segment', 'Arrow', 'Circle', 'Rectangle', 'Polygon'][i], group: 'Drawing',
  })),
  { id: 'tool-select', key: 'v', keys: 'V', label: 'Select tool (alternative)', group: 'Drawing' },
  { id: 'graph', key: 'g', keys: 'G', label: 'Open graph builder', group: 'Panels' },
  { id: 'code', key: 'c', mod: true, shift: true, keys: 'Mod+Shift+C', label: 'Open code', group: 'Panels' },
  { id: 'settings', key: ',', mod: true, keys: 'Mod+,', label: 'Open settings', group: 'Panels' },
  { id: 'export', key: 'e', mod: true, keys: 'Mod+E', label: 'Open video export', group: 'Panels' },
  { id: 'preview', key: 'p', mod: true, shift: true, keys: 'Mod+Shift+P', label: 'Render smooth preview', group: 'Panels' },
  { id: 'search', key: '/', keys: '/', label: 'Search the library', group: 'Panels' },
  ...['library', 'viewer', 'inspector', 'timeline'].map((panel, i): Binding => ({
    id: `focus-${panel}`, key: String(i + 1), alt: true, whileTyping: true, keys: `Alt+${i + 1}`, label: `Focus ${panel}`, group: 'Panels',
  })),
  { id: 'help', key: '?', shift: 'any', keys: '?', label: 'Open shortcut reference and guide', group: 'Panels' },
  { id: 'help', key: 'F1', whileTyping: true, keys: 'F1', label: 'Open guide (also while editing)', group: 'Panels' },
];

export function matchShortcut(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat' | 'isComposing'> & { code?: string }): Binding | undefined {
  if (e.isComposing || (e.ctrlKey && e.altKey)) return; // IME and AltGr belong to text entry.
  return SHORTCUTS.find((b) => (b.key.toLowerCase() === e.key.toLowerCase() || b.alt && e.code === `Digit${b.key}`)
    && Boolean(b.mod) === (e.ctrlKey || e.metaKey)
    && Boolean(b.alt) === e.altKey
    && (b.shift === 'any' || Boolean(b.shift) === e.shiftKey)
    && (!e.repeat || b.repeat));
}

export function isTextEntry(e: KeyboardEvent): boolean {
  return e.composedPath().some((node) => node instanceof Element && (
    node.matches('input, textarea, select, math-field, [role="textbox"], [role="combobox"]')
    || (node instanceof HTMLElement && node.isContentEditable)
  ));
}

const mac = () => /Mac|iPhone|iPad/.test(navigator.platform);
export const shortcutKeys = (keys: string) => keys.replaceAll('Mod', mac() ? 'Cmd' : 'Ctrl').replaceAll('Alt', mac() ? 'Option' : 'Alt');
export function shortcutHint(id: string): string {
  const b = SHORTCUTS.find((s) => s.id === id);
  return b ? `${b.label} (${shortcutKeys(b.keys)})` : '';
}

export type ViewerCommand = 'zoom-in' | 'zoom-out' | 'fit' | 'selection';
export function viewerCommand(command: ViewerCommand) {
  window.dispatchEvent(new CustomEvent('viewer-command', { detail: command }));
}
