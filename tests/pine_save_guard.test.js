/**
 * Regression tests for:
 *  #395 pine_compile / pine_smart_compile / pine_save could save the source over a
 *       different saved script (e.g. after pine_set_source into the wrong script)
 *  #475 pine_new wrote its template into whatever script was open
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSaveTarget, getDeclaredTitle, newScript } from '../src/core/pine.js';

const SRC = (decl) => `//@version=6\n${decl}\nplot(close)`;

describe('getDeclaredTitle', () => {
  it('reads indicator/strategy/library titles, positional or named', () => {
    assert.equal(getDeclaredTitle(SRC('indicator("Unicorn Model", overlay=true)')), 'Unicorn Model');
    assert.equal(getDeclaredTitle(SRC("strategy(title='ORB', overlay=true)")), 'ORB');
    assert.equal(getDeclaredTitle(SRC('library("TTFMLib")')), 'TTFMLib');
  });

  it('returns null when there is no declaration', () => {
    assert.equal(getDeclaredTitle('plot(close)'), null);
    assert.equal(getDeclaredTitle(undefined), null);
  });
});

describe('checkSaveTarget (#395)', () => {
  const bound = (title, decl) => ({ title, modelUri: 'inmemory://1', source: SRC(decl) });

  it('blocks saving another script\'s source over a saved script', () => {
    const problem = checkSaveTarget(bound('Unicorn Model', 'indicator("My script")'));
    assert.match(problem, /Refusing to save.*"Unicorn Model".*"My script"/);
  });

  it('allows saving a script over itself', () => {
    assert.equal(checkSaveTarget(bound('Unicorn Model', 'indicator("Unicorn Model", overlay=true)')), null);
  });

  it('always allows untitled scripts', () => {
    assert.equal(checkSaveTarget(bound('Untitled script', 'indicator("Anything")')), null);
  });

  it('allows a source with no declaration (nothing to compare)', () => {
    assert.equal(checkSaveTarget({ title: 'Lib', source: 'plot(close)' }), null);
  });

  it('honours the explicit override', () => {
    assert.equal(checkSaveTarget(bound('Unicorn Model', 'indicator("Other")'), { allowTitleMismatch: true }), null);
  });

  it('refuses when the editor identity cannot be read', () => {
    assert.match(checkSaveTarget(null), /refusing to save/);
  });
});

describe('newScript (#475)', () => {
  it('rejects an unknown type before touching TradingView', async () => {
    await assert.rejects(newScript({ type: 'widget' }), /Unknown script type "widget"/);
  });
});
