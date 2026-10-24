/**
 * Where the pipe broker keeps its socket and log. Override the socket with TV_PIPE_SOCKET.
 * Unix sockets live in a 0700 directory and are chmod 0600, so only this user can connect.
 *
 * Windows named pipes share one machine-wide namespace, and Node creates them with a
 * DACL that lets Everyone read. So on Windows the broker picks a random pipe name per
 * run and records it, with an auth token, in pipe.json inside the user's private
 * LOCALAPPDATA folder. Other users can neither predict the name nor talk to the broker.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function stateDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'tradingview-mcp');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || homedir(), 'tradingview-mcp');
  return join(process.env.XDG_RUNTIME_DIR || join(homedir(), '.cache'), 'tradingview-mcp');
}

export function pipeInfoPath() {
  return join(stateDir(), 'pipe.json');
}

/** @returns {{ socket: string, token: string, pid: number } | null} */
export function readPipeInfo() {
  try {
    const info = JSON.parse(readFileSync(pipeInfoPath(), 'utf8'));
    return typeof info?.socket === 'string' ? info : null;
  } catch {
    return null;
  }
}

export function writePipeInfo(info) {
  writeFileSync(pipeInfoPath(), JSON.stringify(info), { mode: 0o600 });
}

/** Remove pipe.json, but only if it still describes the broker with this pid. */
export function clearPipeInfo(pid) {
  if (readPipeInfo()?.pid === pid) rmSync(pipeInfoPath(), { force: true });
}

export function newWindowsPipeName() {
  return `\\\\.\\pipe\\tradingview-mcp-${randomBytes(16).toString('hex')}`;
}

export function newAuthToken() {
  return randomBytes(32).toString('hex');
}

/** The token a client must present to the broker on socketPath, if that broker requires one. */
export function pipeAuthToken(socketPath) {
  const info = readPipeInfo();
  return info && info.socket === socketPath ? info.token : undefined;
}

/**
 * The socket clients connect to. On Windows this is the running broker's pipe from
 * pipe.json, or null when no broker has started.
 */
export function defaultSocketPath() {
  if (process.env.TV_PIPE_SOCKET) return process.env.TV_PIPE_SOCKET;
  if (process.platform === 'win32') return readPipeInfo()?.socket || null;
  return join(stateDir(), 'cdp.sock');
}

export function brokerLogPath() {
  return join(stateDir(), 'broker.log');
}
