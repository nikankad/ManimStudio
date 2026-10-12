import { useEffect } from 'react';

// The inspector and dialogs build many controls out of a visible label plus one or more inputs in a row
// (min / max, x / y…). Screen readers need each input's name, so inputs that have none take it from their row's
// label: "Position", or "Center 1 of 2" when the row holds several.

const CONTROLS = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea';
const ROW = '.param, .fx-row, .row, .pcontrol, section, label';
const ROW_LABEL = '.pname, h4, span';

const unnamed = (el: Element) =>
  !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && !el.hasAttribute('title') && !el.closest('label') && !el.hasAttribute('data-named');

function nameFor(el: HTMLElement): string {
  let row: Element | null = el.parentElement?.closest(ROW) ?? null;
  // climb to the first row that has a visible label of its own
  for (let hops = 0; row && hops < 4; hops++) {
    const label = Array.from(row.querySelectorAll(ROW_LABEL)).find((l) => !l.contains(el) && !l.querySelector('input, select') && l.textContent?.trim());
    if (label) {
      const base = label.textContent!.trim().replace(/[:：]$/, '');
      const peers = Array.from(row.querySelectorAll(CONTROLS)).filter(unnamed);
      const n = peers.length;
      return n > 1 ? `${base} ${peers.indexOf(el) + 1} of ${n}` : base;
    }
    row = row.parentElement?.closest(ROW) ?? null;
  }
  return (el as HTMLInputElement).placeholder || 'value';
}

function label(root: ParentNode) {
  const controls = root instanceof Element && root.matches(CONTROLS) ? [root, ...root.querySelectorAll(CONTROLS)] : Array.from(root.querySelectorAll(CONTROLS));
  for (const el of controls) if (unnamed(el)) el.setAttribute('aria-label', nameFor(el as HTMLElement));
}

/** Give every unnamed input, select and textarea in the app an accessible name from its row's label. */
export function useAutoLabels() {
  useEffect(() => {
    label(document.body);
    const mo = new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach((n) => n instanceof Element && label(n));
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
}
