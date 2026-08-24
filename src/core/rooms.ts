import fs from 'fs';
import path from 'path';
import type WebSocket from 'ws';
import logger from '../utils/logger.js';
import { ServerElement, ExcalidrawFile, Snapshot } from '../types.js';
import { DEFAULT_ROOM_ID, ROOM_ID_PATTERN } from './config.js';

// A room is one independent canvas: its elements (including isDeleted
// tombstones, so version chains survive deletes), image files, snapshots,
// the browser tabs watching it, and their presence (cursor/selection).
//
// Persistence is a JSON file per room under DATA_DIR (rooms/<id>.json),
// written atomically on a short debounce and on shutdown. Without DATA_DIR
// rooms are in-memory only (upstream behaviour).

export interface Collaborator {
  clientId: string;
  username: string;
  color: { background: string; stroke: string };
  pointer?: { x: number; y: number; tool: 'pointer' | 'laser' };
  button?: 'up' | 'down';
  selectedElementIds?: Record<string, true>;
  agent?: boolean;
  // Agent presence is synthesized from REST mutations and expires on its own
  expiresAt?: number;
}

export interface Room {
  id: string;
  elements: Map<string, ServerElement>;
  files: Map<string, ExcalidrawFile>;
  snapshots: Map<string, Snapshot>;
  clients: Map<WebSocket, string>; // socket -> clientId
  collaborators: Map<string, Collaborator>;
  createdAt: string;
  updatedAt: string;
  saveTimer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
}

interface RoomFile {
  id: string;
  createdAt: string;
  updatedAt: string;
  elements: ServerElement[];
  files: ExcalidrawFile[];
  snapshots: Snapshot[];
}

const SAVE_DEBOUNCE_MS = 300;
// Tombstones older than this are pruned when a room is loaded from disk
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const rooms = new Map<string, Room>();
let dataDir: string | null = null;

export function configurePersistence(dir: string | undefined | null): void {
  if (!dir) { dataDir = null; return; }
  dataDir = path.resolve(dir);
  fs.mkdirSync(path.join(dataDir, 'rooms'), { recursive: true });
  logger.info(`Room persistence enabled: ${path.join(dataDir, 'rooms')}`);
}

export function persistenceDir(): string | null {
  return dataDir;
}

export function isValidRoomId(id: string): boolean {
  return ROOM_ID_PATTERN.test(id);
}

function roomFilePath(id: string): string {
  return path.join(dataDir!, 'rooms', `${id}.json`);
}

function newRoom(id: string, seed?: Partial<RoomFile>): Room {
  const now = new Date().toISOString();
  const room: Room = {
    id,
    elements: new Map((seed?.elements ?? []).map(el => [el.id, el])),
    files: new Map((seed?.files ?? []).map(f => [f.id, f])),
    snapshots: new Map((seed?.snapshots ?? []).map(s => [s.name, s])),
    clients: new Map(),
    collaborators: new Map(),
    createdAt: seed?.createdAt ?? now,
    updatedAt: seed?.updatedAt ?? now,
    saveTimer: null,
    dirty: false
  };
  return room;
}

function loadRoomFromDisk(id: string): Room | null {
  if (!dataDir) return null;
  const file = roomFilePath(id);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as RoomFile;
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    parsed.elements = (parsed.elements ?? []).filter(el => {
      if (!el.isDeleted) return true;
      const t = Date.parse(el.updatedAt ?? '');
      return Number.isNaN(t) ? true : t > cutoff;
    });
    logger.info(`Room "${id}" loaded from disk (${parsed.elements.length} elements)`);
    return newRoom(id, parsed);
  } catch (error) {
    logger.error(`Failed to load room "${id}" from ${file}:`, error);
    // Don't shadow a corrupt file with an empty room that would then overwrite it
    throw new Error(`Room file for "${id}" is unreadable: ${(error as Error).message}`);
  }
}

// Get (or lazily create/load) a room. Ids are validated by the caller.
export function getRoom(id: string = DEFAULT_ROOM_ID): Room {
  let room = rooms.get(id);
  if (room) return room;
  room = loadRoomFromDisk(id) ?? newRoom(id);
  rooms.set(id, room);
  return room;
}

export function hasRoom(id: string): boolean {
  if (rooms.has(id)) return true;
  return !!dataDir && fs.existsSync(roomFilePath(id));
}

export interface RoomSummary {
  id: string;
  elementCount: number;
  clients: number;
  createdAt: string;
  updatedAt: string;
}

export function summarizeRoom(room: Room): RoomSummary {
  // Count what a human would count: live elements, minus the bound-text
  // labels that ride along with their container
  let elementCount = 0;
  room.elements.forEach(el => { if (!el.isDeleted && !el.containerId) elementCount++; });
  return {
    id: room.id,
    elementCount,
    clients: room.clients.size,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
}

// Every room known in memory or on disk
export function listRooms(): RoomSummary[] {
  const ids = new Set<string>(rooms.keys());
  if (dataDir) {
    for (const f of fs.readdirSync(path.join(dataDir, 'rooms'))) {
      if (f.endsWith('.json')) {
        const id = f.slice(0, -'.json'.length);
        if (isValidRoomId(id)) ids.add(id);
      }
    }
  }
  return Array.from(ids).sort().map(id => summarizeRoom(getRoom(id)));
}

export function deleteRoom(id: string): boolean {
  const room = rooms.get(id);
  if (room) {
    if (room.saveTimer) clearTimeout(room.saveTimer);
    rooms.delete(id);
  }
  let existed = !!room;
  if (dataDir) {
    const file = roomFilePath(id);
    if (fs.existsSync(file)) { fs.unlinkSync(file); existed = true; }
  }
  return existed;
}

export function liveElements(room: Room): ServerElement[] {
  const out: ServerElement[] = [];
  room.elements.forEach(el => { if (!el.isDeleted) out.push(el); });
  return out;
}

export function allElements(room: Room): ServerElement[] {
  return Array.from(room.elements.values());
}

// Mark a room as changed: bumps updatedAt and schedules a persist.
export function touchRoom(room: Room): void {
  room.updatedAt = new Date().toISOString();
  if (!dataDir) return;
  room.dirty = true;
  if (room.saveTimer) return;
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null;
    saveRoom(room);
  }, SAVE_DEBOUNCE_MS);
}

function serializeRoom(room: Room): RoomFile {
  return {
    id: room.id,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    elements: Array.from(room.elements.values()),
    files: Array.from(room.files.values()),
    snapshots: Array.from(room.snapshots.values())
  };
}

// Atomic write: tmp file + rename so a crash mid-write never leaves a
// truncated room file behind.
export function saveRoom(room: Room): void {
  if (!dataDir) return;
  const file = roomFilePath(room.id);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(serializeRoom(room)));
    fs.renameSync(tmp, file);
    room.dirty = false;
  } catch (error) {
    logger.error(`Failed to save room "${room.id}":`, error);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// Flush every dirty room synchronously (shutdown path)
export function saveAllRooms(): void {
  rooms.forEach(room => {
    if (room.saveTimer) { clearTimeout(room.saveTimer); room.saveTimer = null; }
    if (room.dirty) saveRoom(room);
  });
}

export function roomCount(): number {
  return rooms.size;
}

// ---- Presence ----

const COLLAB_COLORS: Array<{ background: string; stroke: string }> = [
  { background: '#ffc9c9', stroke: '#e03131' },
  { background: '#b2f2bb', stroke: '#2f9e44' },
  { background: '#a5d8ff', stroke: '#1971c2' },
  { background: '#ffec99', stroke: '#f08c00' },
  { background: '#d0bfff', stroke: '#7048e8' },
  { background: '#99e9f2', stroke: '#0c8599' },
  { background: '#fcc2d7', stroke: '#d6336c' },
  { background: '#e9ecef', stroke: '#495057' }
];

export function colorFor(key: string): { background: string; stroke: string } {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return COLLAB_COLORS[h % COLLAB_COLORS.length]!;
}

export function publicCollaborator(c: Collaborator): Omit<Collaborator, 'expiresAt'> {
  const { expiresAt: _e, ...rest } = c;
  return rest;
}
