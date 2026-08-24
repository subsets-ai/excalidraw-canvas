import { ServerElement, normalizeFontFamily } from '../types.js';

// Labels on shapes/arrows are stored the way Excalidraw stores them: as a
// separate bound text element (containerId -> parent, parent.boundElements
// -> text). Agents keep writing the friendly `text` / `label` shorthand;
// the canvas server splits it on write and re-attaches it on read.
//
// Why on write: the browser expands `label` into a bound text element with
// a fresh id on every load. With diff-based sync the parent shape never
// changes, so the server would keep the `label` and every new tab would
// expand it again — one more duplicate label per join.

export const LABEL_SUFFIX = '-label';

export function labelTextOf(el: ServerElement): string | undefined {
  const anyEl = el as any;
  const text = anyEl.label?.text ?? (el.type !== 'text' ? anyEl.text : undefined);
  return typeof text === 'string' && text.length > 0 ? text : undefined;
}

export function boundTextId(el: ServerElement): string | undefined {
  const bound = (el as any).boundElements as Array<{ id: string; type: string }> | null | undefined;
  return bound?.find(b => b?.type === 'text')?.id;
}

function randomNonce(): number {
  return Math.floor(Math.random() * 2147483647);
}

function estimateTextBox(text: string, fontSize: number): { width: number; height: number } {
  const lines = text.split('\n');
  const longest = Math.max(1, ...lines.map(l => l.length));
  return {
    width: Math.ceil(longest * fontSize * 0.6),
    height: Math.ceil(lines.length * fontSize * 1.25)
  };
}

// Build the bound text element for a parent shape/arrow.
export function makeBoundText(parent: ServerElement, text: string, existing?: ServerElement): ServerElement {
  const id = existing?.id ?? `${parent.id}${LABEL_SUFFIX}`;
  const isArrow = parent.type === 'arrow' || parent.type === 'line';
  const fontSize = (existing as any)?.fontSize ?? (parent as any).fontSize ?? 20;
  // Excalifont (5) is Excalidraw's default and is loaded eagerly; legacy
  // Virgil (1) loads lazily, so labels measured before it arrives get clipped
  const fontFamily = normalizeFontFamily((existing as any)?.fontFamily ?? (parent as any).fontFamily) ?? 5;
  const box = estimateTextBox(text, fontSize);

  let x: number, y: number;
  if (isArrow) {
    const pts: [number, number][] = (parent as any).points ?? [[0, 0], [100, 0]];
    const last = pts[pts.length - 1] ?? [100, 0];
    x = parent.x + last[0] / 2 - box.width / 2;
    y = parent.y + last[1] / 2 - box.height / 2;
  } else {
    const w = parent.width ?? 160;
    const h = parent.height ?? 80;
    x = parent.x + (w - box.width) / 2;
    y = parent.y + (h - box.height) / 2;
  }

  const now = new Date().toISOString();
  return {
    ...(existing ?? {}),
    id,
    type: 'text',
    x,
    y,
    width: box.width,
    height: box.height,
    angle: (existing as any)?.angle ?? 0,
    strokeColor: isArrow ? '#1e1e1e' : ((existing as any)?.strokeColor ?? parent.strokeColor ?? '#1e1e1e'),
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: (existing as any)?.opacity ?? 100,
    groupIds: existing?.groupIds ?? [],
    frameId: null,
    roundness: null,
    text,
    originalText: text,
    fontSize,
    fontFamily,
    textAlign: 'center',
    verticalAlign: 'middle',
    autoResize: true,
    lineHeight: 1.25,
    containerId: parent.id,
    locked: existing?.locked ?? parent.locked ?? false,
    isDeleted: false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
    versionNonce: randomNonce()
  } as ServerElement;
}

// Split `label`/`text` off a non-text element into a bound text element.
// Returns the cleaned parent and the text element (or null if no label).
// Elements that already carry a bound text reference (browser-synced or
// re-imported expanded scenes) are left alone.
export function splitLabel(el: ServerElement): { parent: ServerElement; text: ServerElement | null } {
  if (el.type === 'text') return { parent: el, text: null };
  const { label: _label, text: _text, ...rest } = el as any;
  const parent = rest as ServerElement;
  const labelText = labelTextOf(el);
  if (!labelText || boundTextId(el)) return { parent, text: null };

  const textEl = makeBoundText(parent, labelText);
  (parent as any).boundElements = [
    ...((Array.isArray((parent as any).boundElements) ? (parent as any).boundElements : []) as any[]),
    { type: 'text', id: textEl.id }
  ];
  return { parent, text: textEl };
}

// Read side: re-attach `label: { text }` to parents so agent-facing reads,
// `query --filter label.text=...`, and `describe` keep working unchanged.
export function attachLabels(elements: ServerElement[]): ServerElement[] {
  const byId = new Map(elements.map(el => [el.id, el]));
  return elements.map(el => {
    if (el.type === 'text') return el;
    const textId = boundTextId(el);
    const textEl = textId ? byId.get(textId) : undefined;
    const text = (textEl as any)?.text;
    if (typeof text !== 'string' || text.length === 0) return el;
    return { ...el, label: { text } } as ServerElement;
  });
}
