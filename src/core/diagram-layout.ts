import { ServerElement } from '../types.js';

// Semantic diagram builder (inspired by Excalidraw+'s create_diagram): the
// agent supplies nodes, edges and optional groups; this computes a tidy
// layered layout, sizes boxes from their labels, draws group zones, and
// emits agent-format elements (elbow arrows bound by element id — the
// canvas server routes them). One call instead of hand-placed coordinates.

export interface DiagramNode {
  id: string;
  label: string;
  group?: string;
  color?: string;      // backgroundColor; default from the group palette
  width?: number;      // override computed width
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  style?: 'elbow' | 'straight';
}

export interface DiagramGroup {
  id: string;
  label?: string;
}

export interface DiagramInput {
  nodes: DiagramNode[];
  edges?: DiagramEdge[];
  groups?: DiagramGroup[];
  origin?: { x: number; y: number };
}

const HGAP = 40;        // between sibling boxes
const VGAP = 70;        // between layers
const BAND_GAP = 80;    // between group bands
const ZONE_PAD = 40;
const ZONE_TITLE = 40;  // extra headroom for the zone title text

const PALETTE = [
  { bg: '#d0ebff', stroke: '#1971c2' },
  { bg: '#d3f9d8', stroke: '#2f9e44' },
  { bg: '#fff3bf', stroke: '#f08c00' },
  { bg: '#e5dbff', stroke: '#7048e8' },
  { bg: '#ffe3e3', stroke: '#e03131' },
  { bg: '#c5f6fa', stroke: '#0c8599' }
];

interface Layout { x: number; y: number }

function labelLines(label: string): string[] {
  return label.split('\n');
}

function nodeWidth(n: DiagramNode, uniform: number): number {
  return n.width ?? uniform;
}

function computeUniformWidth(nodes: DiagramNode[]): number {
  let longest = 0;
  for (const n of nodes) {
    for (const line of labelLines(n.label)) longest = Math.max(longest, line.length);
  }
  return Math.min(440, Math.max(200, longest * 11 + 40));
}

function nodeHeight(n: DiagramNode): number {
  return 44 + 26 * labelLines(n.label).length;
}

// Tidy-tree layout of a forest (ids restricted to `members`), top-down.
// Returns positions relative to (0,0) and the total span width.
function layoutForest(
  members: string[],
  nodesById: Map<string, DiagramNode>,
  parentOf: Map<string, string>,
  uniformW: number
): { pos: Map<string, Layout>; width: number; height: number } {
  const memberSet = new Set(members);
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of members) {
    const p = parentOf.get(id);
    if (p !== undefined && memberSet.has(p)) {
      if (!children.has(p)) children.set(p, []);
      children.get(p)!.push(id);
    } else {
      roots.push(id);
    }
  }

  const layerH = Math.max(...members.map(id => nodeHeight(nodesById.get(id)!))) + VGAP;
  const span = new Map<string, number>();
  const computeSpan = (id: string): number => {
    const kids = children.get(id) ?? [];
    const own = nodeWidth(nodesById.get(id)!, uniformW);
    if (kids.length === 0) { span.set(id, own); return own; }
    const kidsSpan = kids.map(computeSpan).reduce((a, b) => a + b, 0) + HGAP * (kids.length - 1);
    const s = Math.max(own, kidsSpan);
    span.set(id, s);
    return s;
  };
  roots.forEach(computeSpan);

  const pos = new Map<string, Layout>();
  let maxDepth = 0;
  const place = (id: string, left: number, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);
    const s = span.get(id)!;
    const w = nodeWidth(nodesById.get(id)!, uniformW);
    pos.set(id, { x: left + (s - w) / 2, y: depth * layerH });
    let cursor = left + (s - ((children.get(id) ?? []).map(k => span.get(k)!).reduce((a, b) => a + b, 0) + HGAP * Math.max(0, (children.get(id) ?? []).length - 1))) / 2;
    for (const kid of children.get(id) ?? []) {
      place(kid, cursor, depth + 1);
      cursor += span.get(kid)! + HGAP;
    }
  };
  let cursor = 0;
  for (const r of roots) {
    place(r, cursor, 0);
    cursor += span.get(r)! + HGAP;
  }
  const width = Math.max(0, cursor - HGAP);
  const height = (maxDepth + 1) * layerH - VGAP;
  return { pos, width, height };
}

export function buildDiagram(input: DiagramInput): ServerElement[] {
  const origin = input.origin ?? { x: 60, y: 40 };
  const nodes = input.nodes ?? [];
  const edges = input.edges ?? [];
  if (nodes.length === 0) throw new Error('create_diagram needs at least one node');
  const nodesById = new Map(nodes.map(n => [n.id, n]));
  for (const e of edges) {
    if (!nodesById.has(e.from)) throw new Error(`edge references unknown node "${e.from}"`);
    if (!nodesById.has(e.to)) throw new Error(`edge references unknown node "${e.to}"`);
  }
  const uniformW = computeUniformWidth(nodes);

  // First incoming edge = tree parent; extra edges still get arrows
  const parentOf = new Map<string, string>();
  for (const e of edges) {
    if (!parentOf.has(e.to) && e.from !== e.to) parentOf.set(e.to, e.from);
  }

  const groupIds = (input.groups ?? []).map(g => g.id);
  for (const n of nodes) {
    if (n.group && !groupIds.includes(n.group)) groupIds.push(n.group);
  }
  const groupsById = new Map((input.groups ?? []).map(g => [g.id, g]));
  const grouped = new Map<string, string[]>(groupIds.map(g => [g, []]));
  const ungrouped: string[] = [];
  for (const n of nodes) {
    if (n.group) grouped.get(n.group)!.push(n.id);
    else ungrouped.push(n.id);
  }

  const absolute = new Map<string, Layout>();
  const zones: Array<{ group: string; x: number; y: number; w: number; h: number; color: number }> = [];

  // Group bands side by side; ungrouped nodes (e.g. a CEO) in a band above
  let bandsWidth = 0;
  let bandsHeight = 0;
  const bands: Array<{ group: string; pos: Map<string, Layout>; width: number; height: number }> = [];
  for (const g of groupIds) {
    const members = grouped.get(g)!;
    if (members.length === 0) continue;
    const f = layoutForest(members, nodesById, parentOf, uniformW);
    bands.push({ group: g, ...f });
    bandsWidth += f.width + 2 * ZONE_PAD + BAND_GAP;
    bandsHeight = Math.max(bandsHeight, f.height);
  }
  bandsWidth = Math.max(0, bandsWidth - BAND_GAP);

  let topHeight = 0;
  if (ungrouped.length > 0) {
    const top = layoutForest(ungrouped, nodesById, parentOf, uniformW);
    const totalWidth = Math.max(bandsWidth, top.width);
    const offsetX = origin.x + (totalWidth - top.width) / 2;
    top.pos.forEach((p, id) => absolute.set(id, { x: offsetX + p.x, y: origin.y + p.y }));
    topHeight = top.height + VGAP + 40;
  }

  let bandX = origin.x;
  const bandY = origin.y + topHeight + (bands.length > 0 ? ZONE_PAD + ZONE_TITLE : 0);
  bands.forEach((band, i) => {
    const zoneX = bandX;
    const innerX = zoneX + ZONE_PAD;
    band.pos.forEach((p, id) => absolute.set(id, { x: innerX + p.x, y: bandY + p.y }));
    zones.push({
      group: band.group,
      x: zoneX,
      y: bandY - ZONE_PAD - ZONE_TITLE,
      w: band.width + 2 * ZONE_PAD,
      h: band.height + 2 * ZONE_PAD + ZONE_TITLE,
      color: i % PALETTE.length
    });
    bandX += band.width + 2 * ZONE_PAD + BAND_GAP;
  });

  // Emit: zones first (bottom of the z-order), then nodes, then arrows
  const out: ServerElement[] = [];
  for (const z of zones) {
    const g = groupsById.get(z.group);
    out.push({
      id: `zone-${z.group}`, type: 'rectangle', x: z.x, y: z.y, width: z.w, height: z.h,
      backgroundColor: 'transparent', strokeColor: '#868e96', strokeStyle: 'dashed',
      strokeWidth: 1, fillStyle: 'solid', roughness: 0
    } as unknown as ServerElement);
    out.push({
      id: `zone-${z.group}-title`, type: 'text', x: z.x + 16, y: z.y + 12,
      text: g?.label ?? z.group, fontSize: 20, strokeColor: '#495057'
    } as unknown as ServerElement);
  }
  const groupColor = new Map(zones.map(z => [z.group, PALETTE[z.color]!]));
  for (const n of nodes) {
    const p = absolute.get(n.id);
    if (!p) continue;
    const pal = n.group ? groupColor.get(n.group) : undefined;
    out.push({
      id: n.id, type: 'rectangle', x: p.x, y: p.y,
      width: nodeWidth(n, uniformW), height: nodeHeight(n),
      label: { text: n.label },
      backgroundColor: n.color ?? pal?.bg ?? '#f1f3f5',
      strokeColor: pal?.stroke ?? '#343a40',
      fillStyle: 'solid', strokeWidth: 2, roughness: 1
    } as unknown as ServerElement);
  }
  edges.forEach((e, i) => {
    out.push({
      id: `edge-${e.from}-${e.to}-${i}`, type: 'arrow', x: 0, y: 0,
      ...(e.style === 'straight' ? {} : { elbowed: true }),
      ...(e.label ? { label: { text: e.label } } : {}),
      start: { id: e.from }, end: { id: e.to },
      strokeColor: '#343a40', strokeWidth: 2
    } as unknown as ServerElement);
  });
  return out;
}
