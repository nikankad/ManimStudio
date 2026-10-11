import { setState } from '../store';

export function Modal({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }) {
  const close = () => setState({ panel: null, panelData: null });
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="ghost" aria-label="Close" onClick={close}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
