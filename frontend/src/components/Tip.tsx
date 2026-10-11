// Hover help for a setting: what it is, what changing it does, its default. Shown on hover or keyboard
// focus after a short delay, in a portal so the narrow inspector panel doesn't clip it.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface TipContent {
  title: string;
  text?: string; // what it is and what changing it does
  notes?: string[]; // default, type, where it comes from…
}

const DELAY = 300;

export function Tip({ tip, children, className = '' }: { tip: TipContent | null; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [at, setAt] = useState<{ x: number; y: number; above: boolean } | null>(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!tip) return <span className={className}>{children}</span>;
  const show = () => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const above = r.bottom + 160 > window.innerHeight;
      setAt({ x: Math.max(8, Math.min(r.left, window.innerWidth - 328)), y: above ? r.top - 6 : r.bottom + 6, above });
    }, DELAY);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setAt(null);
  };
  return (
    <span ref={ref} className={`has-tip ${className}`} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onPointerDown={hide}>
      {children}
      {at &&
        createPortal(
          <div className={`tip ${at.above ? 'above' : ''}`} role="tooltip" style={{ left: at.x, top: at.y }}>
            <div className="tip-title">{tip.title}</div>
            {tip.text && <div className="tip-text">{tip.text}</div>}
            {tip.notes?.filter(Boolean).map((n, i) => <div key={i} className="tip-note">{n}</div>)}
          </div>,
          document.body,
        )}
    </span>
  );
}
