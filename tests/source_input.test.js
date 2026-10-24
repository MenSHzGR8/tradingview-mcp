/**
 * Pine source decoding for the CLI (stdin / --file), including the encodings
 * Windows tools produce and the lossy-PowerShell-pipe warning.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSource, hasQuestionMarkInText, stdinSourceWarning } from '../src/cli/source_input.js';

const SRC = '//@version=6\nindicator("test ✓ é ®")\nplot(close)\n';

describe('decodeSource', () => {
  it('decodes plain UTF-8', () => {
    assert.equal(decodeSource(Buffer.from(SRC, 'utf8')), SRC);
  });

  it('strips a UTF-8 BOM', () => {
    assert.equal(decodeSource(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(SRC, 'utf8')])), SRC);
  });

  it('decodes UTF-16LE with BOM (PowerShell 5.1 Out-File)', () => {
    assert.equal(decodeSource(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(SRC, 'utf16le')])), SRC);
  });

  it('decodes UTF-16BE with BOM', () => {
    const be = Buffer.from(SRC, 'utf16le').swap16();
    assert.equal(decodeSource(Buffer.concat([Buffer.from([0xFE, 0xFF]), be])), SRC);
  });

  it('falls back to Windows-1252 for invalid UTF-8 (Set-Content default)', () => {
    const ansi = Buffer.from('// caf\xe9 \xae\nplot(close)\n', 'latin1');
    assert.equal(decodeSource(ansi), '// café ®\nplot(close)\n');
  });
});

describe('lossy stdin detection', () => {
  it('ignores the ternary operator', () => {
    assert.equal(hasQuestionMarkInText('x = a > b ? 1 : 2\ny = c?d:e\n'), false);
  });

  it("flags '?' inside a string literal", () => {
    assert.equal(hasQuestionMarkInText('indicator("pipe test ?")\n'), true);
    assert.equal(hasQuestionMarkInText("label.new(bar_index, high, 'Bias ?')\n"), true);
  });

  it("flags '?' inside a comment", () => {
    assert.equal(hasQuestionMarkInText('// This Pine Script? code\nplot(close)\n'), true);
  });

  it('handles escaped quotes inside strings', () => {
    assert.equal(hasQuestionMarkInText('s = "say \\"hi\\"" + (a ? "x" : "y")\n'), false);
  });

  it('warns only on Windows', () => {
    const lossy = 'indicator("test ? ? ?")\n';
    assert.match(stdinSourceWarning(lossy, 'win32'), /OutputEncoding/);
    assert.equal(stdinSourceWarning(lossy, 'darwin'), null);
    assert.equal(stdinSourceWarning(SRC, 'win32'), null);
  });
});
