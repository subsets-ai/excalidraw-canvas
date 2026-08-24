import dotenv from 'dotenv';

// Load environment variables once for every entry point (MCP server, CLI, canvas server)
dotenv.config();

// Express server configuration
export const EXPRESS_SERVER_URL = process.env.EXPRESS_SERVER_URL || 'http://127.0.0.1:3000';
export const ENABLE_CANVAS_SYNC = process.env.ENABLE_CANVAS_SYNC !== 'false'; // Default to true

// Opt-out for auto-starting the canvas server from the CLI / MCP server
export const EXCALIDRAW_NO_AUTOSTART = process.env.EXCALIDRAW_NO_AUTOSTART === '1';

// Safe file path validation base directory (see sanitizeFilePath)
export const ALLOWED_EXPORT_DIR = process.env.EXCALIDRAW_EXPORT_DIR || process.cwd();

// Rooms: every canvas server hosts many independent canvases ("rooms").
// The MCP server / CLI operate on exactly one room per process, chosen by
// EXCALIDRAW_ROOM (or the global --room CLI flag). Browsers pick a room by
// URL (/r/<room>). The default room keeps upstream single-canvas behaviour.
export const DEFAULT_ROOM_ID = 'default';
export const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const ROOM_HEADER = 'x-excalidraw-room';

export function normalizeRoomId(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_ROOM_ID;
  const id = String(raw).trim().toLowerCase();
  return ROOM_ID_PATTERN.test(id) ? id : null;
}

const roomFromEnv = normalizeRoomId(process.env.EXCALIDRAW_ROOM);
if (roomFromEnv === null) {
  throw new Error(
    `Invalid EXCALIDRAW_ROOM "${process.env.EXCALIDRAW_ROOM}": use 1-64 chars of a-z, 0-9, "-" or "_".`
  );
}
export const EXCALIDRAW_ROOM: string = roomFromEnv;

// The room this process draws in. Starts from EXCALIDRAW_ROOM / --room and
// can be switched at runtime (MCP `use_room`), so an agent can open a room
// per task — e.g. named after the Linear issue it's working on.
let currentRoom: string = roomFromEnv;
export function getCurrentRoom(): string {
  return currentRoom;
}
export function setCurrentRoom(id: string): string {
  const normalized = normalizeRoomId(id);
  if (normalized === null) {
    throw new Error(`Invalid room "${id}": use 1-64 chars of a-z, 0-9, "-" or "_" (e.g. "pro-2050").`);
  }
  currentRoom = normalized;
  return currentRoom;
}

// Turn a free-form title into a room id: "PRO-2050 Experiments launched…" ->
// "pro-2050-experiments-launched". Keeps a leading ticket id intact.
export function slugifyRoomId(title: string, maxLength = 64): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || DEFAULT_ROOM_ID;
}

// Optional bearer token sent with every canvas request. The canvas server
// itself does not check it — it's for the auth layer in front of a shared,
// self-hosted canvas (see docs/deploy.md).
export const EXCALIDRAW_API_TOKEN = process.env.EXCALIDRAW_API_TOKEN || '';

// Display name for the presence indicator when an agent draws
export const EXCALIDRAW_AGENT_NAME = process.env.EXCALIDRAW_AGENT_NAME || 'Agent';
