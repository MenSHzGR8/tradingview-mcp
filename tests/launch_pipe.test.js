/**
 * Pipe-mode tv_launch: when a pipe broker already answers (for example the Awesome Charts app),
 * join it instead of killing TradingView, even with kill_existing left at its default.
 * On Windows, fall back to a local copy of the MSIX package when WindowsApps won't run it.
 * CDP_TRANSPORT is read at import time, so pipe mode is set before importing health.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TV_CDP_TRANSPORT = 'pipe';
const { launch } = await import('../src/core/health.js');
const { EXIT_TV_SPAWN_FAILED } = await import('../src/pipe/broker.js');

const WINDOWS_APPS_EXE = 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.4.1.8194_x64__abc\\TradingView.exe';

function fakeChild(exitCode = null) {
  const handlers = {};
  const child = {
    pid: 1,
    unref() {},
    on(ev, fn) { handlers[ev] = fn; if (ev === 'exit' && exitCode !== null) queueMicrotask(() => fn(exitCode)); return child; },
    off() {},
  };
  return child;
}

function deps({ brokerAnswers, exitCodes = [], answersAfterSpawns = Infinity, windowsApps = false }) {
  const calls = { exec: [], spawn: [], copied: [] };
  return {
    calls,
    _deps: {
      probePipe: async () => (brokerAnswers || calls.spawn.length >= answersAfterSpawns
        ? { product: 'Chrome/146.0.0.0', userAgent: 'TVDesktop/3.4.1' } : null),
      execSync: (cmd, opts) => {
        calls.exec.push({ cmd, opts });
        if (/Get-AppxPackage/.test(cmd)) return Buffer.from(WINDOWS_APPS_EXE.replace(/\\TradingView\.exe$/, ''));
        return Buffer.from('');
      },
      spawn: (exe, args) => { calls.spawn.push(args); return fakeChild(exitCodes[calls.spawn.length - 1] ?? null); },
      existsSync: (p) => (windowsApps ? /WindowsApps/.test(p) : true),
      cpSync: (src, dst) => { calls.copied.push(dst); },
      rmSync: () => {},
      readdirSync: () => [],
      delay: async () => {},
    },
  };
}

test('pipe launch joins a running broker even with kill_existing default', async () => {
  const { calls, _deps } = deps({ brokerAnswers: true });
  const result = await launch({ _deps });
  assert.equal(result.already_running, true);
  assert.equal(result.transport, 'pipe');
  assert.equal(calls.exec.some((c) => /pkill|taskkill/.test(c.cmd)), false, 'must not kill TradingView');
  assert.equal(calls.spawn.length, 0, 'must not spawn a second broker');
});

test('pipe launch kills TradingView quietly (no stderr noise when it is not running)', async () => {
  const { calls, _deps } = deps({ brokerAnswers: false, answersAfterSpawns: 1 });
  const result = await launch({ _deps });
  assert.equal(result.success, true);
  const kill = calls.exec.find((c) => /pkill|taskkill/.test(c.cmd));
  assert.equal(kill.opts.stdio, 'ignore');
});

test('pipe launch reports a broker that exits before TradingView answers', async () => {
  const { _deps } = deps({ brokerAnswers: false, exitCodes: [1] });
  const result = await launch({ _deps });
  assert.equal(result.success, false);
  assert.equal(result.broker_exit_code, 1);
  assert.match(result.error, /broker exited/);
});

test('on Windows the broker picks its own pipe name (no --socket)', { skip: process.platform !== 'win32' }, async () => {
  const saved = process.env.TV_PIPE_SOCKET;
  delete process.env.TV_PIPE_SOCKET;
  try {
    const { calls, _deps } = deps({ brokerAnswers: false, answersAfterSpawns: 1 });
    await launch({ _deps });
    assert.equal(calls.spawn[0].includes('--socket'), false);
  } finally {
    if (saved !== undefined) process.env.TV_PIPE_SOCKET = saved;
  }
});

test('pipe launch falls back to a local MSIX copy when WindowsApps refuses to run', { skip: process.platform !== 'win32' }, async () => {
  const { calls, _deps } = deps({ brokerAnswers: false, windowsApps: true, exitCodes: [EXIT_TV_SPAWN_FAILED], answersAfterSpawns: 2 });
  const result = await launch({ _deps });
  assert.equal(result.success, true);
  assert.equal(result.msix_local_copy, true);
  assert.equal(calls.spawn.length, 2);
  assert.match(calls.spawn[0].at(-1), /WindowsApps/);
  assert.doesNotMatch(calls.spawn[1].at(-1), /WindowsApps/);
  assert.match(calls.copied[0], /tradingview-mcp/);
});
