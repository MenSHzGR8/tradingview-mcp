/**
 * Client for the pipe broker. Target clients expose the same shape the tools
 * already use from chrome-remote-interface: client.Runtime.evaluate(params),
 * client.Page.captureScreenshot(params), client.Input.dispatchKeyEvent(...), client.close().
 */
import net from 'node:net';
import { createFrameReader, encodeFrame } from './framing.js';
import { defaultSocketPath, pipeAuthToken } from './paths.js';

const DOMAINS = ['Runtime', 'Page', 'DOM', 'Input', 'Emulation', 'Network', 'Target', 'Browser', 'Log'];
const COMMAND_TIMEOUT_MS = 60_000;

/**
 * @param {string | null} [socketPath] null when no broker has recorded its pipe (Windows)
 * @param {{ token?: string }} [opts] auth token; defaults to the one recorded for socketPath
 * @returns {Promise<{ send: (method: string, params?: object, sessionId?: string) => Promise<any>, close: () => void, isClosed: boolean }>}
 */
export async function connectBroker(socketPath = defaultSocketPath(), { token = pipeAuthToken(socketPath) } = {}) {
  if (!socketPath) {
    throw new Error('TradingView pipe broker not reachable (no broker has started). Start it with the tv_launch tool.');
  }
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', (err) => reject(new Error(
      `TradingView pipe broker not reachable at ${socketPath} (${err.code || err.message}). Start it with the tv_launch tool.`,
    )));
  });
  if (token) socket.write(encodeFrame({ auth: token }));

  const pending = new Map();
  let nextId = 1;
  let isClosed = false;

  const failAll = (reason) => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(reason)); }
    pending.clear();
  };

  socket.on('data', createFrameReader((msg) => {
    const entry = pending.get(msg.id);
    if (!entry) return; // events are not used by the tools
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error.message || 'CDP error'));
    else entry.resolve(msg.result ?? {});
  }));
  socket.on('error', () => {});
  socket.on('close', () => { isClosed = true; failAll('Pipe broker connection closed'); });

  function send(method, params = {}, sessionId) {
    if (isClosed) return Promise.reject(new Error('Pipe broker connection closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      socket.write(encodeFrame({ id, method, params, ...(sessionId && { sessionId }) }));
    });
  }

  return {
    send,
    close: () => socket.end(),
    get isClosed() { return isClosed; },
  };
}

/** Same fields as the HTTP /json/list entries the tools filter on. */
export async function listPipeTargets(broker) {
  const { targetInfos = [] } = await broker.send('Target.getTargets');
  return targetInfos.map((t) => ({ id: t.targetId, type: t.type, title: t.title, url: t.url }));
}

export async function attachPipeTarget(broker, targetId) {
  const { sessionId } = await broker.send('Target.attachToTarget', { targetId, flatten: true });
  const client = {
    sessionId,
    async close() {
      try { await broker.send('Target.detachFromTarget', { sessionId }); } catch { /* target or broker gone */ }
    },
  };
  for (const domain of DOMAINS) {
    client[domain] = new Proxy({}, {
      get: (_, method) => (typeof method === 'string' && method !== 'then'
        ? (params = {}) => broker.send(`${domain}.${method}`, params, sessionId)
        : undefined),
    });
  }
  return client;
}
