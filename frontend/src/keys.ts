/** Shortcut labels as the platform writes them: ⌘ and ⇧ on a Mac, Ctrl+ and Shift+ elsewhere. */
const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const keys = (label: string): string => (mac ? label : label.replace(/⇧/g, 'Shift+').replace(/⌘/g, 'Ctrl+'));
