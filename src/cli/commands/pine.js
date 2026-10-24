import { register } from '../router.js';
import * as core from '../../core/pine.js';
import { readFileSync } from 'fs';
import { decodeSource, stdinSourceWarning } from '../source_input.js';

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return decodeSource(Buffer.concat(chunks));
}

// Run fn with source from --file or stdin; attach a warning if stdin may have lost characters.
async function withSource(opts, fn) {
  const source = opts.file ? decodeSource(readFileSync(opts.file)) : await readStdin();
  if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
  const warning = opts.file ? null : stdinSourceWarning(source);
  if (warning) process.stderr.write(`Warning: ${warning}\n`);
  const result = await fn(source);
  return warning ? { ...result, warning } : result;
}

register('pine', {
  description: 'Pine Script tools',
  subcommands: new Map([
    ['get', {
      description: 'Get current Pine Script source from editor',
      handler: () => core.getSource(),
    }],
    ['set', {
      description: 'Set Pine Script source (reads stdin or --file)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: (opts) => withSource(opts, (source) => core.setSource({ source })),
    }],
    ['compile', {
      description: 'Smart compile: detect button, compile, check errors',
      options: {
        'allow-title-mismatch': { type: 'boolean', description: 'Save even if the editor script name differs from the source title' },
      },
      handler: (opts) => core.smartCompile({ allowTitleMismatch: !!opts['allow-title-mismatch'] }),
    }],
    ['raw-compile', {
      description: 'Click compile/add button without smart detection',
      options: {
        'allow-title-mismatch': { type: 'boolean', description: 'Save even if the editor script name differs from the source title' },
      },
      handler: (opts) => core.compile({ allowTitleMismatch: !!opts['allow-title-mismatch'] }),
    }],
    ['analyze', {
      description: 'Offline static analysis (no TradingView needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: (opts) => withSource(opts, (source) => core.analyze({ source })),
    }],
    ['check', {
      description: 'Server-side compile check (no chart needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: (opts) => withSource(opts, (source) => core.check({ source })),
    }],
    ['save', {
      description: 'Save the current Pine Script (Ctrl+S)',
      options: {
        'allow-title-mismatch': { type: 'boolean', description: 'Save even if the editor script name differs from the source title' },
      },
      handler: (opts) => core.save({ allowTitleMismatch: !!opts['allow-title-mismatch'] }),
    }],
    ['new', {
      description: 'Create a new blank Pine Script (indicator, strategy, library)',
      handler: (opts, positionals) => {
        const type = positionals[0] || 'indicator';
        return core.newScript({ type });
      },
    }],
    ['open', {
      description: 'Open a saved Pine Script by name',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Script name required. Usage: tv pine open "My Script"');
        return core.openScript({ name: positionals.join(' ') });
      },
    }],
    ['list', {
      description: 'List saved Pine Scripts',
      handler: () => core.listScripts(),
    }],
    ['errors', {
      description: 'Get Pine Script compilation errors',
      handler: () => core.getErrors(),
    }],
    ['console', {
      description: 'Get Pine Script console/log output',
      handler: () => core.getConsole(),
    }],
  ]),
});
