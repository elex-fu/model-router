// Dedicated ReEncrypt-only ESM entry (B1a): the rewrapping loader requires a
// distinct specifier with exactly one export. Pure ESM keeps the module
// namespace clean (transpiled CJS entries gain interop keys the loader
// contract rejects). Rewrap deployments wire this .mjs path.
export { createProviderCredentialRewrappingKms } from './software-provider-credential-kms.js';
