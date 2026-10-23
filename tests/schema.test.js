/**
 * Regression tests for issue #527: boolean tool parameters must read the string
 * "false" as false. z.coerce.boolean() used Boolean(value), so alert_delete with
 * delete_all: "false" deleted every alert.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { booleanParam } from '../src/tools/_schema.js';
import { registerAlertTools } from '../src/tools/alerts.js';
import { registerDataTools } from '../src/tools/data.js';
import { registerHealthTools } from '../src/tools/health.js';
import { registerIndicatorTools } from '../src/tools/indicators.js';
import { registerUiTools } from '../src/tools/ui.js';
import { deleteAlerts } from '../src/core/alerts.js';

// Collect each tool's parameter shape the way the MCP server receives it.
function collectSchemas() {
  const shapes = {};
  const server = { tool: (name, _desc, shape) => { shapes[name] = z.object(shape); } };
  [registerAlertTools, registerDataTools, registerHealthTools, registerIndicatorTools, registerUiTools].forEach((register) => register(server));
  return shapes;
}

const BOOLEAN_PARAMS = [
  ['alert_delete', 'delete_all'],
  ['tv_launch', 'kill_existing'],
  ['data_get_ohlcv', 'summary'],
  ['data_get_pine_lines', 'verbose'],
  ['data_get_pine_labels', 'verbose'],
  ['data_get_pine_boxes', 'verbose'],
  ['indicator_toggle_visibility', 'visible'],
  ['ui_mouse_click', 'double_click'],
];

describe('booleanParam', () => {
  const schema = booleanParam();

  it('keeps real booleans', () => {
    assert.equal(schema.parse(true), true);
    assert.equal(schema.parse(false), false);
  });

  it('reads the words true/false in any case and spacing', () => {
    assert.equal(schema.parse('false'), false);
    assert.equal(schema.parse(' FALSE '), false);
    assert.equal(schema.parse('True'), true);
  });

  it('rejects anything else instead of guessing', () => {
    for (const bad of ['0', '1', 'no', 'yes', '', 0, 1, null]) {
      assert.throws(() => schema.parse(bad), undefined, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('tool schemas (#527)', () => {
  const shapes = collectSchemas();

  for (const [tool, param] of BOOLEAN_PARAMS) {
    it(`${tool}.${param}: "false" parses to false`, () => {
      assert.ok(shapes[tool], `tool ${tool} not registered`);
      const base = tool === 'indicator_toggle_visibility' ? { entity_id: 'x' } : tool === 'ui_mouse_click' ? { x: 1, y: 1 } : {};
      assert.equal(shapes[tool].parse({ ...base, [param]: 'false' })[param], false);
      assert.equal(shapes[tool].parse({ ...base, [param]: 'true' })[param], true);
    });
  }

  it('alert_delete rejects an ambiguous delete_all value', () => {
    assert.throws(() => shapes.alert_delete.parse({ delete_all: '0' }));
  });
});

describe('deleteAlerts guard (#527)', () => {
  it('refuses a non-boolean delete_all before touching TradingView', async () => {
    await assert.rejects(deleteAlerts({ delete_all: 'false' }), /delete_all must be a boolean/);
  });
});
