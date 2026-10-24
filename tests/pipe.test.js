/**
 * Tests for the pipe transport: NUL framing, the broker's id remapping and
 * session ownership, and the broker client. A fake browser stands in for
 * TradingView's --remote-debugging-pipe.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFrameReader, encodeFrame } from '../src/pipe/framing.js';
import { createBroker } from '../src/pipe/broker.js';
import { connectBroker, listPipeTargets, attachPipeTarget } from '../src/pipe/client.js';

const TARGETS = [
  { targetId: 'T1', type: 'page', title: 'NQ chart', url: 'https://www.tradingview.com/chart/abc/' },
  { targetId: 'T2', type: 'page', title: 'shell', url: 'file:///app/window/index.html' },
];

function fakeBrowser() {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const received = [];
  const reply = (msg) => fromBrowser.write(encodeFrame(msg));
  toBrowser.on('data', createFrameReader((msg) => {
    received.push(msg);
    switch (msg.method) {
      case 'Target.getTargets': return reply({ id: msg.id, result: { targetInfos: TARGETS } });
      case 'Target.attachToTarget': return reply({ id: msg.id, result: { sessionId: `S-${msg.params.targetId}` } });
      case 'Target.detachFromTarget': return reply({ id: msg.id, result: {} });
      case 'Runtime.evaluate':
        return reply({ id: msg.id, sessionId: msg.sessionId, result: { result: { type: 'string', value: `${msg.sessionId}:${msg.params.expression}` } } });
      default: return reply({ id: msg.id, error: { code: -32601, message: `'${msg.method}' wasn't found` } });
    }
  }));
  return { toBrowser, fromBrowser, received, reply };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

// Close events arrive later on Windows named pipes (~50-150 ms) than on Unix sockets.
async function waitFor(cond, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!cond() && Date.now() < end) await tick();
}

// Windows has no socket files: brokers listen on named pipes instead.
const sockPath = (dir, name) => (process.platform === 'win32'
  ? `\\\\.\\pipe\\tvp-test-${process.pid}-${Math.random().toString(36).slice(2)}-${name}`
  : join(dir, name));

describe('framing', () => {
  it('reassembles messages split across chunks and splits joined ones', () => {
    const out = [];
    const feed = createFrameReader((m) => out.push(m));
    const a = encodeFrame({ id: 1, method: 'X' });
    const b = encodeFrame({ id: 2, method: 'Y' });
    feed(a.subarray(0, 5));
    feed(Buffer.concat([a.subarray(5), b]));
    assert.deepEqual(out, [{ id: 1, method: 'X' }, { id: 2, method: 'Y' }]);
  });

  it('reports invalid JSON frames without stopping', () => {
    const out = [];
    const errors = [];
    const feed = createFrameReader((m) => out.push(m), (e) => errors.push(e.message));
    feed(Buffer.concat([Buffer.from('{bad\0'), encodeFrame({ ok: true })]));
    assert.equal(errors.length, 1);
    assert.deepEqual(out, [{ ok: true }]);
  });
});

describe('pipe broker', () => {
  let dir;
  let socketPath;
  let browser;
  let broker;
  let gone;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tvp-'));
    socketPath = sockPath(dir, 'cdp.sock');
    browser = fakeBrowser();
    gone = 0;
    broker = await createBroker({ ...browser, socketPath, onBrowserGone: () => { gone++; } });
  });

  afterEach(() => {
    broker.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a user-only (0600) socket', { skip: process.platform === 'win32' }, () => {
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  });

  it('lists targets in the /json/list shape', async () => {
    const conn = await connectBroker(socketPath);
    const targets = await listPipeTargets(conn);
    assert.deepEqual(targets[0], { id: 'T1', type: 'page', title: 'NQ chart', url: 'https://www.tradingview.com/chart/abc/' });
    conn.close();
  });

  it('routes evaluate through the attached session with chrome-remote-interface result shape', async () => {
    const conn = await connectBroker(socketPath);
    const client = await attachPipeTarget(conn, 'T1');
    const res = await client.Runtime.evaluate({ expression: '1+1', returnByValue: true });
    assert.equal(res.result.value, 'S-T1:1+1');
    conn.close();
  });

  it('keeps two clients apart even when they use the same request ids', async () => {
    const a = await connectBroker(socketPath);
    const b = await connectBroker(socketPath);
    const [ca, cb] = await Promise.all([attachPipeTarget(a, 'T1'), attachPipeTarget(b, 'T2')]);
    const [ra, rb] = await Promise.all([ca.Runtime.evaluate({ expression: 'a' }), cb.Runtime.evaluate({ expression: 'b' })]);
    assert.equal(ra.result.value, 'S-T1:a');
    assert.equal(rb.result.value, 'S-T2:b');
    const ids = browser.received.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, 'broker ids must be unique on the pipe');
    a.close();
    b.close();
  });

  it('refuses commands on a session owned by another client', async () => {
    const a = await connectBroker(socketPath);
    const b = await connectBroker(socketPath);
    const ca = await attachPipeTarget(a, 'T1');
    await assert.rejects(b.send('Runtime.evaluate', { expression: 'steal' }, ca.sessionId), /does not belong to this client/);
    a.close();
    b.close();
  });

  it('surfaces CDP errors as rejections', async () => {
    const conn = await connectBroker(socketPath);
    await assert.rejects(conn.send('Nope.nothing'), /wasn't found/);
    conn.close();
  });

  it('detaches a client\'s sessions when it disconnects', async () => {
    const conn = await connectBroker(socketPath);
    await attachPipeTarget(conn, 'T1');
    assert.equal(broker.sessionCount, 1);
    conn.close();
    await waitFor(() => broker.sessionCount === 0);
    assert.equal(broker.sessionCount, 0);
    assert.ok(browser.received.some((m) => m.method === 'Target.detachFromTarget' && m.params.sessionId === 'S-T1'));
  });

  it('client.close() detaches only that session', async () => {
    const conn = await connectBroker(socketPath);
    const c1 = await attachPipeTarget(conn, 'T1');
    await attachPipeTarget(conn, 'T2');
    await c1.close();
    assert.equal(broker.sessionCount, 2, 'ownership is released on detachedFromTarget events, not on the reply');
    browser.reply({ method: 'Target.detachedFromTarget', params: { sessionId: 'S-T1' } });
    await tick();
    assert.equal(broker.sessionCount, 1);
    conn.close();
  });

  it('stops and removes its socket when the browser pipe closes', async () => {
    const conn = await connectBroker(socketPath);
    browser.fromBrowser.end();
    await waitFor(() => gone === 1);
    assert.equal(gone, 1);
    assert.equal(existsSync(socketPath), false);
    await assert.rejects(conn.send('Target.getTargets'), /closed/);
  });

  it('refuses to start a second broker on a live socket', async () => {
    await assert.rejects(createBroker({ ...fakeBrowser(), socketPath }), /already running/);
  });

  it('replaces a stale socket file left by a crashed broker', { skip: process.platform === 'win32' }, async () => {
    const stalePath = join(dir, 'stale.sock');
    writeFileSync(stalePath, '');
    const second = await createBroker({ ...fakeBrowser(), socketPath: stalePath });
    const conn = await connectBroker(stalePath);
    assert.equal((await listPipeTargets(conn)).length, 2);
    conn.close();
    second.close();
  });

  it('gives a clear error when no broker is running', async () => {
    await assert.rejects(connectBroker(sockPath(dir, 'missing.sock')), /pipe broker not reachable.*tv_launch/);
  });

  it('gives a clear error when no broker has recorded a pipe', async () => {
    await assert.rejects(connectBroker(null), /pipe broker not reachable.*tv_launch/);
  });

  it('rejects malformed requests without forwarding them', async () => {
    const raw = net.createConnection(socketPath);
    await new Promise((r) => raw.once('connect', r));
    const replies = [];
    raw.on('data', createFrameReader((m) => replies.push(m)));
    raw.write(encodeFrame({ method: 'Runtime.evaluate' }));
    await tick();
    assert.equal(replies[0].error.code, -32600);
    assert.equal(browser.received.length, 0);
    raw.destroy();
  });
});

describe('pipe broker with an auth token', () => {
  const TOKEN = 'a'.repeat(64);
  let dir;
  let socketPath;
  let browser;
  let broker;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tvp-'));
    socketPath = sockPath(dir, 'auth.sock');
    browser = fakeBrowser();
    broker = await createBroker({ ...browser, socketPath, authToken: TOKEN });
  });

  afterEach(() => {
    broker.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function rawClient() {
    const raw = net.createConnection(socketPath);
    await new Promise((r) => raw.once('connect', r));
    const replies = [];
    let closed = false;
    raw.on('data', createFrameReader((m) => replies.push(m)));
    raw.on('error', () => {});
    raw.on('close', () => { closed = true; });
    return { raw, replies, isClosed: () => closed };
  }

  it('serves a client that presents the token', async () => {
    const conn = await connectBroker(socketPath, { token: TOKEN });
    assert.equal((await listPipeTargets(conn)).length, 2);
    conn.close();
  });

  it('drops a client with the wrong token without forwarding anything', async () => {
    const c = await rawClient();
    c.raw.write(encodeFrame({ auth: 'b'.repeat(64) }));
    c.raw.write(encodeFrame({ id: 1, method: 'Target.getTargets' }));
    await waitFor(c.isClosed);
    assert.equal(c.isClosed(), true);
    assert.equal(browser.received.length, 0);
    assert.deepEqual(c.replies, []);
  });

  it('drops a client whose first frame is a command', async () => {
    const c = await rawClient();
    c.raw.write(encodeFrame({ id: 1, method: 'Target.getTargets' }));
    await waitFor(c.isClosed);
    assert.equal(c.isClosed(), true);
    assert.equal(browser.received.length, 0);
  });

  it('sends broadcast events only to authenticated clients', async () => {
    const anon = await rawClient();
    const authed = await rawClient();
    authed.raw.write(encodeFrame({ auth: TOKEN }));
    await waitFor(() => broker.clientCount === 1);
    browser.reply({ method: 'Target.targetCreated', params: { targetInfo: TARGETS[0] } });
    await waitFor(() => authed.replies.length === 1);
    assert.equal(authed.replies[0].method, 'Target.targetCreated');
    assert.deepEqual(anon.replies, []);
    anon.raw.destroy();
    authed.raw.destroy();
  });
});
