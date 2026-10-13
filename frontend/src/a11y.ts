import { useEffect } from 'react';

// The inspector and dialogs build many controls out of a visible label plus one or more inputs in a row
// (min / max, x / y…). Screen readers need each input's name, so inputs that have none take it from their row's
// label: "Position", or "Center 1 of 2" when the row holds several. Names made here are marked (data-auto-label)
// and redone when the row's text changes, so a reused input never keeps another row's name.

const CONTROLS = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea';
const ROW = '.param, .fx-row, .row, .pcontrol, section, label';
const PREFERRED = '.pname, h4';
const HINT = '.muted, .small, .tag, .hint, .mono, .scrub'; // notes and values, never a name

const ownName = (el: Element) => (el.hasAttribute('aria-label') && !el.hasAttribute('data-auto-label')) || el.hasAttribute('aria-labelledby') || el.hasAttribute('title') || !!el.closest('label');

function rowLabel(row: Element, el: Element): string | null {
  const candidates = Array.from(row.querySelectorAll(PREFERRED)).concat(Array.from(row.querySelectorAll(':scope > span, :scope > div > span')).filter((s) => !s.matches(HINT)));
  const found = candidates.find((l) => !l.contains(el) && !l.querySelector('input, select') && l.textContent?.trim());
  return found ? found.textContent!.trim().replace(/[:：]$/, '') : null;
}

function nameFor(el: HTMLElement): string {
  const hint = (el as HTMLInputElement).placeholder?.trim();
  if (hint && hint.length <= 40) return hint; // "Add an argument…" says it better than the section's heading
  let row: Element | null = el.parentElement?.closest(ROW) ?? null;
  for (let hops = 0; row && hops < 4; hops++) {
    const base = rowLabel(row, el);
    if (base) {
      const peers = Array.from(row.querySelectorAll(CONTROLS)).filter((c) => !ownName(c));
      return peers.length > 1 ? `${base} ${peers.indexOf(el) + 1} of ${peers.length}` : base;
    }
    row = row.parentElement?.closest(ROW) ?? null;
  }
  return 'value';
}

function label(root: ParentNode) {
  const controls = root instanceof Element && root.matches(CONTROLS) ? [root, ...root.querySelectorAll(CONTROLS)] : Array.from(root.querySelectorAll(CONTROLS));
  for (const el of controls) {
    if (ownName(el)) continue;
    el.setAttribute('aria-label', nameFor(el as HTMLElement));
    el.setAttribute('data-auto-label', '');
  }
}

/** Give every unnamed input, select and textarea in the app an accessible name from its row's label. */
export function useAutoLabels() {
  useEffect(() => {
    label(document.body);
    const dirty = new Set<Element>();
    let queued = false;
    const flush = () => {
      queued = false;
      dirty.forEach((row) => row.isConnected && label(row));
      dirty.clear();
    };
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((n) => n instanceof Element && dirty.add(n));
        // text that changed inside a row (a label now reads differently): redo that row
        const t = r.target instanceof Element ? r.target : r.target.parentElement;
        const row = t && !t.closest('svg, .stage') ? t.closest(ROW) : null;
        // (only a row with names made here: values ticking during playback don't relabel rows that need nothing)
        if (row && r.type === 'characterData' && !dirty.has(row) && row.querySelector('[data-auto-label]')) dirty.add(row);
      }
      if (dirty.size && !queued) {
        queued = true;
        requestAnimationFrame(flush);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, []);
}
