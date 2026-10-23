/**
 * Where the pipe broker keeps its socket and log. Override the socket with TV_PIPE_SOCKET.
 * Unix sockets live in a 0700 directory and are chmod 0600, so only this user can connect.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export function stateDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'tradingview-mcp');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || homedir(), 'tradingview-mcp');
  return join(process.env.XDG_RUNTIME_DIR || join(homedir(), '.cache'), 'tradingview-mcp');
}

export function defaultSocketPath() {
  if (process.env.TV_PIPE_SOCKET) return process.env.TV_PIPE_SOCKET;
  if (process.platform === 'win32') return '\\\\.\\pipe\\tradingview-mcp-cdp';
  return join(stateDir(), 'cdp.sock');
}

export function brokerLogPath() {
  return join(stateDir(), 'broker.log');
}
