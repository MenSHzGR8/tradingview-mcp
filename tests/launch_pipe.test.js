/**
 * Pipe-mode tv_launch: when a pipe broker already answers (for example the Awesome Charts app),
 * join it instead of killing TradingView, even with kill_existing left at its default.
 * CDP_TRANSPORT is read at import time, so pipe mode is set before importing health.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TV_CDP_TRANSPORT = 'pipe';
const { launch } = await import('../src/core/health.js');

function deps({ brokerAnswers }) {
  const calls = { exec: [], spawn: 0 };
  return {
    calls,
    _deps: {
      probePipe: async () => (brokerAnswers ? { product: 'Chrome/146.0.0.0', userAgent: 'TVDesktop/3.4.1' } : null),
      execSync: (cmd) => { calls.exec.push(cmd); return Buffer.from(''); },
      spawn: () => { calls.spawn++; return { pid: 1, unref() {}, on() {}, off() {} }; },
      existsSync: () => true,
      delay: async () => {},
    },
  };
}

test('pipe launch joins a running broker even with kill_existing default', async () => {
  const { calls, _deps } = deps({ brokerAnswers: true });
  const result = await launch({ _deps });
  assert.equal(result.already_running, true);
  assert.equal(result.transport, 'pipe');
  assert.equal(calls.exec.some((c) => /pkill|taskkill/.test(c)), false, 'must not kill TradingView');
  assert.equal(calls.spawn, 0, 'must not spawn a second broker');
});
