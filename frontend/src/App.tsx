import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Excalidraw,
  convertToExcalidrawElements,
  CaptureUpdateAction,
  ExcalidrawImperativeAPI,
  exportToBlob,
  exportToSvg,
  reconcileElements,
  restoreElements,
  FONT_FAMILY
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { Collaborator as ExcalidrawCollaborator, SocketId } from '@excalidraw/excalidraw/types/types'
import { convertMermaidToExcalidraw, DEFAULT_MERMAID_CONFIG } from './utils/mermaidConverter'
import type { MermaidConfig } from '@excalidraw/mermaid-to-excalidraw'

// ─── Types ─────────────────────────────────────────────────────────────

type ExcalidrawAPIRefValue = ExcalidrawImperativeAPI;

interface ServerElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  version?: number;
  versionNonce?: number;
  isDeleted?: boolean;
  createdAt?: string;
  updatedAt?: string;
  syncedAt?: string;
  source?: string;
  syncTimestamp?: string;
  label?: { text: string };
  boundElements?: any[] | null;
  containerId?: string | null;
  [key: string]: any;
}

interface Collaborator {
  clientId: string;
  username: string;
  email?: string;
  authenticated?: boolean;
  color: { background: string; stroke: string };
  pointer?: { x: number; y: number; tool: 'pointer' | 'laser' };
  button?: 'up' | 'down';
  selectedElementIds?: Record<string, true>;
  agent?: boolean;
}

interface WebSocketMessage {
  type: string;
  element?: ServerElement;
  elements?: ServerElement[];
  elementId?: string;
  count?: number;
  timestamp?: string;
  source?: string;
  mermaidDiagram?: string;
  config?: MermaidConfig;
  requestId?: string;
  scrollToContent?: boolean;
  scrollToElementId?: string;
  scrollToElementIds?: string[];
  viewportZoomFactor?: number;
  zoom?: number;
  offsetX?: number;
  offsetY?: number;
  clientId?: string;
  username?: string;
  authenticated?: boolean;
  room?: string;
  collaborator?: Collaborator;
  collaborators?: Collaborator[];
  files?: any;
  format?: string;
  background?: boolean;
  reason?: string;
}

interface ApiResponse {
  success: boolean;
  elements?: ServerElement[];
  element?: ServerElement;
  files?: Record<string, unknown>;
  count?: number;
  error?: string;
  message?: string;
  accepted?: string[];
  rejected?: ServerElement[];
}

interface RoomSummary {
  id: string;
  elementCount: number;
  clients: number;
  createdAt: string;
  updatedAt: string;
}

type VersionKey = { version: number; versionNonce: number };

const AUTO_SYNC_DEBOUNCE_MS = 300;
const POINTER_THROTTLE_MS = 40;
const ROOM_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NAME_STORAGE_KEY = 'excalidraw-canvas-username';

// ─── Routing / storage helpers ─────────────────────────────────────────

function roomFromLocation(): string | null {
  const match = window.location.pathname.match(/^\/r\/([^/]+)\/?$/)
  if (!match) return null
  const id = decodeURIComponent(match[1]).toLowerCase()
  return ROOM_PATTERN.test(id) ? id : null
}

function loadUsername(): string {
  try {
    const saved = window.localStorage?.getItem(NAME_STORAGE_KEY)
    if (saved && saved.trim()) return saved.trim().slice(0, 40)
  } catch { /* ignore */ }
  return ''
}

function saveUsername(name: string): void {
  try { window.localStorage?.setItem(NAME_STORAGE_KEY, name) } catch { /* ignore */ }
}

// ─── Element helpers ───────────────────────────────────────────────────

// Excalidraw's restore/reconcile expect elements in z-order (monotonic
// fractional `index`); anything else is "repaired" by array position, which
// silently undoes bring-to-front / send-to-back. Sort before handing scenes
// to Excalidraw. Index-less elements keep their relative order at the end.
const compareByIndex = (a: { index?: string | null; id?: string }, b: { index?: string | null; id?: string }): number => {
  const ai = typeof a.index === 'string' ? a.index : null
  const bi = typeof b.index === 'string' ? b.index : null
  if (ai !== null && bi !== null) return ai < bi ? -1 : ai > bi ? 1 : ((a.id ?? '') < (b.id ?? '') ? -1 : (a.id ?? '') > (b.id ?? '') ? 1 : 0)
  if (ai !== null) return -1
  if (bi !== null) return 1
  return 0
}
const sortByIndex = <T extends { index?: string | null; id?: string }>(elements: T[]): T[] => elements.slice().sort(compareByIndex)

const cleanElementForExcalidraw = (element: ServerElement): Partial<ExcalidrawElement> => {
  const {
    createdAt,
    updatedAt,
    syncedAt,
    source,
    syncTimestamp,
    label,
    ...cleanElement
  } = element;
  return cleanElement as Partial<ExcalidrawElement>;
}

const validateAndFixBindings = (elements: Partial<ExcalidrawElement>[]): Partial<ExcalidrawElement>[] => {
  const elementMap = new Map(elements.map(el => [el.id!, el]));

  return elements.map(element => {
    const fixedElement = { ...element };

    if (fixedElement.boundElements) {
      if (Array.isArray(fixedElement.boundElements)) {
        fixedElement.boundElements = fixedElement.boundElements.filter((binding: any) => {
          if (!binding || typeof binding !== 'object') return false;
          if (!binding.id || !binding.type) return false;
          const referencedElement = elementMap.get(binding.id);
          if (!referencedElement || referencedElement.isDeleted) return false;
          if (!['text', 'arrow'].includes(binding.type)) return false;
          return true;
        });
        if (fixedElement.boundElements.length === 0) {
          fixedElement.boundElements = null;
        }
      } else {
        fixedElement.boundElements = null;
      }
    }

    if (fixedElement.containerId) {
      const containerElement = elementMap.get(fixedElement.containerId);
      if (!containerElement) {
        fixedElement.containerId = null;
      }
    }

    return fixedElement;
  });
}

const isImageElement = (element: Partial<ExcalidrawElement>): boolean => element.type === 'image'
const isFreedrawElement = (element: Partial<ExcalidrawElement>): boolean => element.type === 'freedraw'
const isShapeContainerType = (type: string | undefined): boolean =>
  type === 'rectangle' || type === 'ellipse' || type === 'diamond'

const recenterBoundShapeTextElements = (
  elements: Partial<ExcalidrawElement>[]
): Partial<ExcalidrawElement>[] => {
  const elementMap = new Map(elements.map((el) => [el.id, el]))

  return elements.map((element) => {
    if (element.type !== 'text' || !element.containerId) {
      return element
    }

    const textElement = element as ExcalidrawElement & { type: 'text'; containerId: string; autoResize?: boolean }
    const container = elementMap.get(textElement.containerId) as (ExcalidrawElement & { x: number; y: number; width: number; height: number }) | undefined
    if (!container || !isShapeContainerType(container.type)) {
      return element
    }

    if (textElement.autoResize === false) {
      return element
    }

    if (
      typeof container.x !== 'number' ||
      typeof container.y !== 'number' ||
      typeof container.width !== 'number' ||
      typeof container.height !== 'number' ||
      typeof textElement.width !== 'number' ||
      typeof textElement.height !== 'number'
    ) {
      return element
    }

    return {
      ...element,
      x: container.x + (container.width - textElement.width) / 2,
      y: container.y + (container.height - textElement.height) / 2,
    }
  })
}

const normalizeImageElement = (element: Partial<ExcalidrawElement>): Partial<ExcalidrawElement> => {
  const img = element as any
  return {
    ...img,
    angle: img.angle || 0,
    strokeColor: img.strokeColor || 'transparent',
    backgroundColor: img.backgroundColor || 'transparent',
    fillStyle: img.fillStyle || 'solid',
    strokeWidth: img.strokeWidth || 1,
    strokeStyle: img.strokeStyle || 'solid',
    roughness: img.roughness ?? 0,
    opacity: img.opacity ?? 100,
    groupIds: img.groupIds || [],
    roundness: null,
    seed: img.seed || Math.floor(Math.random() * 1000000),
    version: img.version || 1,
    versionNonce: img.versionNonce || Math.floor(Math.random() * 1000000),
    isDeleted: img.isDeleted ?? false,
    boundElements: img.boundElements || null,
    link: img.link || null,
    locked: img.locked || false,
    status: img.status || 'saved',
    fileId: img.fileId,
    scale: img.scale || [1, 1],
  }
}

const normalizeFreedrawElement = (element: Partial<ExcalidrawElement>): Partial<ExcalidrawElement> => {
  const freedraw = element as any
  return {
    ...freedraw,
    angle: freedraw.angle || 0,
    backgroundColor: freedraw.backgroundColor || 'transparent',
    fillStyle: freedraw.fillStyle || 'solid',
    strokeWidth: freedraw.strokeWidth || 1,
    strokeStyle: freedraw.strokeStyle || 'solid',
    roughness: freedraw.roughness ?? 1,
    opacity: freedraw.opacity ?? 100,
    groupIds: freedraw.groupIds || [],
    roundness: null,
    seed: freedraw.seed || Math.floor(Math.random() * 1000000),
    version: freedraw.version || 1,
    versionNonce: freedraw.versionNonce || Math.floor(Math.random() * 1000000),
    isDeleted: freedraw.isDeleted ?? false,
    boundElements: freedraw.boundElements || null,
    link: freedraw.link || null,
    locked: freedraw.locked || false,
    points: freedraw.points || [],
    pressures: freedraw.pressures || [],
    simulatePressure: freedraw.simulatePressure ?? true,
    lastCommittedPoint: freedraw.lastCommittedPoint || null,
  }
}

const restoreBindings = (
  convertedElements: readonly any[],
  originalElements: Partial<ExcalidrawElement>[]
): any[] => {
  const originalMap = new Map<string, any>();
  for (const el of originalElements) {
    if (el.id) originalMap.set(el.id, el);
  }

  return convertedElements.map((el: any) => {
    const orig = originalMap.get(el.id);
    if (!orig) return el;

    const patched = { ...el };

    if (orig.startBinding && !el.startBinding) patched.startBinding = orig.startBinding;
    if (orig.endBinding && !el.endBinding) patched.endBinding = orig.endBinding;
    if (orig.boundElements && (!el.boundElements || el.boundElements.length === 0)) {
      patched.boundElements = orig.boundElements;
    }
    if (orig.elbowed !== undefined && el.elbowed === undefined) patched.elbowed = orig.elbowed;
    // convertToExcalidrawElements resets these; they carry the sync state
    if (orig.isDeleted !== undefined) patched.isDeleted = orig.isDeleted;
    if (orig.version !== undefined) patched.version = orig.version;
    if (orig.versionNonce !== undefined) patched.versionNonce = orig.versionNonce;
    // Fixed-width text keeps its authored layout: convert re-measures text
    // to content width, which shrinks deliberately sized table cells and
    // re-clips them (and worse when fonts haven't loaded yet).
    if (el.type === 'text' && orig.autoResize === false) {
      if (orig.width !== undefined) patched.width = orig.width;
      if (orig.height !== undefined) patched.height = orig.height;
      if (orig.x !== undefined) patched.x = orig.x;
      if (orig.y !== undefined) patched.y = orig.y;
      if (orig.text !== undefined) patched.text = orig.text;
    }

    return patched;
  });
};

const convertElementsPreservingImageProps = (
  elements: Partial<ExcalidrawElement>[]
): Partial<ExcalidrawElement>[] => {
  if (elements.length === 0) return []

  const validatedElements = validateAndFixBindings(elements)
  const imageElements = validatedElements.filter(isImageElement).map(normalizeImageElement)
  const freedrawElements = validatedElements.filter(isFreedrawElement).map(normalizeFreedrawElement)
  const nonImageElements = validatedElements.filter(el => !isImageElement(el) && !isFreedrawElement(el))
  const convertedNonImageElements = convertToExcalidrawElements(nonImageElements as any, { regenerateIds: false })
  const restoredNonImageElements = restoreBindings(convertedNonImageElements, nonImageElements)
  return recenterBoundShapeTextElements([...restoredNonImageElements, ...imageElements, ...freedrawElements])
}

// ─── Room picker (served at "/") ───────────────────────────────────────

const REPO = 'github:subsets-ai/excalidraw-canvas'

function CopyBlock({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }
  return (
    <div className="copy-block">
      <pre>{text}</pre>
      <button type="button" className="btn-ghost copy-btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  )
}

function ConnectGuide({ room }: { room: string }): JSX.Element {
  const origin = window.location.origin
  const claudeCode = [
    'claude mcp add doodle --scope user \\',
    `  -e EXPRESS_SERVER_URL=${origin} \\`,
    '  -e EXCALIDRAW_API_TOKEN=<token> \\',
    `  -e EXCALIDRAW_ROOM=${room} \\`,
    '  -e EXCALIDRAW_NO_AUTOSTART=1 \\',
    `  -- npx -y ${REPO}`
  ].join('\n')
  const claudeDesktop = JSON.stringify({
    mcpServers: {
      doodle: {
        command: 'npx',
        args: ['-y', REPO],
        env: {
          EXPRESS_SERVER_URL: origin,
          EXCALIDRAW_API_TOKEN: '<token>',
          EXCALIDRAW_ROOM: room,
          EXCALIDRAW_NO_AUTOSTART: '1'
        }
      }
    }
  }, null, 2)
  return (
    <section className="guide">
      <h2>Connect Claude</h2>
      <p className="guide-hint">
        Agents draw in a room; humans open <code>{origin}/r/{room}</code>. Replace <code>&lt;token&gt;</code> with the
        shared API token: <code>gcloud secrets versions access latest --secret=excalidraw-api-token --project=misc-internal</code>
      </p>
      <h3>Claude Code</h3>
      <CopyBlock text={claudeCode} />
      <p className="guide-hint">Optional skill (drawing playbook): <code>npx -y {REPO} install-skill</code></p>
      <h3>Claude Desktop</h3>
      <p className="guide-hint">Add to <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>, restart Claude.</p>
      <CopyBlock text={claudeDesktop} />
    </section>
  )
}

function RoomPicker(): JSX.Element {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    fetch('/api/rooms')
      .then(r => r.json())
      .then((data: { success: boolean; rooms?: RoomSummary[]; error?: string }) => {
        if (data.success && data.rooms) setRooms(data.rooms)
        else setError(data.error || 'Failed to load rooms')
      })
      .catch(err => setError((err as Error).message))
  }, [])

  const openRoom = (id: string): void => {
    window.location.href = `/r/${encodeURIComponent(id)}`
  }

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const id = draft.trim().toLowerCase().replace(/\s+/g, '-')
    if (!ROOM_PATTERN.test(id)) {
      setError('Room names: 1-64 chars of a-z, 0-9, "-" or "_".')
      return
    }
    openRoom(id)
  }

  return (
    <div className="room-picker">
      <h1>Doodle</h1>
      <p className="tagline">Self-hosted <a href="https://excalidraw.com" target="_blank" rel="noreferrer">Excalidraw</a> with live shared rooms — you and your agents draw on the same canvas.</p>
      <form className="room-create" onSubmit={submit}>
        <input
          autoFocus
          placeholder="room name, e.g. platform-arch"
          value={draft}
          onChange={e => setDraft(e.target.value)}
        />
        <button type="submit" className="btn-primary">Open</button>
      </form>
      {error && <div className="room-error">{error}</div>}
      {rooms === null && !error && <div className="room-loading">Loading rooms…</div>}
      {rooms && rooms.length === 0 && <div className="room-loading">No rooms yet — create one above.</div>}
      {rooms && rooms.length > 0 && (
        <ul className="room-list">
          {rooms.map(room => (
            <li key={room.id}>
              <a href={`/r/${encodeURIComponent(room.id)}`}>{room.id}</a>
              <span className="room-meta">
                {room.elementCount} element{room.elementCount === 1 ? '' : 's'}
                {room.clients > 0 ? ` · ${room.clients} online` : ''}
                {' · '}updated {new Date(room.updatedAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
      <ConnectGuide room={draft.trim().toLowerCase().replace(/\s+/g, '-') || rooms?.[0]?.id || 'my-room'} />
    </div>
  )
}

// ─── Canvas ────────────────────────────────────────────────────────────

function Canvas({ roomId }: { roomId: string }): JSX.Element {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawAPIRefValue | null>(null)
  const excalidrawAPIRef = useRef<ExcalidrawAPIRefValue | null>(null)
  useEffect(() => {
    excalidrawAPIRef.current = excalidrawAPI
  }, [excalidrawAPI])

  const [isConnected, setIsConnected] = useState<boolean>(false)
  const websocketRef = useRef<WebSocket | null>(null)
  const clientIdRef = useRef<string>('')

  const [username, setUsername] = useState<string>(loadUsername)
  const usernameRef = useRef<string>(username)
  useEffect(() => { usernameRef.current = username }, [username])
  // Behind the auth proxy the server knows who we are; the name box goes away
  const [authenticated, setAuthenticated] = useState<boolean>(false)

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.json())
      .then((me: { authenticated?: boolean; username?: string }) => {
        if (me.authenticated && me.username) {
          setAuthenticated(true)
          setUsername(me.username)
        }
      })
      .catch(() => { /* no proxy: keep the local name */ })
  }, [])

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light'
    try {
      const saved = window.localStorage?.getItem('excalidraw-canvas-theme')
      if (saved === 'light' || saved === 'dark') return saved
    } catch (error) {
      console.warn('Failed to read theme from localStorage:', error)
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  // Sync state
  const [syncError, setSyncError] = useState<string | null>(null)
  const autoSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncInFlightRef = useRef<boolean>(false)
  const syncAgainRef = useRef<boolean>(false)
  const suppressAutoSyncCountRef = useRef<number>(0)
  // What the server holds, as far as this tab knows — the diff base for sync
  const knownVersionsRef = useRef<Map<string, VersionKey>>(new Map())
  // Image files the server already has (or that failed permanently)
  const knownFileIdsRef = useRef<Set<string>>(new Set())

  // Messages that arrive before the Excalidraw API exists (cold load: the
  // socket's initial_elements can beat the editor mount) are replayed later
  const pendingMessagesRef = useRef<WebSocketMessage[]>([])

  // Presence
  const collaboratorsRef = useRef<Map<string, Collaborator>>(new Map())
  const [collaboratorCount, setCollaboratorCount] = useState(0)
  const lastPointerSentRef = useRef<number>(0)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    document.title = `${roomId} · Doodle`
  }, [roomId])

  // Room-scoped fetch
  const roomFetch = useCallback((path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = { ...(init.headers as Record<string, string> | undefined), 'x-excalidraw-room': roomId }
    return fetch(path, { ...init, headers })
  }, [roomId])

  const applySceneUpdateWithoutAutoSync = (
    api: ExcalidrawImperativeAPI,
    scene: Parameters<ExcalidrawImperativeAPI['updateScene']>[0]
  ): void => {
    suppressAutoSyncCountRef.current += 1
    api.updateScene(scene)
    setTimeout(() => {
      suppressAutoSyncCountRef.current = Math.max(0, suppressAutoSyncCountRef.current - 1)
    }, 0)
  }

  const rememberServerVersions = (elements: ServerElement[]): void => {
    for (const el of elements) {
      if (!el.id) continue
      knownVersionsRef.current.set(el.id, {
        version: el.version ?? 1,
        versionNonce: el.versionNonce ?? 0
      })
    }
  }

  // Merge elements coming from the server into the local scene using
  // Excalidraw's own reconcile rule, so an element the user is editing right
  // now is never yanked away, and the same version rule applies on both ends.
  const applyRemoteElements = (incoming: ServerElement[]): void => {
    const api = excalidrawAPIRef.current
    if (!api || incoming.length === 0) return

    rememberServerVersions(incoming)

    const current = api.getSceneElementsIncludingDeleted()
    const incomingById = new Map<string, Partial<ExcalidrawElement>>()
    incoming.forEach(el => { if (el.id) incomingById.set(el.id, cleanElementForExcalidraw(el)) })

    // Convert against the full scene so bindings and bound-text placement
    // have their context, then keep only the incoming ids as "remote".
    const merged: Partial<ExcalidrawElement>[] = current.map(el => {
      const inc = incomingById.get(el.id)
      if (!inc) return el
      incomingById.delete(el.id)
      return { ...el, ...inc }
    })
    merged.push(...incomingById.values())

    const converted = convertElementsPreservingImageProps(sortByIndex(merged as any))
    // Text metrics from elsewhere are never trusted for auto-sized text (see
    // remeasureText); the synchronous pass here gives a first fit, the
    // font-aware pass follows. Fixed-width text (autoResize: false) is laid
    // out deliberately — a refresh would shrink it to its content width and
    // re-wrap it, so it is taken as-is (Excalidraw itself loads files with
    // refreshDimensions off).
    const isFixedWidthText = (el: { type?: string; autoResize?: boolean } | undefined): boolean =>
      el?.type === 'text' && (el as any).autoResize === false
    const needsMeasure = incoming.some(el => el.type === 'text' && !isFixedWidthText(el as any))
    const restored = needsMeasure
      ? restoreElements(converted as any, null, { refreshDimensions: true, repairBindings: true }).map(el =>
          isFixedWidthText(el as any) ? (converted.find(c => c.id === el.id) ?? el) : el
        )
      : converted
    const incomingIds = new Set(incoming.map(el => el.id))
    const remote = restored.filter(el => el.id && incomingIds.has(el.id))

    const reconciled = reconcileElements(current, remote as any, api.getAppState())
    applySceneUpdateWithoutAutoSync(api, {
      elements: reconciled,
      captureUpdate: CaptureUpdateAction.NEVER
    })
    if (needsMeasure) remeasureAfterFonts(remote as any)
  }

  useEffect(() => {
    return () => {
      if (autoSyncTimerRef.current) clearTimeout(autoSyncTimerRef.current)
    }
  }, [])

  // WebSocket connection
  useEffect(() => {
    connectWebSocket()
    return () => {
      if (websocketRef.current) {
        websocketRef.current.onclose = null
        websocketRef.current.close(1000)
      }
    }
  }, [])

  useEffect(() => {
    if (excalidrawAPI) {
      loadExistingElements()
      if (!isConnected) connectWebSocket()
      const queued = pendingMessagesRef.current
      pendingMessagesRef.current = []
      queued.forEach(msg => { void handleWebSocketMessage(msg) })
    }
  }, [excalidrawAPI, isConnected])

  // Excalidraw loads fonts lazily; text measured before its font arrives is
  // too narrow and renders clipped at both ends. That wrong width can come
  // from anywhere — the server's estimate for agent labels, or another tab
  // that measured too early and synced it — so every text element that
  // reaches this tab is re-measured here once its font is loaded (the same
  // pass Excalidraw runs when opening a file). Only the given ids (plus
  // their containers, needed for wrapping) are touched; versions are kept,
  // so the corrected copy replaces the local one without a sync round-trip.
  const remeasureText = (ids?: Set<string>): void => {
    const api = excalidrawAPIRef.current
    if (!api) return
    const current = api.getSceneElementsIncludingDeleted()
    const byId = new Map(current.map(el => [el.id, el]))
    const subset = current.filter(el => {
      if (el.isDeleted) return false
      // Fixed-width text keeps its authored layout (see applyRemoteElements)
      if (el.type === 'text' && (el as any).autoResize === false) return false
      if (!ids) return true
      if (ids.has(el.id)) return true
      // containers of the texts being re-measured
      return current.some(t => t.type === 'text' && ids.has(t.id) && (t as any).containerId === el.id)
    })
    if (!subset.some(el => el.type === 'text')) return
    // restore needs the container in the same list to wrap bound text
    const withContainers = [...subset]
    for (const el of subset) {
      const cid = (el as any).containerId
      if (el.type === 'text' && cid && !withContainers.some(x => x.id === cid) && byId.has(cid)) {
        withContainers.push(byId.get(cid)!)
      }
    }
    // Excalidraw only honours refreshDimensions together with repairBindings
    // (restore.ts returns early otherwise); bindings are repaired against
    // this subset only, so keep just the re-measured text elements.
    const restored = restoreElements(sortByIndex(withContainers as any) as any, null, { refreshDimensions: true, repairBindings: true })
    const changed = restored.filter(r => {
      if (r.type !== 'text' || (r as any).autoResize === false) return false
      const local = byId.get(r.id)
      return local && (local.width !== r.width || local.height !== r.height || local.x !== r.x || local.y !== r.y || (local as any).text !== (r as any).text)
    })
    if (changed.length === 0) return
    const reconciled = reconcileElements(current, changed as any, api.getAppState())
    applySceneUpdateWithoutAutoSync(api, {
      elements: reconciled,
      captureUpdate: CaptureUpdateAction.NEVER
    })
  }

  // Make sure the fonts these text elements use are actually loaded, then
  // re-measure them. Excalidraw registers its font faces up front but only
  // loads them on demand, so measuring right after updateScene may use the
  // fallback font.
  const remeasureAfterFonts = (elements: Array<{ id?: string; type?: string; fontFamily?: number | string; fontSize?: number }>): void => {
    if (typeof document === 'undefined' || !document.fonts) return
    const idToName = new Map<number, string>(Object.entries(FONT_FAMILY).map(([name, id]) => [id as number, name]))
    const specs = new Set<string>()
    const ids = new Set<string>()
    for (const el of elements) {
      if (el.type !== 'text' || !el.id) continue
      if ((el as any).autoResize === false) continue
      ids.add(el.id)
      const name = idToName.get(Number(el.fontFamily))
      if (name) specs.add(`${el.fontSize ?? 20}px "${name}"`)
    }
    if (ids.size === 0) return
    Promise.all(Array.from(specs).map(spec => document.fonts.load(spec).catch(() => [])))
      .then(() => remeasureText(ids))
      .catch(() => { /* ignore */ })
  }
  useEffect(() => {
    if (!excalidrawAPI || typeof document === 'undefined' || !document.fonts) return
    const onFonts = (): void => { setTimeout(() => remeasureText(), 0) }
    document.fonts.addEventListener('loadingdone', onFonts)
    return () => document.fonts.removeEventListener('loadingdone', onFonts)
  }, [excalidrawAPI])

  const loadExistingElements = async (): Promise<void> => {
    try {
      const filesResponse = await roomFetch('/api/files')
      if (filesResponse.ok) {
        const filesResult = await filesResponse.json() as ApiResponse
        if (filesResult.files) {
          Object.keys(filesResult.files).forEach(id => knownFileIdsRef.current.add(id))
          excalidrawAPIRef.current?.addFiles(Object.values(filesResult.files) as any)
        }
      }
      // Elements arrive over the socket (initial_elements, with tombstones)
    } catch (error) {
      console.error('Error loading existing files:', error)
    }
  }

  const pushCollaborators = (): void => {
    const api = excalidrawAPIRef.current
    const map = new Map<SocketId, ExcalidrawCollaborator>()
    collaboratorsRef.current.forEach((c, id) => {
      if (id === clientIdRef.current) return
      map.set(id as SocketId, {
        id,
        socketId: id as SocketId,
        username: c.agent ? `🤖 ${c.username}` : c.username,
        color: c.color,
        pointer: c.pointer as any,
        button: c.button,
        selectedElementIds: c.selectedElementIds as any
      })
    })
    setCollaboratorCount(map.size)
    if (api) {
      suppressAutoSyncCountRef.current += 1
      api.updateScene({ collaborators: map })
      setTimeout(() => {
        suppressAutoSyncCountRef.current = Math.max(0, suppressAutoSyncCountRef.current - 1)
      }, 0)
    }
  }

  const connectWebSocket = (): void => {
    if (websocketRef.current &&
        (websocketRef.current.readyState === WebSocket.CONNECTING ||
         websocketRef.current.readyState === WebSocket.OPEN)) {
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const params = new URLSearchParams({ room: roomId, name: usernameRef.current || 'Anonymous' })
    const wsUrl = `${protocol}//${window.location.host}/?${params.toString()}`

    websocketRef.current = new WebSocket(wsUrl)

    websocketRef.current.onopen = () => {
      setIsConnected(true)
      if (excalidrawAPIRef.current) setTimeout(loadExistingElements, 100)
    }

    websocketRef.current.onmessage = (event: MessageEvent) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data)
        handleWebSocketMessage(data)
      } catch (error) {
        console.error('Error parsing WebSocket message:', error, event.data)
      }
    }

    websocketRef.current.onclose = (event: CloseEvent) => {
      setIsConnected(false)
      collaboratorsRef.current.clear()
      pushCollaborators()
      if (event.code !== 1000) {
        setTimeout(connectWebSocket, 3000)
      }
    }

    websocketRef.current.onerror = (error: Event) => {
      console.error('WebSocket error:', error)
      setIsConnected(false)
    }
  }

  const sendWs = (payload: Record<string, unknown>): void => {
    const ws = websocketRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }

  const handleWebSocketMessage = async (data: WebSocketMessage): Promise<void> => {
    // Presence messages don't need the canvas API
    switch (data.type) {
      case 'welcome':
        if (data.clientId) clientIdRef.current = data.clientId
        if (data.authenticated && data.username) {
          setAuthenticated(true)
          setUsername(data.username)
        }
        return
      case 'collaborators':
        collaboratorsRef.current = new Map((data.collaborators || []).map(c => [c.clientId, c]))
        pushCollaborators()
        return
      case 'collaborator_update':
        if (data.collaborator) {
          collaboratorsRef.current.set(data.collaborator.clientId, data.collaborator)
          pushCollaborators()
        }
        return
      case 'collaborator_left':
        if (data.clientId) {
          collaboratorsRef.current.delete(data.clientId)
          pushCollaborators()
        }
        return
      default:
        break
    }

    const excalidrawAPI = excalidrawAPIRef.current
    if (!excalidrawAPI) {
      pendingMessagesRef.current.push(data)
      return
    }

    try {
      switch (data.type) {
        case 'initial_elements':
          if (data.elements) applyRemoteElements(data.elements)
          if (data.files) {
            Object.keys(data.files).forEach(id => knownFileIdsRef.current.add(id))
            excalidrawAPI.addFiles(Object.values(data.files) as any)
          }
          break

        case 'files_added':
          if (Array.isArray(data.files)) {
            data.files.forEach((f: any) => { if (f?.id) knownFileIdsRef.current.add(f.id) })
            excalidrawAPI.addFiles(data.files)
          }
          break

        case 'element_created':
        case 'element_updated':
          if (data.element) applyRemoteElements([data.element])
          break

        case 'elements_batch_created':
        case 'elements_reconciled':
          if (data.elements) applyRemoteElements(data.elements)
          break

        case 'element_deleted':
          if (data.element) {
            applyRemoteElements([data.element])
          } else if (data.elementId) {
            const filtered = excalidrawAPI.getSceneElementsIncludingDeleted()
              .map(el => el.id === data.elementId ? { ...el, isDeleted: true } : el)
            applySceneUpdateWithoutAutoSync(excalidrawAPI, {
              elements: filtered as any,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
          break

        case 'elements_synced':
        case 'sync_status':
          break

        case 'canvas_cleared':
          knownVersionsRef.current.clear()
          applySceneUpdateWithoutAutoSync(excalidrawAPI, {
            elements: [],
            captureUpdate: CaptureUpdateAction.NEVER
          })
          if (data.reason === 'room_deleted') {
            setSyncError('This room was deleted.')
          }
          break

        case 'export_image_request':
          if (data.requestId) {
            try {
              const elements = excalidrawAPI.getSceneElements()
              const appState = excalidrawAPI.getAppState()
              const files = excalidrawAPI.getFiles()

              if (data.format === 'svg') {
                const svg = await exportToSvg({
                  elements,
                  appState: { ...appState, exportBackground: data.background !== false },
                  files
                })
                const svgString = new XMLSerializer().serializeToString(svg)
                await roomFetch('/api/export/image/result', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ requestId: data.requestId, format: 'svg', data: svgString })
                })
              } else {
                const blob = await exportToBlob({
                  elements,
                  appState: { ...appState, exportBackground: data.background !== false },
                  files,
                  mimeType: 'image/png'
                })
                const reader = new FileReader()
                reader.onload = async () => {
                  try {
                    const resultString = reader.result as string
                    const base64 = resultString?.split(',')[1]
                    if (!base64) throw new Error('Could not extract base64 data from result')
                    await roomFetch('/api/export/image/result', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ requestId: data.requestId, format: 'png', data: base64 })
                    })
                  } catch (readerError) {
                    console.error('Image export (FileReader) failed:', readerError)
                    await roomFetch('/api/export/image/result', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ requestId: data.requestId, error: (readerError as Error).message })
                    }).catch(() => { })
                  }
                }
                reader.onerror = async () => {
                  await roomFetch('/api/export/image/result', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId: data.requestId, error: reader.error?.message || 'FileReader failed' })
                  }).catch(() => { })
                }
                reader.readAsDataURL(blob)
              }
            } catch (exportError) {
              console.error('Image export failed:', exportError)
              await roomFetch('/api/export/image/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requestId: data.requestId, error: (exportError as Error).message })
              })
            }
          }
          break

        case 'set_viewport':
          if (data.requestId) {
            try {
              if (data.scrollToContent) {
                const allElements = excalidrawAPI.getSceneElements()
                if (allElements.length > 0) {
                  excalidrawAPI.scrollToContent(allElements, {
                    fitToViewport: true,
                    viewportZoomFactor: data.viewportZoomFactor,
                    animate: true
                  })
                }
              } else if (data.scrollToElementIds !== undefined) {
                if (!Array.isArray(data.scrollToElementIds) ||
                    data.scrollToElementIds.length === 0 ||
                    !data.scrollToElementIds.every(id => typeof id === 'string' && id.length > 0)) {
                  throw new Error('scrollToElementIds must be a non-empty array of element IDs')
                }
                const allElements = excalidrawAPI.getSceneElements()
                const requestedIds = new Set(data.scrollToElementIds)
                const targetElements = allElements.filter(el => requestedIds.has(el.id))
                const foundIds = new Set(targetElements.map(el => el.id))
                const missingIds = data.scrollToElementIds.filter(id => !foundIds.has(id))
                if (missingIds.length > 0) {
                  throw new Error(`Elements not found for IDs: ${missingIds.join(', ')}`)
                }
                excalidrawAPI.scrollToContent(targetElements, {
                  fitToViewport: true,
                  viewportZoomFactor: data.viewportZoomFactor,
                  animate: true
                })
              } else if (data.scrollToElementId) {
                const allElements = excalidrawAPI.getSceneElements()
                const targetElement = allElements.find(el => el.id === data.scrollToElementId)
                if (targetElement) {
                  excalidrawAPI.scrollToContent([targetElement], { fitToViewport: false, animate: true })
                } else {
                  throw new Error(`Element ${data.scrollToElementId} not found`)
                }
              } else {
                const appState: any = {}
                if (data.zoom !== undefined) appState.zoom = { value: data.zoom }
                if (data.offsetX !== undefined) appState.scrollX = data.offsetX
                if (data.offsetY !== undefined) appState.scrollY = data.offsetY
                if (Object.keys(appState).length > 0) {
                  applySceneUpdateWithoutAutoSync(excalidrawAPI, { appState })
                }
              }

              await roomFetch('/api/viewport/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requestId: data.requestId, success: true, message: 'Viewport updated' })
              })
            } catch (viewportError) {
              console.error('Viewport control failed:', viewportError)
              await roomFetch('/api/viewport/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requestId: data.requestId, error: (viewportError as Error).message })
              }).catch(() => { })
            }
          }
          break

        case 'mermaid_convert':
          if (data.mermaidDiagram) {
            try {
              const result = await convertMermaidToExcalidraw(data.mermaidDiagram, data.config || DEFAULT_MERMAID_CONFIG)

              if (result.error) {
                console.error('Mermaid conversion error:', result.error)
                return
              }

              if (result.elements && result.elements.length > 0) {
                const convertedElements = convertToExcalidrawElements(result.elements, { regenerateIds: true })
                applySceneUpdateWithoutAutoSync(excalidrawAPI, {
                  elements: [...excalidrawAPI.getSceneElementsIncludingDeleted(), ...convertedElements],
                  captureUpdate: CaptureUpdateAction.IMMEDIATELY
                })

                if (result.files) excalidrawAPI.addFiles(Object.values(result.files))

                // New elements aren't in the known map, so the diff picks them up
                await syncToBackend()
              }
            } catch (error) {
              console.error('Error converting Mermaid diagram from WebSocket:', error)
            }
          }
          break

        default:
          console.log('Unknown WebSocket message type:', data.type)
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error, data)
    }
  }

  // Images pasted or dropped into this tab exist only locally until their
  // BinaryFiles are pushed; without this they vanish on refresh.
  const syncFilesToBackend = async (): Promise<void> => {
    const api = excalidrawAPIRef.current
    if (!api) return
    const files = Object.values(api.getFiles() ?? {}) as Array<{ id: string; dataURL: string; mimeType?: string; created?: number }>
    const fresh = files.filter(f => f?.id && f.dataURL && !knownFileIdsRef.current.has(f.id))
    for (const f of fresh) {
      try {
        const response = await roomFetch('/api/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: [f] })
        })
        if (response.ok) {
          knownFileIdsRef.current.add(f.id)
        } else if (response.status === 413) {
          knownFileIdsRef.current.add(f.id) // don't retry forever
          setSyncError('An image is too large to sync (5 MB max) — it will not survive a refresh.')
        }
      } catch { /* retried on the next sync */ }
    }
  }

  // Diff-based sync: send only elements whose version/versionNonce differ
  // from what the server is known to hold.
  const syncToBackend = async (): Promise<void> => {
    const api = excalidrawAPIRef.current
    if (!api) return

    if (syncInFlightRef.current) {
      syncAgainRef.current = true
      return
    }

    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
      autoSyncTimerRef.current = null
    }

    void syncFilesToBackend()

    const known = knownVersionsRef.current
    const changed: ExcalidrawElement[] = []
    for (const el of api.getSceneElementsIncludingDeleted()) {
      const k = known.get(el.id)
      if (!k) {
        if (!el.isDeleted) changed.push(el)
        continue
      }
      if (k.version !== el.version || k.versionNonce !== el.versionNonce) changed.push(el)
    }
    if (changed.length === 0) return

    syncInFlightRef.current = true
    const sentVersions = new Map(changed.map(el => [el.id, { version: el.version, versionNonce: el.versionNonce }]))

    try {
      const response = await roomFetch('/api/elements/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientIdRef.current, elements: changed })
      })

      const result: ApiResponse = await response.json().catch(() => ({ success: false, error: `HTTP ${response.status}` }))
      if (response.ok && result.success) {
        for (const id of result.accepted || []) {
          const v = sentVersions.get(id)
          if (v) known.set(id, v)
        }
        // Elements whose server copy is newer than ours: take the server's
        if (result.rejected && result.rejected.length > 0) applyRemoteElements(result.rejected)
        // Elements the server ignored as no-ops (identical copies) are in
        // neither list; treat them as known so they aren't resent forever
        const handled = new Set([...(result.accepted || []), ...((result.rejected || []).map(el => el.id))])
        sentVersions.forEach((v, id) => { if (!handled.has(id)) known.set(id, v) })
        setSyncError(null)
      } else {
        setSyncError(result.error || `Sync failed (${response.status})`)
      }
    } catch (error) {
      setSyncError((error as Error).message)
    } finally {
      syncInFlightRef.current = false
      if (syncAgainRef.current) {
        syncAgainRef.current = false
        scheduleAutoSync()
      }
    }
  }

  const scheduleAutoSync = (): void => {
    if (suppressAutoSyncCountRef.current > 0) return
    if (autoSyncTimerRef.current) clearTimeout(autoSyncTimerRef.current)
    autoSyncTimerRef.current = setTimeout(() => {
      autoSyncTimerRef.current = null
      void syncToBackend()
    }, AUTO_SYNC_DEBOUNCE_MS)
  }

  const clearCanvas = async (): Promise<void> => {
    if (!window.confirm(`Clear every element in room "${roomId}" for everyone?`)) return
    try {
      await roomFetch('/api/elements/clear', { method: 'DELETE' })
      // The server broadcasts canvas_cleared back to us
    } catch (error) {
      console.error('Error clearing canvas:', error)
    }
  }

  const copyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }

  const commitUsername = (value: string): void => {
    const name = value.trim().slice(0, 40)
    setUsername(name)
    saveUsername(name)
    sendWs({ type: 'rename', username: name || 'Anonymous' })
  }

  const onPointerUpdate = (payload: {
    pointer: { x: number; y: number; tool: 'pointer' | 'laser' };
    button: 'down' | 'up';
  }): void => {
    const now = Date.now()
    if (now - lastPointerSentRef.current < POINTER_THROTTLE_MS) return
    lastPointerSentRef.current = now
    const api = excalidrawAPIRef.current
    sendWs({
      type: 'pointer',
      pointer: payload.pointer,
      button: payload.button,
      selectedElementIds: api?.getAppState().selectedElementIds ?? {}
    })
  }

  return (
    <div className="app" data-theme={theme}>
      <div className="header">
        <div className="header-left">
          <a className="room-home" href="/" title="All rooms">Doodle</a>
          <span className="room-sep">/</span>
          <h1 className="room-name">{roomId}</h1>
          <button className="btn-ghost" onClick={copyLink} title="Copy room link">
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
        <div className="controls">
          <div className="status" title={syncError ? syncError : (isConnected ? 'Live' : 'Reconnecting…')}>
            <div className={`status-dot ${syncError ? 'status-error' : (isConnected ? 'status-connected' : 'status-disconnected')}`}></div>
            <span>
              {syncError ? 'Sync error' : (isConnected ? 'Live' : 'Reconnecting…')}
              {isConnected && collaboratorCount > 0 ? ` · ${collaboratorCount} other${collaboratorCount === 1 ? '' : 's'}` : ''}
            </span>
          </div>
          {authenticated ? (
            <span className="name-fixed" title="Signed in">{username}</span>
          ) : (
            <input
              className="name-input"
              placeholder="Your name"
              defaultValue={username}
              onBlur={e => commitUsername(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            />
          )}
          <button className="btn-secondary" onClick={clearCanvas}>Clear room</button>
        </div>
      </div>

      <div className="canvas-container">
        <Excalidraw
          excalidrawAPI={(api: ExcalidrawAPIRefValue) => {
            // Dev-only hook for local debugging/tests; never exposed on a
            // deployed host (see security review L10).
            if (['127.0.0.1', 'localhost'].includes(window.location.hostname)) {
              ;(window as any).__excalidrawAPI = api
            }
            setExcalidrawAPI(api)
          }}
          isCollaborating={true}
          onPointerUpdate={onPointerUpdate}
          onChange={(_elements, appState) => {
            if (appState?.theme && appState.theme !== theme) {
              setTheme(appState.theme)
              try {
                window.localStorage?.setItem('excalidraw-canvas-theme', appState.theme)
              } catch (error) {
                console.warn('Failed to save theme to localStorage:', error)
              }
            }
            scheduleAutoSync()
          }}
          initialData={{
            elements: [],
            appState: { theme }
          }}
        />
      </div>
    </div>
  )
}

function App(): JSX.Element {
  const roomId = roomFromLocation()
  if (window.location.pathname !== '/' && !roomId) {
    return (
      <div className="room-picker">
        <h1>Invalid room</h1>
        <p className="room-picker-hint">Room names: 1-64 chars of a-z, 0-9, "-" or "_". <a href="/">Back to rooms</a></p>
      </div>
    )
  }
  return roomId ? <Canvas roomId={roomId} /> : <RoomPicker />
}

export default App
