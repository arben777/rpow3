import type { ReactNode } from 'react';

const HORIZ = '+----------------------------------------------------------------------+';

export function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="panel-section" style={{ margin: '12px 0' }}>
      {/* Mobile-only title bar (CSS-bordered panel; the ASCII pre below is hidden ≤720px). */}
      {title && <h2 className="panel-title-mobile">{title}</h2>}
      {title
        ? <pre className="panel-border panel-border-top" style={{ margin: 0 }}>{`+-- ${title} ${'-'.repeat(Math.max(2, 66 - title.length))}+`}</pre>
        : <pre className="panel-border panel-border-top" style={{ margin: 0 }}>{HORIZ}</pre>}
      <div className="panel-body" style={{ padding: '8px 12px' }}>{children}</div>
      <pre className="panel-border panel-border-bottom" style={{ margin: 0 }}>{HORIZ}</pre>
    </section>
  );
}
