# Legacy provider-key literals in environment references

The canonical secret sources are `env` (an environment variable identifier),
`inline` (a non-empty value in the private configuration file), and `secret`
(an encrypted SecretStore reference). New integrations should not put a provider
key in `env.name`.

Older configurations accepted provider-shaped `sk-…` literals in `env.name`.
They remain readable for compatibility. A shared classifier now gives validation,
runtime resolution, availability reporting and redaction the same interpretation,
including short literals that the previous schema accepted but runtime rejected.
A normal environment variable still resolves exclusively through `process.env`.

A successful configuration commit canonicalizes legacy literal sources into
`inline` sources. It does not change an existing snapshot when reading it:
config checksums and in-flight journal recovery must continue to describe the
original snapshot. Management responses present legacy literal sources as a
redacted inline source; a roundtrip of that blank field preserves the existing
credential using the normal inline-value restoration contract. Strict object
validation still rejects unexpected fields. New admin API writes retain the
ordinary environment-identifier schema; clients should submit inline or encrypted
credentials instead of creating new key-shaped environment references.

## Historical configuration protection

New history entries encrypt both inline values and legacy key-shaped environment
sources. Legacy environment sources have a separate encrypted representation whose
decoder reproduces their original JSON object, so historical journal checksums are
not invalidated by canonicalization.

When a ControlStore opens, a transaction upgrades plaintext secret sources in its
existing logical `config_history` rows. Encrypting the secret and updating the row
occur in the same transaction. Already encrypted rows are unchanged on subsequent
opens. Corrupt history fails closed rather than silently dropping records.

This is logical protection, **not secure erasure**. Previous backups, SQLite free
pages, WAL files and copied configuration files may retain prior bytes. The patch
does not delete backups, vacuum user databases or rotate real provider credentials.
An operator should assess prior exports/backups and rotate credentials if exposure
is suspected; do not infer an actual compromise merely from the source defect.

## Offline regression coverage

- `tests/secrets/env-literal-boundaries.test.ts`: availability, management-safe
  copies, exact decoded history/CAS preservation, idempotent legacy migration,
  canonical commits, short literals and ordinary environment names, malformed
  extra-field rejection.
- `tests/admin/env-literal-redaction.test.ts`: authenticated management config,
  export and upstream responses; redacted import/validation roundtrip; encrypted
  history after CAS commit. This exercises the API data consumed by the console,
  not a browser rendering test.
