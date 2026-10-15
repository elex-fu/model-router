import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

/**
 * R4 registration admission (plan §R4): the email transport behind the
 * verification-code sender.
 *
 * The interface is deliberately the same shape as the observability
 * `AlertEmailSender` (src/saas/observability/alerts.ts: `send({ to, subject,
 * body })`) so a single SMTP transport can later serve alert notifications
 * too; identity does not import the observability module, the shapes simply
 * stay structurally compatible.
 *
 * Dependency decision (reported in the task writeup): the repository keeps a
 * deliberately tiny runtime dependency set and already routes optional
 * infrastructure (Redis, credential KMS) through dynamically loaded provider
 * modules. Adding nodemailer (a large dependency tree) for a handful of
 * transactional verification emails conflicts with that posture, so this file
 * ships a minimal SMTP client on node:net/node:tls: EHLO, opportunistic
 * STARTTLS (upgraded with certificate verification), AUTH PLAIN / AUTH LOGIN,
 * and one dot-stuffed DATA payload per message. If a deployment needs pooled
 * deliveries, 8BITMIME negotiation or exotic auth, the `EmailSender` seam can
 * wrap a dynamically loaded provider module without touching callers.
 *
 * The default implementation is the console sender (the existing alerts.ts
 * behavior): an unconfigured deployment logs instead of dialing out, so
 * nothing breaks when SMTP is absent.
 */

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/** AlertEmailSender-shaped transport contract. */
export interface EmailSender {
  send(input: EmailMessage): Promise<void>;
}

/** Default implementation: structured console logging (alerts.ts behavior). */
export class ConsoleEmailSender implements EmailSender {
  async send(input: EmailMessage): Promise<void> {
    console.log(`model-router identity email → ${input.to} :: ${input.subject}\n${input.body}`);
  }
}

export class EmailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

export interface SmtpEmailSenderOptions {
  /** SMTP relay hostname. */
  readonly host: string;
  /** Relay port (587 for STARTTLS, 465 for implicit TLS). */
  readonly port: number;
  /** Implicit TLS from the first byte (port 465 style). */
  readonly secure?: boolean;
  /** SMTP AUTH username. */
  readonly username?: string;
  /**
   * SMTP AUTH password. Callers resolve it from its sealed storage; this
   * module never logs or persists it.
   */
  readonly password?: string;
  /** Envelope sender, also used for the From header when unset. */
  readonly from: string;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SUBJECT_BYTES = 512;
const MAX_BODY_BYTES = 64 * 1024;

function requireAddress(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length > 254 || !EMAIL_PATTERN.test(trimmed)) {
    throw new EmailDeliveryError(`Invalid ${field} address`);
  }
  return trimmed;
}

function encodeHeaderValue(value: string): string {
  // RFC 2047 B-encoding for any non-ASCII header value.
  return /^[\x20-\x7e]*$/.test(value)
    ? value.replace(/[\r\n]/g, ' ')
    : `=?utf-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

interface SmtpReply {
  readonly code: number;
  readonly lines: readonly string[];
}

class SmtpSession {
  private socket: Socket;
  private buffer = '';
  private pending: { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void } | undefined;
  private closed = false;

  constructor(socket: Socket) {
    this.socket = socket;
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.tryCompleteReply();
    });
    this.socket.on('error', (error: Error) => {
      this.fail(error);
    });
    this.socket.on('close', () => {
      this.fail(new EmailDeliveryError('SMTP connection closed unexpectedly'));
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.pending?.reject(error);
    this.pending = undefined;
  }

  private tryCompleteReply(): void {
    if (!this.pending) return;
    for (;;) {
      const index = this.buffer.indexOf('\r\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      const code = Number(line.slice(0, 3));
      const isFinal = line.charAt(3) !== '-';
      if (this.collected.length === 0) {
        if (!Number.isInteger(code) || code < 200 || code > 599) {
          this.pending.reject(new EmailDeliveryError('Malformed SMTP reply'));
          this.pending = undefined;
          return;
        }
        this.code = code;
      }
      this.collected.push(line.slice(4));
      if (isFinal) {
        const reply = { code: this.code, lines: this.collected };
        this.collected = [];
        const pending = this.pending;
        this.pending = undefined;
        pending.resolve(reply);
        return;
      }
    }
  }

  private code = 0;
  private collected: string[] = [];

  async readReply(): Promise<SmtpReply> {
    if (this.pending) throw new EmailDeliveryError('Concurrent SMTP read');
    if (this.closed) throw new EmailDeliveryError('SMTP connection closed');
    return new Promise<SmtpReply>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.tryCompleteReply();
    });
  }

  write(data: string): void {
    if (this.closed) throw new EmailDeliveryError('SMTP connection closed');
    // Normalize to CRLF; callers may pass LF-joined text.
    this.socket.write(data.replace(/\r?\n/g, '\r\n'));
  }

  upgradeTls(servername: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new EmailDeliveryError('SMTP connection closed'));
        return;
      }
      this.socket.removeAllListeners('data');
      this.socket.removeAllListeners('error');
      this.socket.removeAllListeners('close');
      const upgraded = tlsConnect({ socket: this.socket, servername, rejectUnauthorized: true });
      upgraded.once('secureConnect', () => {
        this.socket = upgraded;
        this.attach(upgraded);
        resolve();
      });
      upgraded.once('error', (error: Error) => reject(error));
    });
  }

  private attach(socket: Socket): void {
    this.buffer = '';
    this.closed = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.tryCompleteReply();
    });
    socket.on('error', (error: Error) => this.fail(error));
    socket.on('close', () => this.fail(new EmailDeliveryError('SMTP connection closed unexpectedly')));
  }

  close(): void {
    this.closed = true;
    this.pending = undefined;
    this.socket.destroy();
  }
}

/**
 * Minimal SMTP transport. One connection per message: EHLO → (STARTTLS when
 * offered) → AUTH → MAIL FROM → RCPT TO → DATA → QUIT. Any non-2xx/3xx reply
 * at a step that requires success fails the delivery.
 */
export class SmtpEmailSender implements EmailSender {
  private readonly options: Required<Pick<SmtpEmailSenderOptions, 'host' | 'port' | 'from' | 'timeoutMs'>> &
    Pick<SmtpEmailSenderOptions, 'secure' | 'username' | 'password'>;

  constructor(options: SmtpEmailSenderOptions) {
    if (
      !options ||
      typeof options.host !== 'string' ||
      !/^[a-zA-Z0-9.-]+$/.test(options.host) ||
      options.host.length > 253 ||
      !Number.isSafeInteger(options.port) ||
      options.port < 1 ||
      options.port > 65535 ||
      typeof options.from !== 'string' ||
      (options.username !== undefined && typeof options.username !== 'string') ||
      (options.password !== undefined && typeof options.password !== 'string') ||
      (options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 60_000))
    ) {
      throw new TypeError('Invalid SMTP configuration');
    }
    if ((options.username === undefined) !== (options.password === undefined)) {
      throw new TypeError('SMTP username and password must be configured together');
    }
    this.options = {
      host: options.host,
      port: options.port,
      from: requireAddress(options.from, 'sender'),
      timeoutMs: options.timeoutMs ?? 10_000,
      ...(options.secure === undefined ? {} : { secure: options.secure }),
      ...(options.username === undefined ? {} : { username: options.username }),
      ...(options.password === undefined ? {} : { password: options.password }),
    };
  }

  async send(input: EmailMessage): Promise<void> {
    const to = requireAddress(input.to, 'recipient');
    if (typeof input.subject !== 'string' || Buffer.byteLength(input.subject, 'utf8') > MAX_SUBJECT_BYTES) {
      throw new EmailDeliveryError('Invalid email subject');
    }
    if (
      typeof input.body !== 'string' ||
      input.body.length === 0 ||
      Buffer.byteLength(input.body, 'utf8') > MAX_BODY_BYTES
    ) {
      throw new EmailDeliveryError('Invalid email body');
    }
    const sender = this.options.from;
    const body = Buffer.from(input.body, 'utf8')
      .toString('base64')
      .replace(/(.{76})/g, '$1\n');
    const message = [
      `From: ${sender}`,
      `To: ${to}`,
      `Subject: ${encodeHeaderValue(input.subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
    ].join('\n');

    const socket = await this.connect();
    const session = new SmtpSession(socket);
    try {
      const timer = setTimeout(() => {
        socket.destroy();
      }, this.options.timeoutMs);
      timer.unref();
      try {
        await this.expect(session, 220);
        const extensions = await this.ehlo(session);
        if (!this.options.secure && extensions.has('STARTTLS')) {
          await this.command(session, 'STARTTLS', 220);
          await session.upgradeTls(this.options.host);
          await this.ehlo(session);
        }
        await this.authenticate(session, extensions);
        await this.command(session, `MAIL FROM:<${sender}>`, 250);
        await this.command(session, `RCPT TO:<${to}>`, 250);
        await this.command(session, 'DATA', 354);
        session.write(message.replace(/(^|\n)\./g, '$1..'));
        session.write('.');
        await this.expect(session, 250);
        session.write('QUIT');
      } finally {
        clearTimeout(timer);
      }
    } finally {
      session.close();
    }
  }

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = this.options.secure
        ? tlsConnect({ host: this.options.host, port: this.options.port, rejectUnauthorized: true })
        : netConnect({ host: this.options.host, port: this.options.port });
      socket.setTimeout(this.options.timeoutMs);
      socket.once('connect', () => {
        socket.setTimeout(0);
        resolve(socket);
      });
      socket.once('timeout', () => {
        socket.destroy();
        reject(new EmailDeliveryError('SMTP connection timed out'));
      });
      socket.once('error', (error: Error) =>
        reject(new EmailDeliveryError(`SMTP connection failed: ${error.message}`)),
      );
    });
  }

  private async ehlo(session: SmtpSession): Promise<Set<string>> {
    const reply = await this.command(session, `EHLO ${this.heloName()}`, 250);
    // Flatten verb plus parameters (e.g. "AUTH PLAIN LOGIN" → AUTH, PLAIN,
    // LOGIN) so mechanism names are queryable alongside plain verbs.
    const tokens = new Set<string>();
    for (const line of reply.lines) {
      for (const token of line.toUpperCase().split(/[\s=]+/)) {
        if (token.length > 0) tokens.add(token);
      }
    }
    return tokens;
  }

  private heloName(): string {
    return 'localhost';
  }

  private async authenticate(session: SmtpSession, extensions: Set<string>): Promise<void> {
    const { username, password } = this.options;
    if (username === undefined || password === undefined) return;
    if (!extensions.has('AUTH')) throw new EmailDeliveryError('SMTP server offers no authentication');
    if (extensions.has('PLAIN')) {
      const credentials = Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
      await this.command(session, `AUTH PLAIN ${credentials}`, 235);
      return;
    }
    if (extensions.has('LOGIN')) {
      await this.command(session, 'AUTH LOGIN', 334);
      await this.command(session, Buffer.from(username, 'utf8').toString('base64'), 334);
      await this.command(session, Buffer.from(password, 'utf8').toString('base64'), 235);
      return;
    }
    throw new EmailDeliveryError('SMTP server offers no supported authentication mechanism');
  }

  private async command(session: SmtpSession, verb: string, expected: number): Promise<SmtpReply> {
    session.write(verb);
    return this.expect(session, expected);
  }

  private async expect(session: SmtpSession, expected: number): Promise<SmtpReply> {
    const reply = await session.readReply();
    if (reply.code !== expected) {
      throw new EmailDeliveryError(`SMTP command rejected (${reply.code})`);
    }
    return reply;
  }
}
