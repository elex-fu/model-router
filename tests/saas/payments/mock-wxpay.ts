import { createCipheriv, createSign, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Test-only mock key material (never valid against real providers). Armor
// lines are assembled at load time so secret scanners do not match private
// key blocks in the repository.
const TEST_PRIVATE_KEY_ARMOR_BEGIN = `-----BEGIN ${'PRIVATE KEY'}-----`;
const TEST_PRIVATE_KEY_ARMOR_END = `-----END ${'PRIVATE KEY'}-----`;

function wrapTestPrivateKey(body: string): string {
  return `${TEST_PRIVATE_KEY_ARMOR_BEGIN}\n${(body.match(/.{1,64}/g) ?? []).join('\n')}\n${TEST_PRIVATE_KEY_ARMOR_END}`;
}

// Programmable mock WeChat Pay v3 server for the R3 wxpay provider/drill
// tests. Routes the v3 native-prepay / transaction-query / domestic-refund /
// certificates endpoints the adapter calls, records signed Authorization
// headers plus raw JSON bodies, and builds notifications exactly like the
// WeChat v3 scheme (platform RSA-SHA256 signature over
// "timestamp\nnonce\nbody\n" + AEAD_AES_256_GCM resource encryption under the
// test apiV3Key). Test key material: a merchant RSA keypair (adapter config),
// a platform RSA keypair + self-signed X.509 certificate (notification signer,
// served through /v3/certificates encrypted with the apiV3Key) and an ALT
// platform keypair/cert for the wrong-certificate drills. The adapter never
// talks to real WeChat in tests. The platform certificate validity window
// starts 2026-10-11T09:27:58Z, so fixtures pin now() to 2026-10-12.

export const WXPAY_TEST_MCHID = '1900000109';
export const WXPAY_TEST_APPID = `wx${'1234567890abcdef'}`;
export const WXPAY_TEST_MERCHANT_SERIAL = '1DDE55AD98ED71D6EDD4A8EA691A618D64E2D1CE';
export const WXPAY_TEST_APIV3_KEY = '0123456789abcdef0123456789abcdef';
export const WXPAY_TEST_PLATFORM_SERIAL = '515F9F53D9A61A2B3C4D5E6F708192A3B4C5D6E7';
export const WXPAY_TEST_PLATFORM_ALT_SERIAL = '6A1B2C3D4E5F60718293A4B5C6D7E8F901234567';

const WXPAY_TEST_MERCHANT_PRIVATE_KEY_PEM_BODY =
  'MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDFxlKsxmNK2nafUhkaGq93Fz2BwszjmkaboB1L9nfqZPbMdnt5la27YSFRaSS1Auurj2faNd7q1jFMDPgiHkZcFIYdCcG7RaFRPjofH0cpZZ8ay3v8EZGX/4lhkWeUi3pyXD/p+bzyFgTK3NqafaUVFpwqmJFIiRCLboSrtJpARvU7KrBrLyCLARUBVsXvQ9DoG78n42HlepVEfVbLBXwW3JFRBKwJeklmPuHJO/k0L+n7TiavcTZE9GqC1XlHo5MNFLrhSlFl534qXW1JnFX2U3jceN+Xi1SOB3pnZmfKZcgmA6JGhQN3a40b8esNuls7f5R0Ou2KQUZzOCSkC8otAgMBAAECggEACAtp2/zC163cstzSSBFLT1cK6a8MifqBwj1IS8l19bsPHeB448hulWddRVQ3ScSZZPRTl1jnHRrCzRLe+fZMytyL2v0FXBJ4Phd/ojnxuVGYn+ykeauWRj4+7pDNS4nD3Ih7kg8WPCugnMbQfoW7VAkEJ6hminKG0YEYlOpm9tPJt1hKy8LaL4N8C6uSrtVR72WFpSgbmjbyYQwG/Lraq0OtnACLTtHYvlPqFufb6WxFOuq6Kgpw+BPIEEIYiIO4zrhzmpRJTzr9FTU5mOJ6YtDJHelesOT4WEg+yzt70XVTCCi7jW7FAyCZ2A2tfsSvuCs28+pMFIuTyRCIsiLM4QKBgQDw2YKwO1V1MiNPfpQSiV+NPH3XGhhKZQfm8NNP6QF1VklwINciJNtjhDKeH4SqWrbUwouRAv9nd+EmQH/qSYuzwcw0Jz0rB0cDm6llfzNACUQQPVE1Kpqg8c1LZ02LRiZ7CGzJCn0h9CaLtrKedHDcoCdIWYZ/ev0A39QFj0yLYQKBgQDSNyks9Qox80VirY5OC07oQAo6SftS0bYQKToAR6hrq+sVgLweLlv096oHzbu+OIEQHS2/7SkiRqcq/6Xi3eXO4MIAOsUo6bO6LzeEsfBYneN0wD1V19VhmQyuPwtKuFTckQUAi0yS5UjNL82E+a/RpCmKoiKm+W2VDa62zACeTQKBgQDPXOYpJxyfp4hBRCDmiMHszv0leoEZZDzWd9fngBxSUvUthgjTi9obp1ERVN+a8DljmxAgzOzqv4rorTW0mJegL6XJ7VK7vitFDvtcuJR+eLvSI4jMdp7lHOp9FjbsR3yQByPqP46W8idRuP22cVhOi9DmeLXVAiXcX9mi48qqYQKBgQCH+3q9RD22FiH6NT7qqVH/1v1Gu3jCGDpnteN5LuF51RobLM2D0IVXr6XjqmgaIr8KR3XCw41qSL32iK0sVlJEQwv7zgif8J18gPKu+dP53xi1+20xzI6RtcmIJewOB7ONgpnzwihklcFESfnuXP4o5MKilUNJM+x5EQLF6K01uQKBgQCg4BIXExRVWf3MyynEgF+yIFiDd2Za6QO6CEltwqCop+ARM/ule4zc8S7xSUkUvXz0oGaQsC079rMpxnRi2fo8YhO9Ns8Uv5z77DDQmZdJLYVhiVFAEGtTDU8xa3+eQN4NurMZ66wm+oq8mlVaaHA+9rI2wQFiiUUn3aLON9Z9Ww==';
export const WXPAY_TEST_MERCHANT_PRIVATE_KEY_PEM = wrapTestPrivateKey(WXPAY_TEST_MERCHANT_PRIVATE_KEY_PEM_BODY);

const WXPAY_TEST_PLATFORM_PRIVATE_KEY_PEM_BODY =
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDfXAE40sVBD2M2N9sFgYZqGQ5+moy6GztNhgUyQbV2ZedXwLkLo4TqbsYHiHHWTAq6sU1lzhTv7bD6jQqe1+KtNGorWs7priGGgFrt72nOQZave9VrcB4lOkQoOXEw6ZiVlLQ8Ei8qIkzZx2VJFxzy3xChRiwdBXNKrT0vkxowSn14FNRq8aXpJiVshWDC2phcMhDucBX9pKbCO0GCKCnIrOV3MVB3Celvepl4trSpEbeI7WIETrh29jwRZKYDGAGpdzpT5iqUCWYHxSFHskFJFvLZVe97cZpwtTmYsYmQPNAlVT6oXwAxetYjVCnhuTfF1ANimh+QkJBKblTK6A9VAgMBAAECggEAB/OBg6FVLky67mosnNSQkWRU9MLRsapYgRj9RF28dPuJscEFlVl72NCashf0XXmVhDHdnHsqmaPvgevVbfQneJz+Do8MAJuXS+9zzTaRoKsLDzIsVcfG+vJJDNmGowQdz21cwSqwjSJtc+86NtDg0fCI6gTSezH/ebATFod5DjD3nGXgI5Dpg0rPYjwxTjzO3b9CTnRgo7lx/t9JfPYT4oTBrBOf/SYK52E1ABnnFJ2zI/d/FmZbyF378k8bXScCmkwzTcV0vt189/W8sWlT07v2gNDtfQ69scvOJcp83V+yzn2Byl5ffDwvzALlo0Z1VmrAE4rUAmMldKZ9JP94YQKBgQD7o1VKKPIvG1IVQX/mvTEKr5mICV94VjxRQ/7TgMRc/9dBTF6CzWnuc/bpt7puEaufETVlcBoQmvhwwdjEtk8qjktDwjQacEufX8jXqKwFpG8WINdvCgnT3m85rCXA3juSc33MAdxQydUhIgfFgPu1dzop0q0dNLaOEghyttehTQKBgQDjOy6/UZLut2h0IIing0pn+dT9dZ0rafMQN/pVLeDMm/6MtBAinlG8uCDHM8YMmNlyz98nfqZQ36NXn4ifw0B5CKYi5zOY8AhpHfo9pPKQrVjwtz1l/+tefQpsKXx1pRrJzJTPmviNGjbEPF3grtuB/dSAUdRCat4V/nd2YT8iKQKBgDzbscLvyDLQXre5UZ+SXgwBkBYwfiByasAUu8qXN+ZuEbc/KxRjbZ03+p1ny/TW3TTpSoqv4/3kHPXYS/63QMpAA7/tdgB27DMtTTurFX9/10X4x2GZger1vtyp36+Xj7zJpcDzKj93sM4ElvCTU0z9+tkmlKudlhEiF1z3D4t5AoGBAL+E0UjVc1caZMKD7Unq4ZqzOm6KY/cEbKY92BNVAMTTsf9bgMH82H2MX6wmGgXiCly3kalTGNDPPXgL8XZedgfNX2HJpnZ/0UbvykuMrBl+0ZjJiMlgozvXfiJd8RWjG+n8MWytfFJJRuGs058dIcv1adbhoVp9gkPdX0j6e+DJAoGAEHu1tp9DayVoT50Mn1IV7g8KC9nMpTu5b2rVr6Z0lgjuRmYiX+5rjtTjRVp9PrF6wAxg9ecBM5OoFjBPVf4X2H+h/zlWkBUSozgp1Lb5FSr7V0XISH19S/0Xw7XoN646Q7bRe5FV/Nh6huORPBanYjaef7Dvn9Ixz797bdvdSh8=';
export const WXPAY_TEST_PLATFORM_PRIVATE_KEY_PEM = wrapTestPrivateKey(WXPAY_TEST_PLATFORM_PRIVATE_KEY_PEM_BODY);

export const WXPAY_TEST_PLATFORM_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIDYTCCAkmgAwIBAgIUUV+fU9mmGis8TV5vcIGSo7TF1ucwDQYJKoZIhvcNAQEL
BQAwQDEhMB8GA1UEAwwYV2VDaGF0IFBheSBQbGF0Zm9ybSBNb2NrMRswGQYDVQQK
DBJtb2RlbC1yb3V0ZXIgdGVzdHMwHhcNMjYxMDExMDkyNzU4WhcNMzYxMDA4MDky
NzU4WjBAMSEwHwYDVQQDDBhXZUNoYXQgUGF5IFBsYXRmb3JtIE1vY2sxGzAZBgNV
BAoMEm1vZGVsLXJvdXRlciB0ZXN0czCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC
AQoCggEBAN9cATjSxUEPYzY32wWBhmoZDn6ajLobO02GBTJBtXZl51fAuQujhOpu
xgeIcdZMCrqxTWXOFO/tsPqNCp7X4q00aitazumuIYaAWu3vac5Blq971WtwHiU6
RCg5cTDpmJWUtDwSLyoiTNnHZUkXHPLfEKFGLB0Fc0qtPS+TGjBKfXgU1Grxpekm
JWyFYMLamFwyEO5wFf2kpsI7QYIoKcis5XcxUHcJ6W96mXi2tKkRt4jtYgROuHb2
PBFkpgMYAal3OlPmKpQJZgfFIUeyQUkW8tlV73txmnC1OZixiZA80CVVPqhfADF6
1iNUKeG5N8XUA2KaH5CQkEpuVMroD1UCAwEAAaNTMFEwHQYDVR0OBBYEFM6pSRkP
j6w+PFWrsHW+r07uRrpDMB8GA1UdIwQYMBaAFM6pSRkPj6w+PFWrsHW+r07uRrpD
MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAAxvLfPH7kUag/2o
nV7WKMzldbkQGXYzhdBnhd4VDWjsKzEOyaOiyqLtXM8xovwnUpuzubnxwDthS4Et
IO1UFroIzuN6SltxTGkQoBIKIkEtNS8sN+CKx3AYQRdbqL0b+ycJbfnfujWnKmSS
fopzE0UufruoaUqjgql5twCSbYkoDHIiJV6qiG6mWzBsihikvgJr0DNjcEnVBKKj
aJZIVBAhYS55sTLb4Lcu1w0nyWa1TGV0p7ylC1vE6+BRoqoHBA0sLMEeC8Tr36m5
GZepMcjDFq6b889rUyXpCnQJZkaSqOcYLwMS6yfKUCDeNubiwq1ilKxT/JkVUgVq
7iTFY/Q=
-----END CERTIFICATE-----`;

const WXPAY_TEST_PLATFORM_ALT_PRIVATE_KEY_PEM_BODY =
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDH/JyKN2xsvm5EgOgAr5jxDuMPGaiIAFUwEOMHvPNmHHuV8NaiGr83nK1qSvXR74WNSfWEb9Zy9aPJEO6GGZuQ3TAJS2VURROKu0ZFNSeo64a4b6dZx8NLk2OXZGafsIX9LfBk8Fz1OpXVngxQhItw0KN9/q1UhrEKGSDFDwyJ+C9EPM4MRVXWyESfAbHFmMXg5UxVEsLXQE8Zp/mvPFz79HUYoMzIebBielRw4cClnuP7vFQwer4pcrgDv5rnSEobsX6o2JdSbe5aWivfpjpBZunIMete7dHE4KrzEg+Dq1g14eXVpKx3CeCoqsN7wvHZhR2TqwROs1uqWFpBvPeTAgMBAAECggEAIfPexc6ED3BDO0khWmB1mFN9NCaYiMJ5tAfh64HmVus2Bi5V2j6tQS1N+dJRKru+Ek9AqiPspibTEENaI5U8ZptO2P0ebnCt0StbUkukeJbIEA8Qu/rgyrdyvJS0oZ7wGJxQiGqQdaflIVfMYm0mWVhqsWzoE4Ysj3jVqe8Uo2WdDQ8dCEE848ASNh5RzNO0e6LA1Pz75xvY4Cf8W3ru3egtOqQ9yUmvIP7LJxj5YBHARJ9zVMyP1LBiVcZGiVLVl+L5b/xiP37aeXI4bdsk3zTG5Gcj6lCyIDJmeZG2dVGe0BCM628yYgMkH4uZ9V8Pm+Fee0i0YWodPH3Jd5rmSQKBgQDqDcO2K6dp4zKarGA1xcNYA7UhqTAjJteZwV+1EaJlo434b59LXh+plQ5dZyikOBGA3EXSk9QRRxea21bRtn914nhhxvwhekvf2/ULdIs0J93FDgu9NAvBV9DAx0SkaItmrBsugcUHQR+iqZMkK+jV+fHS3Xn2t+mLLn+WH3kPiQKBgQDavRnw55f4g6OzH6gxcCjHznUfcBpUOGSRONVXkzrGB/OO5fdz393Lyz/PGS5/yZ3Op4FGcNWkuNgjuRfqqkU5cVaf8vLmPeVK9rYqBcO5yQPsklgljU8ufRY0GND+2hoboJeJzm9taTvt73P9BlFKnZ+ANq0e4221mKn1AW+LOwKBgFYdhGHVg/5osqjIPYnrXqlWi+F7r5NvaipPRNiJSXgeClFbOH/xfLLXffaNyx1I59/CrAoDjCZjQuMeSr5UaGdGUUaggQoMRjhyZKG3WrRw6p7jQRx3NtAHcG5Nowre0FORhVrCMm0t3+bof5Pyd/Oqx/futz44grxL+nOQ1ukJAoGBAJYESU1KWJTNG7FWzdCSPrXCJ9uW08fdIUPj+ZVlWVLF00m2+H5VE9WYILwVZimoCf3YLbY03qFpUHs3j2qWuoFJ9QIf6mz0GFTQXWD2sSSy82kFeUTP5HVavqaeOn/+7xbxjdyqYwtjuAFYT3FCKvCEqAaT+SmNCwoXmMB66phPAoGAarLYkpBCv7kUWQ5M5vpqSiM8pWW9FwwoSR0mEid9/gPKatG8I+EKyCD8Mx3+7a9clebgT/cr0k2WvppmfLHqxMzxntQXm9f/OSQbao8UhyYWSJqRrEIjauKbTMEoHkHvCd5KVz4oZ4N2ZYvlZfcLu7Bc2WhiUUvGjxiVXddLAGE=';
export const WXPAY_TEST_PLATFORM_ALT_PRIVATE_KEY_PEM = wrapTestPrivateKey(WXPAY_TEST_PLATFORM_ALT_PRIVATE_KEY_PEM_BODY);

export const WXPAY_TEST_PLATFORM_ALT_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIDaTCCAlGgAwIBAgIUahssPU5fYHGCk6S1xtfo+QEjRWcwDQYJKoZIhvcNAQEL
BQAwRDElMCMGA1UEAwwcV2VDaGF0IFBheSBQbGF0Zm9ybSBNb2NrIEFMVDEbMBkG
A1UECgwSbW9kZWwtcm91dGVyIHRlc3RzMB4XDTI2MTAxMTA5Mjc1OFoXDTM2MTAw
ODA5Mjc1OFowRDElMCMGA1UEAwwcV2VDaGF0IFBheSBQbGF0Zm9ybSBNb2NrIEFM
VDEbMBkGA1UECgwSbW9kZWwtcm91dGVyIHRlc3RzMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAx/ycijdsbL5uRIDoAK+Y8Q7jDxmoiABVMBDjB7zzZhx7
lfDWohq/N5ytakr10e+FjUn1hG/WcvWjyRDuhhmbkN0wCUtlVEUTirtGRTUnqOuG
uG+nWcfDS5Njl2Rmn7CF/S3wZPBc9TqV1Z4MUISLcNCjff6tVIaxChkgxQ8Mifgv
RDzODEVV1shEnwGxxZjF4OVMVRLC10BPGaf5rzxc+/R1GKDMyHmwYnpUcOHApZ7j
+7xUMHq+KXK4A7+a50hKG7F+qNiXUm3uWlor36Y6QWbpyDHrXu3RxOCq8xIPg6tY
NeHl1aSsdwngqKrDe8Lx2YUdk6sETrNbqlhaQbz3kwIDAQABo1MwUTAdBgNVHQ4E
FgQUMHOpfz6Fe0K3sUqlplF3o3pdY/0wHwYDVR0jBBgwFoAUMHOpfz6Fe0K3sUql
plF3o3pdY/0wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAD6UF
hYQpxv7ipL/GGVwJvNUikaIfM2QnsJ5moBjI+J8zcpQenRTyqLAS3vZTFJqcjLNb
zgyFgEyMHGM8x0qnjj1SqL3YonfGJRkYXano7Qt0Y882i86+YFXceripVd46U0l0
w3HIlRP7IK1Le57ik+l0cnwmvgms3gT5I+h8SD5CiUqIdJPIi1KFMbAoEhX8QlJq
tjvjRM0OZPGE86JsYRMF+dp2u8rKxHFXFr0egErSxZpC7ODLJiz4deYYdMxv/oLK
RTPFywxE/4/qWm2xowl1b4tEFtsK+66ouYrXm8/RZ1c68pGKxh/+W0HZFVvqfcte
wt0TvzCXkSJpa/+Wcw==
-----END CERTIFICATE-----`;

export interface MockWxpayCall {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly rawBody: string;
  readonly json: unknown;
}

export type WxpayMockEndpoint =
  | 'transactionsNativeCreate'
  | 'transactionsQuery'
  | 'refundsCreate'
  | 'refundsQuery'
  | 'certificates';

export type WxpayMockHandler = (call: MockWxpayCall) => { status?: number; json?: unknown; raw?: string };

export interface MockWxpay {
  readonly url: string;
  readonly calls: Record<WxpayMockEndpoint, MockWxpayCall[]>;
  readonly setHandler: (endpoint: WxpayMockEndpoint, handler: WxpayMockHandler) => void;
  readonly close: () => Promise<void>;
}

/** Encrypts a certificate PEM exactly like WeChat's /v3/certificates envelope (AES-256-GCM under apiV3Key). */
export function wxpayEncryptCertificate(
  apiV3Key: string,
  certificatePem: string,
): { algorithm: string; nonce: string; associated_data: string; ciphertext: string } {
  const nonce = randomBytes(12).toString('hex');
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), nonce);
  cipher.setAAD(Buffer.from('certificate', 'utf8'));
  const packed = Buffer.concat([cipher.update(certificatePem, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return {
    algorithm: 'AEAD_AES_256_GCM',
    nonce,
    associated_data: 'certificate',
    ciphertext: packed.toString('base64'),
  };
}

/** Canonical /v3/certificates response carrying one encrypted platform certificate. */
export function wxpayCertificatesJson(input: {
  readonly apiV3Key?: string;
  readonly certificatePem?: string;
  readonly serialNo?: string;
}): Record<string, unknown> {
  return {
    data: [
      {
        serial_no: input.serialNo ?? WXPAY_TEST_PLATFORM_SERIAL,
        effective_time: '2026-10-11T09:27:58+08:00',
        expire_time: '2036-10-08T09:27:58+08:00',
        encrypt_certificate: wxpayEncryptCertificate(
          input.apiV3Key ?? WXPAY_TEST_APIV3_KEY,
          input.certificatePem ?? WXPAY_TEST_PLATFORM_CERTIFICATE_PEM,
        ),
      },
    ],
  };
}

/** Platform RSA-SHA256 notification signature over "timestamp\nnonce\nbody\n". */
export function wxpayNotificationSignature(
  body: Buffer,
  timestamp: string,
  nonce: string,
  platformPrivateKeyPem: string = WXPAY_TEST_PLATFORM_PRIVATE_KEY_PEM,
): string {
  return createSign('RSA-SHA256')
    .update(timestamp, 'utf8')
    .update('\n', 'utf8')
    .update(nonce, 'utf8')
    .update('\n', 'utf8')
    .update(body)
    .update('\n', 'utf8')
    .sign(platformPrivateKeyPem, 'base64');
}

export interface WxpayTestTransaction {
  readonly outTradeNo: string;
  readonly transactionId?: string | null;
  readonly tradeState: string;
  readonly total: number;
  readonly currency?: string;
  readonly mchid?: string;
  readonly appid?: string;
  readonly attach?: string | null;
  readonly successTime?: string;
}

/** Canonical transaction JSON for the query endpoint and notification resources. */
export function wxpayTransactionJson(transaction: WxpayTestTransaction): Record<string, unknown> {
  const body: Record<string, unknown> = {
    mchid: transaction.mchid ?? WXPAY_TEST_MCHID,
    appid: transaction.appid ?? WXPAY_TEST_APPID,
    out_trade_no: transaction.outTradeNo,
    trade_state: transaction.tradeState,
    trade_state_desc: `state:${transaction.tradeState}`,
    trade_type: 'NATIVE',
    amount: {
      total: transaction.total,
      payer_total: transaction.total,
      currency: transaction.currency ?? 'CNY',
      payer_currency: transaction.currency ?? 'CNY',
    },
  };
  if (transaction.transactionId !== undefined && transaction.transactionId !== null) {
    body.transaction_id = transaction.transactionId;
  }
  if (transaction.attach !== undefined && transaction.attach !== null) body.attach = transaction.attach;
  if (transaction.successTime !== undefined) body.success_time = transaction.successTime;
  return body;
}

/** Canonical domestic-refund JSON for create/query endpoints. */
export function wxpayRefundJson(input: {
  readonly outRefundNo: string;
  readonly outTradeNo: string;
  readonly refundId?: string;
  readonly status: string;
  readonly refund: number;
  readonly total?: number;
  readonly currency?: string;
}): Record<string, unknown> {
  return {
    refund_id: input.refundId ?? `5030${input.outRefundNo}`.slice(0, 32),
    out_refund_no: input.outRefundNo,
    out_trade_no: input.outTradeNo,
    transaction_id: '4200000000000000000000000001',
    status: input.status,
    amount: {
      total: input.total ?? 1234,
      refund: input.refund,
      currency: input.currency ?? 'CNY',
    },
  };
}

/** Builds a signed + encrypted v3 payment notification exactly like the WeChat scheme. */
export function wxpayNotification(input: {
  readonly transaction: WxpayTestTransaction;
  readonly eventId?: string;
  readonly eventType?: string;
  readonly apiV3Key?: string;
  readonly platformPrivateKeyPem?: string;
  readonly serialNo?: string;
  readonly timestampSec?: number;
  readonly nonce?: string;
  readonly createTime?: string;
  readonly summary?: string;
}): { body: Buffer; headers: Record<string, string> } {
  const apiV3Key = input.apiV3Key ?? WXPAY_TEST_APIV3_KEY;
  const timestamp = String(input.timestampSec ?? Math.floor(Date.parse('2026-10-12T00:00:00.000Z') / 1000));
  const nonce = input.nonce ?? randomBytes(16).toString('hex');
  const resourceNonce = randomBytes(12).toString('hex');
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), resourceNonce);
  cipher.setAAD(Buffer.from('transaction', 'utf8'));
  const packed = Buffer.concat([
    cipher.update(JSON.stringify(wxpayTransactionJson(input.transaction)), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const body = Buffer.from(
    JSON.stringify({
      id: input.eventId ?? `evt-${input.transaction.outTradeNo}`,
      create_time: input.createTime ?? '2026-10-12T00:00:00+08:00',
      event_type: input.eventType ?? 'TRANSACTION.SUCCESS',
      resource_type: 'encrypt-resource',
      summary: input.summary ?? 'payment notification',
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        original_type: 'transaction',
        associated_data: 'transaction',
        nonce: resourceNonce,
        ciphertext: packed.toString('base64'),
      },
    }),
    'utf8',
  );
  return {
    body,
    headers: {
      'wechatpay-signature': wxpayNotificationSignature(
        body,
        timestamp,
        nonce,
        input.platformPrivateKeyPem ?? WXPAY_TEST_PLATFORM_PRIVATE_KEY_PEM,
      ),
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': nonce,
      'wechatpay-serial': input.serialNo ?? WXPAY_TEST_PLATFORM_SERIAL,
    },
  };
}

export async function startMockWxpay(options: { readonly apiV3Key?: string } = {}): Promise<MockWxpay> {
  const apiV3Key = options.apiV3Key ?? WXPAY_TEST_APIV3_KEY;
  const calls: Record<WxpayMockEndpoint, MockWxpayCall[]> = {
    transactionsNativeCreate: [],
    transactionsQuery: [],
    refundsCreate: [],
    refundsQuery: [],
    certificates: [],
  };
  const handlers = new Map<WxpayMockEndpoint, WxpayMockHandler>();
  handlers.set('certificates', () => ({ json: wxpayCertificatesJson({ apiV3Key }) }));
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let json: unknown = null;
      if (rawBody !== '') {
        try {
          json = JSON.parse(rawBody);
        } catch {
          json = null;
        }
      }
      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        query[key] = value;
      });
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key] = value;
      }
      const method = req.method ?? 'GET';
      let endpoint: WxpayMockEndpoint | null = null;
      if (method === 'POST' && url.pathname === '/v3/pay/transactions/native') endpoint = 'transactionsNativeCreate';
      else if (method === 'GET' && /^\/v3\/pay\/transactions\/out-trade-no\/[^/]+$/.test(url.pathname))
        endpoint = 'transactionsQuery';
      else if (method === 'POST' && url.pathname === '/v3/refund/domestic/refunds') endpoint = 'refundsCreate';
      else if (method === 'GET' && /^\/v3\/refund\/domestic\/refunds\/[^/]+$/.test(url.pathname))
        endpoint = 'refundsQuery';
      else if (method === 'GET' && url.pathname === '/v3/certificates') endpoint = 'certificates';
      if (endpoint === null) {
        res
          .writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ code: 'RESOURCE_NOT_EXISTS', message: 'resource not exists' }));
        return;
      }
      const call: MockWxpayCall = { method, path: url.pathname, query, headers, rawBody, json };
      calls[endpoint].push(call);
      const handler = handlers.get(endpoint);
      if (!handler) {
        res.writeHead(500).end('no handler');
        return;
      }
      const outcome = handler(call);
      if (outcome.raw !== undefined) {
        res.writeHead(outcome.status ?? 200, { 'content-type': 'text/plain' }).end(outcome.raw);
        return;
      }
      res
        .writeHead(outcome.status ?? 200, { 'content-type': 'application/json' })
        .end(JSON.stringify(outcome.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    setHandler: (endpoint, handler) => handlers.set(endpoint, handler),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
