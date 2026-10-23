/**
 * Message framing used by Chromium's --remote-debugging-pipe: each CDP message
 * is a JSON document terminated by a NUL byte. The broker socket uses the same
 * framing so messages can be relayed without re-encoding.
 */

/**
 * @param {(msg: object) => void} onMessage
 * @param {(err: Error) => void} [onError]
 * @returns {(chunk: Buffer) => void} feed function for 'data' events
 */
export function createFrameReader(onMessage, onError = () => {}) {
  let pending = [];
  return (chunk) => {
    let start = 0;
    let end;
    while ((end = chunk.indexOf(0, start)) !== -1) {
      pending.push(chunk.subarray(start, end));
      const raw = Buffer.concat(pending).toString('utf8');
      pending = [];
      start = end + 1;
      if (!raw) continue;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (err) {
        onError(new Error(`Invalid CDP frame: ${err.message}`));
        continue;
      }
      onMessage(msg);
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  };
}

/** @param {object} msg */
export function encodeFrame(msg) {
  return Buffer.from(`${JSON.stringify(msg)}\0`, 'utf8');
}
