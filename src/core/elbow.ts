import { ServerElement } from '../types.js';

// Manhattan (elbow) routing for agent-created arrows bound by
// startElementId/endElementId. Mirrors how a human draws org-chart /
// flowchart connectors: leave one edge, run along a mid-gutter, enter the
// facing edge of the target. Returns the arrow's absolute start point and
// its relative points array.
//
// The route is a good static guess; the browser may refine it (Excalidraw
// re-routes bound elbow arrows on interaction), but it renders correctly
// as-is — including in headless exports.

interface Box { x: number; y: number; w: number; h: number; cx: number; cy: number }

function boxOf(el: ServerElement): Box {
  const w = el.width ?? 0;
  const h = el.height ?? 0;
  return { x: el.x, y: el.y, w, h, cx: el.x + w / 2, cy: el.y + h / 2 };
}

const GAP = 8;

export interface ElbowRoute {
  x: number;
  y: number;
  points: [number, number][];
}

export function elbowRoute(startEl: ServerElement, endEl: ServerElement): ElbowRoute {
  const a = boxOf(startEl);
  const b = boxOf(endEl);

  const abs: [number, number][] = [];

  const below = b.y >= a.y + a.h;         // target starts below source
  const above = b.y + b.h <= a.y;         // target ends above source
  const rightOf = b.x >= a.x + a.w;
  const leftOf = b.x + b.w <= a.x;

  const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);

  if ((below || above) && (xOverlap > 0 || !(rightOf || leftOf))) {
    const sy = below ? a.y + a.h + GAP : a.y - GAP;       // leave bottom/top
    const ty = below ? b.y - GAP : b.y + b.h + GAP;       // enter top/bottom
    const midY = (sy + ty) / 2;
    if (Math.abs(a.cx - b.cx) < 1) {
      // vertically aligned: straight drop
      abs.push([a.cx, sy], [b.cx, ty]);
    } else {
      // down, across at the mid-gap, down again (classic tree connector)
      abs.push([a.cx, sy], [a.cx, midY], [b.cx, midY], [b.cx, ty]);
    }
  } else if ((below || above) && (rightOf || leftOf)) {
    // Diagonal with no horizontal overlap: crossing at mid-height would cut
    // through whatever sits between the rows. Leave the source's facing
    // side at its own row (usually clear), run to a gutter just before the
    // target column, drop to the target's row, enter its facing side.
    const sx = rightOf ? a.x + a.w + GAP : a.x - GAP;
    const tx = rightOf ? b.x - GAP : b.x + b.w + GAP;
    const gx = rightOf ? b.x - 3 * GAP : b.x + b.w + 3 * GAP;
    abs.push([sx, a.cy], [gx, a.cy], [gx, b.cy], [tx, b.cy]);
  } else if (rightOf || leftOf) {
    const sx = rightOf ? a.x + a.w + GAP : a.x - GAP;     // leave right/left
    const tx = rightOf ? b.x - GAP : b.x + b.w + GAP;     // enter left/right
    const midX = (sx + tx) / 2;
    if (Math.abs(a.cy - b.cy) < 1) {
      abs.push([sx, a.cy], [tx, b.cy]);
    } else {
      abs.push([sx, a.cy], [midX, a.cy], [midX, b.cy], [tx, b.cy]);
    }
  } else {
    // overlapping boxes: fall back to center-to-center straight segment
    abs.push([a.cx, a.cy], [b.cx, b.cy]);
  }

  const [ox, oy] = abs[0]!;
  return { x: ox, y: oy, points: abs.map(([px, py]) => [px - ox, py - oy]) };
}
