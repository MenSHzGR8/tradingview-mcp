import { z } from 'zod';
import { jsonResult } from './_format.js';
import { booleanParam } from './_schema.js';
import * as core from '../core/pine.js';

const allowTitleMismatch = () => booleanParam().optional().describe(
  'Save even though the editor is bound to a saved script whose name differs from the indicator()/strategy()/library() title in the source (default false: refuse, since that would overwrite the other script)',
);

export function registerPineTools(server) {
  server.tool('pine_get_source', 'Get current Pine Script source code from the editor', {}, async () => {
    try { return jsonResult(await core.getSource()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_set_source', 'Set Pine Script source code in the editor', {
    source: z.string().describe('Pine Script source code to inject'),
  }, async ({ source }) => {
    try { return jsonResult(await core.setSource({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_compile', 'Compile / add the current Pine Script to the chart. May save the script; refuses if that would overwrite a different saved script.', {
    allow_title_mismatch: allowTitleMismatch(),
  }, async ({ allow_title_mismatch }) => {
    try { return jsonResult(await core.compile({ allowTitleMismatch: allow_title_mismatch === true })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {}, async () => {
    try { return jsonResult(await core.getErrors()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_save', 'Save the current Pine Script (Ctrl+S). Refuses if that would overwrite a different saved script.', {
    allow_title_mismatch: allowTitleMismatch(),
  }, async ({ allow_title_mismatch }) => {
    try { return jsonResult(await core.save({ allowTitleMismatch: allow_title_mismatch === true })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_console', 'Read Pine Script console/log output (compile messages, log.info(), errors)', {}, async () => {
    try { return jsonResult(await core.getConsole()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_smart_compile', 'Intelligent compile: detects button, compiles, checks errors, reports study changes. May save; refuses if that would overwrite a different saved script.', {
    allow_title_mismatch: allowTitleMismatch(),
  }, async ({ allow_title_mismatch }) => {
    try { return jsonResult(await core.smartCompile({ allowTitleMismatch: allow_title_mismatch === true })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_new', 'Create a new, unsaved Pine Script via the editor\'s "Create new" menu. Fails (and writes nothing) rather than reusing the open script.', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create'),
  }, async ({ type }) => {
    try { return jsonResult(await core.newScript({ type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_open', 'Open a saved Pine Script by name', {
    name: z.string().describe('Name of the saved script to open (case-insensitive match)'),
  }, async ({ name }) => {
    try { return jsonResult(await core.openScript({ name })); }
    catch (err) { return jsonResult({ success: false, source: 'internal_api', error: err.message }, true); }
  });

  server.tool('pine_list_scripts', 'List saved Pine Scripts', {}, async () => {
    try { return jsonResult(await core.listScripts()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_analyze', 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
  }, async ({ source }) => {
    try { return jsonResult(core.analyze({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_check', 'Compile Pine Script via TradingView\'s server API without needing the chart open. Returns compilation errors/warnings. Useful for validating code before injecting into the chart.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
  }, async ({ source }) => {
    try { return jsonResult(await core.check({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
