/**
 * Regression tests for:
 *  #477 ui_mouse_click sent left clicks as "no button pressed" (buttons: 0)
 *  #476 ui_evaluate returned {} for async expressions (promise not awaited)
 *  #553 tab_new clicked the new-tab wrapper div instead of its button
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mouseButtonMask, mouseClick, uiEvaluate } from '../src/core/ui.js';
import { NEW_TAB_BUTTON_CLICK } from '../src/core/tab.js';

function recordingClient() {
  const events = [];
  return { events, client: { Input: { dispatchMouseEvent: async (e) => { events.push(e); } } } };
}

describe('mouse clicks (#477)', () => {
  it('uses the CDP button bitmask: left=1, right=2, middle=4', () => {
    assert.equal(mouseButtonMask('left'), 1);
    assert.equal(mouseButtonMask('right'), 2);
    assert.equal(mouseButtonMask('middle'), 4);
    assert.equal(mouseButtonMask('bogus'), 1);
  });

  it('presses the left button with buttons=1 and releases with buttons=0', async () => {
    const { events, client } = recordingClient();
    await mouseClick({ x: 10, y: 20, _deps: { getClient: async () => client } });
    const pressed = events.find((e) => e.type === 'mousePressed');
    const released = events.find((e) => e.type === 'mouseReleased');
    assert.deepEqual([pressed.button, pressed.buttons, pressed.clickCount], ['left', 1, 1]);
    assert.deepEqual([released.button, released.buttons, released.clickCount], ['left', 0, 1]);
  });

  it('marks the second press and release of a double click with clickCount 2', async () => {
    const { events, client } = recordingClient();
    await mouseClick({ x: 1, y: 1, button: 'right', double_click: true, _deps: { getClient: async () => client } });
    const second = events.filter((e) => e.clickCount === 2);
    assert.deepEqual(second.map((e) => [e.type, e.buttons]), [['mousePressed', 2], ['mouseReleased', 0]]);
  });
});

describe('ui_evaluate (#476)', () => {
  it('asks CDP to await promises so async results come back', async () => {
    let seenOpts;
    const evaluate = async (expr, opts) => { seenOpts = opts; return opts?.awaitPromise ? 42 : {}; };
    const out = await uiEvaluate({ expression: '(async () => 42)()', _deps: { evaluate } });
    assert.equal(seenOpts.awaitPromise, true);
    assert.deepEqual(out, { success: true, result: 42 });
  });
});

describe('tab_new button click (#553)', () => {
  // Minimal stand-in for the Desktop shell DOM, wrapper div first in document order.
  function shellDom({ withButtonClass = true, withAria = true } = {}) {
    const clicks = [];
    const button = { tagName: 'BUTTON', click: () => clicks.push('button') };
    const wrapper = { tagName: 'DIV', click: () => clicks.push('wrapper'), querySelector: (sel) => (sel === 'button' ? button : null) };
    const document = {
      querySelector: (sel) => {
        if (sel === 'button.create-new-tab-button') return withButtonClass ? button : null;
        if (sel === 'button[aria-label="New tab"]') return withAria ? button : null;
        if (sel === '[class*="create-new-tab"]') return wrapper;
        return null;
      },
    };
    const run = () => new Function('doc', `return (${NEW_TAB_BUTTON_CLICK})(doc)`)(document);
    return { clicks, run };
  }

  it('clicks the button, not the wrapper div that matches first', () => {
    const dom = shellDom();
    assert.equal(dom.run(), true);
    assert.deepEqual(dom.clicks, ['button']);
  });

  it('falls back to the aria label, then to the button inside the wrapper', () => {
    const byAria = shellDom({ withButtonClass: false });
    byAria.run();
    assert.deepEqual(byAria.clicks, ['button']);
    const byWrapper = shellDom({ withButtonClass: false, withAria: false });
    byWrapper.run();
    assert.deepEqual(byWrapper.clicks, ['button']);
  });
});
