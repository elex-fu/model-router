import net from 'node:net';
import tls from 'node:tls';
import type { buildConnector } from 'undici';

/**
 * R3 egress proxies: a minimal SOCKS5 client connector for undici.
 *
 * undici (6.x) ships no native SOCKS support and `socks-proxy-agent` is an
 * http.Agent-world package that cannot act as an undici Dispatcher, so the
 * SOCKS path is a purpose-built undici connector (RFC 1928 + RFC 1929
 * username/password auth). It implements socks5h semantics exclusively: the
 * destination hostname is sent to the proxy as a DOMAINNAME address type
 * (ATYP 0x03), so DNS resolution always happens on the proxy side — the
 * sub2api requirement that rules out local-DNS socks5 and DNS leaks.
 *
 * The TCP connection to the proxy itself uses the already-pinned,
 * whitelist-validated proxy address (no resolution happens here). Error
 * messages never contain the proxy credentials or the destination URL.
 */

const SOCKS5_VERSION = 0x05;
const SOCKS5_AUTH_NONE = 0x00;
const SOCKS5_AUTH_USERNAME_PASSWORD = 0x02;
const SOCKS5_REPLY_SUCCEEDED = 0x00;
const SOCKS5_ATYP_IPV4 = 0x01;
const SOCKS5_ATYP_DOMAINNAME = 0x03;
const SOCKS5_ATYP_IPV6 = 0x04;

export const DEFAULT_SOCKS5_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface Socks5ConnectorProxy {
  /** The pinned, whitelist-validated proxy address. */
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: number;
  /** Proxy username; empty/omitted means no username/password auth. */
  readonly username?: string;
  readonly password?: string;
  readonly handshakeTimeoutMs?: number;
  /** Extra TLS connect options for the tunneled destination (tests inject a CA). */
  readonly tlsOptions?: tls.ConnectionOptions;
}

export type Socks5ConnectorErrorCode = 'HANDSHAKE_TIMEOUT' | 'PROTOCOL_ERROR' | 'AUTH_REJECTED' | 'CONNECT_REJECTED';

export class Socks5ConnectorError extends Error {
  constructor(readonly code: Socks5ConnectorErrorCode) {
    super(
      code === 'HANDSHAKE_TIMEOUT'
        ? 'the socks5 proxy handshake timed out'
        : code === 'PROTOCOL_ERROR'
          ? 'the socks5 proxy sent a malformed reply'
          : code === 'AUTH_REJECTED'
            ? 'the socks5 proxy rejected the credentials'
            : 'the socks5 proxy refused the connect request',
    );
    this.name = 'Socks5ConnectorError';
  }
}

/**
 * Build the undici connector for one pinned socks5h proxy. The returned
 * function follows the buildConnector contract: it receives the destination
 * ({hostname, port, protocol, servername}) and calls back with the
 * established (optionally TLS-upgraded) tunnel socket.
 */
export function createSocks5HConnector(proxy: Socks5ConnectorProxy): buildConnector.connector {
  const username = proxy.username ?? '';
  const password = proxy.password ?? '';
  const hasAuth = username !== '';
  const timeoutMs = proxy.handshakeTimeoutMs ?? DEFAULT_SOCKS5_HANDSHAKE_TIMEOUT_MS;

  return (options, callback) => {
    const destinationPort = options.port || (options.protocol === 'https:' ? '443' : '80');
    let stage: 'greeting' | 'auth' | 'connect' | 'tunnel' = 'greeting';
    let settled = false;
    let buffer: Buffer = Buffer.alloc(0);

    const socket = net.connect({
      host: proxy.address,
      port: proxy.port,
      family: proxy.family,
      localAddress: options.localAddress ?? undefined,
    });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60_000);

    let handshakeTimeout: NodeJS.Timeout | undefined = setTimeout(() => {
      settle(new Socks5ConnectorError('HANDSHAKE_TIMEOUT'), null);
    }, timeoutMs);
    const clearHandshakeTimeout = (): void => {
      if (handshakeTimeout !== undefined) {
        clearTimeout(handshakeTimeout);
        handshakeTimeout = undefined;
      }
    };

    function settle(error: Error | null, result: net.Socket | tls.TLSSocket | null): void {
      if (settled) return;
      settled = true;
      clearHandshakeTimeout();
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (error !== null || result === null) {
        socket.destroy();
        callback(error ?? new Socks5ConnectorError('PROTOCOL_ERROR'), null);
        return;
      }
      callback(null, result);
    }

    function onError(error: Error): void {
      settle(error, null);
    }

    function onClose(): void {
      settle(new Socks5ConnectorError('PROTOCOL_ERROR'), null);
    }

    function consume(length: number): Buffer | null {
      if (buffer.length < length) return null;
      const consumed = buffer.subarray(0, length);
      buffer = buffer.subarray(length);
      return consumed;
    }

    function onData(chunk: Buffer): void {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      pump();
    }

    function sendConnectRequest(): void {
      const hostname = Buffer.from(options.hostname, 'ascii');
      const port = Number(destinationPort);
      if (hostname.length === 0 || hostname.length > 255 || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        settle(new Socks5ConnectorError('PROTOCOL_ERROR'), null);
        return;
      }
      // ATYP 0x03 — DOMAINNAME: socks5h remote-DNS semantics.
      const request = Buffer.alloc(7 + hostname.length);
      request[0] = SOCKS5_VERSION;
      request[1] = 0x01; // CONNECT
      request[2] = 0x00; // RSV
      request[3] = SOCKS5_ATYP_DOMAINNAME;
      request[4] = hostname.length;
      hostname.copy(request, 5);
      request.writeUInt16BE(port, 5 + hostname.length);
      socket.write(request);
    }

    function sendUsernamePasswordAuth(): void {
      const user = Buffer.from(username, 'utf8');
      const pass = Buffer.from(password, 'utf8');
      if (user.length === 0 || user.length > 255 || pass.length > 255) {
        settle(new Socks5ConnectorError('PROTOCOL_ERROR'), null);
        return;
      }
      const request = Buffer.alloc(3 + user.length + pass.length);
      request[0] = 0x01; // RFC 1928 auth version
      request[1] = user.length;
      user.copy(request, 2);
      request[2 + user.length] = pass.length;
      pass.copy(request, 3 + user.length);
      socket.write(request);
    }

    function finishTunnel(): void {
      if (options.protocol !== 'https:') {
        settle(null, socket);
        return;
      }
      // TLS over the tunnel; the handshake timeout keeps guarding the
      // upgrade because settle() has not run yet.
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      const tlsSocket = tls.connect({
        socket,
        servername: options.servername ?? options.hostname,
        ALPNProtocols: ['http/1.1'],
        ...(proxy.tlsOptions ?? {}),
      });
      tlsSocket.once('secureConnect', () => {
        settle(null, tlsSocket);
      });
      tlsSocket.once('error', (error: Error) => {
        settle(error, null);
      });
    }

    function pump(): void {
      if (settled) return;
      if (stage === 'greeting') {
        const reply = consume(2);
        if (reply === null) return;
        if (reply[0] !== SOCKS5_VERSION) {
          settle(new Socks5ConnectorError('PROTOCOL_ERROR'), null);
          return;
        }
        if (reply[1] === SOCKS5_AUTH_USERNAME_PASSWORD && hasAuth) {
          stage = 'auth';
          sendUsernamePasswordAuth();
          return;
        }
        if (reply[1] === SOCKS5_AUTH_NONE) {
          stage = 'connect';
          sendConnectRequest();
          return;
        }
        // No acceptable method (0xFF), or auth demanded but not configured.
        settle(new Socks5ConnectorError('AUTH_REJECTED'), null);
        return;
      }
      if (stage === 'auth') {
        const reply = consume(2);
        if (reply === null) return;
        if (reply[1] !== 0x00) {
          settle(new Socks5ConnectorError('AUTH_REJECTED'), null);
          return;
        }
        stage = 'connect';
        sendConnectRequest();
        return;
      }
      if (stage === 'connect') {
        const header = consume(4);
        if (header === null) return;
        if (header[0] !== SOCKS5_VERSION || header[1] !== SOCKS5_REPLY_SUCCEEDED) {
          settle(
            header[1] === SOCKS5_REPLY_SUCCEEDED
              ? new Socks5ConnectorError('PROTOCOL_ERROR')
              : new Socks5ConnectorError('CONNECT_REJECTED'),
            null,
          );
          return;
        }
        const addressLength =
          header[3] === SOCKS5_ATYP_IPV4
            ? 4
            : header[3] === SOCKS5_ATYP_IPV6
              ? 16
              : header[3] === SOCKS5_ATYP_DOMAINNAME
                ? -1
                : 0;
        if (addressLength === 0) {
          settle(new Socks5ConnectorError('PROTOCOL_ERROR'), null);
          return;
        }
        if (addressLength > 0) {
          if (consume(addressLength + 2) === null) return;
          stage = 'tunnel';
          finishTunnel();
          return;
        }
        const lengthByte = consume(1);
        if (lengthByte === null) return;
        if (consume(lengthByte[0] + 2) === null) return;
        stage = 'tunnel';
        finishTunnel();
      }
    }

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.once('connect', () => {
      // Greeting: no-auth, plus username/password when credentials exist.
      socket.write(
        hasAuth
          ? Buffer.from([SOCKS5_VERSION, 0x02, SOCKS5_AUTH_NONE, SOCKS5_AUTH_USERNAME_PASSWORD])
          : Buffer.from([SOCKS5_VERSION, 0x01, SOCKS5_AUTH_NONE]),
      );
    });

    return socket;
  };
}
