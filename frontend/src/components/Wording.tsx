// Change wording…: how clips like this one read on the timeline (an entry of the phrasebook, see words.ts).

import { useState } from 'react';
import { setState, useStore } from '../store';
import { findAnim, findStep } from '../timeline';
import { animWords, book, defaultPhrase, getOverrides, nameWords, placeholdersOf, stepWords, type Overrides, type PhraseKey, type Words } from '../words';
import { setPhrase } from '../wording';
import { Modal } from './Modal';
import { Field } from './ParamField';

const id = (k: PhraseKey) => `${k.section}:${k.key}`;

export function WordingDialog() {
  const doc = useStore((s) => s.doc);
  const clip = useStore((s) => s.panelData) as string;
  useStore((s) => s.wording);
  const step = findStep(doc, clip);
  const anim = step ? null : findAnim(doc, clip)?.anim ?? null;
  const wordsWith = (b: ReturnType<typeof book>): Words | null => (anim ? animWords(anim, b) : step ? stepWords(step, b) : null);
  const now = wordsWith(book());
  const keys = [...new Map((now?.keys ?? []).map((k) => [id(k), k])).values()];
  const current = (k: PhraseKey) => getOverrides()[k.section]?.[k.key] ?? defaultPhrase(k.section, k.key) ?? '';
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(keys.map((k) => [id(k), current(k)])));
  const close = () => setState({ panel: null, panelData: null });
  if (!now) return null;

  const merged = (): Overrides => {
    const o: Overrides = structuredClone(getOverrides());
    for (const k of keys) {
      const t = draft[id(k)]?.trim();
      const sec = (o[k.section] ??= {});
      if (t) sec[k.key] = t;
      else delete sec[k.key];
    }
    return o;
  };
  const preview = wordsWith(book(merged()));
  const save = () => {
    for (const k of keys) {
      const t = draft[id(k)]?.trim() ?? '';
      if (t === current(k)) continue;
      setPhrase(k.section, k.key, t && t !== defaultPhrase(k.section, k.key) ? t : null);
    }
    close();
  };
  const show = (w: Words | null) => (w ? [w.name, w.sub].filter(Boolean).join(' · ') : '');
  const values = placeholdersOf(anim, step ?? null);

  return (
    <Modal title="Change wording">
      <p className="muted small">How clips like this one read on the timeline. Every clip that uses the same animation, method or statement changes with it.</p>
      <div className="wording-preview"><span className="muted small">Now</span> <b>{show(now)}</b></div>
      <div className="wording-preview"><span className="muted small">Becomes</span> <b className="wording-new">{show(preview)}</b></div>
      {keys.length === 0 && <p className="muted small">This clip is named after its object only.</p>}
      {keys.map((k) => {
        const d = defaultPhrase(k.section, k.key);
        const changed = (getOverrides()[k.section]?.[k.key] ?? null) !== null;
        return (
          <label key={id(k)} className="param wording-row">
            <span className="pname">{k.what}</span>
            <div className="row">
              <Field className="mono" value={draft[id(k)] ?? ''} ariaLabel={`Wording of ${k.what}`} placeholder={d ?? nameWords(k.key)}
                onChange={(v) => setDraft({ ...draft, [id(k)]: v })} />
              {(changed || (draft[id(k)] ?? '') !== (d ?? '')) && (
                <button className="ghost small" title={d ? `Back to “${d}”` : 'Back to the name in the code'} onClick={(e) => { e.preventDefault(); setDraft({ ...draft, [id(k)]: d ?? '' }); }}>Default</button>
              )}
            </div>
          </label>
        );
      })}
      {values.length > 0 && (
        <p className="muted small">
          This clip's values: {values.map(([p, v], i) => <span key={i}><code>{p}</code> = <code>{v || '—'}</code>{i < values.length - 1 ? ', ' : ''}</span>)}.
        </p>
      )}
      <p className="muted small">
        Write <code>{'{1}'}</code> for the first argument, <code>{'{angle}'}</code> for the one called angle, <code>{'{1|angle}'}</code> for
        whichever is given. <code>{'{1:side}'}</code> says UP as “above” (lists: side, edge, corner, move, arrange);{' '}
        <code>{'{2:side=RIGHT}'}</code> is RIGHT when it isn't given. Leave it empty for the name in the code.
      </p>
      <div className="row actions">
        <span className="spacer" />
        <button onClick={close}>Cancel</button>
        <button className="primary" onClick={save}>Save</button>
      </div>
    </Modal>
  );
}
