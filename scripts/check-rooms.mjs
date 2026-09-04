#!/usr/bin/env node
// Integration check for rooms, label splitting, diff-based reconcile,
// presence relay, and on-disk persistence. Boots dist/server.js twice
// against a temp DATA_DIR. Run after `npm run build:server`.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const serverPath = join(repoRoot, 'dist', 'server.js');
const binPath = join(repoRoot, 'dist', 'bin.js');
const port = Number(process.env.PORT || 34000 + Math.floor(Math.random() * 2000));
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'excalidraw-rooms-'));

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log(`  ok   ${msg}`); }
  else { failures++; console.log(`  FAIL ${msg}`); }
}
function eq(a, b, msg) { check(JSON.stringify(a) === JSON.stringify(b), `${msg} (${JSON.stringify(a)} == ${JSON.stringify(b)})`); }

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, LOG_LEVEL: 'error', TOMBSTONE_RESURRECT_GRACE_MS: '400', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.stderr.write(d));
  return child;
}

async function waitHealthy(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return await r.json();
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not become healthy');
}

async function stopServer(child) {
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
}

async function api(room, path, init = {}) {
  const headers = { 'content-type': 'application/json', ...(init.headers || {}) };
  if (room) headers['x-excalidraw-room'] = room;
  const r = await fetch(`${base}${path}`, { ...init, headers });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

function connectWs(room, name, origin, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?room=${room}&name=${encodeURIComponent(name)}`, { ...(origin ? { origin } : {}), ...(headers ? { headers } : {}) });
    const inbox = [];
    const waiters = [];
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      const i = waiters.findIndex(w => w.pred(msg));
      if (i !== -1) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(msg); }
      else inbox.push(msg);
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws,
      next(pred, label, timeoutMs = 3000) {
        const i = inbox.findIndex(pred);
        if (i !== -1) return Promise.resolve(inbox.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), timeoutMs);
          waiters.push({ pred, resolve: res, timer });
        });
      },
      quiet(pred, ms = 400) {
        return new Promise(res => setTimeout(() => res(!inbox.some(pred)), ms));
      },
      send(obj) { ws.send(JSON.stringify(obj)); },
      close() { ws.close(1000); }
    }));
  });
}

let server = startServer();
try {
  const health = await waitHealthy();
  console.log('server up');
  check(health.service === 'mcp-excalidraw-canvas', 'health identity');
  check(health.persistence === true, 'persistence enabled');

  // ---- rooms are isolated
  console.log('rooms');
  let r = await api('alpha', '/api/elements', {
    method: 'POST',
    body: JSON.stringify({ id: 'box', type: 'rectangle', x: 10, y: 10, width: 200, height: 100, text: 'API' })
  });
  eq(r.status, 200, 'create in alpha');
  eq(r.body.element.label, { text: 'API' }, 'label attached on create response');
  check(!('text' in r.body.element), 'shape does not carry raw text');
  check(Array.isArray(r.body.element.boundElements) && r.body.element.boundElements[0].id === 'box-label', 'bound text created');

  r = await api('beta', '/api/elements');
  eq(r.body.count, 0, 'beta is empty');
  r = await api('alpha', '/api/elements');
  eq(r.body.count, 2, 'alpha has shape + bound text');
  eq(r.body.elements.find(e => e.id === 'box').label, { text: 'API' }, 'label attached on list');
  const textEl = r.body.elements.find(e => e.id === 'box-label');
  check(textEl && textEl.type === 'text' && textEl.containerId === 'box' && textEl.text === 'API', 'bound text element well-formed');

  r = await api('Bad Room!', '/api/elements');
  eq(r.status, 400, 'invalid room id rejected');
  r = await api(null, '/api/elements');
  eq(r.body.room, 'default', 'no header = default room');

  r = await api(null, '/api/rooms');
  check(r.body.rooms.map(x => x.id).includes('alpha'), 'rooms list includes alpha');
  eq(r.body.rooms.find(x => x.id === 'alpha').elementCount, 1, 'room summary counts live shapes only');

  // ---- label update goes to bound text
  console.log('labels');
  r = await api('alpha', '/api/elements/box', { method: 'PUT', body: JSON.stringify({ label: { text: 'Gateway' } }) });
  eq(r.status, 200, 'update label');
  eq(r.body.element.label, { text: 'Gateway' }, 'updated label echoed');
  r = await api('alpha', '/api/elements/box-label');
  eq(r.body.element.text, 'Gateway', 'bound text updated');
  const textVersionAfterLabel = r.body.element.version;
  check(textVersionAfterLabel >= 2, 'bound text version bumped');

  // Moving the shape recenters its label server-side
  r = await api('alpha', '/api/elements/box', { method: 'PUT', body: JSON.stringify({ x: 500, y: 500 }) });
  r = await api('alpha', '/api/elements/box-label');
  check(r.body.element.x > 500 && r.body.element.y > 500, 'bound text follows the shape');

  // ---- old full-replace sync is gone
  r = await api('alpha', '/api/elements/sync', { method: 'POST', body: JSON.stringify({ elements: [] }) });
  eq(r.status, 410, '/api/elements/sync is gone');
  r = await api('alpha', '/api/elements');
  eq(r.body.count, 2, 'sync attempt changed nothing');

  // ---- reconcile
  console.log('reconcile');
  const serverBox = (await api('alpha', '/api/elements/box')).body.element;
  // stale copy (older version) must be rejected
  r = await api('alpha', '/api/elements/reconcile', {
    method: 'POST',
    body: JSON.stringify({ clientId: 'c1', elements: [{ ...serverBox, x: 1, version: 1, versionNonce: 1 }] })
  });
  eq(r.body.accepted, [], 'stale version rejected');
  eq(r.body.rejected.map(e => e.id), ['box'], 'server copy returned for stale');
  // newer version wins
  r = await api('alpha', '/api/elements/reconcile', {
    method: 'POST',
    body: JSON.stringify({ clientId: 'c1', elements: [{ ...serverBox, x: 42, version: serverBox.version + 1, versionNonce: 7 }] })
  });
  eq(r.body.accepted, ['box'], 'newer version accepted');
  eq((await api('alpha', '/api/elements/box')).body.element.x, 42, 'reconciled x stored');
  // equal version: lower nonce wins
  r = await api('alpha', '/api/elements/reconcile', {
    method: 'POST',
    body: JSON.stringify({ elements: [{ ...serverBox, x: 43, version: serverBox.version + 1, versionNonce: 99 }] })
  });
  eq(r.body.accepted, [], 'tie with higher nonce rejected');
  r = await api('alpha', '/api/elements/reconcile', {
    method: 'POST',
    body: JSON.stringify({ elements: [{ ...serverBox, x: 44, version: serverBox.version + 1, versionNonce: 3 }] })
  });
  eq(r.body.accepted, ['box'], 'tie with lower nonce accepted');
  // a browser-created element (no label, raw excalidraw shape)
  r = await api('alpha', '/api/elements/reconcile', {
    method: 'POST',
    body: JSON.stringify({ elements: [{ id: 'circle', type: 'ellipse', x: 0, y: 0, width: 50, height: 50, version: 3, versionNonce: 5 }] })
  });
  eq(r.body.accepted, ['circle'], 'new browser element accepted');
  // delete via tombstone
  r = await api('alpha', '/api/elements/reconcile', {
    method: 'POST',
    body: JSON.stringify({ elements: [{ id: 'circle', type: 'ellipse', x: 0, y: 0, width: 50, height: 50, version: 4, versionNonce: 5, isDeleted: true }] })
  });
  eq(r.body.accepted, ['circle'], 'tombstone accepted');
  eq((await api('alpha', '/api/elements/circle')).status, 404, 'deleted element hidden from reads');
  r = await api('alpha', '/api/elements');
  check(!r.body.elements.some(e => e.id === 'circle'), 'deleted element not listed');
  // stale resurrection attempt is rejected
  r = await api('alpha', '/api/elements/reconcile', {
    method: 'POST',
    body: JSON.stringify({ elements: [{ id: 'circle', type: 'ellipse', x: 9, y: 9, width: 50, height: 50, version: 2, versionNonce: 5 }] })
  });
  eq(r.body.accepted, [], 'stale resurrection rejected');

  // REST delete tombstones parent + label
  r = await api('alpha', '/api/elements/box', { method: 'DELETE' });
  eq(r.status, 200, 'delete box');
  r = await api('alpha', '/api/elements');
  eq(r.body.count, 0, 'box and its label gone from reads');

  // ---- websocket: initial state, presence relay, broadcast exclusion
  console.log('websocket');
  await api('alpha', '/api/elements', { method: 'POST', body: JSON.stringify({ id: 'n1', type: 'ellipse', x: 0, y: 0, width: 10, height: 10 }) });
  const a = await connectWs('alpha', 'Ada');
  const welcome = await a.next(m => m.type === 'welcome', 'welcome');
  check(typeof welcome.clientId === 'string' && welcome.room === 'alpha', 'welcome carries clientId + room');
  const initial = await a.next(m => m.type === 'initial_elements', 'initial_elements');
  check(initial.elements.some(e => e.id === 'n1'), 'initial_elements has live element');
  check(initial.elements.some(e => e.id === 'box' && e.isDeleted === true), 'initial_elements carries tombstones');
  const collabs = await a.next(m => m.type === 'collaborators', 'collaborators');
  eq(collabs.collaborators.map(c => c.username), ['Ada'], 'self listed in collaborators');

  const b = await connectWs('alpha', 'Bob');
  await b.next(m => m.type === 'welcome', 'welcome b');
  const joined = await a.next(m => m.type === 'collaborator_update' && m.collaborator.username === 'Bob', 'Bob joined');
  check(joined.collaborator.color && joined.collaborator.color.stroke, 'collaborator has color');

  b.send({ type: 'pointer', pointer: { x: 5, y: 6, tool: 'pointer' }, button: 'down', selectedElementIds: { n1: true } });
  const ptr = await a.next(m => m.type === 'collaborator_update' && m.collaborator.pointer, 'pointer relayed');
  eq(ptr.collaborator.pointer, { x: 5, y: 6, tool: 'pointer' }, 'pointer payload');
  eq(ptr.collaborator.button, 'down', 'button relayed');
  check(await b.quiet(m => m.type === 'collaborator_update' && m.collaborator.username === 'Bob'), 'sender does not get its own pointer');

  // another room does not see alpha traffic
  const c = await connectWs('beta', 'Cy');
  await c.next(m => m.type === 'welcome', 'welcome c');
  await api('alpha', '/api/elements', { method: 'POST', body: JSON.stringify({ id: 'n2', type: 'ellipse', x: 0, y: 0, width: 10, height: 10 }) });
  await a.next(m => m.type === 'element_created' && m.element.id === 'n2', 'a sees n2');
  check(await c.quiet(m => m.type === 'element_created'), 'beta tab does not see alpha element');

  // agent presence appears and expires
  const agent = await a.next(m => m.type === 'collaborator_update' && m.collaborator.agent, 'agent presence');
  check(agent.collaborator.username === 'Agent' && agent.collaborator.pointer, 'agent marker at element');

  // reconcile broadcast excludes the sender
  await api('alpha', '/api/elements/reconcile', {
    method: 'POST',
    body: JSON.stringify({ clientId: welcome.clientId, elements: [{ id: 'n3', type: 'ellipse', x: 0, y: 0, width: 1, height: 1, version: 1, versionNonce: 1 }] })
  });
  await b.next(m => m.type === 'elements_reconciled' && m.elements.some(e => e.id === 'n3'), 'b receives reconcile broadcast');
  check(await a.quiet(m => m.type === 'elements_reconciled'), 'sender excluded from its own reconcile broadcast');

  b.close();
  await a.next(m => m.type === 'collaborator_left', 'Bob left');

  // identity from the auth proxy wins over ?name= and can't be renamed
  const d = await connectWs('alpha', 'Spoof', undefined, { 'x-forwarded-email': 'Ada.Lovelace@subsets.com' });
  const dw = await d.next(m => m.type === 'welcome', 'welcome d');
  eq(dw.username, 'ada.lovelace', 'proxy identity sets username');
  eq(dw.authenticated, true, 'welcome flags authenticated');
  const dj = await a.next(m => m.type === 'collaborator_update' && m.collaborator.authenticated, 'auth collaborator seen');
  eq(dj.collaborator.email, 'ada.lovelace@subsets.com', 'email lowercased on collaborator');
  d.send({ type: 'rename', username: 'Mallory' });
  check(await a.quiet(m => m.type === 'collaborator_update' && m.collaborator.username === 'Mallory'), 'rename ignored for authenticated user');
  d.close();
  r = await fetch(`${base}/api/me`, { headers: { 'x-forwarded-email': 'ob@subsets.com', 'x-forwarded-preferred-username': 'Oliver' } }).then(x => x.json());
  eq([r.authenticated, r.username, r.email], [true, 'Oliver', 'ob@subsets.com'], '/api/me with proxy headers');
  r = await fetch(`${base}/api/me`).then(x => x.json());
  eq(r.authenticated, false, '/api/me without proxy headers');
  a.close(); c.close();

  // ---- CLI with --room
  console.log('cli');
  const cli = spawnSync(process.execPath, [binPath, '--url', base, '--room', 'gamma', 'add', '--one',
    JSON.stringify({ id: 'cli1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, text: 'from cli' })],
    { env: { ...process.env, EXCALIDRAW_NO_AUTOSTART: '1' }, encoding: 'utf-8' });
  eq(cli.status, 0, `cli add exits 0 ${cli.stderr.trim().slice(0, 200)}`);
  r = await api('gamma', '/api/elements/cli1');
  eq(r.body.element?.label, { text: 'from cli' }, 'cli element landed in gamma with label');
  const cliEnv = spawnSync(process.execPath, [binPath, 'query', '--url', base],
    { env: { ...process.env, EXCALIDRAW_NO_AUTOSTART: '1', EXCALIDRAW_ROOM: 'gamma' }, encoding: 'utf-8' });
  check(cliEnv.status === 0 && cliEnv.stdout.includes('cli1'), 'EXCALIDRAW_ROOM env selects room');

  // rooms CLI: slugified create + list marks current
  const rc = spawnSync(process.execPath, [binPath, '--url', base, 'rooms', 'create', 'PRO-2050 Wrong experiment objective'],
    { env: { ...process.env, EXCALIDRAW_NO_AUTOSTART: '1' }, encoding: 'utf-8' });
  const rcOut = rc.status === 0 ? JSON.parse(rc.stdout) : {};
  eq(rcOut.room?.id, 'pro-2050-wrong-experiment-objective', `rooms create slugifies ${rc.stderr.trim().slice(0, 120)}`);
  check(rcOut.url?.endsWith('/r/pro-2050-wrong-experiment-objective'), 'rooms create returns the room URL');
  const rl = spawnSync(process.execPath, [binPath, '--url', base, '--room', 'gamma', 'rooms'],
    { env: { ...process.env, EXCALIDRAW_NO_AUTOSTART: '1' }, encoding: 'utf-8' });
  const rlOut = rl.status === 0 ? JSON.parse(rl.stdout) : {};
  eq(rlOut.current, 'gamma', 'rooms list reports current room');
  check((rlOut.rooms || []).some(r => r.id === 'pro-2050-wrong-experiment-objective'), 'rooms list includes created room');

  // ---- GETs never create rooms; deleted rooms stay deleted
  console.log('room lifecycle');
  r = await api('ghost-room', '/api/elements');
  eq(r.status, 200, 'GET on nonexistent room answers empty');
  r = await api(null, '/api/rooms');
  check(!r.body.rooms.some(x => x.id === 'ghost-room'), 'plain GET did not create the room');
  await api(null, '/api/rooms', { method: 'POST', body: JSON.stringify({ id: 'shortlived' }) });
  await api(null, '/api/rooms/shortlived', { method: 'DELETE' });
  await api('shortlived', '/api/files');
  await api('shortlived', '/api/elements');
  r = await api(null, '/api/rooms');
  check(!r.body.rooms.some(x => x.id === 'shortlived'), 'reads after delete do not resurrect the room');

  // ---- re-import: a tombstoned id is resurrected after the grace period
  console.log('resurrection');
  const imp = { id: 'imp1', type: 'rectangle', x: 1, y: 1, width: 9, height: 9, version: 4, versionNonce: 4 };
  await api('imp', '/api/elements/reconcile', { method: 'POST', body: JSON.stringify({ elements: [imp] }) });
  await api('imp', '/api/elements/imp1', { method: 'DELETE' });
  // fresh tombstone: stale echo still rejected
  r = await api('imp', '/api/elements/reconcile', { method: 'POST', body: JSON.stringify({ elements: [imp] }) });
  eq(r.body.accepted, [], 'echo within grace rejected');
  await new Promise(res => setTimeout(res, 600));
  // late re-import (same id, old version): accepted, version bumped past the tombstone
  r = await api('imp', '/api/elements/reconcile', { method: 'POST', body: JSON.stringify({ elements: [imp] }) });
  eq(r.body.accepted, ['imp1'], 'late re-import resurrects');
  check(r.body.rejected.length === 1 && r.body.rejected[0].version > 5, 'sender told to adopt bumped version');
  r = await api('imp', '/api/elements/imp1');
  eq(r.status, 200, 'element live again');

  // ---- z-order: reads are sorted by fractional index, not insertion order
  console.log('z-order');
  await api('zorder', '/api/elements/reconcile', { method: 'POST', body: JSON.stringify({ elements: [
    { id: 'z-first-inserted', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, index: 'a2' },
    { id: 'z-second-inserted', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, index: 'a1' },
    { id: 'z-no-index', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1 }
  ] }) });
  r = await api('zorder', '/api/elements');
  eq(r.body.elements.map(e => e.id), ['z-second-inserted', 'z-first-inserted', 'z-no-index'], 'elements listed in index order, index-less last');

  // ---- elbow routing, semantic diagrams, lint
  console.log('diagram tools');
  await api('draw', '/api/elements/batch', { method: 'POST', body: JSON.stringify({ elements: [
    { id: 'top', type: 'rectangle', x: 300, y: 0, width: 200, height: 80 },
    { id: 'kid', type: 'rectangle', x: 0, y: 300, width: 200, height: 80 },
    { id: 'el1', type: 'arrow', x: 0, y: 0, elbowed: true, start: { id: 'top' }, end: { id: 'kid' } }
  ] }) });
  r = await api('draw', '/api/elements/el1');
  check((r.body.element.points || []).length === 4, `elbowed bound arrow gets a Manhattan route (${JSON.stringify(r.body.element.points)})`);
  // endpoints carry boundElements back-refs so the browser drags arrows along
  r = await api('draw', '/api/elements/top');
  check((r.body.element.boundElements || []).some(b => b.id === 'el1'), 'endpoint box gets boundElements back-ref');
  await api('draw', '/api/elements/el1', { method: 'DELETE' });
  r = await api('draw', '/api/elements/top');
  check(!(r.body.element.boundElements || []).some(b => b.id === 'el1'), 'back-ref removed when arrow deleted');
  await api('draw', '/api/elements/batch', { method: 'POST', body: JSON.stringify({ elements: [
    { id: 'el2', type: 'arrow', x: 0, y: 0, elbowed: true, start: { id: 'top' }, end: { id: 'kid' } }
  ] }) });
  r = await api('draw', '/api/elements/kid');
  check((r.body.element.boundElements || []).some(b => b.id === 'el2'), 'batch-created arrow attaches back-refs too');
  const dg = spawnSync(process.execPath, [binPath, '--url', base, '--room', 'dgm', 'diagram', '-'], {
    env: { ...process.env, EXCALIDRAW_NO_AUTOSTART: '1' }, encoding: 'utf-8',
    input: JSON.stringify({
      nodes: [ { id: 'a', label: 'Boss' }, { id: 'b', label: 'Kid One', group: 'g' }, { id: 'c', label: 'Kid Two', group: 'g' } ],
      edges: [ { from: 'a', to: 'b' }, { from: 'a', to: 'c' } ],
      groups: [ { id: 'g', label: 'Team' } ]
    })
  });
  const dgOut = dg.status === 0 ? JSON.parse(dg.stdout) : {};
  eq(dgOut.created, 7, `diagram builds zone+title+3 nodes+2 arrows ${dg.stderr.trim().slice(0, 120)}`);
  r = await api('dgm', '/api/elements/b');
  check(r.body.element && r.body.element.y > (await api('dgm', '/api/elements/a')).body.element.y, 'diagram layers children below parents');
  const lint = spawnSync(process.execPath, [binPath, '--url', base, '--room', 'dgm', 'lint'], { env: { ...process.env, EXCALIDRAW_NO_AUTOSTART: '1' }, encoding: 'utf-8' });
  eq(JSON.parse(lint.stdout).count, 0, 'generated diagram lints clean');
  await api('lintbad', '/api/elements/batch', { method: 'POST', body: JSON.stringify({ elements: [
    { id: 'o1', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 },
    { id: 'o2', type: 'rectangle', x: 50, y: 20, width: 100, height: 60 }
  ] }) });
  const lint2 = spawnSync(process.execPath, [binPath, '--url', base, '--room', 'lintbad', 'lint'], { env: { ...process.env, EXCALIDRAW_NO_AUTOSTART: '1' }, encoding: 'utf-8' });
  check(JSON.parse(lint2.stdout).warnings.some(w => w.kind === 'overlap'), 'lint flags overlap');

  // ---- persistence across restart
  console.log('persistence');
  await new Promise(r => setTimeout(r, 500)); // let the debounced save land
  await stopServer(server);
  check(existsSync(join(dataDir, 'rooms', 'alpha.json')), 'alpha.json written');
  server = startServer();
  await waitHealthy();
  r = await api('alpha', '/api/elements');
  eq(r.body.elements.map(e => e.id).sort(), ['n1', 'n2', 'n3'], 'alpha elements survive restart');
  r = await api(null, '/api/rooms');
  check(r.body.rooms.map(x => x.id).includes('gamma'), 'rooms rediscovered from disk');
  r = await api(null, '/api/rooms/gamma', { method: 'DELETE' });
  eq(r.status, 200, 'delete room');
  check(!existsSync(join(dataDir, 'rooms', 'gamma.json')), 'room file removed');
  r = await api(null, '/api/rooms/default', { method: 'DELETE' });
  eq(r.status, 400, 'default room protected');

  // ---- origin allowlist (PUBLIC_ORIGIN) on WebSocket upgrades
  console.log('origin');
  await stopServer(server);
  server = startServer({ PUBLIC_ORIGIN: 'https://draw.example.test', NODE_ENV: 'production' });
  await waitHealthy();
  const good = await connectWs('alpha', 'Ok', 'https://draw.example.test');
  await good.next(m => m.type === 'welcome', 'welcome (allowed origin)');
  good.close();
  const noOrigin = await connectWs('alpha', 'Cli');
  await noOrigin.next(m => m.type === 'welcome', 'welcome (no origin header)');
  noOrigin.close();
  const bad = await connectWs('alpha', 'Evil', 'https://evil.example').then(() => 'connected', err => err.message);
  check(bad !== 'connected', `cross-origin upgrade rejected (${bad})`);
  r = await fetch(`${base}/api/rooms`, { headers: { origin: 'https://evil.example' } });
  check(!r.headers.get('access-control-allow-origin'), 'no wildcard CORS in production');
  r = await fetch(`${base}/server.js`);
  eq(r.status, 404, 'compiled backend not served');
} catch (error) {
  failures++;
  console.error('ERROR', error);
} finally {
  if (server.exitCode === null) await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall room checks passed');
