// Dedicated ReEncrypt-only ESM entry (B1a): the rewrapping loader requires a
// distinct specifier with exactly one export. Pure ESM keeps the module
// namespace clean (transpiled CJS entries gain interop keys the loader
// contract rejects). Rewrap deployments wire this .mjs path.
//
// The implementation module ships as CommonJS (the repo has no package
// "type": "module"; both tsx and tsc emit CJS for it). A named re-export from
// CJS relies on cjs-module-lexer, which cannot see through the tsx/esbuild
// export helper — so import the default interop object (module.exports) and
// re-export the single factory explicitly.
import softwareProviderCredentialKms from './software-provider-credential-kms.js';

export const createProviderCredentialRewrappingKms =
  softwareProviderCredentialKms.createProviderCredentialRewrappingKms;
