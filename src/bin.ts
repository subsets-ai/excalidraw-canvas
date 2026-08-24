#!/usr/bin/env node

// Single bin entry for both package bins (mcp-excalidraw-server and
// excalidraw-canvas):
//
//   no arguments  -> MCP stdio server (backward compatible with MCP clients)
//   <subcommand>  -> CLI
//
// IMPORTANT: never statically import ./index.js or ./server.js here.
// index.js evaluates the whole MCP module graph, and server.js used to start
// the Express canvas server on import — the CLI must only ever reach the
// canvas by spawning dist/server.js as a child process (see core/spawn.ts).

// Disable colors to prevent ANSI color codes from breaking JSON parsing
process.env.NODE_DISABLE_COLORS = '1';
process.env.NO_COLOR = '1';

const argv = process.argv.slice(2);

// Global --url / --room flags: must land in the environment before any core
// module (which reads EXPRESS_SERVER_URL / EXCALIDRAW_ROOM at import time)
// is loaded.
const GLOBAL_FLAGS: Record<string, string> = { '--url': 'EXPRESS_SERVER_URL', '--room': 'EXCALIDRAW_ROOM' };
for (let i = 0; i < argv.length; i++) {
  const token = argv[i]!;
  const eq = token.indexOf('=');
  const flag = eq === -1 ? token : token.slice(0, eq);
  const envName = GLOBAL_FLAGS[flag];
  if (!envName) continue;
  if (eq !== -1) {
    process.env[envName] = token.slice(eq + 1);
    argv.splice(i, 1);
    i--;
  } else if (argv[i + 1]) {
    process.env[envName] = argv[i + 1];
    argv.splice(i, 2);
    i--;
  }
}

if (argv.length === 0) {
  // MCP mode: stdout belongs to the JSON-RPC transport from here on
  const { runServer } = await import('./index.js');
  await runServer();
} else {
  const { runCli } = await import('./cli/run.js');
  await runCli(argv);
}

export {};
