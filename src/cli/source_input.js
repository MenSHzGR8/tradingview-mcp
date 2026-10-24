/**
 * Decoding Pine source handed to the CLI via stdin or --file.
 *
 * Windows tools rarely produce plain UTF-8: PowerShell 5.1's Out-File writes
 * UTF-16LE with a BOM, Set-Content writes the ANSI code page, and piping to a
 * native program re-encodes text with $OutputEncoding (ASCII by default), which
 * turns every non-ASCII character into '?' before we ever see it.
 */

const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf16le = new TextDecoder('utf-16le');
const cp1252 = new TextDecoder('windows-1252');

/** Decode source bytes: honor a UTF-8/UTF-16 BOM, else UTF-8, else Windows-1252. */
export function decodeSource(buf) {
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xFF && buf[1] === 0xFE) return utf16le.decode(buf.subarray(2));
  if (buf[0] === 0xFE && buf[1] === 0xFF) return utf16le.decode(Buffer.from(buf.subarray(2)).swap16());
  try {
    return utf8.decode(buf);
  } catch {
    return cp1252.decode(buf);
  }
}

/**
 * True if a '?' sits inside a string literal or comment. Identifiers and operators
 * are ASCII, so that is where characters lost to a lossy stdin pipe end up; the
 * ternary operator's '?' is never inside either.
 */
export function hasQuestionMarkInText(source) {
  for (const line of source.split('\n')) {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        else if (ch === '?') return true;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '/' && line[i + 1] === '/') {
        if (line.includes('?', i)) return true;
        break;
      }
    }
  }
  return false;
}

export const LOSSY_STDIN_WARNING =
  "Source from stdin has '?' inside strings or comments. Windows PowerShell 5.1 pipes text as ASCII and " +
  "replaces non-ASCII characters with '?'. If that happened, use --file, or run " +
  '$OutputEncoding = [System.Text.UTF8Encoding]::new() before piping.';

/** Warning for source read from stdin, or null. */
export function stdinSourceWarning(source, platform = process.platform) {
  return platform === 'win32' && hasQuestionMarkInText(source) ? LOSSY_STDIN_WARNING : null;
}
