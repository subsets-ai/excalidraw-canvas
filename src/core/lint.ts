import { ServerElement } from '../types.js';

// Geometric quality checks the agent can run instead of a screenshot:
// overlap, label overflow, arrows cutting through unrelated boxes, unbound
// arrows. Pure math on the scene — no browser tab needed. A screenshot is
// still the gold standard for final visual sign-off; this catches the
// common problems cheaply.

export interface LintWarning {
  kind: 'overlap' | 'label-overflow' | 'arrow-through-box' | 'unbound-arrow';
  elements: string[];
  message: string;
}

interface Box { x0: number; y0: number; x1: number; y1: number }

function boxOf(el: ServerElement): Box {
  return { x0: el.x, y0: el.y, x1: el.x + (el.width ?? 0), y1: el.y + (el.height ?? 0) };
}

function intersects(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function contains(outer: Box, inner: Box): boolean {
  return outer.x0 <= inner.x0 && outer.y0 <= inner.y0 && outer.x1 >= inner.x1 && outer.y1 >= inner.y1;
}

// Liang-Barsky segment vs box
function segmentHitsBox(px: number, py: number, qx: number, qy: number, b: Box): boolean {
  let t0 = 0, t1 = 1;
  const dx = qx - px, dy = qy - py;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, px - b.x0) && clip(dx, b.x1 - px) && clip(-dy, py - b.y0) && clip(dy, b.y1 - py);
}

export function lintScene(elements: ServerElement[]): LintWarning[] {
  const warnings: LintWarning[] = [];
  const byId = new Map(elements.map(el => [el.id, el]));
  const label = (el: ServerElement): string => {
    const t = (el as any).label?.text ?? (el.type === 'text' ? el.text : '');
    return t ? ` ("${(String(t).split('\n')[0] ?? '').slice(0, 24)}")` : '';
  };

  const isBoundText = (el: ServerElement): boolean => el.type === 'text' && !!(el as any).containerId;
  const shapes = elements.filter(el =>
    el.type !== 'arrow' && el.type !== 'line' && el.type !== 'freedraw' && !isBoundText(el) && (el.width ?? 0) > 0
  );

  // A shape that fully contains another is a zone/container — not an overlap
  const zoneIds = new Set<string>();
  for (const a of shapes) {
    for (const b of shapes) {
      if (a.id !== b.id && contains(boxOf(a), boxOf(b))) zoneIds.add(a.id);
    }
  }

  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const a = shapes[i]!, b = shapes[j]!;
      if (zoneIds.has(a.id) || zoneIds.has(b.id)) continue;
      if (a.type === 'text' || b.type === 'text') continue; // free text near shapes is usually fine
      if (intersects(boxOf(a), boxOf(b))) {
        warnings.push({
          kind: 'overlap',
          elements: [a.id, b.id],
          message: `${a.id}${label(a)} overlaps ${b.id}${label(b)}`
        });
      }
    }
  }

  // Bound label wider/taller than its container
  for (const el of elements) {
    if (!isBoundText(el)) continue;
    const container = byId.get((el as any).containerId);
    if (!container) continue;
    if ((el.width ?? 0) > (container.width ?? 0) - 8 || (el.height ?? 0) > (container.height ?? 0) - 4) {
      warnings.push({
        kind: 'label-overflow',
        elements: [container.id],
        message: `label of ${container.id}${label(container)} exceeds its box (${Math.round(el.width ?? 0)}x${Math.round(el.height ?? 0)} in ${Math.round(container.width ?? 0)}x${Math.round(container.height ?? 0)}) — widen or shorten`
      });
    }
  }

  // Arrows: unbound, or cutting through unrelated boxes
  for (const el of elements) {
    if (el.type !== 'arrow') continue;
    const anyEl = el as any;
    const from = anyEl.startBinding?.elementId ?? anyEl.start?.id;
    const to = anyEl.endBinding?.elementId ?? anyEl.end?.id;
    if (!from && !to) {
      warnings.push({ kind: 'unbound-arrow', elements: [el.id], message: `arrow ${el.id} is not connected to any element` });
    }
    const pts: [number, number][] = anyEl.points ?? [];
    for (let s = 0; s + 1 < pts.length; s++) {
      const [px, py] = [el.x + pts[s]![0], el.y + pts[s]![1]];
      const [qx, qy] = [el.x + pts[s + 1]![0], el.y + pts[s + 1]![1]];
      for (const shape of shapes) {
        if (shape.id === from || shape.id === to || zoneIds.has(shape.id) || shape.type === 'text') continue;
        if (segmentHitsBox(px, py, qx, qy, boxOf(shape))) {
          warnings.push({
            kind: 'arrow-through-box',
            elements: [el.id, shape.id],
            message: `arrow ${el.id} (${from ?? '?'} -> ${to ?? '?'}) passes through ${shape.id}${label(shape)}`
          });
          break;
        }
      }
    }
  }

  // Dedup identical messages
  const seen = new Set<string>();
  return warnings.filter(w => !seen.has(w.message) && seen.add(w.message));
}
