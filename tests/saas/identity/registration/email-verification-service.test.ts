import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { SaasDatabase } from '../../../../src/saas/db/types.js';
import type { EmailMessage, EmailSender } from '../../../../src/saas/identity/email-sender.js';
import {
  EmailVerificationError,
  EmailVerificationService,
  MAX_CODE_ATTEMPTS,
  PASSWORD_RESET_CODE_TTL_MS,
  REGISTER_CODE_TTL_MS,
  SEND_COOLDOWN_MS,
} from '../../../../src/saas/identity/email-verification-service.js';
import { FakeSaasDatabase } from '../fake-database.js';

const EMAIL = 'unit.verification@example.test';

/** Deterministic code sequence; delivered emails expose the issued code. */
class CapturingSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  private next = 0;
  private readonly codes: readonly string[];

  constructor(codes: readonly string[] = ['123456']) {
    this.codes = codes;
  }

  get lastCode(): string | undefined {
    return this.sent.at(-1)?.body.match(/code is: (\d{6})/)?.[1];
  }

  async send(input: EmailMessage): Promise<void> {
    this.sent.push(input);
    void this.codes[this.next];
    this.next += 1;
  }
}

class FailingSender implements EmailSender {
  async send(): Promise<void> {
    throw new Error('unit delivery failure');
  }
}

function fixture(
  sender: EmailSender,
  codes: readonly string[] = ['123456'],
): { database: FakeSaasDatabase; service: EmailVerificationService; advance: (ms: number) => void } {
  const database = new FakeSaasDatabase();
  let nowMs = Date.UTC(2026, 9, 15, 8, 0, 0);
  let codeIndex = 0;
  const service = new EmailVerificationService({
    database: database as unknown as SaasDatabase,
    emailSender: sender,
    now: () => new Date(nowMs),
    codeFactory: () => codes[codeIndex++ % codes.length] ?? '000000',
  });
  return {
    database,
    service,
    advance: (milliseconds: number) => {
      nowMs += milliseconds;
    },
  };
}

const rejected = (code: string) => (error: unknown) => error instanceof EmailVerificationError && error.code === code;

function codeHash(email: string, purpose: string, code: string): string {
  return createHash('sha256')
    .update('saas-email-verification:v1\0', 'utf8')
    .update(purpose, 'utf8')
    .update('\0', 'utf8')
    .update(email, 'utf8')
    .update('\0', 'utf8')
    .update(code, 'utf8')
    .digest('hex');
}

test('issue stores only the purpose+email-bound hash, never the plaintext code', async () => {
  const sender = new CapturingSender();
  const fxt = fixture(sender, ['654321']);
  await fxt.service.issueCode({ email: EMAIL, purpose: 'register' });
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.lastCode, '654321');
  const rows = fxt.database.state.emailVerificationCodes;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.code_hash, codeHash(EMAIL, 'register', '654321'));
  assert.notEqual(rows[0]?.code_hash, '654321');
  assert.equal(JSON.stringify(rows).includes('654321'), false, 'plaintext never serialized in the table');
});

test('send cooldown: a second issue within 60 seconds is refused with retry-after', async () => {
  const sender = new CapturingSender();
  const fxt = fixture(sender, ['111111', '222222']);
  await fxt.service.issueCode({ email: EMAIL, purpose: 'register' });
  await assert.rejects(
    () => fxt.service.issueCode({ email: EMAIL, purpose: 'register' }),
    (error: unknown) =>
      error instanceof EmailVerificationError && error.code === 'COOLDOWN_ACTIVE' && error.retryAfterSeconds === 60,
  );
  assert.equal(sender.sent.length, 1, 'cooldown blocks the second delivery');
  fxt.advance(SEND_COOLDOWN_MS);
  await fxt.service.issueCode({ email: EMAIL, purpose: 'register' });
  assert.equal(sender.sent.length, 2);
  assert.equal(fxt.database.state.emailVerificationCodes.length, 2);
});

test('cooldown is per (purpose, email): password_reset does not collide with register', async () => {
  const sender = new CapturingSender();
  const fxt = fixture(sender, ['111111', '222222']);
  await fxt.service.issueCode({ email: EMAIL, purpose: 'register' });
  await fxt.service.issueCode({ email: EMAIL, purpose: 'password_reset' });
  assert.equal(sender.sent.length, 2);
});

test('TTL: register codes expire after 15 minutes, password-reset after 30', async () => {
  const sender = new CapturingSender();
  const fxt = fixture(sender, ['111111']);
  await fxt.service.issueCode({ email: EMAIL, purpose: 'register' });
  fxt.advance(REGISTER_CODE_TTL_MS - 1);
  await fxt.service.verifyCode({ email: EMAIL, purpose: 'register', code: '111111' });
  const sender2 = new CapturingSender();
  const fxt2 = fixture(sender2, ['222222']);
  await fxt2.service.issueCode({ email: EMAIL, purpose: 'register' });
  fxt2.advance(REGISTER_CODE_TTL_MS);
  await assert.rejects(
    () => fxt2.service.verifyCode({ email: EMAIL, purpose: 'register', code: '222222' }),
    rejected('CODE_INVALID'),
  );

  const sender3 = new CapturingSender();
  const fxt3 = fixture(sender3, ['333333']);
  await fxt3.service.issueCode({ email: EMAIL, purpose: 'password_reset' });
  fxt3.advance(PASSWORD_RESET_CODE_TTL_MS - 1);
  await fxt3.service.verifyCode({ email: EMAIL, purpose: 'password_reset', code: '333333' });
});

test('purpose isolation: a register code cannot verify for password_reset', async () => {
  const sender = new CapturingSender();
  const fxt = fixture(sender, ['111111']);
  await fxt.service.issueCode({ email: EMAIL, purpose: 'register' });
  await assert.rejects(
    () => fxt.service.verifyCode({ email: EMAIL, purpose: 'password_reset', code: '111111' }),
    rejected('CODE_INVALID'),
  );
  // The failed purpose probe did not burn the register code's attempts.
  await fxt.service.verifyCode({ email: EMAIL, purpose: 'register', code: '111111' });
});

test('email binding: a code cannot verify for another address', async () => {
  const sender = new CapturingSender();
  const fxt = fixture(sender, ['111111']);
  await fxt.service.issueCode({ email: EMAIL, purpose: 'register' });
  await assert.rejects(
    () => fxt.service.verifyCode({ email: 'other@example.test', purpose: 'register', code: '111111' }),
    rejected('CODE_INVALID'),
  );
});

test('attempt bound: five wrong attempts exhaust the code even with the correct value', async () => {
  const sender = new CapturingSender();
  const fxt = fixture(sender, ['111111']);
  await fxt.service.issueCode({ email: EMAIL, purpose: 'register' });
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    await assert.rejects(
      () => fxt.service.verifyCode({ email: EMAIL, purpose: 'register', code: '000000' }),
      rejected('CODE_INVALID'),
    );
  }
  assert.equal(fxt.database.state.emailVerificationCodes[0]?.attempts, MAX_CODE_ATTEMPTS);
  await assert.rejects(
    () => fxt.service.verifyCode({ email: EMAIL, purpose: 'register', code: '111111' }),
    rejected('CODE_INVALID'),
  );
});

test('one-time consume: a verified code cannot verify twice', async () => {
  const sender = new CapturingSender();
  const fxt = fixture(sender, ['111111']);
  await fxt.service.issueCode({ email: EMAIL, purpose: 'register' });
  await fxt.service.verifyCode({ email: EMAIL, purpose: 'register', code: '111111' });
  assert.equal(fxt.database.state.emailVerificationCodes[0]?.consumed_at !== null, true);
  await assert.rejects(
    () => fxt.service.verifyCode({ email: EMAIL, purpose: 'register', code: '111111' }),
    rejected('CODE_INVALID'),
  );
});

test('only the newest live code is verifiable; a re-issue supersedes', async () => {
  const sender = new CapturingSender();
  const fxt = fixture(sender, ['111111', '222222']);
  await fxt.service.issueCode({ email: EMAIL, purpose: 'register' });
  fxt.advance(SEND_COOLDOWN_MS);
  await fxt.service.issueCode({ email: EMAIL, purpose: 'register' });
  await assert.rejects(
    () => fxt.service.verifyCode({ email: EMAIL, purpose: 'register', code: '111111' }),
    rejected('CODE_INVALID'),
  );
  await fxt.service.verifyCode({ email: EMAIL, purpose: 'register', code: '222222' });
});

test('delivery failure removes the just-issued row so an immediate retry is possible', async () => {
  const database = new FakeSaasDatabase();
  let nowMs = Date.UTC(2026, 9, 15, 8, 0, 0);
  const service = new EmailVerificationService({
    database: database as unknown as SaasDatabase,
    emailSender: new FailingSender(),
    now: () => new Date(nowMs),
    codeFactory: () => '111111',
  });
  await assert.rejects(
    () => service.issueCode({ email: EMAIL, purpose: 'register' }),
    rejected('EMAIL_DELIVERY_FAILED'),
  );
  assert.equal(database.state.emailVerificationCodes.length, 0, 'compensating delete removed the row');
  // Immediate retry is not cooldown-blocked.
  await assert.rejects(
    () => service.issueCode({ email: EMAIL, purpose: 'register' }),
    rejected('EMAIL_DELIVERY_FAILED'),
  );
  nowMs += 1;
  void nowMs;
});

test('issue prunes long-expired rows for the same key', async () => {
  const sender = new CapturingSender();
  const fxt = fixture(sender, ['111111', '222222']);
  await fxt.service.issueCode({ email: EMAIL, purpose: 'register' });
  fxt.advance(8 * 24 * 60 * 60_000);
  await fxt.service.issueCode({ email: EMAIL, purpose: 'register' });
  assert.equal(fxt.database.state.emailVerificationCodes.length, 1, 'the stale row was pruned');
});

test('invalid inputs are rejected before any storage or delivery', async () => {
  const sender = new CapturingSender();
  const fxt = fixture(sender);
  await assert.rejects(
    () => fxt.service.issueCode({ email: 'not-an-email', purpose: 'register' }),
    rejected('INVALID_INPUT'),
  );
  await assert.rejects(() => fxt.service.issueCode({ email: '', purpose: 'register' }), rejected('INVALID_INPUT'));
  await assert.rejects(
    // @ts-expect-error deliberately invalid purpose
    () => fxt.service.issueCode({ email: EMAIL, purpose: 'login' }),
    rejected('INVALID_INPUT'),
  );
  await assert.rejects(
    () => fxt.service.verifyCode({ email: EMAIL, purpose: 'register', code: '12ab56' }),
    rejected('CODE_INVALID'),
  );
  await assert.rejects(
    () => fxt.service.verifyCode({ email: EMAIL, purpose: 'register', code: '1234567' }),
    rejected('CODE_INVALID'),
  );
  assert.equal(sender.sent.length, 0);
  assert.equal(fxt.database.state.emailVerificationCodes.length, 0);
});
