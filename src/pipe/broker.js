/**
 * Pipe broker: owns TradingView's --remote-debugging-pipe and shares it with
 * local clients (MCP servers, CLI) over a user-only Unix socket. No TCP port
 * is opened, so other users and other machines cannot reach the debugger.
 *
 * Each client gets its own id space (ids are remapped) and only receives
 * events for the target sessions it attached itself. Sessions are detached
 * when their client disconnects.
 *
 * With an authToken (always on Windows, see paths.js), a client must send
 * { auth: token } as its first frame; until then it receives nothing and
 * anything else closes the connection.
 *
 * Run directly to launch TradingView under the broker:
 *   node src/pipe/broker.js [--socket <path>] [--tv <binary>]
 */
import net from 'node:net';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFrameReader, encodeFrame } from './framing.js';
import {
  clearPipeInfo, defaultSocketPath, newAuthToken, newWindowsPipeName, stateDir, writePipeInfo,
} from './paths.js';

const IS_WINDOWS = process.platform === 'win32';
const AUTH_TIMEOUT_MS = 5000;

/** Broker exit code when TradingView itself could not be started (e.g. EACCES in WindowsApps). */
export const EXIT_TV_SPAWN_FAILED = 3;

function tokenMatches(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function log(...args) {
  process.stderr.write(`[${new Date().toISOString()}] ${args.join(' ')}\n`);
}

function canConnect(socketPath) {
  return new Promise((resolve) => {
    const s = net.createConnection(socketPath);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function prepareSocketPath(socketPath) {
  if (IS_WINDOWS) return;
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(socketPath), 0o700);
  if (!existsSync(socketPath)) return;
  if (await canConnect(socketPath)) throw new Error(`A pipe broker is already running on ${socketPath}`);
  unlinkSync(socketPath); // stale socket from a crashed broker
}

/**
 * @param {object} opts
 * @param {import('node:stream').Writable} opts.toBrowser   browser's fd 3 (we write commands)
 * @param {import('node:stream').Readable} opts.fromBrowser browser's fd 4 (we read replies/events)
 * @param {string} opts.socketPath
 * @param {string} [opts.authToken] require clients to present this token first
 * @param {() => void} [opts.onBrowserGone]
 */
export async function createBroker({ toBrowser, fromBrowser, socketPath, authToken, onBrowserGone = () => {} }) {
  const clients = new Set();
  const inflight = new Map(); // broker id -> { client, id, method } (client null = broker's own call)
  const sessionOwner = new Map(); // sessionId -> client
  let nextId = 1;
  let isClosed = false;

  const sendToBrowser = (msg, client, originalId) => {
    const id = nextId++;
    inflight.set(id, { client, id: originalId, method: msg.method });
    toBrowser.write(encodeFrame({ ...msg, id }));
  };

  const releaseSession = (sessionId) => {
    const owner = sessionOwner.get(sessionId);
    sessionOwner.delete(sessionId);
    owner?.sessions.delete(sessionId);
    return owner;
  };

  const onBrowserMessage = (msg) => {
    if (typeof msg.id === 'number') {
      const entry = inflight.get(msg.id);
      if (!entry) return;
      inflight.delete(msg.id);
      const sessionId = msg.result?.sessionId;
      if (entry.method === 'Target.attachToTarget' && sessionId) {
        if (!entry.client || entry.client.isClosed) {
          sendToBrowser({ method: 'Target.detachFromTarget', params: { sessionId } }, null, null);
          return;
        }
        sessionOwner.set(sessionId, entry.client);
        entry.client.sessions.add(sessionId);
      }
      entry.client?.send({ ...msg, id: entry.id });
      return;
    }
    if (msg.method === 'Target.detachedFromTarget') {
      releaseSession(msg.params?.sessionId)?.send(msg);
      return;
    }
    if (msg.sessionId) {
      sessionOwner.get(msg.sessionId)?.send(msg);
      return;
    }
    for (const client of clients) client.send(msg);
  };

  const onClientMessage = (client, msg) => {
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') {
      client.send({ id: msg.id ?? null, error: { code: -32600, message: 'Invalid CDP request' } });
      return;
    }
    if (msg.sessionId && sessionOwner.get(msg.sessionId) !== client) {
      client.send({ id: msg.id, error: { code: -32001, message: `Session ${msg.sessionId} does not belong to this client` } });
      return;
    }
    sendToBrowser(msg, client, msg.id);
  };

  const onClientConnection = (socket) => {
    const client = {
      sessions: new Set(),
      isClosed: false,
      authed: !authToken,
      send: (msg) => { if (!client.isClosed && client.authed) socket.write(encodeFrame(msg)); },
      destroy: () => socket.destroy(),
    };
    let authTimer = null;
    if (client.authed) clients.add(client);
    else authTimer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
    socket.on('data', createFrameReader((msg) => {
      if (client.authed) return onClientMessage(client, msg);
      if (client.isClosed) return;
      if (!tokenMatches(msg?.auth, authToken)) {
        client.isClosed = true;
        socket.destroy();
        return;
      }
      clearTimeout(authTimer);
      client.authed = true;
      clients.add(client);
    }, (err) => log('client:', err.message)));
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(authTimer);
      client.isClosed = true;
      clients.delete(client);
      for (const sessionId of [...client.sessions]) {
        releaseSession(sessionId);
        if (!isClosed) sendToBrowser({ method: 'Target.detachFromTarget', params: { sessionId } }, null, null);
      }
    });
  };

  fromBrowser.on('data', createFrameReader(onBrowserMessage, (err) => log('browser:', err.message)));

  await prepareSocketPath(socketPath);
  const server = net.createServer(onClientConnection);
  await new Promise((resolve, reject) => {
    // Windows has no socket file to probe in prepareSocketPath; the pipe name itself is taken.
    server.once('error', (err) => reject(err.code === 'EADDRINUSE'
      ? new Error(`A pipe broker is already running on ${socketPath}`)
      : err));
    server.listen(socketPath, resolve);
  });
  if (!IS_WINDOWS) chmodSync(socketPath, 0o600);
  const socketInode = IS_WINDOWS ? null : statSync(socketPath).ino;

  function close() {
    if (isClosed) return;
    isClosed = true;
    server.close();
    for (const client of clients) {
      client.isClosed = true;
      client.destroy();
    }
    // Only remove the socket file if it is still ours (a newer broker may have replaced it).
    try {
      if (!IS_WINDOWS && statSync(socketPath).ino === socketInode) unlinkSync(socketPath);
    } catch { /* already gone */ }
  }

  const onGone = () => {
    if (isClosed) return;
    close();
    onBrowserGone();
  };
  fromBrowser.on('end', onGone);
  fromBrowser.on('close', onGone);

  return {
    close,
    get clientCount() { return clients.size; },
    get sessionCount() { return sessionOwner.size; },
  };
}

function parseCli(argv) {
  const opts = { socketPath: null, tvPath: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--socket') opts.socketPath = argv[++i];
    else if (argv[i] === '--tv') opts.tvPath = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return opts;
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const { findTradingViewPath } = await import('../core/health.js');
  const tvPath = opts.tvPath || findTradingViewPath();
  const socketPath = opts.socketPath || (IS_WINDOWS ? newWindowsPipeName() : defaultSocketPath());
  const authToken = IS_WINDOWS ? newAuthToken() : undefined;

  const child = spawn(tvPath, ['--remote-debugging-pipe'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  child.on('error', (err) => { log('TradingView failed to start:', err.message); process.exit(EXIT_TV_SPAWN_FAILED); });

  const broker = await createBroker({
    toBrowser: child.stdio[3],
    fromBrowser: child.stdio[4],
    socketPath,
    authToken,
    onBrowserGone: () => { log('TradingView exited; broker stopping.'); clearPipeInfo(process.pid); process.exit(0); },
  });
  if (authToken) {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    writePipeInfo({ socket: socketPath, token: authToken, pid: process.pid });
  }
  log(`TradingView ${tvPath} (pid ${child.pid}) on pipe; broker listening on ${socketPath}`);

  const shutdown = () => { broker.close(); clearPipeInfo(process.pid); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { log(err.message); process.exit(1); });
}
