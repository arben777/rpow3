// The 1000×1000 px billboard.
//
// Render strategy:
//   * One <canvas> draws the entire grid. We fetch /billboard/grid (one
//     JSON list of all slots) on mount + every 10 s, then paint each
//     slot's image into its rectangle. Only as many image fetches as
//     there are claimed slots — early on this is a handful.
//   * Hover/click goes through one transparent <div> overlay sized to
//     match the canvas. We do hit-testing in JS from the click coords
//     against the cached slot list.
//
// The MDH aesthetic: 100×100 grid of cells, each cell 10×10 px. Hovering
// a claimed slot pops a tooltip (owner mask, RPOW burned, listing price);
// clicking a claimed slot opens its detail panel with the click-URL.
// Clicking an empty cell opens the claim modal pre-positioned there.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { useMe } from '../hooks/useMe.js';
import { api, resolveImageUrl } from '../api.js';
import type { BillboardSummary, SlotGridEntry } from '@rpow/shared';

const CANVAS_DIM_PX = 1000;
const CELL_PX = 10;

type ModalState =
  | { kind: 'none' }
  | { kind: 'claim'; cell_x: number; cell_y: number; cell_w: number; cell_h: number }
  | { kind: 'detail'; slot_id: number }
  | { kind: 'edit'; slot: SlotGridEntry };

export function BillboardPage() {
  const { me, refresh: refreshMe } = useMe();
  const [grid, setGrid] = useState<SlotGridEntry[] | null>(null);
  const [summary, setSummary] = useState<BillboardSummary | null>(null);
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const [error, setError] = useState<string | null>(null);
  const [zoomScale, setZoomScale] = useState(1);
  const [hoverSlot, setHoverSlot] = useState<SlotGridEntry | null>(null);
  const [mousePx, setMousePx] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<null | { startX: number; startY: number; endX: number; endY: number }>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());

  const slotByCellMemo = useMemo(() => {
    if (!grid) return null;
    const map = new Map<string, SlotGridEntry>();
    for (const slot of grid) {
      if (slot.state !== 'OWNED') continue;
      for (let dy = 0; dy < slot.cell_h; dy++) {
        for (let dx = 0; dx < slot.cell_w; dx++) {
          map.set(`${slot.cell_x + dx},${slot.cell_y + dy}`, slot);
        }
      }
    }
    return map;
  }, [grid]);

  const ownedByMe = useMemo(() => {
    if (!grid || !me) return [];
    return grid.filter(s => s.state === 'OWNED');
    // owner_handle_masked doesn't expose the full email; we'll filter using the
    // detail call when the user clicks. For the "your slots" list below, we
    // approximate via the prefix of the masked handle.
  }, [grid, me]);

  async function loadGrid() {
    try {
      const [g, s] = await Promise.all([api.billboardGrid(), api.billboardSummary()]);
      setGrid(g);
      setSummary(s);
    } catch (e: any) {
      setError(e?.message ?? 'failed to load billboard');
    }
  }

  useEffect(() => {
    loadGrid();
    const t = setInterval(loadGrid, 10_000);
    return () => clearInterval(t);
  }, []);

  // Render the canvas whenever grid changes.
  useEffect(() => {
    if (!grid || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = CANVAS_DIM_PX;
    canvas.height = CANVAS_DIM_PX;
    ctx.fillStyle = '#0b0b0e';
    ctx.fillRect(0, 0, CANVAS_DIM_PX, CANVAS_DIM_PX);

    // Subtle 10×10 grid lines.
    ctx.strokeStyle = 'rgba(110, 231, 183, 0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 100; i += 10) {
      const p = i * CELL_PX;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, CANVAS_DIM_PX); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(CANVAS_DIM_PX, p); ctx.stroke();
    }

    for (const slot of grid) {
      const px = slot.cell_x * CELL_PX;
      const py = slot.cell_y * CELL_PX;
      const pw = slot.cell_w * CELL_PX;
      const ph = slot.cell_h * CELL_PX;
      if (slot.state === 'MOD_HIDDEN') {
        // Diagonal stripes for hidden content.
        ctx.fillStyle = '#3a1d1d';
        ctx.fillRect(px, py, pw, ph);
        ctx.strokeStyle = '#7a3a3a';
        for (let s = -ph; s < pw; s += 6) {
          ctx.beginPath(); ctx.moveTo(px + s, py); ctx.lineTo(px + s + ph, py + ph); ctx.stroke();
        }
        continue;
      }
      if (!slot.image_url) continue;
      const url = resolveImageUrl(slot.image_url) ?? slot.image_url;
      let img = imageCacheRef.current.get(url);
      if (!img) {
        img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          // Re-paint just this slot when its image lands. Repaint the
          // whole canvas instead of computing a partial redraw — at our
          // sizes, full repaint is well under a millisecond.
          if (canvasRef.current) {
            ctx.drawImage(img!, px, py, pw, ph);
          }
        };
        img.src = url;
        imageCacheRef.current.set(url, img);
      } else if (img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, px, py, pw, ph);
      }
    }
  }, [grid]);

  // Mouse handlers operate in canvas coordinates.
  function eventToCell(e: React.MouseEvent | React.TouchEvent): { cx: number; cy: number; px: number; py: number } | null {
    const overlay = e.currentTarget as HTMLElement;
    const rect = overlay.getBoundingClientRect();
    const point = 'touches' in e
      ? (e.touches[0] ?? e.changedTouches?.[0])
      : (e as React.MouseEvent);
    if (!point) return null;
    const x = (point.clientX - rect.left) * (CANVAS_DIM_PX / rect.width);
    const y = (point.clientY - rect.top) * (CANVAS_DIM_PX / rect.height);
    if (x < 0 || y < 0 || x >= CANVAS_DIM_PX || y >= CANVAS_DIM_PX) return null;
    return {
      cx: Math.floor(x / CELL_PX),
      cy: Math.floor(y / CELL_PX),
      px: x, py: y,
    };
  }

  function onOverlayMouseMove(e: React.MouseEvent) {
    const c = eventToCell(e);
    if (!c) { setHoverSlot(null); setMousePx(null); return; }
    setMousePx({ x: c.px, y: c.py });
    if (drag) {
      setDrag({ ...drag, endX: c.cx, endY: c.cy });
      return;
    }
    const slot = slotByCellMemo?.get(`${c.cx},${c.cy}`) ?? null;
    setHoverSlot(slot);
  }

  function onOverlayMouseLeave() {
    setHoverSlot(null);
    setMousePx(null);
    setDrag(null);
  }

  function onOverlayMouseDown(e: React.MouseEvent) {
    if (!me) return;
    const c = eventToCell(e);
    if (!c) return;
    const existing = slotByCellMemo?.get(`${c.cx},${c.cy}`);
    if (existing) {
      setModal({ kind: 'detail', slot_id: existing.slot_id });
      return;
    }
    setDrag({ startX: c.cx, startY: c.cy, endX: c.cx, endY: c.cy });
  }

  function onOverlayMouseUp(e: React.MouseEvent) {
    if (!drag) return;
    const c = eventToCell(e);
    const endX = c?.cx ?? drag.endX;
    const endY = c?.cy ?? drag.endY;
    const x0 = Math.min(drag.startX, endX);
    const y0 = Math.min(drag.startY, endY);
    const w = Math.abs(endX - drag.startX) + 1;
    const h = Math.abs(endY - drag.startY) + 1;
    setDrag(null);
    // Verify selection doesn't intersect any owned slot. If it does,
    // shrink to a single cell at the start (most charitable interpretation).
    let intersects = false;
    if (slotByCellMemo) {
      outer: for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          if (slotByCellMemo.has(`${x0 + dx},${y0 + dy}`)) { intersects = true; break outer; }
        }
      }
    }
    if (intersects) {
      setError('Selection overlaps an existing slot');
      return;
    }
    setError(null);
    setModal({ kind: 'claim', cell_x: x0, cell_y: y0, cell_w: w, cell_h: h });
  }

  return (
    <>
      <Panel title="THE BILLBOARD">
        {error && <div className="error" style={{ marginBottom: 8 }}>{error}</div>}
        {summary && (
          <div className="dim" style={{ marginBottom: 8, fontSize: 12 }}>
            cells: {summary.cells_claimed.toLocaleString()} / {summary.cells_total.toLocaleString()}
            {' · '}rpow burned: {summary.total_rpow_burned.toLocaleString()}
            {' · '}listed: {summary.slots_listed}
            {' · '}rpow/cell: {summary.config.rpow_per_cell}
            {' · '}lightning: <span className={summary.config.lightning_enabled ? 'accent' : 'dim'}>{summary.config.lightning_enabled ? 'ON' : 'OFF'}</span>
          </div>
        )}
        <div className="dim" style={{ marginBottom: 8, fontSize: 11 }}>
          {me
            ? 'click an empty area and drag to claim a rectangle · click a slot to view detail'
            : 'log in to claim a slot.'}
          {' '}
          <button onClick={() => setZoomScale(z => Math.max(0.25, z * 0.8))} style={{ padding: '0 6px' }}>−</button>
          {' '}
          <button onClick={() => setZoomScale(z => Math.min(3, z * 1.25))} style={{ padding: '0 6px' }}>+</button>
          {' '}<span>{(zoomScale * 100).toFixed(0)}%</span>
        </div>
        <div style={{ overflow: 'auto', maxWidth: '100%', WebkitOverflowScrolling: 'touch', position: 'relative' }}>
          <div style={{
            position: 'relative',
            width: CANVAS_DIM_PX * zoomScale, height: CANVAS_DIM_PX * zoomScale,
            margin: '0 auto',
            border: '1px solid var(--accent-dim)',
            background: '#08080a',
            imageRendering: 'pixelated',
          }}>
            <canvas
              ref={canvasRef}
              width={CANVAS_DIM_PX}
              height={CANVAS_DIM_PX}
              style={{
                width: '100%', height: '100%', display: 'block',
                imageRendering: 'pixelated',
              }}
            />
            <div
              onMouseMove={onOverlayMouseMove}
              onMouseDown={onOverlayMouseDown}
              onMouseUp={onOverlayMouseUp}
              onMouseLeave={onOverlayMouseLeave}
              style={{
                position: 'absolute', inset: 0, cursor: me ? 'crosshair' : 'pointer',
              }}
            >
              {drag && (() => {
                const x0 = Math.min(drag.startX, drag.endX);
                const y0 = Math.min(drag.startY, drag.endY);
                const w = Math.abs(drag.endX - drag.startX) + 1;
                const h = Math.abs(drag.endY - drag.startY) + 1;
                return (
                  <div style={{
                    position: 'absolute',
                    left: `${(x0 * CELL_PX / CANVAS_DIM_PX) * 100}%`,
                    top: `${(y0 * CELL_PX / CANVAS_DIM_PX) * 100}%`,
                    width: `${(w * CELL_PX / CANVAS_DIM_PX) * 100}%`,
                    height: `${(h * CELL_PX / CANVAS_DIM_PX) * 100}%`,
                    border: '2px dashed var(--accent)',
                    background: 'rgba(110, 231, 183, 0.15)',
                    pointerEvents: 'none',
                  }} />
                );
              })()}
            </div>
            {hoverSlot && mousePx && (
              <div className="bb-tooltip" style={{
                position: 'absolute',
                left: Math.min(80, mousePx.x / CANVAS_DIM_PX * 100) + '%',
                top: Math.min(80, mousePx.y / CANVAS_DIM_PX * 100) + '%',
                pointerEvents: 'none',
                background: 'rgba(8,8,10,0.92)',
                border: '1px solid var(--accent-dim)',
                color: 'var(--fg)',
                padding: '6px 10px',
                fontSize: 11,
                lineHeight: 1.4,
                whiteSpace: 'pre',
                fontFamily: 'inherit',
                transform: 'translate(8px, 8px)',
                maxWidth: 240,
                zIndex: 5,
              }}>
{`#${hoverSlot.slot_id}  ${hoverSlot.cell_w}×${hoverSlot.cell_h} @ (${hoverSlot.cell_x},${hoverSlot.cell_y})
owner: ${hoverSlot.owner_handle_masked ?? '(unowned)'}
burned: ${hoverSlot.total_rpow_burned} RPOW${
  hoverSlot.listing_sats != null ? `\nfor sale: ${hoverSlot.listing_sats.toLocaleString()} sats` : ''
}${
  hoverSlot.click_url ? `\n→ ${hostnameOf(hoverSlot.click_url)}` : ''
}${hoverSlot.pending_review ? '\n⚠ pending review' : ''}`}
              </div>
            )}
          </div>
        </div>
      </Panel>

      {ownedByMe.length > 0 && (
        <Panel title="LIVE BILLBOARD ACTIVITY">
          <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
            click any slot above to view + edit if it's yours, or take it over if it's listed
          </div>
        </Panel>
      )}

      {modal.kind === 'claim' && (
        <ClaimModal
          rect={modal}
          rpowPerCell={summary?.config.rpow_per_cell ?? 100}
          balance={me?.balance ?? 0}
          onClose={() => setModal({ kind: 'none' })}
          onClaimed={async () => {
            setModal({ kind: 'none' });
            await loadGrid();
            await refreshMe();
          }}
        />
      )}
      {modal.kind === 'detail' && (
        <SlotDetailModal
          slotId={modal.slot_id}
          meEmail={me?.email}
          lightningEnabled={summary?.config.lightning_enabled ?? false}
          onClose={() => setModal({ kind: 'none' })}
          onChanged={async () => {
            await loadGrid();
            await refreshMe();
          }}
        />
      )}
    </>
  );
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

// ── Claim modal ────────────────────────────────────────────────────────

function ClaimModal({
  rect, rpowPerCell, balance, onClose, onClaimed,
}: {
  rect: { cell_x: number; cell_y: number; cell_w: number; cell_h: number };
  rpowPerCell: number;
  balance: number;
  onClose: () => void;
  onClaimed: () => void;
}) {
  const cells = rect.cell_w * rect.cell_h;
  const cost = cells * rpowPerCell;
  const [imageBytes, setImageBytes] = useState<{ b64: string; ct: 'image/png' | 'image/jpeg' | 'image/webp' } | null>(null);
  const [clickUrl, setClickUrl] = useState('https://');
  const [textCaption, setTextCaption] = useState('');
  const [hoverTooltip, setHoverTooltip] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 256 * 1024) {
      setErr('image must be ≤ 256 KB');
      return;
    }
    const ct = file.type;
    if (ct !== 'image/png' && ct !== 'image/jpeg' && ct !== 'image/webp') {
      setErr('image must be PNG, JPEG, or WebP');
      return;
    }
    const buf = await file.arrayBuffer();
    const b64 = base64ArrayBuffer(buf);
    setImageBytes({ b64, ct });
    setErr(null);
  }

  async function submit() {
    if (!imageBytes) { setErr('select an image'); return; }
    setBusy(true); setErr(null);
    try {
      await api.billboardClaim({
        cell_x: rect.cell_x, cell_y: rect.cell_y, cell_w: rect.cell_w, cell_h: rect.cell_h,
        image_b64: imageBytes.b64, image_content_type: imageBytes.ct,
        click_url: clickUrl,
        text_caption: textCaption || undefined,
        hover_tooltip: hoverTooltip || undefined,
      });
      onClaimed();
    } catch (e: any) {
      setErr(`${e?.error ?? 'INTERNAL'}: ${e?.message ?? 'failed'}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title={`CLAIM SLOT  ${rect.cell_w}×${rect.cell_h} @ (${rect.cell_x}, ${rect.cell_y})`} onClose={onClose}>
      <pre style={{ margin: 0 }}>
{`  rectangle      : ${rect.cell_w}×${rect.cell_h} cells (${rect.cell_w * 10}×${rect.cell_h * 10} px)
  cost           : ${cost.toLocaleString()} RPOW (${rpowPerCell}/cell × ${cells})
  your balance   : ${balance.toLocaleString()} RPOW
  burn           : PERMANENT — RPOW gone, slot is yours forever
`}
      </pre>
      <div style={{ marginTop: 6 }}>
        IMAGE     : <input type="file" accept="image/png,image/jpeg,image/webp" onChange={onFile} />
        <div className="dim" style={{ fontSize: 11 }}>PNG / JPEG / WebP, ≤ 256 KB. Will be drawn at {rect.cell_w * 10}×{rect.cell_h * 10} px.</div>
      </div>
      <div style={{ marginTop: 6 }}>
        CLICK-URL : <input type="url" required value={clickUrl} onChange={e => setClickUrl(e.target.value)} style={{ width: '36ch' }} />
        <div className="dim" style={{ fontSize: 11 }}>https:// only, ≤ 512 chars.</div>
      </div>
      <div style={{ marginTop: 6 }}>
        CAPTION   : <input type="text" maxLength={80} value={textCaption} onChange={e => setTextCaption(e.target.value)} style={{ width: '40ch' }} />
      </div>
      <div style={{ marginTop: 6 }}>
        TOOLTIP   : <input type="text" maxLength={140} value={hoverTooltip} onChange={e => setHoverTooltip(e.target.value)} style={{ width: '40ch' }} />
      </div>
      {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
      <div style={{ marginTop: 12 }}>
        <button onClick={submit} disabled={busy || cost > balance}>
          {busy ? '[ claiming... ]' : `[ BURN ${cost.toLocaleString()} RPOW & CLAIM ]`}
        </button>{' '}
        <button onClick={onClose} disabled={busy}>[ cancel ]</button>
      </div>
    </ModalShell>
  );
}

// ── Slot detail modal ──────────────────────────────────────────────────

function SlotDetailModal({
  slotId, meEmail, lightningEnabled, onClose, onChanged,
}: {
  slotId: number;
  meEmail: string | undefined;
  lightningEnabled: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.billboardSlot>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editMode, setEditMode] = useState(false);

  async function reload() {
    try { setDetail(await api.billboardSlot(slotId)); }
    catch (e: any) { setErr(e?.message ?? 'failed'); }
  }
  useEffect(() => { reload(); }, [slotId]);

  if (!detail) return (
    <ModalShell title={`SLOT #${slotId}`} onClose={onClose}>
      {err ? <div className="error">{err}</div> : <div>loading...</div>}
    </ModalShell>
  );

  const isMine = !!meEmail && detail.owner_handle_masked != null
    && (detail.owner_handle_masked.startsWith(meEmail.slice(0, 1)) && detail.owner_handle_masked.endsWith(`@${meEmail.split('@')[1]}`));

  async function listForSale() {
    const v = window.prompt('Sats price (whole sats):');
    if (!v) return;
    const sats = Number(v);
    if (!Number.isFinite(sats) || sats <= 0) { setErr('invalid price'); return; }
    setBusy(true);
    try { await api.billboardList({ slot_id: slotId, listing_sats: sats }); await reload(); onChanged(); }
    catch (e: any) { setErr(`${e?.error ?? 'INTERNAL'}: ${e?.message ?? 'failed'}`); }
    finally { setBusy(false); }
  }
  async function unlist() {
    setBusy(true);
    try { await api.billboardUnlist({ slot_id: slotId }); await reload(); onChanged(); }
    catch (e: any) { setErr(`${e?.error ?? 'INTERNAL'}: ${e?.message ?? 'failed'}`); }
    finally { setBusy(false); }
  }
  async function takeover() {
    if (!confirm(`Pay ${detail!.listing_sats?.toLocaleString()} sats to take this slot?`)) return;
    setBusy(true);
    try { await api.billboardTakeover({ slot_id: slotId }); await reload(); onChanged(); }
    catch (e: any) { setErr(`${e?.error ?? 'INTERNAL'}: ${e?.message ?? 'failed'}`); }
    finally { setBusy(false); }
  }
  async function abandon() {
    if (!confirm('Abandoning is permanent. The RPOW you burned is GONE. Continue?')) return;
    setBusy(true);
    try {
      await api.billboardAbandon({ slot_id: slotId, confirm: 'I UNDERSTAND THE RPOW BURN IS PERMANENT' });
      onChanged();
      onClose();
    } catch (e: any) { setErr(`${e?.error ?? 'INTERNAL'}: ${e?.message ?? 'failed'}`); }
    finally { setBusy(false); }
  }
  async function report() {
    const reason = window.prompt('Report reason: NSFW / CSAM / MALWARE / COPYRIGHT / IMPERSONATION / OTHER', 'OTHER') ?? '';
    if (!reason) return;
    const r = reason.toUpperCase();
    const allowed = ['NSFW', 'CSAM', 'MALWARE', 'COPYRIGHT', 'IMPERSONATION', 'OTHER'];
    if (!allowed.includes(r)) { setErr('invalid reason'); return; }
    const notes = window.prompt('Notes (optional):') ?? undefined;
    setBusy(true);
    try {
      await api.billboardReport(slotId, { reason: r as any, notes: notes || undefined });
      setErr('reported. ops will review within 24h.');
    } catch (e: any) { setErr(`${e?.error ?? 'INTERNAL'}: ${e?.message ?? 'failed'}`); }
    finally { setBusy(false); }
  }

  if (editMode) {
    return (
      <EditModal
        slot={detail}
        onClose={() => setEditMode(false)}
        onSaved={async () => { setEditMode(false); await reload(); onChanged(); }}
      />
    );
  }

  return (
    <ModalShell title={`SLOT #${detail.slot_id}  ${detail.cell_w}×${detail.cell_h} @ (${detail.cell_x},${detail.cell_y})`} onClose={onClose}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{
          flex: '0 0 auto',
          border: '1px solid var(--accent-dim)',
          padding: 4,
          background: '#08080a',
          imageRendering: 'pixelated',
        }}>
          {detail.image_url ? (
            <img
              src={resolveImageUrl(detail.image_url) ?? detail.image_url}
              width={Math.min(300, detail.cell_w * 10 * 4)}
              height={Math.min(300, detail.cell_h * 10 * 4)}
              alt={detail.text_caption ?? ''}
              style={{ imageRendering: 'pixelated', display: 'block' }}
            />
          ) : <div className="dim">(no image)</div>}
        </div>
        <pre style={{ margin: 0, flex: 1 }}>
{`  owner       : ${detail.owner_handle_masked ?? '(unowned)'}
  state       : ${detail.state}${detail.pending_review ? ' (pending review)' : ''}
  burned      : ${detail.total_rpow_burned} RPOW
  takeovers   : ${detail.takeover_count}
  link        : ${detail.click_url ? hostnameOf(detail.click_url) : '(none)'}
  caption     : ${detail.text_caption ?? '(none)'}
${detail.listing_sats != null ? `  for sale    : ${detail.listing_sats.toLocaleString()} sats\n` : ''}${detail.no_list_until ? `  list cooldown until : ${new Date(detail.no_list_until).toISOString()}\n` : ''}`}
        </pre>
      </div>
      {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
      <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {detail.click_url && (
          <a href={detail.click_url} target="_blank" rel="noopener noreferrer nofollow ugc">[ visit → ]</a>
        )}
        {isMine && <button disabled={busy} onClick={() => setEditMode(true)}>[ edit ]</button>}
        {isMine && !(detail.listing_sats != null) && (
          <button disabled={busy} onClick={listForSale}>[ list for sats ]</button>
        )}
        {isMine && (detail.listing_sats != null) && (
          <button disabled={busy} onClick={unlist}>[ unlist ]</button>
        )}
        {!isMine && (detail.listing_sats != null) && lightningEnabled && (
          <button disabled={busy} onClick={takeover}>
            [ takeover for {detail.listing_sats?.toLocaleString()} sats ]
          </button>
        )}
        {isMine && (
          <button disabled={busy} onClick={abandon} style={{ borderColor: '#7a3a3a', color: '#f87171' }}>
            [ abandon ]
          </button>
        )}
        {!isMine && (
          <button disabled={busy} onClick={report}>[ report ]</button>
        )}
        <button onClick={onClose}>[ close ]</button>
      </div>
    </ModalShell>
  );
}

function EditModal({
  slot, onClose, onSaved,
}: {
  slot: Awaited<ReturnType<typeof api.billboardSlot>>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [imageBytes, setImageBytes] = useState<{ b64: string; ct: 'image/png' | 'image/jpeg' | 'image/webp' } | null>(null);
  const [clickUrl, setClickUrl] = useState(slot.click_url ?? 'https://');
  const [textCaption, setTextCaption] = useState(slot.text_caption ?? '');
  const [hoverTooltip, setHoverTooltip] = useState(slot.hover_tooltip ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 256 * 1024) { setErr('image must be ≤ 256 KB'); return; }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setErr('image must be PNG, JPEG, or WebP'); return;
    }
    const buf = await file.arrayBuffer();
    setImageBytes({ b64: base64ArrayBuffer(buf), ct: file.type as any });
    setErr(null);
  }

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await api.billboardEdit({
        slot_id: slot.slot_id,
        image_b64: imageBytes?.b64,
        image_content_type: imageBytes?.ct,
        click_url: clickUrl !== slot.click_url ? clickUrl : undefined,
        text_caption: textCaption !== slot.text_caption ? textCaption : undefined,
        hover_tooltip: hoverTooltip !== slot.hover_tooltip ? hoverTooltip : undefined,
      });
      onSaved();
    } catch (e: any) {
      setErr(`${e?.error ?? 'INTERNAL'}: ${e?.message ?? 'failed'}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title={`EDIT SLOT #${slot.slot_id}`} onClose={onClose}>
      <div>IMAGE   : <input type="file" accept="image/png,image/jpeg,image/webp" onChange={onFile} /></div>
      <div className="dim" style={{ fontSize: 11 }}>(leave blank to keep current image)</div>
      <div style={{ marginTop: 6 }}>
        URL     : <input type="url" value={clickUrl} onChange={e => setClickUrl(e.target.value)} style={{ width: '36ch' }} />
      </div>
      <div style={{ marginTop: 6 }}>
        CAPTION : <input type="text" maxLength={80} value={textCaption} onChange={e => setTextCaption(e.target.value)} style={{ width: '40ch' }} />
      </div>
      <div style={{ marginTop: 6 }}>
        TOOLTIP : <input type="text" maxLength={140} value={hoverTooltip} onChange={e => setHoverTooltip(e.target.value)} style={{ width: '40ch' }} />
      </div>
      {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
      <div style={{ marginTop: 12 }}>
        <button onClick={submit} disabled={busy}>{busy ? '[ saving... ]' : '[ SAVE ]'}</button>{' '}
        <button onClick={onClose} disabled={busy}>[ cancel ]</button>
      </div>
    </ModalShell>
  );
}

function ModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
      }}
    >
      <div style={{
        background: 'var(--bg-2)', border: '1px solid var(--accent-dim)',
        borderRadius: 4, padding: 16, maxWidth: 600, width: '90%',
        maxHeight: '90vh', overflow: 'auto',
      }}>
        <div className="accent" style={{
          fontSize: 12, letterSpacing: '0.12em', borderBottom: '1px solid var(--accent-dim)',
          paddingBottom: 4, marginBottom: 8,
        }}>
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

function base64ArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
