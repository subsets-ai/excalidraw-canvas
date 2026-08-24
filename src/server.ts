import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer, IncomingMessage } from 'http';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import {
  generateId,
  EXCALIDRAW_ELEMENT_TYPES,
  ServerElement,
  ExcalidrawElementType,
  ExcalidrawFile,
  WebSocketMessage,
  ElementCreatedMessage,
  ElementUpdatedMessage,
  ElementDeletedMessage,
  BatchCreatedMessage,
  SyncStatusMessage,
  InitialElementsMessage,
  Snapshot,
  normalizeFontFamily
} from './types.js';
import { z } from 'zod';
import WebSocket from 'ws';
import { isMainModule } from './core/entry.js';
import { writePidFile, removePidFile } from './core/pidfile.js';
import { DEFAULT_ROOM_ID, ROOM_HEADER, normalizeRoomId } from './core/config.js';
import {
  Room,
  Collaborator,
  configurePersistence,
  persistenceDir,
  getRoom,
  hasRoom,
  listRooms,
  deleteRoom,
  summarizeRoom,
  liveElements,
  allElements,
  touchRoom,
  saveAllRooms,
  roomCount,
  colorFor,
  publicCollaborator
} from './core/rooms.js';
import { splitLabel, attachLabels, boundTextId, makeBoundText } from './core/labels.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// Browsers must come from our own origin(s): a logged-in user's session
// cookie would otherwise ride along on a cross-site WebSocket handshake from
// any web page (Safari/Firefox don't default cookies to SameSite=Lax) and
// leak the whole room. PUBLIC_ORIGIN is a comma-separated allowlist of
// origins (e.g. https://doodle.subsets.com); unset = allow all (local dev).
const allowedOrigins = new Set(
  (process.env.PUBLIC_ORIGIN || '').split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean)
);
function originAllowed(origin: string | undefined): boolean {
  if (allowedOrigins.size === 0) return true;
  if (!origin) return true; // non-browser clients (no Origin header)
  return allowedOrigins.has(origin.replace(/\/$/, ''));
}
const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }: { origin?: string }) => originAllowed(origin)
});

// Optional on-disk persistence for rooms (see core/rooms.ts)
configurePersistence(process.env.DATA_DIR);

// Middleware. Wildcard CORS only outside production: nothing legitimate is
// cross-origin (browsers are same-origin, MCP/CLI aren't browsers), and on
// a cookie-authenticated public host it would only widen the CSRF surface.
if (process.env.NODE_ENV !== 'production') {
  app.use(cors());
}
app.use(express.json({ limit: '10mb' }));

// Serve only the built frontend (never the compiled backend in dist/)
app.use(express.static(path.join(__dirname, '../dist/frontend')));
// Serve Excalidraw fonts so the font subsetting worker can fetch them for export
app.use('/assets/fonts', express.static(
  path.join(__dirname, '../node_modules/@excalidraw/excalidraw/dist/prod/fonts')
));

// ─── Rooms ─────────────────────────────────────────────────────────────
// Every /api request is scoped to one room, chosen by the X-Excalidraw-Room
// header (MCP server / CLI) or ?room= (browser). Missing = "default".

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      room: Room;
    }
  }
}

function requestedRoomId(req: Request): string | null {
  const header = req.header(ROOM_HEADER);
  const query = typeof req.query.room === 'string' ? req.query.room : undefined;
  return normalizeRoomId(header ?? query);
}

app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  // Room management / identity endpoints are not themselves room-scoped
  if (req.path === '/rooms' || req.path.startsWith('/rooms/') || req.path === '/me') return next();
  const id = requestedRoomId(req);
  if (!id) {
    return res.status(400).json({
      success: false,
      error: `Invalid room id. Use 1-64 chars of a-z, 0-9, "-" or "_".`
    });
  }
  req.room = getRoom(id);
  next();
});

// Broadcast to every browser tab in a room (optionally excluding one client)
function broadcast(room: Room, message: WebSocketMessage, exceptClientId?: string): void {
  const data = JSON.stringify(message);
  room.clients.forEach((clientId, client) => {
    if (exceptClientId && clientId === exceptClientId) return;
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    } catch (err) {
      logger.warn('Failed to send to client, removing');
      room.clients.delete(client);
    }
  });
}

function normalizeLineBreakMarkup(text: string): string {
  return text
    .replace(/<\s*b\s*r\s*\/?\s*>/gi, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomNonce(): number {
  return Math.floor(Math.random() * 2147483647);
}

// Server-side mutation stamp: bump version + fresh versionNonce so browsers
// (which reconcile by version/versionNonce) accept the change.
function stampUpdate(el: ServerElement, existing?: ServerElement): ServerElement {
  el.updatedAt = nowIso();
  el.version = (existing?.version ?? el.version ?? 0) + 1;
  el.versionNonce = randomNonce();
  return el;
}

function filesObject(room: Room): Record<string, ExcalidrawFile> {
  const filesObj: Record<string, ExcalidrawFile> = {};
  room.files.forEach((f, id) => { filesObj[id] = f; });
  return filesObj;
}

function initialElementsMessage(room: Room): InitialElementsMessage & { files?: Record<string, ExcalidrawFile> } {
  return {
    type: 'initial_elements',
    room: room.id,
    // Tombstones included: Excalidraw handles isDeleted natively and needs
    // them to converge with a tab that missed the delete
    elements: allElements(room),
    ...(room.files.size > 0 ? { files: filesObject(room) } : {})
  };
}

// ─── Presence ──────────────────────────────────────────────────────────

function collaboratorsMessage(room: Room): WebSocketMessage {
  return {
    type: 'collaborators',
    collaborators: Array.from(room.collaborators.values()).map(publicCollaborator)
  };
}

// Agents don't hold a socket; synthesize a short-lived presence marker at the
// element they just touched so humans see where the agent is working.
const AGENT_PRESENCE_MS = 5000;
const agentPresenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function agentPresence(room: Room, req: Request, el: ServerElement | undefined): void {
  if (room.clients.size === 0) return;
  const name = (req.header('x-excalidraw-agent') || 'Agent').slice(0, 40);
  const clientId = `agent:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const collab: Collaborator = {
    clientId,
    username: name,
    color: colorFor(clientId),
    agent: true,
    ...(el ? {
      pointer: {
        x: el.x + (el.width ?? 0) / 2,
        y: el.y + (el.height ?? 0) / 2,
        tool: 'pointer' as const
      },
      button: 'up' as const,
      selectedElementIds: { [el.id]: true as const }
    } : {}),
    expiresAt: Date.now() + AGENT_PRESENCE_MS
  };
  room.collaborators.set(clientId, collab);
  broadcast(room, { type: 'collaborator_update', collaborator: publicCollaborator(collab) });

  const timerKey = `${room.id}:${clientId}`;
  const existing = agentPresenceTimers.get(timerKey);
  if (existing) clearTimeout(existing);
  agentPresenceTimers.set(timerKey, setTimeout(() => {
    agentPresenceTimers.delete(timerKey);
    room.collaborators.delete(clientId);
    broadcast(room, { type: 'collaborator_left', clientId });
  }, AGENT_PRESENCE_MS));
}

// ─── Identity from the auth proxy ──────────────────────────────────────
// Behind Caddy + oauth2-proxy the browser path carries X-Forwarded-Email /
// -Preferred-Username set by the proxy, and the bearer path has them
// stripped (see deploy/vm-startup.sh), so they're trustworthy either way.
// Locally there is no proxy and no auth, so a spoofed header only spoofs a
// presence name.
interface ProxyIdentity {
  email: string;
  username: string;
}

function identityFromHeaders(headers: IncomingMessage['headers']): ProxyIdentity | null {
  const first = (v: string | string[] | undefined): string =>
    (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
  const email = first(headers['x-forwarded-email']).toLowerCase();
  if (!email || !email.includes('@')) return null;
  const preferred = first(headers['x-forwarded-preferred-username']);
  const username = (preferred || email.split('@')[0] || email).slice(0, 40);
  return { email, username };
}

app.get('/api/me', (req: Request, res: Response) => {
  const identity = identityFromHeaders(req.headers);
  res.json(identity
    ? { success: true, authenticated: true, email: identity.email, username: identity.username }
    : { success: true, authenticated: false });
});

// ─── WebSocket ─────────────────────────────────────────────────────────

function wsParams(req: IncomingMessage): { roomId: string | null; name: string } {
  const url = new URL(req.url || '/', 'http://localhost');
  const roomId = normalizeRoomId(url.searchParams.get('room'));
  const name = (url.searchParams.get('name') || 'Anonymous').slice(0, 40);
  return { roomId, name };
}

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const { roomId, name } = wsParams(req);
  if (!roomId) {
    ws.close(1008, 'invalid room id');
    return;
  }
  let room: Room;
  try {
    room = getRoom(roomId);
  } catch (error) {
    // Unreadable room file must not take the whole process down
    logger.error(`WebSocket join refused for room "${roomId}":`, error);
    ws.close(1011, 'room unavailable');
    return;
  }
  const clientId = generateId();
  room.clients.set(ws, clientId);
  const identity = identityFromHeaders(req.headers);
  const me: Collaborator = identity
    ? { clientId, username: identity.username, email: identity.email, authenticated: true, color: colorFor(identity.email) }
    : { clientId, username: name, color: colorFor(clientId) };
  room.collaborators.set(clientId, me);
  logger.info(`WebSocket connected: room="${room.id}" client=${clientId} name="${me.username}"${identity ? ' (auth)' : ''}`);

  ws.send(JSON.stringify({ type: 'welcome', clientId, room: room.id, username: me.username, authenticated: !!identity }));
  ws.send(JSON.stringify(initialElementsMessage(room)));

  const syncMessage: SyncStatusMessage = {
    type: 'sync_status',
    elementCount: liveElements(room).length,
    timestamp: nowIso()
  };
  ws.send(JSON.stringify(syncMessage));

  // Everyone learns about everyone
  ws.send(JSON.stringify(collaboratorsMessage(room)));
  broadcast(room, { type: 'collaborator_update', collaborator: publicCollaborator(me) }, clientId);

  ws.on('message', (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const collab = room.collaborators.get(clientId);
    if (!collab) return;

    switch (msg.type) {
      case 'pointer': {
        if (msg.pointer && typeof msg.pointer.x === 'number' && typeof msg.pointer.y === 'number') {
          collab.pointer = {
            x: msg.pointer.x,
            y: msg.pointer.y,
            tool: msg.pointer.tool === 'laser' ? 'laser' : 'pointer'
          };
        }
        if (msg.button === 'down' || msg.button === 'up') collab.button = msg.button;
        if (msg.selectedElementIds && typeof msg.selectedElementIds === 'object') {
          collab.selectedElementIds = msg.selectedElementIds;
        }
        broadcast(room, { type: 'collaborator_update', collaborator: publicCollaborator(collab) }, clientId);
        break;
      }
      case 'rename': {
        // Names from the auth proxy are not client-editable
        if (collab.authenticated) break;
        if (typeof msg.username === 'string' && msg.username.trim()) {
          collab.username = msg.username.trim().slice(0, 40);
          broadcast(room, { type: 'collaborator_update', collaborator: publicCollaborator(collab) }, clientId);
        }
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    room.collaborators.delete(clientId);
    broadcast(room, { type: 'collaborator_left', clientId });
    logger.info(`WebSocket closed: room="${room.id}" client=${clientId}`);
  });

  ws.on('error', (error) => {
    logger.error('WebSocket error:', error);
    room.clients.delete(ws);
    room.collaborators.delete(clientId);
    broadcast(room, { type: 'collaborator_left', clientId });
  });
});

// ─── Schema validation ─────────────────────────────────────────────────

const CreateElementSchema = z.object({
  id: z.string().optional(), // Allow passing ID for MCP sync
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  label: z.object({
    text: z.string()
  }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  // Bound-text back-pointer — without it, zod strips containerId on import
  // and re-imported bound labels detach from their containers
  containerId: z.string().nullable().optional(),
  // Excalidraw identity fields — preserve through import so re-exported
  // scenes keep their stacking order, roughness seeds, and timestamps, and
  // no-op import→export cycles stay byte-stable
  index: z.string().nullable().optional(),
  seed: z.number().optional(),
  versionNonce: z.number().optional(),
  updated: z.number().optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(),
  // Arrow-specific properties
  points: z.any().optional(),
  start: z.object({ id: z.string() }).optional(),
  end: z.object({ id: z.string() }).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  elbowed: z.boolean().optional(),
  // Arrow binding properties (preserved for Excalidraw frontend)
  startBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  endBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  boundElements: z.array(z.object({
    id: z.string(),
    type: z.enum(['arrow', 'text']),
  })).nullable().optional(),
  // Image-specific properties
  fileId: z.string().optional(),
  status: z.string().optional(),
  scale: z.tuple([z.number(), z.number()]).optional(),
}).passthrough();

const UpdateElementSchema = z.object({
  id: z.string(),
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  originalText: z.string().optional(),
  label: z.object({
    text: z.string()
  }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  containerId: z.string().nullable().optional(),
  index: z.string().nullable().optional(),
  seed: z.number().optional(),
  versionNonce: z.number().optional(),
  updated: z.number().optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(),
  points: z.array(z.union([
    z.tuple([z.number(), z.number()]),
    z.object({ x: z.number(), y: z.number() })
  ])).optional(),
  start: z.object({ id: z.string() }).optional(),
  end: z.object({ id: z.string() }).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  elbowed: z.boolean().optional(),
  startBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  endBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  boundElements: z.array(z.object({
    id: z.string(),
    type: z.enum(['arrow', 'text']),
  })).nullable().optional(),
  fileId: z.string().optional(),
  status: z.string().optional(),
  scale: z.tuple([z.number(), z.number()]).optional(),
}).passthrough();

// ─── Geometry helpers ──────────────────────────────────────────────────

// Helper: compute edge point for an element given a direction toward a target
function computeEdgePoint(
  el: ServerElement,
  targetCenterX: number,
  targetCenterY: number
): { x: number; y: number } {
  const cx = el.x + (el.width || 0) / 2;
  const cy = el.y + (el.height || 0) / 2;
  const dx = targetCenterX - cx;
  const dy = targetCenterY - cy;

  if (el.type === 'diamond') {
    const hw = (el.width || 0) / 2;
    const hh = (el.height || 0) / 2;
    if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const scale = (absDx / hw + absDy / hh) > 0
      ? 1 / (absDx / hw + absDy / hh)
      : 1;
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  if (el.type === 'ellipse') {
    const a = (el.width || 0) / 2;
    const b = (el.height || 0) / 2;
    if (dx === 0 && dy === 0) return { x: cx, y: cy + b };
    const angle = Math.atan2(dy, dx);
    return { x: cx + a * Math.cos(angle), y: cy + b * Math.sin(angle) };
  }

  const hw = (el.width || 0) / 2;
  const hh = (el.height || 0) / 2;
  if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
  const angle = Math.atan2(dy, dx);
  const tanA = Math.tan(angle);
  if (Math.abs(tanA * hw) <= hh) {
    const signX = dx >= 0 ? 1 : -1;
    return { x: cx + signX * hw, y: cy + signX * hw * tanA };
  } else {
    const signY = dy >= 0 ? 1 : -1;
    return { x: cx + signY * hh / tanA, y: cy + signY * hh };
  }
}

// Helper: resolve arrow bindings in a batch (against the room's elements)
function resolveArrowBindings(room: Room, batchElements: ServerElement[]): void {
  const elementMap = new Map<string, ServerElement>();
  batchElements.forEach(el => elementMap.set(el.id, el));

  room.elements.forEach((el, id) => {
    if (!el.isDeleted && !elementMap.has(id)) elementMap.set(id, el);
  });

  for (const el of batchElements) {
    if (el.type !== 'arrow' && el.type !== 'line') continue;
    const startRef = (el as any).start as { id: string } | undefined;
    const endRef = (el as any).end as { id: string } | undefined;

    if (!startRef && !endRef) continue;

    const startEl = startRef ? elementMap.get(startRef.id) : undefined;
    const endEl = endRef ? elementMap.get(endRef.id) : undefined;

    const startCenter = startEl
      ? { x: startEl.x + (startEl.width || 0) / 2, y: startEl.y + (startEl.height || 0) / 2 }
      : { x: el.x, y: el.y };
    const endCenter = endEl
      ? { x: endEl.x + (endEl.width || 0) / 2, y: endEl.y + (endEl.height || 0) / 2 }
      : { x: el.x + 100, y: el.y };

    const GAP = 8;
    const startPt = startEl
      ? computeEdgePoint(startEl, endCenter.x, endCenter.y)
      : startCenter;
    const endPt = endEl
      ? computeEdgePoint(endEl, startCenter.x, startCenter.y)
      : endCenter;

    const startDx = endPt.x - startPt.x;
    const startDy = endPt.y - startPt.y;
    const startDist = Math.sqrt(startDx * startDx + startDy * startDy) || 1;
    const endDx = startPt.x - endPt.x;
    const endDy = startPt.y - endPt.y;
    const endDist = Math.sqrt(endDx * endDx + endDy * endDy) || 1;

    const finalStart = {
      x: startPt.x + (startDx / startDist) * GAP,
      y: startPt.y + (startDy / startDist) * GAP
    };
    const finalEnd = {
      x: endPt.x + (endDx / endDist) * GAP,
      y: endPt.y + (endDy / endDist) * GAP
    };

    el.x = finalStart.x;
    el.y = finalStart.y;
    el.points = [[0, 0], [finalEnd.x - finalStart.x, finalEnd.y - finalStart.y]];

    // Do NOT delete `start` and `end` here.
    // Excalidraw's frontend `convertToExcalidrawElements` method looks for these exact properties
    // to calculate mathematically sound `startBinding`, `endBinding`, `focus`, `gap`, and `boundElements`.
  }
}

// After a shape's geometry changes, recompute every arrow bound to it so the
// visual connection follows the shape. Returns the re-routed arrows.
function rerouteBoundArrows(room: Room, movedId: string): ServerElement[] {
  const rerouted: ServerElement[] = [];
  room.elements.forEach(el => {
    if (el.isDeleted) return;
    if (el.type !== 'arrow' && el.type !== 'line') return;
    const startRef = (el as any).start as { id: string } | undefined;
    const endRef = (el as any).end as { id: string } | undefined;
    if (startRef?.id !== movedId && endRef?.id !== movedId) return;
    resolveArrowBindings(room, [el]);
    stampUpdate(el, el);
    rerouted.push(el);
    recenterBoundText(room, el, rerouted);
  });
  return rerouted;
}

// Keep a bound label centred on its container after the container moved or
// resized server-side (the browser does this itself for its own edits).
function recenterBoundText(room: Room, parent: ServerElement, out: ServerElement[]): void {
  const textId = boundTextId(parent);
  const textEl = textId ? room.elements.get(textId) : undefined;
  if (!textEl || textEl.isDeleted) return;
  const w = textEl.width ?? 0;
  const h = textEl.height ?? 0;
  let x: number, y: number;
  if (parent.type === 'arrow' || parent.type === 'line') {
    const pts: [number, number][] = (parent as any).points ?? [[0, 0], [100, 0]];
    const last = pts[pts.length - 1] ?? [100, 0];
    x = parent.x + last[0] / 2 - w / 2;
    y = parent.y + last[1] / 2 - h / 2;
  } else {
    x = parent.x + ((parent.width ?? 0) - w) / 2;
    y = parent.y + ((parent.height ?? 0) - h) / 2;
  }
  if (Math.abs(x - textEl.x) < 0.01 && Math.abs(y - textEl.y) < 0.01) return;
  textEl.x = x;
  textEl.y = y;
  stampUpdate(textEl, textEl);
  out.push(textEl);
}

// Build server elements from validated create params: label splitting,
// timestamps, version 1.
function materialize(room: Room, params: z.infer<typeof CreateElementSchema>): ServerElement[] {
  const id = params.id || generateId();
  const element: ServerElement = {
    ...params,
    id,
    fontFamily: normalizeFontFamily(params.fontFamily),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    version: 1,
    versionNonce: params.versionNonce ?? randomNonce(),
    isDeleted: false
  };
  const { parent, text } = splitLabel(element);
  const out = [parent];
  if (text) {
    // A previous label element with the same deterministic id (re-created
    // shape) must not survive as a tombstone with a higher version
    const stale = room.elements.get(text.id);
    if (stale) text.version = (stale.version ?? 0) + 1;
    out.push(text);
  }
  return out;
}

// ─── API Routes ────────────────────────────────────────────────────────

// Get all elements
app.get('/api/elements', (req: Request, res: Response) => {
  try {
    const elementsArray = attachLabels(liveElements(req.room));
    res.json({
      success: true,
      room: req.room.id,
      elements: elementsArray,
      count: elementsArray.length
    });
  } catch (error) {
    logger.error('Error fetching elements:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Create new element
app.post('/api/elements', (req: Request, res: Response) => {
  try {
    const room = req.room;
    const params = CreateElementSchema.parse(req.body);
    logger.info('Creating element via API', { room: room.id, type: params.type });

    const created = materialize(room, params);
    const element = created[0]!;

    if (element.type === 'arrow' || element.type === 'line') {
      resolveArrowBindings(room, [element]);
      if (created[1]) recenterBoundText(room, element, []);
    }

    created.forEach(el => room.elements.set(el.id, el));
    touchRoom(room);

    if (created.length === 1) {
      const message: ElementCreatedMessage = { type: 'element_created', element };
      broadcast(room, message);
    } else {
      const message: BatchCreatedMessage = { type: 'elements_batch_created', elements: created };
      broadcast(room, message);
    }
    agentPresence(room, req, element);

    res.json({
      success: true,
      element: attachLabels(created)[0]
    });
  } catch (error) {
    logger.error('Error creating element:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Update element
app.put('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const room = req.room;
    const { id } = req.params;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const updates = UpdateElementSchema.parse({ id, ...body });

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }

    const existingElement = room.elements.get(id);
    if (!existingElement || existingElement.isDeleted) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    const changed: ServerElement[] = [];

    // Label updates on shapes/arrows go to the bound text element
    let shapeUpdates: Record<string, unknown> = { ...updates };
    if (existingElement.type !== 'text') {
      const { label, text, ...rest } = shapeUpdates as any;
      shapeUpdates = rest;
      const labelText: string | undefined = label?.text ?? text;
      if (typeof labelText === 'string') {
        const textId = boundTextId(existingElement);
        const textEl = textId ? room.elements.get(textId) : undefined;
        if (textEl && !textEl.isDeleted) {
          if (textEl.text !== labelText) {
            textEl.text = labelText;
            textEl.originalText = labelText;
            stampUpdate(textEl, textEl);
            changed.push(textEl);
          }
        } else {
          const stale = textId ? room.elements.get(textId) : undefined;
          const created = makeBoundText(existingElement, labelText, stale);
          room.elements.set(created.id, created);
          (shapeUpdates as any).boundElements = [
            ...((Array.isArray(existingElement.boundElements) ? existingElement.boundElements : []) as any[])
              .filter((b: any) => b?.type !== 'text'),
            { type: 'text', id: created.id }
          ];
          changed.push(created);
        }
      }
    }

    const updatedElement: ServerElement = {
      ...existingElement,
      ...shapeUpdates,
      fontFamily: updates.fontFamily !== undefined ? normalizeFontFamily(updates.fontFamily) : existingElement.fontFamily
    } as ServerElement;
    stampUpdate(updatedElement, existingElement);

    // Keep Excalidraw text source in sync when clients update text via REST.
    // If originalText lags behind text, rendered wrapping/position can drift.
    const hasTextUpdate = Object.prototype.hasOwnProperty.call(body, 'text');
    const hasOriginalTextUpdate = Object.prototype.hasOwnProperty.call(body, 'originalText');
    if (updatedElement.type === EXCALIDRAW_ELEMENT_TYPES.TEXT && hasTextUpdate && !hasOriginalTextUpdate) {
      const incomingText = updates.text ?? '';
      const existingText = typeof existingElement.text === 'string' ? existingElement.text : '';
      const existingOriginalText = typeof existingElement.originalText === 'string'
        ? existingElement.originalText
        : '';
      const existingOriginalHasBr = /<\s*b\s*r\s*\/?\s*>/i.test(existingOriginalText);
      const normalizedExistingText = normalizeLineBreakMarkup(existingText);
      const normalizedExistingOriginalText = normalizeLineBreakMarkup(existingOriginalText);

      if (existingOriginalHasBr && incomingText === normalizedExistingText && normalizedExistingOriginalText) {
        updatedElement.text = normalizedExistingOriginalText;
        updatedElement.originalText = normalizedExistingOriginalText;
      } else {
        updatedElement.originalText = incomingText;
      }
    }

    if (updatedElement.type === 'arrow' || updatedElement.type === 'line') {
      const bindingChanged = ['start', 'end'].some(key => Object.prototype.hasOwnProperty.call(body, key));
      if (bindingChanged) resolveArrowBindings(room, [updatedElement]);
    }

    room.elements.set(id, updatedElement);
    changed.unshift(updatedElement);

    // Moving/resizing a shape must drag its bound arrows and label along
    const geometryChanged = ['x', 'y', 'width', 'height', 'points']
      .some(key => Object.prototype.hasOwnProperty.call(body, key));
    if (geometryChanged) {
      recenterBoundText(room, updatedElement, changed);
      if (updatedElement.type !== 'arrow' && updatedElement.type !== 'line') {
        changed.push(...rerouteBoundArrows(room, id));
      }
    }

    touchRoom(room);
    for (const el of changed) {
      broadcast(room, { type: 'element_updated', element: el } as ElementUpdatedMessage);
    }
    agentPresence(room, req, updatedElement);

    res.json({
      success: true,
      element: attachLabels([updatedElement, ...changed])[0]
    });
  } catch (error) {
    logger.error('Error updating element:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Tombstone helper: a delete is a versioned update, so a stale tab can't
// resurrect the element with an older copy.
function tombstone(room: Room, el: ServerElement): void {
  el.isDeleted = true;
  stampUpdate(el, el);
  room.elements.set(el.id, el);
}

// Clear all elements (must be before /:id route)
app.delete('/api/elements/clear', (req: Request, res: Response) => {
  try {
    const room = req.room;
    const live = liveElements(room);
    live.forEach(el => tombstone(room, el));
    touchRoom(room);

    broadcast(room, {
      type: 'canvas_cleared',
      timestamp: nowIso()
    });
    agentPresence(room, req, undefined);

    logger.info(`Canvas cleared: room="${room.id}" ${live.length} elements removed`);

    res.json({
      success: true,
      message: `Cleared ${live.length} elements`,
      count: live.length
    });
  } catch (error) {
    logger.error('Error clearing canvas:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Delete element
app.delete('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const room = req.room;
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }

    const existing = room.elements.get(id);
    if (!existing || existing.isDeleted) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    const removed: ServerElement[] = [existing];
    const textId = boundTextId(existing);
    const textEl = textId ? room.elements.get(textId) : undefined;
    if (textEl && !textEl.isDeleted) removed.push(textEl);
    removed.forEach(el => tombstone(room, el));
    touchRoom(room);

    for (const el of removed) {
      // Carry the tombstone so browsers reconcile the delete by version
      const message: ElementDeletedMessage & { element: ServerElement } = { type: 'element_deleted', elementId: el.id, element: el };
      broadcast(room, message);
    }
    agentPresence(room, req, existing);

    res.json({
      success: true,
      message: `Element ${id} deleted successfully`
    });
  } catch (error) {
    logger.error('Error deleting element:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Query elements with filters
app.get('/api/elements/search', (req: Request, res: Response) => {
  try {
    const { type, x_min, x_max, y_min, y_max, room: _room, ...filters } = req.query;
    let results = attachLabels(liveElements(req.room));

    if (type && typeof type === 'string') {
      results = results.filter(element => element.type === type);
    }

    if (x_min !== undefined || x_max !== undefined || y_min !== undefined || y_max !== undefined) {
      const xMin = x_min !== undefined ? Number(x_min) : -Infinity;
      const xMax = x_max !== undefined ? Number(x_max) : Infinity;
      const yMin = y_min !== undefined ? Number(y_min) : -Infinity;
      const yMax = y_max !== undefined ? Number(y_max) : Infinity;

      results = results.filter(el =>
        el.x >= xMin &&
        el.x <= xMax &&
        el.y >= yMin &&
        el.y <= yMax
      );
    }

    if (Object.keys(filters).length > 0) {
      results = results.filter(element => {
        return Object.entries(filters).every(([key, value]) => {
          return (element as any)[key] === value;
        });
      });
    }

    res.json({
      success: true,
      elements: results,
      count: results.length
    });
  } catch (error) {
    logger.error('Error querying elements:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Get element by ID
app.get('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const room = req.room;
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }

    const element = room.elements.get(id);

    if (!element || element.isDeleted) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    const textId = boundTextId(element);
    const textEl = textId ? room.elements.get(textId) : undefined;
    res.json({
      success: true,
      element: attachLabels(textEl ? [element, textEl] : [element])[0]
    });
  } catch (error) {
    logger.error('Error fetching element:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Batch create elements
app.post('/api/elements/batch', (req: Request, res: Response) => {
  try {
    const room = req.room;
    const { elements: elementsToCreate } = req.body;

    if (!Array.isArray(elementsToCreate)) {
      return res.status(400).json({
        success: false,
        error: 'Expected an array of elements'
      });
    }

    const createdElements: ServerElement[] = [];
    const parents: ServerElement[] = [];

    elementsToCreate.forEach(elementData => {
      const params = CreateElementSchema.parse(elementData);
      const created = materialize(room, params);
      parents.push(created[0]!);
      createdElements.push(...created);
    });

    // Resolve arrow bindings (computes positions, startBinding, endBinding, boundElements)
    resolveArrowBindings(room, parents);

    createdElements.forEach(el => room.elements.set(el.id, el));
    parents.forEach(p => {
      if (p.type === 'arrow' || p.type === 'line') recenterBoundText(room, p, []);
    });
    touchRoom(room);

    const message: BatchCreatedMessage = {
      type: 'elements_batch_created',
      elements: createdElements
    };
    broadcast(room, message);
    agentPresence(room, req, parents[parents.length - 1]);

    const withLabels = attachLabels(createdElements);
    const parentIds = new Set(parents.map(p => p.id));
    const response = withLabels.filter(el => parentIds.has(el.id));
    res.json({
      success: true,
      elements: response,
      count: response.length
    });
  } catch (error) {
    logger.error('Error batch creating elements:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Convert Mermaid diagram to Excalidraw elements
app.post('/api/elements/from-mermaid', (req: Request, res: Response) => {
  try {
    const room = req.room;
    const { mermaidDiagram, config } = req.body;

    if (!mermaidDiagram || typeof mermaidDiagram !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Mermaid diagram definition is required'
      });
    }

    if (room.clients.size === 0) {
      return res.status(503).json({
        success: false,
        error: `No frontend client connected to room "${room.id}". Open the canvas in a browser first.`
      });
    }

    logger.info('Received Mermaid conversion request', {
      room: room.id,
      diagramLength: mermaidDiagram.length,
      hasConfig: !!config
    });

    // Only one tab must convert, or the diagram lands N times
    const [firstClient] = room.clients.entries().next().value as [WebSocket, string];
    const target = firstClient;
    const payload = JSON.stringify({
      type: 'mermaid_convert',
      mermaidDiagram,
      config: config || {},
      timestamp: nowIso()
    });
    if (target.readyState === WebSocket.OPEN) target.send(payload);

    res.json({
      success: true,
      mermaidDiagram,
      config: config || {},
      message: 'Mermaid diagram sent to frontend for conversion.'
    });
  } catch (error) {
    logger.error('Error processing Mermaid diagram:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// The old full-scene overwrite. Gone: a single stale tab would replace the
// whole room with its own copy. Browsers use /api/elements/reconcile.
app.post('/api/elements/sync', (_req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    error: 'POST /api/elements/sync was removed (it overwrote the whole canvas). Use POST /api/elements/reconcile with only the changed elements.'
  });
});

// Diff-based sync from browsers. Each element is accepted with Excalidraw's
// own rule (higher version wins; on a tie the lower versionNonce wins), so
// two tabs — or a tab and an agent — editing at once converge instead of
// clobbering each other.
function acceptsIncoming(existing: ServerElement | undefined, incoming: ServerElement): boolean {
  if (!existing) return true;
  const ev = existing.version ?? 0;
  const iv = incoming.version ?? 0;
  if (iv !== ev) return iv > ev;
  const en = existing.versionNonce ?? 0;
  const inn = incoming.versionNonce ?? 0;
  return inn <= en;
}

// Browser elements are stored as-is (they're Excalidraw's own objects), but
// bounded: a well-formed identity, a sane key count, and a size cap per
// element so a tab can't stuff arbitrary blobs into the room file.
const MAX_RECONCILE_ELEMENTS = 5000;
const MAX_ELEMENT_BYTES = 512 * 1024;
const ReconcileElementSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.string().min(1).max(32),
  x: z.number().finite(),
  y: z.number().finite(),
  version: z.number().int().nonnegative().optional(),
  versionNonce: z.number().int().optional(),
  isDeleted: z.boolean().optional()
}).passthrough().refine(obj => Object.keys(obj).length <= 200, { message: 'too many keys' });

app.post('/api/elements/reconcile', (req: Request, res: Response) => {
  try {
    const room = req.room;
    const { elements: incomingElements, clientId } = req.body ?? {};

    if (!Array.isArray(incomingElements)) {
      return res.status(400).json({
        success: false,
        error: 'Expected elements to be an array'
      });
    }

    if (incomingElements.length > MAX_RECONCILE_ELEMENTS) {
      return res.status(413).json({
        success: false,
        error: `Too many elements in one reconcile (${incomingElements.length} > ${MAX_RECONCILE_ELEMENTS})`
      });
    }

    const accepted: ServerElement[] = [];
    const rejected: ServerElement[] = [];

    for (const raw of incomingElements as any[]) {
      if (!ReconcileElementSchema.safeParse(raw).success) continue;
      if (JSON.stringify(raw).length > MAX_ELEMENT_BYTES) continue;
      const existing = room.elements.get(raw.id);
      // Deleting something we never had is a no-op
      if (!existing && raw.isDeleted) continue;

      const incoming: ServerElement = {
        ...raw,
        version: typeof raw.version === 'number' ? raw.version : 1,
        versionNonce: typeof raw.versionNonce === 'number' ? raw.versionNonce : 0,
        isDeleted: !!raw.isDeleted,
        createdAt: existing?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
        source: 'browser'
      };
      // Server-only bookkeeping never comes from the browser
      delete (incoming as any).syncedAt;
      delete (incoming as any).syncTimestamp;
      delete (incoming as any).label;

      if (acceptsIncoming(existing, incoming)) {
        // Identical copy: nothing to store or broadcast
        if (existing && existing.version === incoming.version && existing.versionNonce === incoming.versionNonce) continue;
        room.elements.set(incoming.id, incoming);
        accepted.push(incoming);
      } else if (existing) {
        rejected.push(existing);
      }
    }

    if (accepted.length > 0) {
      touchRoom(room);
      broadcast(room, {
        type: 'elements_reconciled',
        elements: accepted,
        timestamp: nowIso()
      }, typeof clientId === 'string' ? clientId : undefined);
    }

    res.json({
      success: true,
      accepted: accepted.map(el => el.id),
      rejected,
      count: accepted.length
    });
  } catch (error) {
    logger.error('Reconcile error:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// ─── Files API (for image elements) ───────────────────────────
// Every image is rewritten into the room file on each save; keep them sane.
const MAX_FILE_DATAURL_BYTES = 5 * 1024 * 1024;
app.get('/api/files', (req: Request, res: Response) => {
  res.json({ files: filesObject(req.room) });
});

app.post('/api/files', (req: Request, res: Response) => {
  const room = req.room;
  const body = req.body;
  const fileList: ExcalidrawFile[] = Array.isArray(body) ? body : (body?.files || []);
  for (const f of fileList) {
    if (typeof f?.id !== 'string' || typeof f?.dataURL !== 'string') continue;
    if (f.id.length > 128 || f.dataURL.length > MAX_FILE_DATAURL_BYTES) {
      return res.status(413).json({ success: false, error: `File ${f.id} exceeds ${MAX_FILE_DATAURL_BYTES} bytes` });
    }
    if (f.id && f.dataURL) {
      room.files.set(f.id, { id: f.id, dataURL: f.dataURL, mimeType: f.mimeType || 'image/png', created: f.created || Date.now() });
    }
  }
  touchRoom(room);
  broadcast(room, { type: 'files_added', files: fileList });
  res.json({ success: true, count: fileList.length });
});

app.delete('/api/files/:id', (req: Request, res: Response) => {
  const room = req.room;
  const id = req.params.id as string;
  if (room.files.delete(id)) {
    touchRoom(room);
    broadcast(room, { type: 'file_deleted', fileId: id });
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: `File with ID ${id} not found` });
  }
});

// ─── Image export (MCP -> Express -> WebSocket -> Frontend) ────────────
interface PendingExport {
  resolve: (data: { format: string; data: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  collectionTimeout: ReturnType<typeof setTimeout> | null;
  bestResult: { format: string; data: string } | null;
}
const pendingExports = new Map<string, PendingExport>();

app.post('/api/export/image', (req: Request, res: Response) => {
  try {
    const room = req.room;
    const { format, background } = req.body;

    if (!format || !['png', 'svg'].includes(format)) {
      return res.status(400).json({
        success: false,
        error: 'format must be "png" or "svg"'
      });
    }

    if (room.clients.size === 0) {
      return res.status(503).json({
        success: false,
        error: `No frontend client connected to room "${room.id}". Open the canvas in a browser first.`
      });
    }

    const requestId = generateId();

    const exportPromise = new Promise<{ format: string; data: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = pendingExports.get(requestId);
        pendingExports.delete(requestId);
        if (pending?.bestResult) {
          resolve(pending.bestResult);
        } else {
          reject(new Error('Export timed out after 30 seconds'));
        }
      }, 30000);

      pendingExports.set(requestId, { resolve, reject, timeout, collectionTimeout: null, bestResult: null });
    });

    // Re-broadcast current elements so all connected clients (including stale ones)
    // sync to the canonical server state before exporting
    broadcast(room, initialElementsMessage(room));

    setTimeout(() => {
      broadcast(room, {
        type: 'export_image_request',
        requestId,
        format,
        background: background ?? true
      });
    }, 800);

    exportPromise
      .then(result => {
        res.json({
          success: true,
          format: result.format,
          data: result.data
        });
      })
      .catch(error => {
        res.status(500).json({
          success: false,
          error: (error as Error).message
        });
      });
  } catch (error) {
    logger.error('Error initiating image export:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

app.post('/api/export/image/result', (req: Request, res: Response) => {
  try {
    const { requestId, format, data, error } = req.body;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        error: 'requestId is required'
      });
    }

    const pending = pendingExports.get(requestId);
    if (!pending) {
      return res.json({ success: true });
    }

    if (error) {
      logger.warn(`Export error from one client (requestId=${requestId}): ${error}`);
      return res.json({ success: true });
    }

    if (!pending.bestResult || data.length > pending.bestResult.data.length) {
      pending.bestResult = { format, data };
    }

    if (!pending.collectionTimeout) {
      pending.collectionTimeout = setTimeout(() => {
        const p = pendingExports.get(requestId);
        if (p?.bestResult) {
          clearTimeout(p.timeout);
          pendingExports.delete(requestId);
          p.resolve(p.bestResult);
        }
      }, 3000);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error processing export result:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// ─── Viewport control ──────────────────────────────────────────────────
interface PendingViewport {
  resolve: (data: { success: boolean; message: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingViewports = new Map<string, PendingViewport>();

const viewportRequestSchema = z.object({
  scrollToContent: z.boolean().optional(),
  scrollToElementIds: z.array(z.string().min(1)).min(1).optional(),
  viewportZoomFactor: z.number().positive().max(1).optional(),
  scrollToElementId: z.string().min(1).optional(),
  zoom: z.number().min(0.1).max(10).optional(),
  offsetX: z.number().optional(),
  offsetY: z.number().optional()
}).superRefine((params, ctx) => {
  const modes = [
    params.scrollToContent === true,
    params.scrollToElementIds !== undefined,
    params.scrollToElementId !== undefined,
    params.zoom !== undefined || params.offsetX !== undefined || params.offsetY !== undefined
  ].filter(Boolean).length;

  if (modes !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Specify exactly one viewport mode: scrollToContent, scrollToElementIds, scrollToElementId, or manual zoom/offset'
    });
  }
  if (params.viewportZoomFactor !== undefined &&
      params.scrollToContent !== true &&
      params.scrollToElementIds === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['viewportZoomFactor'],
      message: 'viewportZoomFactor requires scrollToContent or scrollToElementIds'
    });
  }
});

app.post('/api/viewport', (req: Request, res: Response) => {
  try {
    const room = req.room;
    const {
      scrollToContent,
      scrollToElementIds,
      scrollToElementId,
      viewportZoomFactor,
      zoom,
      offsetX,
      offsetY
    } = viewportRequestSchema.parse(req.body);

    if (room.clients.size === 0) {
      return res.status(503).json({
        success: false,
        error: `No frontend client connected to room "${room.id}". Open the canvas in a browser first.`
      });
    }

    const requestId = generateId();

    const viewportPromise = new Promise<{ success: boolean; message: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingViewports.delete(requestId);
        reject(new Error('Viewport request timed out after 10 seconds'));
      }, 10000);

      pendingViewports.set(requestId, { resolve, reject, timeout });
    });

    broadcast(room, {
      type: 'set_viewport',
      requestId,
      scrollToContent,
      scrollToElementIds,
      scrollToElementId,
      viewportZoomFactor,
      zoom,
      offsetX,
      offsetY
    });

    viewportPromise
      .then(result => {
        res.json(result);
      })
      .catch(error => {
        res.status(500).json({
          success: false,
          error: (error as Error).message
        });
      });
  } catch (error) {
    logger.error('Error initiating viewport change:', error);
    res.status(error instanceof z.ZodError ? 400 : 500).json({
      success: false,
      error: error instanceof z.ZodError
        ? error.issues.map(issue => issue.message).join('; ')
        : (error as Error).message
    });
  }
});

app.post('/api/viewport/result', (req: Request, res: Response) => {
  try {
    const { requestId, success, message, error } = req.body;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        error: 'requestId is required'
      });
    }

    const pending = pendingViewports.get(requestId);
    if (!pending) {
      return res.json({ success: true });
    }

    if (error || success === false) {
      clearTimeout(pending.timeout);
      pendingViewports.delete(requestId);
      pending.reject(new Error(error || message || 'Viewport update failed'));
      return res.json({ success: true });
    }

    clearTimeout(pending.timeout);
    pendingViewports.delete(requestId);
    pending.resolve({ success: true, message: message || 'Viewport updated' });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error processing viewport result:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// ─── Snapshots ─────────────────────────────────────────────────────────
app.post('/api/snapshots', (req: Request, res: Response) => {
  try {
    const room = req.room;
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Snapshot name is required'
      });
    }

    const snapshot: Snapshot = {
      name,
      elements: attachLabels(liveElements(room)),
      createdAt: nowIso()
    };

    room.snapshots.set(name, snapshot);
    touchRoom(room);
    logger.info(`Snapshot saved: room="${room.id}" "${name}" with ${snapshot.elements.length} elements`);

    res.json({
      success: true,
      name,
      elementCount: snapshot.elements.length,
      createdAt: snapshot.createdAt
    });
  } catch (error) {
    logger.error('Error saving snapshot:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

app.get('/api/snapshots', (req: Request, res: Response) => {
  try {
    const list = Array.from(req.room.snapshots.values()).map(s => ({
      name: s.name,
      elementCount: s.elements.length,
      createdAt: s.createdAt
    }));

    res.json({
      success: true,
      snapshots: list,
      count: list.length
    });
  } catch (error) {
    logger.error('Error listing snapshots:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

app.get('/api/snapshots/:name', (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const snapshot = req.room.snapshots.get(name!);

    if (!snapshot) {
      return res.status(404).json({
        success: false,
        error: `Snapshot "${name}" not found`
      });
    }

    res.json({
      success: true,
      snapshot
    });
  } catch (error) {
    logger.error('Error fetching snapshot:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// ─── Rooms API ─────────────────────────────────────────────────────────
app.get('/api/rooms', (_req: Request, res: Response) => {
  try {
    const rooms = listRooms();
    res.json({ success: true, rooms, count: rooms.length });
  } catch (error) {
    logger.error('Error listing rooms:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.post('/api/rooms', (req: Request, res: Response) => {
  const id = normalizeRoomId(req.body?.id);
  if (!id) {
    return res.status(400).json({
      success: false,
      error: 'Invalid room id. Use 1-64 chars of a-z, 0-9, "-" or "_".'
    });
  }
  const existed = hasRoom(id);
  const room = getRoom(id);
  if (!existed) touchRoom(room);
  res.status(existed ? 200 : 201).json({ success: true, room: summarizeRoom(room), created: !existed });
});

app.get('/api/rooms/:id', (req: Request, res: Response) => {
  const id = normalizeRoomId(req.params.id);
  if (!id || !hasRoom(id)) {
    return res.status(404).json({ success: false, error: `Room "${req.params.id}" not found` });
  }
  res.json({ success: true, room: summarizeRoom(getRoom(id)) });
});

app.delete('/api/rooms/:id', (req: Request, res: Response) => {
  const id = normalizeRoomId(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, error: 'Invalid room id' });
  }
  if (id === DEFAULT_ROOM_ID) {
    return res.status(400).json({ success: false, error: 'The default room cannot be deleted; clear it instead.' });
  }
  if (!hasRoom(id)) {
    return res.status(404).json({ success: false, error: `Room "${id}" not found` });
  }
  const room = getRoom(id);
  // Tabs still in the room get a clean slate and a reason
  broadcast(room, { type: 'canvas_cleared', timestamp: nowIso(), reason: 'room_deleted' });
  room.clients.forEach((_clientId, ws) => { try { ws.close(1000, 'room deleted'); } catch { /* ignore */ } });
  deleteRoom(id);
  logger.info(`Room deleted: "${id}"`);
  res.json({ success: true, message: `Room "${id}" deleted` });
});

// ─── Frontend ──────────────────────────────────────────────────────────
function serveFrontend(_req: Request, res: Response): void {
  const htmlFile = path.join(__dirname, '../dist/frontend/index.html');
  res.sendFile(htmlFile, (err) => {
    if (err) {
      logger.error('Error serving frontend:', err);
      res.status(404).send('Frontend not found. Please run "npm run build" first.');
    }
  });
}
app.get('/', serveFrontend);
app.get('/r/:room', serveFrontend);

// Health check endpoint (room-aware via header/query, default room otherwise)
app.get('/health', (req: Request, res: Response) => {
  const roomId = requestedRoomId(req) ?? DEFAULT_ROOM_ID;
  const room = getRoom(roomId);
  res.json({
    status: 'healthy',
    timestamp: nowIso(),
    room: room.id,
    elements_count: liveElements(room).length,
    websocket_clients: room.clients.size,
    rooms: roomCount(),
    persistence: persistenceDir() !== null,
    // Identity for `stop`: it must only ever signal a process that both
    // identifies as this service AND self-reports its pid — never a pid
    // from a stale pidfile or an unrelated app squatting on the port.
    service: 'mcp-excalidraw-canvas',
    pid: process.pid
  });
});

// Sync status endpoint
app.get('/api/sync/status', (req: Request, res: Response) => {
  res.json({
    success: true,
    room: req.room.id,
    elementCount: liveElements(req.room).length,
    timestamp: nowIso(),
    memoryUsage: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024), // MB
    },
    websocketClients: req.room.clients.size,
    collaborators: Array.from(req.room.collaborators.values()).map(c => ({ username: c.username, agent: !!c.agent }))
  });
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// ─── Start server ──────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK_GUARD_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'];

function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const socket = net.createConnection({ host, port });

    const finish = (isOpen: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(isOpen);
    };

    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function findExistingLoopbackListener(port: number): Promise<string | null> {
  for (const host of LOOPBACK_ADDRESSES) {
    if (await canConnect(host, port)) {
      return host;
    }
  }
  return null;
}

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    const address = (error as NodeJS.ErrnoException & { address?: string }).address || HOST;
    logger.error(`Canvas server port ${PORT} is already in use on ${formatHostForUrl(address)}.`);
  } else if (error.code === 'EACCES') {
    logger.error(`Canvas server cannot bind ${formatHostForUrl(HOST)}:${PORT}: permission denied.`);
  } else {
    logger.error('Failed to start canvas server:', error);
  }
  process.exit(1);
});

async function startServer(): Promise<void> {
  if (LOOPBACK_GUARD_HOSTS.has(HOST)) {
    const existingHost = await findExistingLoopbackListener(PORT);
    if (existingHost) {
      logger.error(
        `Refusing to start canvas server on ${formatHostForUrl(HOST)}:${PORT}: ` +
        `${formatHostForUrl(existingHost)}:${PORT} is already listening. ` +
        'This prevents duplicate IPv4/IPv6 canvas servers from splitting state.'
      );
      process.exit(1);
    }
  }

  let ownsPidFile = false;

  server.listen(PORT, HOST, () => {
    const hostForUrl = formatHostForUrl(HOST);
    logger.info(`Canvas server running on http://${hostForUrl}:${PORT}`);
    logger.info(`WebSocket server running on ws://${hostForUrl}:${PORT}`);

    writePidFile(PORT, process.pid);
    ownsPidFile = true;
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info(`Received ${signal}, shutting down canvas server`);
    saveAllRooms();
    if (ownsPidFile) removePidFile(PORT);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('exit', () => {
    saveAllRooms();
    if (ownsPidFile) removePidFile(PORT);
  });
}

if (isMainModule(import.meta.url)) {
  void startServer();
}

export { startServer };
export default app;
