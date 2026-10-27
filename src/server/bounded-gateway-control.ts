import { chmodSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { isBoundedGatewayTicket } from './bounded-gateway-protocol.js';

export type BoundedGatewayControlAction = 'stop' | 'roll';
const maximumMessageBytes = 1024;
export function boundedGatewayControlPath(directory: string, generation: string): string {
  if (!isBoundedGatewayTicket(generation)) throw new Error('BOUNDED_GATEWAY_INVALID_CONTROL_GENERATION');
  return join(directory, `control-${generation}.sock`);
}

/** Local same-UID control only, beneath the verified 0700 state directory. No HTTP/public route. */
export async function createBoundedGatewayControl(
  directory: string,
  generation: string,
  accept: (action: BoundedGatewayControlAction) => (() => void) | undefined,
  permissions: typeof chmodSync = chmodSync,
): Promise<{ close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(1000, () => socket.destroy());
    let buffer = '';
    let bytes = 0;
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximumMessageBytes) {
        socket.destroy();
        return;
      }
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\n')) return;
      socket.pause();
      try {
        const value = JSON.parse(buffer);
        if (value?.generation !== generation || !['stop', 'roll'].includes(value?.action)) {
          socket.end('{"accepted":false}\n');
          return;
        }
        const run = accept(value.action);
        if (!run) {
          socket.end('{"accepted":false}\n');
          return;
        }
        socket.end('{"accepted":true}\n', run);
      } catch {
        socket.destroy();
      }
    });
  });
  server.maxConnections = 4;
  const path = boundedGatewayControlPath(directory, generation);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path, backlog: 4 }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    permissions(path, 0o600);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  let closed: Promise<void> | undefined;
  return {
    close() {
      closed ??= new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return closed;
    },
  };
}

/** Generation authentication replaces unsafe persisted-PID check-then-signal operations. */
export async function requestBoundedGatewayControl(
  directory: string,
  generation: string,
  action: BoundedGatewayControlAction,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ path: boundedGatewayControlPath(directory, generation) });
    let response = '';
    let bytes = 0;
    const timer = setTimeout(() => socket.destroy(new Error('BOUNDED_GATEWAY_CONTROL_TIMEOUT')), 2000);
    socket.once('connect', () => socket.write(`${JSON.stringify({ generation, action })}\n`));
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximumMessageBytes) {
        socket.destroy(new Error('BOUNDED_GATEWAY_INVALID_CONTROL_RESPONSE'));
        return;
      }
      response += chunk.toString('utf8');
    });
    socket.once('error', reject);
    socket.once('close', () => {
      clearTimeout(timer);
      try {
        if (JSON.parse(response)?.accepted === true) resolve();
        else reject(new Error('BOUNDED_GATEWAY_CONTROL_REJECTED'));
      } catch {
        reject(new Error('BOUNDED_GATEWAY_INVALID_CONTROL_RESPONSE'));
      }
    });
  });
}
